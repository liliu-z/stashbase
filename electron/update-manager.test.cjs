const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createUpdateManager } = require('./update-manager.cjs');

class FakeUpdater extends EventEmitter {
  checks = 0;
  downloads = 0;
  installs = 0;
  async checkForUpdates() {
    this.checks += 1;
    this.emit('update-available', { version: '2.1.0' });
  }
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

test('keeps downloads and installs under manager control and schedules default-on checks', async () => {
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.checks, 1);
  assert.equal(manager.getState().phase, 'ready');
});

test('a found release downloads in the background and installs only on an explicit restart', async () => {
  const { updater, manager, states } = harness();
  updater.checkForUpdates = async () => {
    updater.checks++;
    updater.emit('update-available', { version: '2.1.0', releaseDate: '2026-08-17' });
  };
  await manager.check({ manual: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.downloads, 1);
  assert.equal(updater.installs, 0);
  assert.equal(manager.getState().phase, 'ready');
  assert.equal(manager.getState().availableVersion, '2.1.0');
  await manager.primaryAction();
  assert.equal(updater.installs, 1);
  assert.deepEqual(
    states.filter((state) => ['available', 'downloading', 'ready', 'installing'].includes(state.phase)).map((state) => state.phase),
    ['available', 'downloading', 'downloading', 'ready', 'ready', 'installing'],
  );
  assert.equal(updater.downloads, 1, 'restart reuses the already downloaded latest release');
  assert.equal(manager.getState().phase, 'installing');
});

test('restart does nothing until a download has finished', async () => {
  const { updater, manager } = harness();
  await manager.start();
  updater.emit('update-available', { version: '2.1.0' });
  assert.equal((await manager.primaryAction()).phase, 'available');
  assert.equal(updater.downloads, 0);
  assert.equal(updater.installs, 0);
});

test('keeps a downloaded update ready when a renderer save barrier declines', async () => {
  let mayInstall = false;
  const { manager, updater } = harness({ beforeInstall: async () => mayInstall });
  await manager.start();
  updater.emit('update-downloaded', { version: '2.1.0' });
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
  updater.emit('update-downloaded', { version: '2.1.0' });
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
  updater.emit('update-downloaded', { version: '2.1.0' });
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

test('Store installs never check, download or install NSIS updates, and open their Store listing', async () => {
  const opened = [];
  const { updater, manager, scheduled } = harness({
    isWindowsStore: true,
    openReleasePage: async (url) => opened.push(url),
  });
  await manager.start();
  await manager.check();
  await manager.checkOnActivity();
  await manager.refreshPreference();
  assert.equal(manager.getState().phase, 'store');
  assert.equal(scheduled.length, 0);
  assert.equal(updater.listenerCount('update-downloaded'), 0);
  updater.emit('update-downloaded', { version: '9.0.0' });
  await manager.primaryAction();
  assert.equal(updater.checks + updater.downloads + updater.installs, 0);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.deepEqual(opened, ['https://apps.microsoft.com/detail/9N1Z6TB2H2P5']);
  manager.dispose();
  await manager.primaryAction();
  assert.equal(opened.length, 1);
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
  assert.equal(manager.getState().phase, 'ready');
  assert.equal(updater.downloads, 1);
  assert.equal(updater.installs, 0);
  manager.dispose();
});

test('restart checks again with automatic checks disabled and installs only the latest download', async () => {
  let finishDownload;
  let saves = 0;
  let installedVersion;
  const { manager, updater, scheduled } = harness({
    readAutoCheck: async () => false,
    beforeInstall: async () => { saves++; return true; },
    installUpdate: () => { installedVersion = manager.getState().availableVersion; },
  });
  await manager.start();
  updater.emit('update-downloaded', { version: '2.1.0' });
  updater.checkForUpdates = async () => {
    updater.checks++;
    updater.emit('update-available', { version: '2.7.3' });
  };
  updater.downloadUpdate = async () => {
    updater.downloads++;
    await new Promise((resolve) => { finishDownload = resolve; });
    updater.emit('update-downloaded', { version: '2.7.3' });
  };
  await manager.checkOnActivity();
  assert.equal(updater.checks, 0, 'a ready download still honors automatic opt-out');
  const actions = [manager.primaryAction(), manager.primaryAction()];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getState().phase, 'downloading');
  assert.equal(updater.checks, 1);
  assert.equal(updater.downloads, 1);
  assert.equal(saves, 0, 'windows remain editable while fetching the newer release');
  assert.equal(installedVersion, undefined);
  finishDownload();
  await Promise.all(actions);
  assert.equal(installedVersion, '2.7.3');
  assert.equal(saves, 1, 'concurrent restart clicks share one installation');
  assert.equal(scheduled.length, 0);
  manager.dispose();
});

test('restart does not silently install a stale download when refreshing or downloading its successor fails', async () => {
  for (const stage of ['check', 'download', 'withdrawn']) {
    let saves = 0;
    const { manager, updater } = harness({ beforeInstall: async () => { saves++; return true; } });
    await manager.start();
    updater.emit('update-downloaded', { version: '2.1.0' });
    updater.checkForUpdates = async () => {
      if (stage === 'check') throw new Error('offline during refresh');
      updater.emit(stage === 'withdrawn' ? 'update-not-available' : 'update-available', { version: '2.7.3' });
    };
    updater.downloadUpdate = async () => { throw new Error('successor download failed'); };
    await manager.primaryAction();
    assert.equal(manager.getState().phase, stage === 'check' ? 'ready' : stage === 'withdrawn' ? 'current' : 'error');
    assert.equal(updater.installs, 0);
    assert.equal(saves, 0);
    if (stage === 'check') {
      assert.equal(manager.getState().checkFailed, true);
      assert.equal(manager.getState().availableVersion, '2.1.0');
      await manager.primaryAction();
      assert.equal(updater.installs, 1, 'a second click explicitly accepts the disclosed offline installer');
      assert.equal(saves, 1);
    }
    manager.dispose();
  }
});

test('ready events cannot start another check until the updater finishes its download promise', async () => {
  let finishDownload;
  const { manager, updater } = harness();
  updater.downloadUpdate = async () => {
    updater.downloads++;
    updater.emit('update-downloaded', { version: '2.1.0' });
    await new Promise((resolve) => { finishDownload = resolve; });
  };
  await manager.check();
  await manager.check();
  assert.equal(updater.checks, 1);
  const action = manager.primaryAction();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.checks, 1);
  assert.equal(updater.installs, 0);
  finishDownload();
  await action;
  assert.equal(updater.checks, 2);
  assert.equal(updater.downloads, 1);
  assert.equal(updater.installs, 1);
  manager.dispose();
});

test('disposal while restart downloads a newer release prevents installation', async () => {
  let finishDownload;
  const { manager, updater } = harness();
  await manager.start();
  updater.emit('update-downloaded', { version: '2.0.1' });
  updater.downloadUpdate = async () => {
    await new Promise((resolve) => { finishDownload = resolve; });
    updater.emit('update-downloaded', { version: '2.1.0' });
  };
  const action = manager.primaryAction();
  await new Promise((resolve) => setImmediate(resolve));
  manager.dispose();
  finishDownload();
  await action;
  assert.equal(updater.installs, 0);
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

test('updater reports the original error and stage once across emit and rejection', async () => {
  const reported = [];
  const { manager, updater } = harness({ onDiagnostic: (error, context) => reported.push({ error, context }) });
  const failure = Object.assign(new Error('Checksum mismatch for downloaded update'), { code: 'ERR_SHA512' });
  updater.checkForUpdates = async () => { updater.emit('error', failure); throw failure; };
  await manager.check();
  assert.deepEqual(reported, [{ error: failure, context: { stage: 'checking', target_version: undefined } }]);
  assert.equal(manager.getState().phase, 'error');
  manager.dispose();
});

test('expected check network failures are warnings, while retries still update state and schedule checks', async () => {
  const reported = [];
  const { manager, updater, scheduled } = harness({
    onDiagnostic: (error, context, severity) => reported.push({ error, context, severity }),
  });
  for (const code of ['ERR_INTERNET_DISCONNECTED', 'ERR_NETWORK_CHANGED', 'ERR_NETWORK_IO_SUSPENDED', 'ERR_NAME_NOT_RESOLVED']) {
    const failure = new Error(`net::${code}`);
    updater.checkForUpdates = async () => { updater.emit('error', failure); throw failure; };
    await manager.check();
    assert.equal(reported.at(-1).severity, 'warning');
    assert.equal(reported.at(-1).error, failure);
    assert.equal(reported.at(-1).context.stage, 'checking');
    assert.equal(manager.getState().message, failure.message);
    assert.equal(scheduled.at(-1).delay, 15 * 60_000);
  }
  assert.equal(reported.length, 4, 'emit and rejection are one occurrence');
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '2.1.0' });
  await manager.check();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getState().phase, 'ready');
  assert.equal(manager.getState().message, undefined);
  manager.dispose();
});

test('check certificates and integrity failures, and network failures during downloads/install, remain errors', async () => {
  const reported = [];
  const { manager, updater } = harness({
    onDiagnostic: (error, context, severity) => reported.push({ error, context, severity }),
    installUpdate: () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); },
  });
  for (const failure of [new Error('net::ERR_CERT_AUTHORITY_INVALID'),
    Object.assign(new Error('Checksum mismatch: net::ERR_NAME_NOT_RESOLVED'), { code: 'ERR_SHA512' })]) {
    updater.checkForUpdates = async () => { throw failure; };
    await manager.check();
    assert.equal(reported.at(-1).severity, 'error');
  }
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '2.1.0' });
  updater.downloadUpdate = async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); };
  await manager.check();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reported.at(-1).severity, 'error');
  assert.equal(reported.at(-1).context.stage, 'downloading');
  assert.equal(manager.getState().phase, 'error');
  updater.emit('update-downloaded', { version: '2.1.0' });
  await manager.primaryAction();
  assert.equal(reported.at(-1).severity, 'error');
  assert.equal(reported.at(-1).context.stage, 'installing');
  manager.dispose();
});

test('GitHub release wrappers retain the severity of the actual check failure, never feed contents', async () => {
  const reported = [];
  const { manager, updater } = harness({ onDiagnostic: (error, context, severity) => reported.push({ error, context, severity }) });
  const latest = 'Unable to find latest version on GitHub (https://github.com/liliu-z/stashbase/releases/latest), please ensure a production release exists: Error: net::ERR_NETWORK_IO_SUSPENDED';
  for (const [code, message, severity] of [
    ['ERR_UPDATER_INVALID_RELEASE_FEED', `Cannot parse releases feed: Error: ${latest}\n    at request\nXML:\n<feed/>`, 'warning'],
    ['ERR_UPDATER_LATEST_VERSION_NOT_FOUND', latest, 'warning'],
    ['ERR_UPDATER_INVALID_RELEASE_FEED', 'Cannot parse releases feed: Error: Invalid XML\nXML:\n<entry>net::ERR_NETWORK_IO_SUSPENDED</entry>', 'error'],
    ['ERR_UPDATER_INVALID_RELEASE_FEED', latest.replace('ERR_NETWORK_IO_SUSPENDED', 'ERR_CERT_AUTHORITY_INVALID'), 'error'],
    ['ERR_SHA512', latest, 'error'],
  ]) {
    const failure = Object.assign(new Error(message), { code });
    updater.checkForUpdates = async () => { throw failure; };
    await manager.check();
    assert.equal(reported.at(-1).severity, severity);
    assert.equal(reported.at(-1).error, failure);
  }
  manager.dispose();
});

test('timer and foreground checks reuse ready downloads and replace them across skipped releases', async () => {
  let time = 0;
  const { manager, updater, scheduled } = harness({ now: () => time });
  let latest = '2.1.0';
  const downloaded = [];
  let finishDownload;
  updater.checkForUpdates = async () => {
    updater.checks++;
    updater.emit('update-available', { version: latest });
  };
  updater.downloadUpdate = async () => {
    updater.downloads++;
    const version = latest;
    if (version === '2.3.0') await new Promise(resolve => { finishDownload = resolve; });
    downloaded.push(version);
    updater.emit('update-downloaded', { version });
  };
  await manager.check();
  await new Promise(resolve => setImmediate(resolve));
  await manager.check();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updater.checks, 2);
  assert.equal(updater.downloads, 1, 'the same version reuses the ready installer');
  latest = '2.3.0';
  scheduled.shift().fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.getState().availableVersion, latest);
  assert.equal(manager.getState().phase, 'downloading');
  await manager.primaryAction();
  await manager.check();
  assert.equal(updater.installs, 0);
  assert.equal(updater.checks, 3, 'checks cannot overlap a replacement download');
  finishDownload();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.getState().phase, 'ready');
  latest = '2.7.3';
  time += 10 * 60_000;
  await manager.checkOnActivity();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.getState().phase, 'ready');
  assert.equal(manager.getState().availableVersion, latest);
  assert.equal(updater.installs, 0, 'a new download still needs an explicit restart');
  await manager.primaryAction();
  assert.deepEqual(downloaded, ['2.1.0', '2.3.0', '2.7.3']);
  assert.equal(updater.installs, 1);
  manager.dispose();
});

test('failed rechecks preserve a ready installer and expose the failure, but failed replacements cannot install it', async () => {
  const { manager, updater } = harness();
  await manager.start();
  updater.emit('update-downloaded', { version: '2.1.0' });
  const failure = new Error('net::ERR_INTERNET_DISCONNECTED');
  updater.checkForUpdates = async () => { updater.emit('error', failure); throw failure; };
  await manager.check();
  assert.equal(manager.getState().phase, 'ready');
  assert.equal(manager.getState().availableVersion, '2.1.0');
  assert.equal(manager.getState().checkFailed, true);
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '2.3.0' });
  updater.downloadUpdate = async () => { throw new Error('download failed'); };
  await manager.check();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.getState().phase, 'error');
  assert.equal(manager.getState().availableVersion, '2.3.0');
  await manager.primaryAction();
  assert.equal(updater.installs, 0, 'the superseded package must not be installed');
  manager.dispose();
});

test('a recheck finishing after availability cannot race installation or a second check', async () => {
  let finish;
  const { manager, updater } = harness();
  await manager.start();
  updater.emit('update-downloaded', { version: '2.1.0' });
  updater.checkForUpdates = async () => {
    updater.checks++;
    updater.emit('update-available', { version: '2.1.0' });
    if (updater.checks === 1) await new Promise(resolve => { finish = resolve; });
  };
  const check = manager.check();
  await new Promise(resolve => setImmediate(resolve));
  const peerCheck = manager.check();
  await manager.primaryAction();
  assert.equal(updater.checks, 1);
  assert.equal(updater.installs, 0);
  finish();
  await Promise.all([check, peerCheck]);
  await manager.primaryAction();
  assert.equal(updater.installs, 1);
  manager.dispose();
});
