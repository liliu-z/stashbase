import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stageWindowsStore, storeVersion } from './windows-store.mjs';

test('Store versions retain semver order, reserve revision zero, and reject unrepresentable releases', () => {
  assert.equal(storeVersion('2.19.1'), '2.19.1.0');
  assert.equal(storeVersion('1.0.65535'), '1.0.65535.0');
  for (const value of ['0.1.0', '1.2.65536', '1.2.3-beta.1', '1.2.3.4', '01.2.3', '1.2.3\n', '{{VERSION}}']) {
    assert.throws(() => storeVersion(value), /stable version/);
  }
});

test('MSIX staging preserves a complete Windows payload and rejects incomplete or linked inputs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, content) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  put('package.json', JSON.stringify({ version: '2.19.1' }));
  fs.cpSync(new URL('../../build/windows-store/', import.meta.url), path.join(root, 'build/windows-store'), { recursive: true });
  const source = 'release.nosync/win-unpacked';
  put(`${source}/StashBase.exe`, 'electron');
  put(`${source}/resources/app.asar`, 'application');
  assert.throws(() => stageWindowsStore(root), /ENOENT/);
  put(`${source}/resources/python/sidecar/stashbase-daemon/stashbase-daemon.exe`, 'daemon');
  put(`${source}/resources/opencode/opencode.exe`, 'agent');
  put(`${source}/resources/nested/native.dll`, Buffer.from([0, 255, 12]));
  const stage = stageWindowsStore(root);
  assert.deepEqual(fs.readFileSync(path.join(stage, 'app/resources/nested/native.dll')), Buffer.from([0, 255, 12]));
  assert.equal(fs.readFileSync(path.join(stage, 'app/resources/opencode/opencode.exe'), 'utf8'), 'agent');
  assert.match(fs.readFileSync(path.join(stage, 'AppxManifest.xml'), 'utf8'), /Version="2\.19\.1\.0"/);
  fs.symlinkSync(path.join(root, 'build'), path.join(root, source, 'linked'), 'junction');
  assert.throws(() => stageWindowsStore(root), /symbolic link/);
  assert.equal(fs.readdirSync(path.join(root, 'release.nosync')).filter(name => name.startsWith('msix-stage-')).length, 1,
    'failed staging removes only its own partial output');
});
