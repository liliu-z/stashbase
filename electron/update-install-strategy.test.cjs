const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createUpdateInstaller } = require('./update-install-strategy.cjs');

class FakeUpdater extends EventEmitter {
  calls = [];
  quitAndInstall(isSilent, isForceRunAfter) {
    this.calls.push([isSilent, isForceRunAfter]);
  }
}

for (const [platform, expected] of [
  ['win32', [true, true]],
  ['darwin', [false, true]],
  ['linux', [false, true]],
]) {
  test(`${platform} uses the expected native updater install mode`, () => {
    const updater = new FakeUpdater();
    const install = createUpdateInstaller({
      updater,
      app: { relaunch() {} },
      platform,
      appImagePath: null,
      fileExists: () => true,
    });
    install();
    assert.deepEqual(updater.calls, [expected]);
  });
}

test('AppImage applies first and relaunches the final filename after process exit', () => {
  const updater = new FakeUpdater();
  const relaunches = [];
  updater.quitAndInstall = function quitAndInstall(isSilent, isForceRunAfter) {
    this.calls.push([isSilent, isForceRunAfter]);
    this.emit('appimage-filename-updated', '/opt/StashBase-2.1.0.AppImage');
  };
  const install = createUpdateInstaller({
    updater,
    app: { relaunch: (options) => relaunches.push(options) },
    platform: 'linux',
    appImagePath: '/opt/StashBase-2.0.0.AppImage',
    fileExists: (file) => file === '/opt/StashBase-2.1.0.AppImage',
  });

  install();

  assert.deepEqual(updater.calls, [[false, false]]);
  assert.equal(updater.autoRunAppAfterInstall, false);
  assert.deepEqual(relaunches, [{ execPath: '/opt/StashBase-2.1.0.AppImage' }]);
  assert.equal(updater.listenerCount('appimage-filename-updated'), 0);
});

test('AppImage does not schedule a relaunch after a synchronous install error', () => {
  const updater = new FakeUpdater();
  let relaunched = false;
  updater.quitAndInstall = function quitAndInstall() {
    this.emit('error', new Error('install failed'));
  };
  const install = createUpdateInstaller({
    updater,
    app: { relaunch: () => { relaunched = true; } },
    platform: 'linux',
    appImagePath: '/opt/StashBase.AppImage',
    fileExists: () => true,
  });

  assert.throws(install, /install failed/);
  assert.equal(relaunched, false);
});
