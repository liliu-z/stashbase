import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractorInputs, extractorVersion } from './extractor-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packagedFiles = pkg.build?.files ?? [];

function packaged(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  return packagedFiles.some((entry) => {
    if (typeof entry !== 'string' || entry.startsWith('!')) return false;
    if (entry.endsWith('/**/*')) return normalized.startsWith(entry.slice(0, -4));
    if (entry.endsWith('/**')) return normalized.startsWith(entry.slice(0, -3));
    return normalized === entry;
  });
}

function cjsFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return cjsFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.cjs') ? [absolute] : [];
  });
}

test('the supported renderer build is the only packaged renderer input', () => {
  const rendererPkg = JSON.parse(
    fs.readFileSync(path.join(root, 'renderer', 'package.json'), 'utf8'),
  );
  const rendererConfig = fs.readFileSync(path.join(root, 'renderer', 'vite.config.ts'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server', 'index.ts'), 'utf8');

  assert.equal(rendererPkg.name, '@stashbase/renderer');
  for (const scriptName of [
    'dev:web',
    'build:web',
    'format:web',
    'lint:web',
    'test:renderer',
    'typecheck:web',
  ]) {
    assert.match(pkg.scripts?.[scriptName] ?? '', /@stashbase\/renderer/);
  }

  assert.match(rendererConfig, /outDir:\s*['"]\.\.\/dist\/renderer['"]/);
  assert.ok(packagedFiles.includes('dist/renderer/**/*'));
  assert.ok(packagedFiles.includes('dist/electron/**/*'));
  assert.ok(
    !packagedFiles.some((entry) => typeof entry === 'string' && entry.includes('dist/storybook')),
  );
  assert.ok(
    !packagedFiles.some((entry) => typeof entry === 'string' && entry.includes('web/dist-app')),
  );
  assert.match(server, /path\.resolve\(APP_ROOT, ['"]dist['"], ['"]renderer['"]\)/);
  assert.doesNotMatch(server, /web\/dist-app/);

  const electronBuild = fs.readFileSync(
    path.join(root, 'scripts', 'electron', 'boundary.mjs'),
    'utf8',
  );
  assert.match(electronBuild, /['"]renderer\/preload['"]:\s*['"]electron\/renderer\/preload\.ts['"]/);
  assert.match(pkg.scripts?.build ?? '', /build:electron-boundary/);
});

test('packaged Agent Personas include every preset the picker offers', () => {
  // A packaged placeholder or a missing preset would start a session with no
  // persona while the picker says one is chosen.
  for (const id of ['builder', 'marketer', 'journalist', 'storyteller']) {
    const source = fs.readFileSync(path.join(root, 'assets', 'agent-personas', `${id}.md`), 'utf8').trim();
    const prompt = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    assert.match(prompt, /^Take the persona of /);
  }

  assert.deepEqual(
    pkg.build?.extraResources?.find((entry) => entry?.to === 'assets/agent-personas'),
    {
      from: 'assets/agent-personas',
      to: 'assets/agent-personas',
    },
  );
});

test('electron-builder includes local CommonJS dependencies outside electron/', () => {
  const missing = [];
  const relativeRequire = /require\(\s*['"](\.\.\/[^'"]+)['"]\s*\)/g;

  for (const source of cjsFiles(path.join(root, 'electron'))) {
    const content = fs.readFileSync(source, 'utf8');
    for (const match of content.matchAll(relativeRequire)) {
      const dependency = path.resolve(path.dirname(source), match[1]);
      const relative = path.relative(root, dependency);
      if (!fs.existsSync(dependency) || packaged(relative)) continue;
      missing.push(`${path.relative(root, source)} -> ${relative}`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `package.json build.files omits Electron runtime dependencies:\n${missing.join('\n')}`,
  );
});

test('Windows extractor build wires PyInstaller hide-console without switching off stderr', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'build-python-sidecar.mjs'), 'utf8');

  assert.match(
    source,
    /const extractorConsoleArgs = process\.platform === 'win32'[\s\S]*?'--hide-console',[\s\S]*?'hide-early'/,
  );
  assert.match(source, /'stashbase-extract',\s*\.\.\.extractorConsoleArgs,/);
  assert.doesNotMatch(source, /'--(?:no)?console'/);
});

test('Python setup and build keep each checkout constraint readable by pip under special paths', (t) => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-pip-inputs-')));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const sharedTemp = path.join(temporary, "First Last's Temp");
  fs.mkdirSync(sharedTemp);
  const sharedConstraint = path.join(sharedTemp, 'stashbase-constraints.txt');
  fs.writeFileSync(sharedConstraint, 'unrelated temporary file\n');
  const bootstrap = path.join(temporary, 'probe.mjs');
  fs.writeFileSync(bootstrap, `
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: process.env.FIXTURE_PLATFORM });
os.tmpdir = () => process.env.FIXTURE_TEMP;
const commands = [];
childProcess.spawnSync = () => ({ status: 0, stdout: '3 13' });
childProcess.execFileSync = (command, args) => {
  commands.push(command);
  if (command === 'powershell.exe') throw new Error('No 8.3 short names in this fixture');
  if (args[0] === '-m' && args[1] === 'venv') fs.mkdirSync(args[2], { recursive: true });
  else if (args[0] === '-m' && args[1] === 'pip' && args[2] === 'install') {
    console.log('PIP_INPUT ' + JSON.stringify({ constraint: process.env.PIP_CONSTRAINT, commands }));
    process.exit(0);
  }
  else if (command !== process.execPath) throw new Error('Unexpected process: ' + command);
  return Buffer.alloc(0);
};
syncBuiltinESMExports();
`);
  const candidates = [
    path.join(root, 'python', '.venv.nosync', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    'python3.13', 'python3', 'python',
  ];
  const python = candidates.find(command => spawnSync(command, ['-c', 'import pip'], { encoding: 'utf8' }).status === 0);
  assert.ok(python, 'Python with pip is required to verify the constraint consumer');
  for (const platform of new Set(['win32', process.platform])) {
    for (const script of ['setup-python.mjs', 'build-python-sidecar.mjs']) {
      const constraints = [];
      for (const [name, pin] of [["First Last's checkout #1 % 中文", '1.0'], ['Second checkout', '2.0']]) {
        const checkout = path.join(temporary, platform, script, name);
        fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
        fs.mkdirSync(path.join(checkout, 'python'));
        const sourceConstraint = path.join(checkout, 'python', 'constraints.txt');
        fs.writeFileSync(sourceConstraint, `stashbase-path-fixture==${pin}\n`);
        fs.copyFileSync(path.join(root, 'scripts', script), path.join(checkout, 'scripts', script));
        const result = spawnSync(process.execPath, ['--import', pathToFileURL(bootstrap).href, path.join(checkout, 'scripts', script)], {
          cwd: checkout, encoding: 'utf8',
          env: { ...process.env, FIXTURE_PLATFORM: platform, FIXTURE_TEMP: sharedTemp },
        });
        assert.equal(result.status, 0, result.stderr);
        const captured = result.stdout.split(/\r?\n/).find(line => line.startsWith('PIP_INPUT '));
        assert.ok(captured, result.stdout);
        const input = JSON.parse(captured.slice('PIP_INPUT '.length));
        assert.equal(input.constraint, pathToFileURL(sourceConstraint).href);
        assert.doesNotMatch(input.constraint, /\s/);
        assert.equal(input.commands.includes('powershell.exe'), false, 'paths must never become PowerShell code');
        constraints.push(input.constraint);
        // Use the real pip parser and local-file reader, without contacting an
        // index or changing an environment. pip is already installed.
        const pip = spawnSync(python, ['-m', 'pip', 'install', '--dry-run', '--no-index', '--no-deps', 'pip'], {
          encoding: 'utf8',
          env: { ...process.env, PIP_CONFIG_FILE: os.devNull, PIP_CONSTRAINT: input.constraint, PIP_DISABLE_PIP_VERSION_CHECK: '1' },
        });
        assert.equal(pip.status, 0, pip.stderr || pip.stdout);
      }
      assert.notEqual(constraints[0], constraints[1], 'different checkouts must never share a mutable constraint copy');
      assert.equal(fs.readFileSync(fileURLToPath(constraints[0]), 'utf8'), 'stashbase-path-fixture==1.0\n');
      assert.equal(fs.readFileSync(sharedConstraint, 'utf8'), 'unrelated temporary file\n');
    }
  }
});

test('the packaged daemon pins the public MFS project and excludes retired ONNX wiring', () => {
  const requirements = fs.readFileSync(path.join(root, 'python', 'requirements.txt'), 'utf8');
  const build = fs.readFileSync(path.join(root, 'scripts', 'build-python-sidecar.mjs'), 'utf8');
  const daemonExcludes = build.match(/const daemonExcludedModules = \[([\s\S]*?)\n\];/)?.[1] ?? '';
  const daemonForbidden = build.match(/const daemonForbiddenEntries = \[([\s\S]*?)\n\];/)?.[1] ?? '';

  assert.match(requirements, /^mfs @ https:\/\/github\.com\/liliu-z\/mfs\/archive\/refs\/tags\/v\d+\.\d+\.\d+\.tar\.gz$/m);
  assert.doesNotMatch(requirements, /mfs-cli|\[onnx\]/);
  assert.doesNotMatch(build, /mfs\.embedder\.onnx|mfs\.store|mfs\.ingest\.scanner/);
  assert.match(build, /'--hidden-import',\s*'mfs\._process_supervisor'/);
  assert.match(build, /'--copy-metadata',\s*'mfs'/);
  for (const runtime of ['onnxruntime', 'tokenizers']) {
    assert.ok(daemonExcludes.includes(`'${runtime}'`) || daemonForbidden.includes(`'${runtime}'`));
  }
});

test('bundled OpenCode runtime and SDK are pinned with an explicit packaged executable', () => {
  assert.equal(pkg.dependencies?.['@opencode-ai/sdk'], '1.18.19');
  assert.equal(pkg.dependencies?.['opencode-ai'], '1.18.19');
  assert.deepEqual(
    pkg.build?.extraResources?.find((entry) => entry?.to === 'opencode/opencode.exe'),
    {
      from: 'node_modules/opencode-ai/bin/opencode.exe',
      to: 'opencode/opencode.exe',
    },
    'OpenCode postinstall target must be copied to a stable resource path',
  );
  assert.ok(
    pkg.build?.asarUnpack?.includes('node_modules/opencode-ai/bin/**/*'),
    'direct OpenCode dependency fallback must remain executable outside app.asar',
  );
  assert.ok(
    pkg.build?.asarUnpack?.includes('node_modules/.pnpm/opencode-ai*/node_modules/opencode-ai/bin/**/*'),
    'pnpm OpenCode dependency fallback must remain executable outside app.asar',
  );
  const workspace = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  assert.match(workspace, /^\s*opencode-ai:\s+true\s*$/m);
  assert.ok(fs.existsSync(path.join(root, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')));
  assert.equal(pkg.devDependencies?.['@vscode/ripgrep'], '1.18.0');
  assert.deepEqual(
    pkg.build?.win?.extraResources?.find((entry) => entry?.to === 'opencode/rg.exe'),
    { from: 'build/native.nosync/rg.exe', to: 'opencode/rg.exe' },
    'Windows must ship the native skill read dependency beside OpenCode',
  );
});


test('the packaging CLI validates component version and bytes before invoking the builder', async (t) => {
  const componentVersion = await extractorVersion(root);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'package-input-validation-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  for (const relative of ['scripts/package-desktop.mjs', 'scripts/macos-release-contract.mjs',
    'scripts/windows-release-contract.mjs', 'shared/extractor-runtime.ts', 'package.json',
    'scripts/packaging/extractor-release.mjs', 'pnpm-lock.yaml', ...extractorInputs]) {
    fs.mkdirSync(path.dirname(path.join(tmp, relative)), { recursive: true });
    fs.copyFileSync(path.join(root, relative), path.join(tmp, relative));
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const sidecar = path.join(tmp, 'python', 'sidecar.nosync');
  fs.mkdirSync(sidecar, { recursive: true });
  fs.writeFileSync(path.join(sidecar, 'stashbase-daemon'), Buffer.from('7f454c46', 'hex'));
  const bytes = Buffer.from('component archive fixture');
  const manifest = { schema: 1, version: componentVersion, platform: 'linux', arch: 'x64',
    asset: `stashbase-extract-${componentVersion}-linux-x64.tar.gz`,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length };
  fs.mkdirSync(path.join(tmp, 'release.nosync'));
  const archive = path.join(tmp, 'release.nosync', manifest.asset);
  fs.writeFileSync(archive, bytes);
  const manifestPath = path.join(sidecar, 'extractor-runtime.json');
  const preload = `import cp from 'node:child_process'; import { syncBuiltinESMExports, createRequire } from 'node:module';
    import assert from 'node:assert/strict';
    const require = createRequire(${JSON.stringify(path.join(tmp, 'package.json'))});
    const { createYargs, configureBuildCommand } = require('electron-builder/out/builder.js');
    cp.execFileSync = (_command, args) => {
      if (args[0]?.endsWith('cli.js')) {
        const options = configureBuildCommand(createYargs()).exitProcess(false).parse(args.slice(1));
        if (options.win) {
          assert.deepEqual(options.win, ['nsis']);
          assert.equal(options.x64, true);
        }
        console.log('builder arguments accepted');
      }
      return '';
    }; syncBuiltinESMExports();`;
  const run = (platform = '--linux') => spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    path.join(tmp, 'scripts', 'package-desktop.mjs'), platform, '--skip-sidecar-build'], {
    encoding: 'utf8', env: process.env,
  });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  // Passing the component checks reaches the next real guard, without packaging an installer.
  assert.doesNotMatch(run().stderr, /component archive does not match/i);
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '0.0.0' }));
  assert.match(run().stderr, /Extractor component manifest does not match this app build/);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(archive, 'corrupted');
  assert.match(run().stderr, /Extractor component archive does not match its embedded manifest/);

  // Exercise the actual CLI argument consumer without building an installer.
  // Placing --x64 between --win and its target list makes yargs reject nsis/zip.
  fs.writeFileSync(path.join(sidecar, 'stashbase-daemon.exe'), Buffer.from('4d5a0000', 'hex'));
  const windowsManifest = { ...manifest, platform: 'win32',
    asset: `stashbase-extract-${componentVersion}-win32-x64.tar.gz` };
  fs.writeFileSync(manifestPath, JSON.stringify(windowsManifest));
  fs.writeFileSync(path.join(tmp, 'release.nosync', windowsManifest.asset), bytes);
  const result = run('--win');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /builder arguments accepted/);
  if (process.platform === 'win32') {
    const staged = path.join(tmp, 'build', 'native.nosync', 'rg.exe');
    assert.ok(fs.existsSync(staged), 'Windows packaging stages the pinned ripgrep binary');
    assert.equal(fs.readFileSync(staged).subarray(0, 2).toString(), 'MZ');
  }
});
