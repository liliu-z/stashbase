const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createUpdateManager } = require('./update-manager.cjs');

class FakeUpdater extends EventEmitter {
  checks = 0;
  downloads = 0;
  installs = 0;
  async checkForUpdates() { this.checks += 1; }
  async downloadUpdate() {
    this.downloads += 1;
    this.emit('download-progress', { percent: 42.3 });
    this.emit('update-downloaded', { version: '2.1.0' });
  }
}

function harness(overrides = {}) {
  const updater = new FakeUpdater();
  const scheduled = [];
  const states = [];
  const manager = createUpdateManager({
    updater,
    currentVersion: '2.0.0',
    isPackaged: true,
    readAutoCheck: async () => true,
    beforeInstall: async () => true,
    installUpdate: () => { updater.installs += 1; },
    openReleasePage: async () => {},
    onStateChange: (state) => states.push(state),
    setTimer: (fn, delay) => {
      const handle = { fn, delay, unref() {} };
      scheduled.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      const index = scheduled.indexOf(handle);
      if (index >= 0) scheduled.splice(index, 1);
    },
    ...overrides,
  });
  return { updater, scheduled, states, manager };
}

test('configures explicit user-controlled downloads and schedules default-on checks', async () => {
  const { updater, scheduled, manager } = harness();
  await manager.start();
  assert.equal(manager.getState().autoCheckEnabled, true);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 30_000);
});

test('an explicit opt-out cancels automatic checks but manual checks still work', async () => {
  let enabled = true;
  const { updater, scheduled, manager } = harness({ readAutoCheck: async () => enabled });
  await manager.start();
  enabled = false;
  await manager.refreshPreference();
  assert.equal(scheduled.length, 0);
  await manager.check({ manual: true });
  assert.equal(updater.checks, 1);
  assert.equal(manager.getState().phase, 'checking');
});

test('one explicit action downloads, crosses the save barrier, installs, and relaunches', async () => {
  const { updater, manager, states } = harness();
  await manager.start();
  updater.emit('update-available', { version: '2.1.0', releaseDate: '2026-08-17' });
  assert.equal(manager.getState().availableVersion, '2.1.0');
  await manager.primaryAction();
  assert.equal(updater.downloads, 1);
  assert.equal(updater.installs, 1);
  assert.deepEqual(
    states.filter((state) => ['downloading', 'ready', 'installing'].includes(state.phase)).map((state) => state.phase),
    ['downloading', 'downloading', 'ready', 'installing'],
  );
  assert.equal(manager.getState().phase, 'installing');
});

test('keeps a downloaded update ready when a renderer save barrier declines', async () => {
  let mayInstall = false;
  const { manager, updater } = harness({ beforeInstall: async () => mayInstall });
  await manager.start();
  updater.emit('update-available', { version: '2.1.0' });
  await manager.primaryAction();
  assert.equal(updater.installs, 0);
  assert.equal(manager.getState().phase, 'ready');
  mayInstall = true;
  await manager.primaryAction();
  assert.equal(updater.installs, 1);
});

test('reports installation failure and revokes prepared close approval', async () => {
  let rollbacks = 0;
  const { updater, manager } = harness({
    installUpdate: () => { throw new Error('installer rejected'); },
    afterInstallFailure: () => { rollbacks += 1; },
  });
  await manager.start();
  updater.emit('update-available', { version: '2.1.0' });
  await manager.primaryAction();
  assert.equal(manager.getState().phase, 'error');
  assert.match(manager.getState().message, /installer rejected/);
  assert.equal(rollbacks, 1);
});

test('rolls back once when a platform adapter emits and throws one install failure', async () => {
  let rollbacks = 0;
  let updater;
  const setup = harness({
    installUpdate: () => {
      const error = new Error('installer emitted failure');
      updater.emit('error', error);
      throw error;
    },
    afterInstallFailure: () => { rollbacks += 1; },
  });
  updater = setup.updater;
  await setup.manager.start();
  updater.emit('update-available', { version: '2.1.0' });
  await setup.manager.primaryAction();
  assert.equal(setup.manager.getState().phase, 'error');
  assert.equal(rollbacks, 1);
});

test('development builds report unsupported and can open the release page', async () => {
  let opened = '';
  const { updater, manager } = harness({
    isPackaged: false,
    openReleasePage: async (url) => { opened = url; },
  });
  await manager.start();
  await manager.check();
  assert.equal(updater.checks, 0);
  assert.equal(manager.getState().phase, 'unsupported');
  await manager.openDownloadPage();
  assert.match(opened, /github\.com\/liliu-z\/stashbase\/releases\/latest/);
});
