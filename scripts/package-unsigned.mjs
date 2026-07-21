import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const requireFromRoot = createRequire(path.join(root, 'package.json'));
const claudeAgentSdkDir = path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
const args = process.argv.slice(2);
const platform = args.includes('--linux') ? 'linux' : args.includes('--win') ? 'win' : 'mac';
const skipSidecarBuild = args.includes('--skip-sidecar-build') || process.env.STASHBASE_SKIP_SIDECAR_BUILD === '1';
const skipTranscriptionBuild = process.env.STASHBASE_SKIP_TRANSCRIPTION_BUILD === '1';
const target = args.includes('--dir')
  ? ['dir']
  : platform === 'win'
    ? ['nsis', 'zip']
    : platform === 'linux'
      ? ['deb']
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
const TRANSCRIPTION_TOOLCHAIN = JSON.parse(
  fs.readFileSync(path.join(root, 'native', 'transcription', 'toolchain.json'), 'utf8'),
);
validateTranscriptionToolchain(TRANSCRIPTION_TOOLCHAIN);
const EXPECTED_TRANSCRIPTION_BUILD = Object.freeze({
  providerId: TRANSCRIPTION_TOOLCHAIN.providerId,
  whisperCppVersion: TRANSCRIPTION_TOOLCHAIN.whisperCppVersion,
  whisperCppCommit: TRANSCRIPTION_TOOLCHAIN.whisperCppCommit,
  ggmlNative: TRANSCRIPTION_TOOLCHAIN.ggmlNative,
  ggmlBlas: TRANSCRIPTION_TOOLCHAIN.ggmlBlas,
  ffmpegVersion: TRANSCRIPTION_TOOLCHAIN.ffmpegVersion,
  ffmpegLicense: TRANSCRIPTION_TOOLCHAIN.ffmpegLicense,
  opusVersion: TRANSCRIPTION_TOOLCHAIN.opusVersion,
  macosDeploymentTarget: TRANSCRIPTION_TOOLCHAIN.macosDeploymentTarget,
  linuxGlibcBaseline: TRANSCRIPTION_TOOLCHAIN.linuxGlibcBaseline,
  linuxGlibcxxBaseline: TRANSCRIPTION_TOOLCHAIN.linuxGlibcxxBaseline,
});

function validateTranscriptionToolchain(info) {
  for (const field of [
    'providerId',
    'whisperCppVersion',
    'whisperCppCommit',
    'ffmpegVersion',
    'ffmpegSha256',
    'ffmpegLicense',
    'opusVersion',
    'opusSha256',
    'macosDeploymentTarget',
    'linuxGlibcBaseline',
    'linuxGlibcxxBaseline',
  ]) {
    if (typeof info[field] !== 'string' || !info[field].trim()) {
      throw new Error(`native/transcription/toolchain.json requires non-empty string ${field}`);
    }
  }
  for (const field of ['ggmlNative', 'ggmlBlas']) {
    if (typeof info[field] !== 'boolean') {
      throw new Error(`native/transcription/toolchain.json requires boolean ${field}`);
    }
  }
}

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
    'native/transcription/sidecar.nosync',
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
  try {
    run(process.execPath, [electronBuilderCli, `--${platform}`, ...target, '--publish', 'never'], {
      ...fallback.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    });
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
  return { nodePlatform: 'darwin', arch: 'arm64', binaryFormat: 'macho', label: 'macOS' };
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
  if (actual === expected) return null;
  return `${path.relative(root, file)} (${label}) is ${formatLabel(actual)}, expected ${formatLabel(expected)}`;
}

function assertSidecarsForPlatform() {
  const daemon = sidecarCandidates('stashbase-daemon').find((candidate) => fs.existsSync(candidate));
  const extract = sidecarCandidates('stashbase-extract').find((candidate) => fs.existsSync(candidate));
  const requireExtract = process.env.STASHBASE_REQUIRE_EXTRACT === '1' || process.env.STASHBASE_BUILD_EXTRACT === '1';
  const issues = [
    daemon ? sidecarIssue(daemon, 'daemon') : null,
    extract ? sidecarIssue(extract, 'extractor') : null,
  ].filter(Boolean);

  if (daemon && (extract || !requireExtract) && issues.length === 0) {
    if (!extract) {
      console.warn(
        `[package] optional PDF/OCR extractor sidecar not found; packaged local PDF/OCR extraction will be disabled.\n` +
          `          To include it, run with STASHBASE_BUILD_EXTRACT=1.`,
      );
    }
    return;
  }

  const expected = sidecarCandidates('stashbase-daemon')[0];
  const extractExpected = sidecarCandidates('stashbase-extract')[0];
  const hint = !hostMatchesTarget()
    ? `Build the ${targetRuntime().label} Python sidecars on ${targetRuntime().label} before running \`pnpm dist:${platform}\` from another OS.`
    : requireExtract
      ? 'Run `STASHBASE_BUILD_EXTRACT=1 pnpm build:python-sidecar` before packaging.'
      : 'Run `pnpm build:python-sidecar` before packaging.';
  const missing = [
    daemon ? null : path.relative(root, expected),
    requireExtract && !extract ? path.relative(root, extractExpected) : null,
  ].filter(Boolean);
  throw new Error(
    `${platform} packaging requires valid Python sidecar${missing.length + issues.length === 1 ? '' : 's'}:\n` +
      [...missing.map((item) => `missing ${item}`), ...issues].map((item) => `  - ${item}`).join('\n') +
      `\n${hint}`,
  );
}

function transcriptionRoot() {
  const runtime = targetRuntime();
  return path.join(root, 'native', 'transcription', 'sidecar.nosync', `${runtime.nodePlatform}-${runtime.arch}`);
}

function transcriptionExecutable(name) {
  return path.join(transcriptionRoot(), platform === 'win' ? `${name}.exe` : name);
}

function assertTranscriptionToolsForPlatform() {
  const required = [
    transcriptionExecutable('whisper-cli'),
    transcriptionExecutable('ffmpeg'),
    transcriptionExecutable('ffprobe'),
    path.join(transcriptionRoot(), 'build-info.json'),
    path.join(transcriptionRoot(), 'THIRD_PARTY_NOTICES.txt'),
    path.join(transcriptionRoot(), 'LICENSE.whisper.cpp'),
    path.join(transcriptionRoot(), 'COPYING.FFmpeg.LGPLv2.1'),
    path.join(transcriptionRoot(), 'COPYING.FFmpeg.LGPLv3'),
    path.join(transcriptionRoot(), 'LICENSE.Opus'),
  ];
  const missing = required.filter((file) => !fs.existsSync(file));
  const empty = required.filter((file) => fs.existsSync(file) && fs.statSync(file).size === 0);
  const binaries = [
    [transcriptionExecutable('whisper-cli'), 'whisper-cli'],
    [transcriptionExecutable('ffmpeg'), 'ffmpeg'],
    [transcriptionExecutable('ffprobe'), 'ffprobe'],
  ];
  const issues = binaries
    .filter(([file]) => fs.existsSync(file))
    .map(([file, label]) => sidecarIssue(file, label))
    .filter(Boolean);
  issues.push(...empty.map((file) => `${path.relative(root, file)} is empty`));

  if (missing.length === 0) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(transcriptionRoot(), 'build-info.json'), 'utf8'));
      const expectedTarget = `${targetRuntime().nodePlatform}-${targetRuntime().arch}`;
      if (info.target !== expectedTarget) issues.push(`build-info.json targets ${info.target}, expected ${expectedTarget}`);
      for (const [field, expected] of Object.entries(EXPECTED_TRANSCRIPTION_BUILD)) {
        const targetExpected = field === 'macosDeploymentTarget' && platform !== 'mac'
          ? null
          : (field === 'linuxGlibcBaseline' || field === 'linuxGlibcxxBaseline') && platform !== 'linux'
            ? null
            : expected;
        if (info[field] !== targetExpected) {
          issues.push(`build-info.json ${field} is ${JSON.stringify(info[field])}, expected ${JSON.stringify(targetExpected)}`);
        }
      }
      const notices = fs.readFileSync(path.join(transcriptionRoot(), 'THIRD_PARTY_NOTICES.txt'), 'utf8');
      for (const expectedNotice of [
        `whisper.cpp ${EXPECTED_TRANSCRIPTION_BUILD.whisperCppVersion} (${EXPECTED_TRANSCRIPTION_BUILD.whisperCppCommit})`,
        `FFmpeg ${EXPECTED_TRANSCRIPTION_BUILD.ffmpegVersion}`,
        `libopus ${EXPECTED_TRANSCRIPTION_BUILD.opusVersion}`,
      ]) {
        if (!notices.includes(expectedNotice)) issues.push(`THIRD_PARTY_NOTICES.txt is missing ${expectedNotice}`);
      }
    } catch (err) {
      issues.push(`build-info.json is invalid: ${err.message}`);
    }
  }

  if (missing.length === 0 && issues.length === 0 && hostMatchesTarget()) {
    try {
      const version = execFileSync(transcriptionExecutable('ffmpeg'), ['-version'], {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      });
      if (version.includes('--enable-gpl') || version.includes('--enable-nonfree')) {
        issues.push('ffmpeg enables GPL or nonfree components');
      }
      for (const flag of ['--disable-gpl', '--disable-nonfree', '--enable-libopus']) {
        if (!version.includes(flag)) issues.push(`ffmpeg is missing required configure flag ${flag}`);
      }
      if (!version.includes(`ffmpeg version ${EXPECTED_TRANSCRIPTION_BUILD.ffmpegVersion}`)) {
        issues.push(`ffmpeg runtime version is not ${EXPECTED_TRANSCRIPTION_BUILD.ffmpegVersion}`);
      }
      execFileSync(transcriptionExecutable('ffprobe'), ['-version'], { stdio: 'ignore' });
      execFileSync(transcriptionExecutable('whisper-cli'), ['--help'], { stdio: 'ignore' });
      if (platform === 'mac') {
        for (const [file, label] of binaries) {
          const output = execFileSync('otool', ['-l', file], { encoding: 'utf8' });
          const versions = [...output.matchAll(/^\s*minos\s+(\S+)/gm)].map((match) => match[1]);
          if (versions.length === 0) {
            issues.push(`${label} has no LC_BUILD_VERSION minimum macOS version`);
          } else if (versions.some((version) => compareDottedVersions(version, EXPECTED_TRANSCRIPTION_BUILD.macosDeploymentTarget) > 0)) {
            issues.push(`${label} requires macOS ${versions.join(', ')}, above ${EXPECTED_TRANSCRIPTION_BUILD.macosDeploymentTarget}`);
          }
        }
      } else if (platform === 'linux') {
        assertLinuxTranscriptionAbi(binaries, issues);
      }
    } catch (err) {
      issues.push(`native transcription tool smoke failed: ${err.message}`);
    }
  }

  if (missing.length === 0 && issues.length === 0) return;
  const hint = hostMatchesTarget()
    ? 'Run `pnpm build:transcription-sidecar` before packaging.'
    : `Build the ${targetRuntime().label} transcription sidecar on ${targetRuntime().label} before cross-packaging.`;
  throw new Error(
    `${platform} packaging requires a verified native transcription toolchain:\n` +
      [
        ...missing.map((file) => `missing ${path.relative(root, file)}`),
        ...issues,
      ].map((item) => `  - ${item}`).join('\n') +
      `\n${hint}`,
  );
}

function assertLinuxTranscriptionAbi(binaries, issues) {
  for (const [file, label] of binaries) {
    const output = execFileSync('objdump', ['-T', file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    for (const [family, baseline] of [
      ['GLIBC', EXPECTED_TRANSCRIPTION_BUILD.linuxGlibcBaseline],
      ['GLIBCXX', EXPECTED_TRANSCRIPTION_BUILD.linuxGlibcxxBaseline],
    ]) {
      const matches = [...output.matchAll(new RegExp(`${family}_(\\d+(?:\\.\\d+)+)`, 'g'))]
        .map((match) => match[1]);
      const required = matches.sort(compareDottedVersions).at(-1);
      if (required && compareDottedVersions(required, baseline) > 0) {
        issues.push(`${label} requires ${family}_${required}, above ${baseline}`);
      }
    }
  }
}

function compareDottedVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function assertRipgrepForPlatform() {
  if (!hostMatchesTarget()) return;

  const nodePlatform = targetRuntime().nodePlatform;
  const packageName = `@vscode/ripgrep-${nodePlatform}-${process.arch}`;
  const binary = nodePlatform === 'win32' ? 'rg.exe' : 'rg';
  try {
    requireFromRoot.resolve(`${packageName}/bin/${binary}`);
  } catch {
    throw new Error(
      `${platform} packaging requires ${packageName}. ` +
        `Run \`pnpm install --frozen-lockfile\` on ${targetRuntime().label} and make sure ` +
        `package.json optionalDependencies includes ${packageName}.`,
    );
  }
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

if (!hostMatchesTarget()) {
  assertSidecarsForPlatform();
  assertTranscriptionToolsForPlatform();
  assertRipgrepForPlatform();
  assertClaudeAgentSdkForPlatform();
  runScript('build');
} else {
  runScript('build');
  if (!skipSidecarBuild) runScript('build:python-sidecar');
  if (!skipTranscriptionBuild) runScript('build:transcription-sidecar');
  assertSidecarsForPlatform();
  assertTranscriptionToolsForPlatform();
  assertRipgrepForPlatform();
  assertClaudeAgentSdkForPlatform();
}
clearQuarantine();
runElectronBuilder();
clearQuarantine(['release.nosync']);
