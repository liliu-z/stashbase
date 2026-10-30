'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  WORKSPACE_SESSION_CAPABILITY,
  createWorkspaceSessionStore,
  registerWorkspaceSession,
} = require('../../dist/electron/workspace/session.cjs');

const snapshot = {
  activeFolderPath: '/workspace/notes',
  folders: [{
    activeTabId: null,
    expandedPaths: ['drafts'],
    folderPath: '/workspace/notes',
    mathMode: false,
    selectedPath: null,
    tabs: [],
  }],
  shell: { agentPaneWidth: 576, sidebarOpen: true, sidebarWidth: 240 },
  version: 1,
};

function harness(overrides = {}) {
  const handlers = new Map();
  const frame = { url: 'app://renderer/' };
  const sender = { mainFrame: frame };
  const window = {};
  const dependencies = {
    BrowserWindow: { fromWebContents: () => window },
    claimRestore: () => true,
    expectedOrigins: new Set(['app://renderer']),
    hasCapability: (_window, capability) => capability === WORKSPACE_SESSION_CAPABILITY,
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } },
    isLiveWindow: () => true,
    store: { read: async () => snapshot, write: async () => undefined },
    ...overrides,
  };
  return { dependencies, event: { sender, senderFrame: frame }, handlers };
}

test('workspace session store round-trips validated state and ignores corrupt versions', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stashbase-session-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const filePath = path.join(directory, 'workspace-session.json');
  const store = createWorkspaceSessionStore({ filePath });

  assert.equal(await store.read(), null);
  await store.write(snapshot);
  assert.deepEqual(await store.read(), snapshot);

  const legacy = structuredClone(snapshot);
  delete legacy.folders[0].mathMode;
  await fs.writeFile(filePath, JSON.stringify(legacy));
  assert.equal((await store.read()).folders[0].mathMode, false);

  await fs.writeFile(filePath, JSON.stringify({ ...snapshot, version: 2 }));
  assert.equal(await store.read(), null);
  await fs.writeFile(filePath, '{broken');
  assert.equal(await store.read(), null);
});

test('workspace session IPC authorizes the sender and validates writes', async () => {
  const writes = [];
  const setup = harness({
    store: { read: async () => snapshot, write: async (value) => writes.push(value) },
  });
  registerWorkspaceSession(setup.dependencies);

  assert.deepEqual(
    await setup.handlers.get('workspace-session:read')(setup.event),
    { ok: true, session: snapshot },
  );
  assert.deepEqual(
    await setup.handlers.get('workspace-session:write')(setup.event, snapshot),
    { ok: true },
  );
  assert.deepEqual(writes, [snapshot]);
  assert.deepEqual(
    await setup.handlers.get('workspace-session:write')(setup.event, {
      ...snapshot,
      pendingCommand: true,
    }),
    {
      ok: false,
      failure: { kind: 'invalid-response', message: 'The workspace session state was invalid.' },
    },
  );
});

test('workspace session IPC denies ungranted windows before storage access', async () => {
  let reads = 0;
  const setup = harness({
    hasCapability: () => false,
    store: { read: async () => { reads += 1; return snapshot; }, write: async () => undefined },
  });
  registerWorkspaceSession(setup.dependencies);

  assert.deepEqual(await setup.handlers.get('workspace-session:read')(setup.event), {
    ok: false,
    failure: {
      kind: 'unauthorized',
      message: 'This window cannot restore workspace session state.',
    },
  });
  assert.equal(reads, 0);
});

test('only the first window claims durable restore while each reload keeps its own snapshot', async () => {
  const firstWindow = {};
  const secondWindow = {};
  const firstFrame = { url: 'app://renderer/' };
  const secondFrame = { url: 'app://renderer/' };
  const firstSender = { mainFrame: firstFrame, window: firstWindow };
  const secondSender = { mainFrame: secondFrame, window: secondWindow };
  let claimed = false;
  const setup = harness({
    BrowserWindow: { fromWebContents: (sender) => sender.window },
    claimRestore: () => {
      if (claimed) return false;
      claimed = true;
      return true;
    },
  });
  registerWorkspaceSession(setup.dependencies);
  const read = setup.handlers.get('workspace-session:read');

  assert.deepEqual(await read({ sender: firstSender, senderFrame: firstFrame }), {
    ok: true,
    session: snapshot,
  });
  assert.deepEqual(await read({ sender: secondSender, senderFrame: secondFrame }), {
    ok: true,
    session: null,
  });
  assert.deepEqual(await read({ sender: firstSender, senderFrame: firstFrame }), {
    ok: true,
    session: snapshot,
  });
});

function windowEvent() {
  const frame = { url: 'app://renderer/' };
  return { sender: { mainFrame: frame, window: {} }, senderFrame: frame };
}

function multiWindowSession(store) {
  const first = windowEvent();
  const second = windowEvent();
  const setup = harness({
    BrowserWindow: { fromWebContents: (sender) => sender.window },
    claimRestore: (window) => window === first.sender.window,
    store,
  });
  registerWorkspaceSession(setup.dependencies);
  return {
    first, second,
    read: setup.handlers.get('workspace-session:read'),
    write: setup.handlers.get('workspace-session:write'),
  };
}

const emptySnapshot = { ...snapshot, activeFolderPath: null, folders: [] };
const folderState = (folderPath, tab = 'note.md') => ({
  ...snapshot.folders[0], folderPath,
  tabs: [{ id: 'tab', path: tab }], activeTabId: 'tab',
});

test('real persistence merges window changes without blank or stale snapshots erasing peers', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stashbase-session-windows-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'workspace-session.json');
  const store = createWorkspaceSessionStore({ filePath });
  const initial = { ...snapshot, folders: [folderState('/a'), folderState('/b')] };
  await store.write(initial);
  const setup = multiWindowSession(store);
  assert.deepEqual((await setup.read(setup.first)).session, initial);
  assert.equal((await setup.read(setup.second)).session, null);
  const first = { ...initial, folders: [folderState('/a', 'edited.md'), folderState('/b')] };
  await Promise.all([
    setup.write(setup.first, first),
    setup.write(setup.second, emptySnapshot),
  ]);
  assert.deepEqual((await store.read()).folders, [folderState('/b'), folderState('/a', 'edited.md')]);
  const second = { ...snapshot, folders: [folderState('/b', 'newer.md')] };
  await setup.write(setup.second, second);
  await setup.write(setup.first, { ...first, shell: { ...first.shell, sidebarWidth: 300 } });
  assert.equal((await store.read()).folders.find((folder) => folder.folderPath === '/b').tabs[0].path, 'newer.md');
  // Membership pruning is an explicit deletion relative to this window's last
  // snapshot. A peer's unchanged cached folder cannot resurrect it.
  await setup.write(setup.second, emptySnapshot);
  await setup.write(setup.first, first);
  const restarted = createWorkspaceSessionStore({ filePath });
  assert.deepEqual((await restarted.read()).folders, [folderState('/a', 'edited.md')]);
  assert.deepEqual((await setup.read(setup.first)).session, first);
  assert.deepEqual((await setup.read(setup.second)).session, emptySnapshot);
});

test('failed persistence keeps the previous delta baseline so retry writes the change', async () => {
  let durable = snapshot;
  let fail = true;
  const setup = multiWindowSession({
    read: async () => durable,
    write: async (value) => {
      if (fail) { fail = false; throw new Error('disk unavailable'); }
      durable = value;
    },
  });
  await setup.read(setup.first);
  const changed = { ...snapshot, folders: [folderState('/workspace/notes', 'retry.md')] };
  assert.equal((await setup.write(setup.first, changed)).ok, false);
  assert.equal((await setup.write(setup.first, changed)).ok, true);
  assert.deepEqual(durable.folders, changed.folders);
});

test('merged persistence evicts oldest folder records to retain count and byte bounds', async () => {
  const largeFolder = (id) => ({
    ...folderState(`/folder-${id}`),
    expandedPaths: Array.from({ length: 10 }, (_, index) => `${index}${'x'.repeat(4000)}`),
  });
  let durable = { ...snapshot, folders: Array.from({ length: 20 }, (_, i) => largeFolder(i)) };
  const setup = multiWindowSession({ read: async () => durable, write: async (value) => { durable = value; } });
  await setup.read(setup.second);
  const incoming = { ...snapshot, folders: Array.from({ length: 20 }, (_, i) => largeFolder(i + 20)) };
  assert.equal((await setup.write(setup.second, incoming)).ok, true);
  assert.ok(durable.folders.length > 20 && durable.folders.length <= 32);
  assert.ok(Buffer.byteLength(JSON.stringify(durable)) <= 1_048_576);
  assert.deepEqual(durable.folders.slice(-20), incoming.folders);
});

for (const code of ['EPERM', 'EEXIST']) {
  test(`workspace replacement failure (${code}) retains the previous durable snapshot`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stashbase-session-failure-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'session.json');
    const initial = createWorkspaceSessionStore({ filePath });
    await initial.write(snapshot);
    const failing = createWorkspaceSessionStore({ filePath, fileSystem: {
      ...fs,
      rename: async () => { throw Object.assign(new Error('replacement failed'), { code }); },
    } });
    await assert.rejects(failing.write({ ...snapshot, folders: [] }), { code });
    assert.deepEqual(await initial.read(), snapshot);
    assert.deepEqual(await fs.readdir(directory), ['session.json']);
  });
}
