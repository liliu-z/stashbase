import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach, mock, type TestContext } from 'node:test';
import { filesystemPath } from './filesystem-path.ts';

let scratch: string;
let root: string;
let folder: typeof import('./folder.ts');
let config: typeof import('./app-config.ts');
const originalHome = process.env.STASHBASE_FOLDER_HOME;

before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-project-open-'));
  const home = mock.method(os, 'homedir', () => scratch);
  try {
    folder = await import('./folder.ts');
    config = await import('./app-config.ts');
  } finally { home.mock.restore(); }
});
beforeEach(() => {
  root = filesystemPath.absolute(fs.mkdtempSync(path.join(scratch, 'folders-')));
  process.env.STASHBASE_FOLDER_HOME = root;
  folder.clearCurrentFolder();
  config.writeAppConfigStrict({});
});
after(() => {
  if (originalHome === undefined) delete process.env.STASHBASE_FOLDER_HOME;
  else process.env.STASHBASE_FOLDER_HOME = originalHome;
  fs.rmSync(scratch, { recursive: true, force: true });
});

function directory(name: string): string {
  const target = path.join(root, name);
  fs.mkdirSync(target, { recursive: true });
  return filesystemPath.absolute(target);
}

function holdStat(t: TestContext, target: string) {
  const stat = fs.promises.stat;
  let reached!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  let resume!: () => void;
  let fail!: (error: Error) => void;
  const gate = new Promise<void>((resolve, reject) => { resume = resolve; fail = reject; });
  let held = false;
  t.mock.method(fs.promises, 'stat', async (...args: Parameters<typeof stat>) => {
    if (filesystemPath.absolute(String(args[0])) === target && !held) {
      held = true;
      reached();
      await gate;
    }
    return stat(...args);
  });
  return { started, resume, fail };
}

for (const slowName of ['Slow', 'healthy']) {
test(`a project request ignores a slow ${slowName === 'Slow' ? 'unrelated mount' : 'possible alias'} but still requires an exact available member`, async (t) => {
  const slow = directory(slowName), healthy = directory('Healthy');
  const missing = filesystemPath.absolute(path.join(root, 'Missing'));
  const file = filesystemPath.absolute(path.join(root, 'File'));
  fs.writeFileSync(file, 'not a directory');
  config.writeAppConfigStrict({ recentFolders: ['', slow, healthy, missing, file].map((path) => ({ path, openedAt: new Date().toISOString() })) });
  const gate = holdStat(t, slow);
  const request = folder.exactRegisteredFolderRootAsync(healthy);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      request,
      new Promise<null>((resolve) => { deadline = setTimeout(() => resolve(null), 200); }),
    ]);
    assert.equal(result, healthy, 'the exact stored spelling must win without probing another member');
    assert.equal(await folder.exactRegisteredFolderRootAsync(path.join(healthy, 'child')), null);
    assert.equal(await folder.exactRegisteredFolderRootAsync(root), null);
    assert.equal(await folder.exactRegisteredFolderRootAsync(missing), null);
    assert.equal(await folder.exactRegisteredFolderRootAsync(file), null);
  } finally {
    clearTimeout(deadline);
    gate.resume();
    await request;
  }
});
}

test('opening a slow directory yields and uses no synchronous directory probes', async (t) => {
  const selected = directory('Selected');
  const gate = holdStat(t, selected);
  const stat = fs.statSync;
  let syncProbes = 0;
  t.mock.method(fs, 'statSync', (...args: Parameters<typeof stat>) => {
    if (filesystemPath.absolute(String(args[0])).startsWith(root)) syncProbes++;
    return stat(...args);
  });
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof readdir>) => {
    if (filesystemPath.absolute(String(args[0])).startsWith(root)) syncProbes++;
    return readdir(...args);
  });
  const pending = folder.openProjectFolder(selected);
  await gate.started;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(folder.getCurrentFolder(), null);
  gate.resume();
  const result = await pending;
  assert.equal(result.snapshot.current?.path, selected);
  assert.equal(result.changed, true);
  assert.equal(syncProbes, 0, 'opening a project must not synchronously probe its directories');
});

for (const failure of [false, true]) {
  test(`an old snapshot cannot replace a newer binding (${failure ? 'failed' : 'successful'} stat)`, async (t) => {
    const old = directory('Old'), next = directory('Next');
    await folder.openProjectFolder(old);
    const gate = holdStat(t, old);
    const pending = folder.getProjectRegistrySnapshot();
    await gate.started;
    await folder.openProjectFolder(next);
    if (failure) gate.fail(Object.assign(new Error('unavailable'), { code: 'EACCES' }));
    else gate.resume();
    assert.deepEqual((await pending).current, { path: next, name: 'Next' });
    assert.equal(folder.getCurrentFolder(), next);
  });
}

test('a stale open cannot override the next open or add unwanted membership', async (t) => {
  const old = directory('Slow'), next = directory('Next');
  const gate = holdStat(t, old);
  const pending = folder.openProjectFolder(old);
  const rejected = assert.rejects(pending, { code: 'FOLDER_CHANGED' });
  await gate.started;
  await folder.openProjectFolder(next);
  gate.resume();
  await rejected;
  assert.equal(folder.getCurrentFolder(), next);
  assert.deepEqual(config.readAppConfigStrict().recentFolders?.map((r) => r.path), [next]);
});

test('window retirement while opening prevents both binding and registration', async (t) => {
  const selected = directory('Selected');
  await folder.runWithWindowId('retiring', async () => {
    const gate = holdStat(t, selected);
    const pending = folder.openProjectFolder(selected);
    const rejected = assert.rejects(pending, { code: 'WINDOW_CLOSED' });
    await gate.started;
    folder.retireWindow();
    gate.resume();
    await rejected;
    assert.equal(folder.getCurrentFolder(), null);
    assert.deepEqual(config.readAppConfigStrict().recentFolders ?? [], []);
  });
});

test('losing the old directory during a pending open does not cancel the new open', async (t) => {
  const old = directory('Old'), next = directory('Next');
  await folder.openProjectFolder(old);
  const gate = holdStat(t, next);
  const pending = folder.openProjectFolder(next);
  await gate.started;
  fs.rmdirSync(old);
  assert.equal((await folder.getProjectRegistrySnapshot()).current, null);
  gate.resume();
  assert.equal((await pending).snapshot.current?.path, next);
  assert.equal(folder.getCurrentFolder(), next);
});

test('closing while an open is pending preserves Welcome', async (t) => {
  const next = directory('Next');
  const gate = holdStat(t, next);
  const pending = folder.openProjectFolder(next);
  const rejected = assert.rejects(pending, { code: 'FOLDER_CHANGED' });
  await gate.started;
  folder.clearCurrentFolder();
  gate.resume();
  await rejected;
  assert.equal(folder.getCurrentFolder(), null);
  assert.deepEqual(config.readAppConfigStrict().recentFolders ?? [], []);
});

test('a failed response validation leaves the previous binding and config intact', async () => {
  const previous = directory('Previous');
  await folder.openProjectFolder(previous);
  const before = config.readAppConfigStrict();
  // A valid on-disk path whose relative display label exceeds the wire bound.
  const oversizedLabel = directory(Array(6).fill('a'.repeat(50)).join('/'));
  await assert.rejects(folder.openProjectFolder(oversizedLabel));
  assert.equal(folder.getCurrentFolder(), previous);
  assert.deepEqual(config.readAppConfigStrict(), before);
});

test('failed persistence leaves the previous binding and membership intact', async (t) => {
  const previous = directory('Previous'), next = directory('Next');
  await folder.openProjectFolder(previous);
  const before = config.readAppConfigStrict();
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (...args: Parameters<typeof rename>) => {
    if (String(args[1]).endsWith('config.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return rename(...args);
  });
  await assert.rejects(folder.openProjectFolder(next));
  assert.equal(folder.getCurrentFolder(), previous);
  assert.deepEqual(config.readAppConfigStrict(), before);
});

test('a filesystem root has a nonempty label and returns a valid committed snapshot', async () => {
  const filesystemRoot = path.parse(root).root;
  const result = await folder.openProjectFolder(filesystemRoot);
  assert.ok(result.snapshot.current?.name);
  assert.equal(result.snapshot.current?.path, folder.getCurrentFolder());
  assert.equal(result.snapshot.recent[0]?.path, folder.getCurrentFolder());
});

test('reopening an equivalent path retains the established source spelling', async (t) => {
  const selected = directory('CaseFolder');
  const alias = path.join(root, 'casefolder');
  if (!fs.existsSync(alias)) return t.skip('requires a case-insensitive volume');
  await folder.openProjectFolder(selected);
  const result = await folder.openProjectFolder(alias);
  assert.equal(result.changed, false);
  assert.equal(result.snapshot.current?.path, selected);
  assert.equal(result.snapshot.recent.length, 1);
});

test('a directory disappearing during preparation does not commit an open', async (t) => {
  const previous = directory('Previous'), next = directory('Next');
  await folder.openProjectFolder(previous);
  const before = config.readAppConfigStrict();
  const stat = fs.promises.stat;
  let selectedChecks = 0;
  t.mock.method(fs.promises, 'stat', async (...args: Parameters<typeof stat>) => {
    if (args[0] === next && ++selectedChecks === 2) fs.rmdirSync(next);
    return stat(...args);
  });
  await assert.rejects(folder.openProjectFolder(next));
  assert.equal(folder.getCurrentFolder(), previous);
  assert.deepEqual(config.readAppConfigStrict(), before);
});

test('cancelling a pending entry leaves the previous binding and membership intact', async (t) => {
  const previous = directory('Previous'), next = directory('Cancelled');
  await folder.openProjectFolder(previous);
  const before = config.readAppConfigStrict();
  const gate = holdStat(t, next);
  const controller = new AbortController();
  const opening = folder.openProjectFolder(next, controller.signal);
  await gate.started;
  controller.abort();
  gate.resume();
  await assert.rejects(opening, { name: 'AbortError' });
  assert.equal(folder.getCurrentFolder(), previous);
  assert.deepEqual(config.readAppConfigStrict(), before);
});
