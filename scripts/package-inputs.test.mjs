import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

test('bundled Start Here filenames preserve the intended reading order', () => {
  const files = fs.readdirSync(path.join(root, 'assets', 'builtin-library'))
    .filter((name) => !name.startsWith('.'))
    .sort();

  assert.deepEqual(files, [
    '00 Welcome.html',
    '01 Getting Started and Workflows.md',
    '02 Product and Mental Model.md',
    '03 Capabilities and Boundaries.md',
    '04 FAQ and Comparisons.md',
    '05 Troubleshooting and Reference.md',
    'AGENTS.md',
  ]);
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

test('packaged AI Index daemon includes the local ONNX embedding runtime', () => {
  const requirements = fs.readFileSync(path.join(root, 'python', 'requirements.txt'), 'utf8');
  const build = fs.readFileSync(path.join(root, 'scripts', 'build-python-sidecar.mjs'), 'utf8');
  const daemonExcludes = build.match(/const daemonExcludedModules = \[([\s\S]*?)\n\];/)?.[1] ?? '';
  const daemonForbidden = build.match(/const daemonForbiddenEntries = \[([\s\S]*?)\n\];/)?.[1] ?? '';

  assert.match(requirements, /^mfs-cli\[onnx\]>=/m);
  for (const runtime of ['onnxruntime', 'tokenizers', 'mfs.embedder.onnx']) {
    assert.doesNotMatch(daemonExcludes, new RegExp(`['"]${runtime.replaceAll('.', '\\\\.')}['"]`));
  }
  for (const runtime of ['onnxruntime', 'tokenizers']) {
    assert.doesNotMatch(daemonForbidden, new RegExp(`['"]${runtime}['"]`));
  }
  assert.match(build, /'--hidden-import',\s*'mfs\.embedder\.onnx'/);
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
});
