'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createUpdateWindowBarrier } = require('./update-window-barrier.cjs');

function harness(overrides = {}) {
  const windows = [
    { id: 1, ready: true, live: true },
    { id: 2, ready: true, live: true },
    { id: 3, ready: false, live: true },
    { id: 4, ready: true, live: false },
  ];
  const requested = [];
  const approved = [];
  const revoked = [];
  let blocked = 0;
  const barrier = createUpdateWindowBarrier({
    getWindows: () => windows,
    isLiveWindow: (win) => win.live,
    shouldRequestFlush: (win) => win.ready,
    requestFlush: async (win) => {
      requested.push(win.id);
      return true;
    },
    approveClose: (win) => { approved.push(win.id); },
    revokeCloseApproval: (win) => { revoked.push(win.id); },
    onBlocked: async () => { blocked += 1; },
    ...overrides,
  });
  return { windows, requested, approved, revoked, blocked: () => blocked, barrier };
}

test('update save barrier flushes every ready live window before approving any close', async () => {
  const releases = new Map();
  const setup = harness({
    requestFlush: (win) => new Promise((resolve) => {
      setup.requested.push(win.id);
      releases.set(win.id, resolve);
    }),
  });

  const pending = setup.barrier.prepare();
  await Promise.resolve();
  assert.deepEqual(setup.requested, [1, 2]);
  assert.deepEqual(setup.approved, []);
  releases.get(1)(true);
  await Promise.resolve();
  assert.deepEqual(setup.approved, []);
  releases.get(2)(true);

  assert.equal(await pending, true);
  assert.deepEqual(setup.approved, [1, 2, 3]);
});

test('one failed or rejected save blocks installation and grants no close approval', async () => {
  const setup = harness({
    requestFlush: async (win) => {
      setup.requested.push(win.id);
      if (win.id === 1) return false;
      throw new Error('renderer disappeared');
    },
    onBlocked: async () => {
      throw new Error('dialog unavailable');
    },
  });

  assert.equal(await setup.barrier.prepare(), false);
  assert.deepEqual(setup.requested, [1, 2]);
  assert.deepEqual(setup.approved, []);
});

test('installation failure revokes exactly the closes approved by the update', async () => {
  const setup = harness();
  assert.equal(await setup.barrier.prepare(), true);
  assert.deepEqual(setup.approved, [1, 2, 3]);

  setup.barrier.revoke();
  setup.barrier.revoke();
  assert.deepEqual(setup.revoked, [1, 2, 3]);
});

test('Electron main wires the tested barrier into updater install and rollback hooks', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  assert.match(source, /createUpdateWindowBarrier/);
  assert.match(source, /beforeInstall:\s*updateWindowBarrier\.prepare/);
  assert.match(source, /afterInstallFailure:\s*updateWindowBarrier\.revoke/);
});
