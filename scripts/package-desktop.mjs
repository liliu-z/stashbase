import { extractorVersion, verifyExtractorArchive } from './packaging/extractor-release.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { stageWindowsSpeechRuntime } from './packaging/speech-runtime.mjs';
import { fileURLToPath } from 'node:url';
import { assertMacosArchitecture, assertMacosReleaseCredentials } from './macos-release-contract.mjs';
import { resolveWindowsSigningConfiguration } from './windows-release-contract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const componentVersion = await extractorVersion(root);
const claudeAgentSdkDir = path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
const args = process.argv.slice(2);
const platform = args.includes('--linux') ? 'linux' : args.includes('--win') ? 'win' : 'mac';
const skipSidecarBuild = args.includes('--skip-sidecar-build') || process.env.STASHBASE_SKIP_SIDECAR_BUILD === '1';
const target = args.includes('--dir')
  ? ['dir']
  : platform === 'win'
    ? ['nsis']
    : platform === 'linux'
      ? []
      : ['dmg', 'zip'];
const xattr = fs.existsSync('/usr/bin/xattr') ? '/usr/bin/xattr' : 'xattr';
const packageManagerCli = process.env.npm_execpath;
const electronBuilderCli = path.join(
  root,
  'node_modules',
  'electron-builder',
  'cli.js',
);
const pnpmListFallback = path.join(root, 'scripts', 'pnpm-list-for-electron-builder.mjs');
function run(command, args, env = {}) {
  execFileSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
}

function findCommand(command) {
  try {
    const locator = process.platform === 'win32' ? 'where.exe' : '/usr/bin/which';
    const out = execFileSync(locator, [command], { encoding: 'utf8' }).trim();
    return out.split(/\r?\n/).find(Boolean) || null;
  } catch {
    return null;
  }
}

function clearQuarantine(extraCandidates = []) {
  if (process.platform !== 'darwin') return;
  const candidates = [
    'electron',
    'dist',
    'web',
    'python/stashbase_daemon.py',
    'python/requirements.txt',
    'python/requirements-extract.txt',
    'python/sidecar.nosync',
    'package.json',
    'package-lock.json',
    'node_modules',
    ...extraCandidates,
  ]
    .map((item) => path.join(root, item))
    .filter((item) => fs.existsSync(item));

  if (candidates.length === 0) return;
  run(xattr, ['-cr', ...candidates]);
}

function runScript(script) {
  if (packageManagerCli) {
    run(process.execPath, [packageManagerCli, 'run', script]);
    return;
  }
  run('npm', ['run', script]);
}

function runElectronBuilder() {
  if (!fs.existsSync(electronBuilderCli)) {
    throw new Error('Missing local electron-builder CLI. Run your package manager install first.');
  }
  assertPnpmCollectorInput();
  const fallback = preparePnpmCollectorFallback();
  const requireMacosSigning = platform === 'mac' && process.env.STASHBASE_RELEASE_BUILD === '1';
  const windowsSigningConfigured = platform === 'win'
    ? resolveWindowsSigningConfiguration(process.env)
    : false;
  if (requireMacosSigning) assertMacosReleaseCredentials(process.env);
  const builderArgs = [electronBuilderCli, `--${platform}`, ...target, `--${targetRuntime().arch}`, '--publish', 'never'];
  if (requireMacosSigning) builderArgs.push('--config.forceCodeSigning=true');
  if (windowsSigningConfigured) builderArgs.push('--config.forceCodeSigning=true');
  try {
    run(process.execPath, builderArgs, fallback.env);
  } finally {
    fallback.cleanup();
  }
}

function assertPnpmCollectorInput() {
  if (!fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return;
  try {
    execFileSync(process.execPath, [pnpmListFallback, root], {
      cwd: root,
      stdio: 'ignore',
    });
  } catch (err) {
    throw new Error(
      `Unable to synthesize electron-builder's pnpm dependency tree fallback: ${err.message}`,
    );
  }
}

function preparePnpmCollectorFallback() {
  if (!fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) {
    return { env: {}, cleanup() {} };
  }
  const realPnpm = findCommand('pnpm');
  if (!realPnpm) return { env: {}, cleanup() {} };

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-pnpm-wrapper-'));
  const wrapper = process.platform === 'win32'
    ? path.join(binDir, 'pnpm.cmd')
    : path.join(binDir, 'pnpm');
  if (process.platform === 'win32') {
    fs.writeFileSync(wrapper, `@echo off\r
if "%~1"=="list" (\r
  "${process.execPath}" "${pnpmListFallback}" "${root}"\r
  exit /b %ERRORLEVEL%\r
)\r
"${realPnpm}" %*\r
exit /b %ERRORLEVEL%\r
`);
  } else {
    fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = "list" ]; then
  exec "${process.execPath}" "${pnpmListFallback}" "${root}"
fi
exec "${realPnpm}" "$@"
`);
    fs.chmodSync(wrapper, 0o755);
  }

  return {
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      STASHBASE_REAL_PNPM: realPnpm,
    },
    cleanup() {
      fs.rmSync(binDir, { recursive: true, force: true });
    },
  };
}

function sidecarCandidates(name) {
  const exe = platform === 'win' ? `${name}.exe` : name;
  return [
    path.join(root, 'python', 'sidecar.nosync', name, exe),
    path.join(root, 'python', 'sidecar.nosync', exe),
  ];
}

function targetRuntime() {
  if (platform === 'win') {
    return { nodePlatform: 'win32', arch: 'x64', binaryFormat: 'pe', label: 'Windows' };
  }
  if (platform === 'linux') {
    return { nodePlatform: 'linux', arch: 'x64', binaryFormat: 'elf', label: 'Linux' };
  }
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error('macOS packaging requires a native arm64 or x64 macOS build host.');
  }
  return { nodePlatform: 'darwin', arch: process.arch, binaryFormat: 'macho', label: 'macOS' };
}

function hostMatchesTarget() {
  const runtime = targetRuntime();
  return process.platform === runtime.nodePlatform && process.arch === runtime.arch;
}

function binaryFormat(file) {
  const header = Buffer.alloc(4);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  const hex = header.toString('hex');
  if (hex === '7f454c46') return 'elf';
  if (header[0] === 0x4d && header[1] === 0x5a) return 'pe';
  if (
    hex === 'feedface' ||
    hex === 'feedfacf' ||
    hex === 'cefaedfe' ||
    hex === 'cffaedfe' ||
    hex === 'cafebabe' ||
    hex === 'cafebabf'
  ) {
    return 'macho';
  }
  return 'unknown';
}

function formatLabel(format) {
  if (format === 'elf') return 'Linux ELF';
  if (format === 'pe') return 'Windows PE';
  if (format === 'macho') return 'macOS Mach-O';
  return 'unknown binary format';
}

function sidecarIssue(file, label) {
  const expected = targetRuntime().binaryFormat;
  const actual = binaryFormat(file);
  if (actual === expected) {
    if (expected === 'macho') {
      try {
        assertMacosArchitecture(file);
      } catch {
        return `${path.relative(root, file)} (${label}) does not contain the target ${process.arch} architecture`;
      }
    }
    return null;
  }
  return `${path.relative(root, file)} (${label}) is ${formatLabel(actual)}, expected ${formatLabel(expected)}`;
}

async function assertSidecarsForPlatform() {
  const daemon = sidecarCandidates('stashbase-daemon').find((candidate) => fs.existsSync(candidate));
  if (!daemon || sidecarIssue(daemon, 'daemon')) {
    throw new Error('A valid target-platform Python index daemon is required; run pnpm build:python-sidecar.');
  }
  const manifestPath = path.join(root, 'python', 'sidecar.nosync', 'extractor-runtime.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const runtime = targetRuntime();
  if (manifest.version !== componentVersion || manifest.platform !== runtime.nodePlatform || manifest.arch !== runtime.arch) {
    throw new Error('Extractor component manifest does not match this app build');
  }
  await verifyExtractorArchive(path.join(root, 'release.nosync'), componentVersion, runtime.nodePlatform, runtime.arch, manifestPath);
}

function assertClaudeAgentSdkForPlatform() {
  if (!hostMatchesTarget()) return;

  const nodePlatform = targetRuntime().nodePlatform;
  const packageName = `@anthropic-ai/claude-agent-sdk-${nodePlatform}-${process.arch}`;
  const binary = nodePlatform === 'win32' ? 'claude.exe' : 'claude';
  try {
    const sdkRealDir = fs.realpathSync(claudeAgentSdkDir);
    createRequire(path.join(sdkRealDir, 'sdk.mjs')).resolve(`${packageName}/${binary}`);
  } catch {
    throw new Error(
      `${platform} packaging requires ${packageName}. ` +
        `Run \`pnpm install --frozen-lockfile\` on ${targetRuntime().label} before packaging.`,
    );
  }
}

function prepareIntelOpenCode() {
  if (platform !== 'mac' || process.arch !== 'x64') return;
  // A hosted runner's AVX2 support must not decide the minimum customer CPU.
  const runtimeRoot = fs.realpathSync(path.join(root, 'node_modules', 'opencode-ai'));
  const resolve = createRequire(path.join(runtimeRoot, 'package.json'));
  const baseline = resolve.resolve('opencode-darwin-x64-baseline/bin/opencode');
  fs.copyFileSync(baseline, path.join(runtimeRoot, 'bin', 'opencode.exe'));
  fs.chmodSync(path.join(runtimeRoot, 'bin', 'opencode.exe'), 0o755);
}

function prepareWindowsRipgrep() {
  if (platform !== 'win' || !hostMatchesTarget()) return;
  const { rgPath } = createRequire(import.meta.url)('@vscode/ripgrep');
  if (!fs.existsSync(rgPath) || binaryFormat(rgPath) !== 'pe') {
    throw new Error('Windows packaging requires @vscode/ripgrep-win32-x64. Run pnpm install --frozen-lockfile on Windows.');
  }
  const target = path.join(root, 'build', 'native.nosync', 'rg.exe');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(rgPath, target);
}

if (!hostMatchesTarget()) {
  await assertSidecarsForPlatform();
  assertClaudeAgentSdkForPlatform();
  runScript('build');
} else {
  runScript('build');
  if (!skipSidecarBuild) {
    runScript('build:python-sidecar');
    run(process.execPath, [path.join(root, 'scripts/prepare-extractor-release.mjs'), 'download']);
  }
  await assertSidecarsForPlatform();
  assertClaudeAgentSdkForPlatform();
}
clearQuarantine();
prepareIntelOpenCode();
prepareWindowsRipgrep();
if (platform === 'win' && hostMatchesTarget()) stageWindowsSpeechRuntime({ root });
runElectronBuilder();
