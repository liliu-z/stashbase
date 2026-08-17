import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertMacUpdateArtifacts } from './update-artifact-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('packaging declares the official GitHub update channel', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.build.publish, [{
    provider: 'github',
    owner: 'liliu-z',
    repo: 'stashbase',
  }]);
  assert.ok(pkg.build.win.target.includes('nsis'));
  assert.ok(pkg.build.mac.target.includes('dmg'));
  assert.ok(pkg.build.linux.target.includes('AppImage'));
  assert.ok(pkg.build.linux.target.includes('deb'));
});

test('every platform release uploads electron-updater metadata', () => {
  const ci = read('.github/workflows/ci.yml');
  const windows = read('.github/workflows/release-windows.yml');
  const linux = read('.github/workflows/release-linux.yml');
  const mac = read('.github/workflows/release-macos.yml');
  const coordinator = read('.github/workflows/release.yml');
  const macPublisher = read('scripts/publish-github-release.mjs');
  const localPublisher = read('scripts/publish.mjs');
  assert.match(windows, /latest\.yml/);
  assert.match(windows, /blockmap/);
  assert.match(windows, /Missing NSIS installer/);
  assert.match(windows, /Missing Windows zip archive/);
  assert.match(windows, /Get-AuthenticodeSignature/);
  assert.match(windows, /publishing unsigned NSIS artifacts/);
  assert.doesNotMatch(windows, /STASHBASE_REQUIRE_WINDOWS_SIGNING/);
  assert.match(linux, /latest-linux\.yml/);
  assert.match(linux, /blockmap/);
  assert.match(linux, /blockMapSize/);
  assert.match(linux, /Missing Debian package/);
  assert.match(linux, /Missing AppImage/);
  assert.match(macPublisher, /\^latest\.\*\\\.ya\?ml\$/);
  assert.match(macPublisher, /assertMacUpdateArtifacts/);
  assert.match(ci, /pnpm test:windows-signing/);
  assert.match(ci, /pnpm test:updates/);

  for (const [name, workflow] of [['macOS', mac], ['Windows', windows], ['Linux', linux]]) {
    assert.match(workflow, /workflow_call:/, `${name} must be callable by the release coordinator`);
    assert.doesNotMatch(workflow, /types:\s*\[published\]/, `${name} must not start after a release is public`);
    assert.doesNotMatch(workflow, /--clobber/, `${name} must not replace an existing version asset`);
  }
  assert.match(coordinator, /--draft/);
  assert.match(coordinator, /uses:\s*\.\/\.github\/workflows\/release-macos\.yml/);
  assert.match(coordinator, /uses:\s*\.\/\.github\/workflows\/release-windows\.yml/);
  assert.match(coordinator, /uses:\s*\.\/\.github\/workflows\/release-linux\.yml/);
  assert.match(coordinator, /--draft=false/);
  assert.match(coordinator, /release_version="\$\{RELEASE_TAG#v\}"/);
  assert.ok(
    coordinator.indexOf('--draft=false') < coordinator.indexOf('publish-homebrew.mjs'),
    'the public release must exist before Homebrew points users at it',
  );
  assert.doesNotMatch(macPublisher, /method:\s*['"]DELETE['"]/);
  assert.doesNotMatch(macPublisher, /--clobber/);
  assert.match(macPublisher, /require-draft/);
  assert.doesNotMatch(macPublisher, /releases['"`],\s*\{\s*method:\s*['"]POST/s);
  assert.match(localPublisher, /if \(!dryRun\)[\s\S]+Direct publication is disabled/);
});

test('changed updater E2E carries stable J01 traceability', () => {
  const settings = read('e2e/smoke/settings.spec.ts');
  assert.match(settings, /test\(['"]J01: user can navigate Settings/);
  assert.match(settings, /test\(['"]J01: an available update/);
});

test('macOS publication fails closed unless installer, payload, and metadata coexist', () => {
  assert.throws(
    () => assertMacUpdateArtifacts(['StashBase-2.0.0.dmg', 'latest-mac.yml']),
    /ZIP update payload/,
  );
  assert.throws(
    () => assertMacUpdateArtifacts(['StashBase-2.0.0.dmg', 'StashBase-2.0.0.zip']),
    /latest-mac\.yml metadata/,
  );
  assert.doesNotThrow(() => assertMacUpdateArtifacts([
    'StashBase-2.0.0.dmg',
    'StashBase-2.0.0.zip',
    'latest-mac.yml',
  ]));
});
