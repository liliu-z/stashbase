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
  assert.throws(
    () => manager.setUpdateSimulation('available'),
    /development builds only/,
  );
});

test('development update simulation previews states without touching the real updater', async () => {
  const { updater, manager, states } = harness({
    isPackaged: false,
    debugEnabled: true,
  });
  await manager.start();

  assert.deepEqual(manager.getState().simulation, { enabled: true, value: 'off' });
  assert.equal(manager.getState().phase, 'unsupported');

  manager.setUpdateSimulation('available');
  assert.equal(manager.getState().phase, 'available');
  assert.equal(manager.getState().availableVersion, '2.0.1');

  manager.setUpdateSimulation('downloading');
  assert.equal(manager.getState().phase, 'downloading');
  assert.equal(manager.getState().percent, 42);

  manager.setUpdateSimulation('ready');
  assert.equal(manager.getState().phase, 'ready');
  assert.equal(manager.getState().percent, 100);

  manager.setUpdateSimulation('error');
  assert.equal(manager.getState().phase, 'error');
  assert.match(manager.getState().message, /Simulated update failure/);

  await manager.primaryAction();
  assert.equal(updater.downloads, 0);
  assert.equal(updater.installs, 0);
  assert.equal(manager.getState().phase, 'error');

  manager.setUpdateSimulation('off');
  assert.equal(manager.getState().phase, 'unsupported');
  assert.equal(manager.getState().availableVersion, undefined);
  assert.equal(states.at(-1).simulation.value, 'off');

  assert.throws(() => manager.setUpdateSimulation('bogus'), /Invalid update simulation/);
});


test('an updater error during pending saves cancels installation without hiding the error', async () => {
  let release;
  let rollbacks = 0;
  const { updater, manager } = harness({
    beforeInstall: () => new Promise((resolve) => { release = resolve; }),
    afterInstallFailure: () => { rollbacks += 1; },
  });
  await manager.start();
  updater.emit('update-downloaded', { version: '2.1.0' });
  const pending = manager.primaryAction();
  await new Promise((resolve) => setImmediate(resolve));
  updater.emit('error', new Error('native preparation failed'));
  release(true);
  await pending;
  assert.equal(updater.installs, 0);
  assert.equal(rollbacks, 1);
  assert.equal(manager.getState().phase, 'error');
});


test('a late save completion cannot install or overwrite a retry after an updater error', async () => {
  const replies = [];
  const { updater, manager } = harness({
    beforeInstall: () => new Promise((resolve) => { replies.push(resolve); }),
  });
  await manager.start();
  updater.emit('update-downloaded', { version: '2.1.0' });
  const first = manager.primaryAction();
  await new Promise((resolve) => setImmediate(resolve));
  updater.emit('error', new Error('native preparation failed'));
  updater.emit('update-downloaded', { version: '2.1.0' });
  const retry = manager.primaryAction();
  await new Promise((resolve) => setImmediate(resolve));
  replies[0](false);
  await first;
  assert.equal(manager.getState().phase, 'installing');
  assert.equal(updater.installs, 0);
  replies[1](true);
  await retry;
  assert.equal(updater.installs, 1);
});

test('a resident application discovers releases periodically without a restart', async () => {
  const { manager, updater, scheduled } = harness();
  updater.checkForUpdates = async () => {
    updater.checks++;
    updater.emit(updater.checks === 1 ? 'update-not-available' : 'update-available', { version: '2.1.0' });
  };
  await manager.start();
  scheduled.shift().fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getState().phase, 'current');
  assert.equal(scheduled[0].delay, 15 * 60_000);
  scheduled.shift().fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getState().phase, 'available');
  assert.equal(updater.downloads, 0);
  manager.dispose();
});

test('focus and wake share a throttle, while manual checks bypass it and automatic opt-out wins', async () => {
  let time = 1000;
  let enabled = true;
  const { manager, updater } = harness({ now: () => time, readAutoCheck: async () => enabled });
  updater.checkForUpdates = async () => { updater.checks++; updater.emit('update-not-available'); };
  await manager.start();
  await Promise.all([manager.checkOnActivity(), manager.checkOnActivity()]);
  assert.equal(updater.checks, 1);
  time += 4 * 60_000;
  await manager.checkOnActivity();
  assert.equal(updater.checks, 1);
  await manager.check();
  assert.equal(updater.checks, 2);
  time += 5 * 60_000;
  await manager.checkOnActivity();
  assert.equal(updater.checks, 3);
  enabled = false;
  await manager.refreshPreference();
  time += 60 * 60_000;
  await manager.checkOnActivity();
  assert.equal(updater.checks, 3);
  await manager.check();
  assert.equal(updater.checks, 4);
  manager.dispose();
  time += 60 * 60_000;
  await manager.checkOnActivity();
  assert.equal(updater.checks, 4);
});

test('focus cannot restart a check after availability was announced but the request is unfinished', async () => {
  let finish;
  let time = 0;
  const { manager, updater } = harness({ now: () => time });
  updater.checkForUpdates = async () => {
    updater.checks++;
    updater.emit('update-available', { version: '2.1.0' });
    await new Promise((resolve) => { finish = resolve; });
  };
  await manager.start();
  const first = manager.check();
  await new Promise((resolve) => setImmediate(resolve));
  time += 10 * 60_000;
  const second = manager.checkOnActivity();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.checks, 1);
  finish();
  await Promise.all([first, second]);
  manager.dispose();
});

test('an explicit Update click waits for a foreground check before deciding what to download', async () => {
  let finish;
  const { manager, updater } = harness();
  updater.checkForUpdates = async () => {
    updater.checks++;
    await new Promise((resolve) => { finish = resolve; });
    updater.emit('update-not-available');
  };
  await manager.start();
  updater.emit('update-available', { version: '2.1.0' });
  const check = manager.checkOnActivity();
  await new Promise((resolve) => setImmediate(resolve));
  const action = manager.primaryAction();
  assert.equal(updater.downloads, 0);
  finish();
  await Promise.all([check, action]);
  assert.equal(updater.downloads, 0);
  assert.equal(manager.getState().phase, 'current');
  manager.dispose();
});
