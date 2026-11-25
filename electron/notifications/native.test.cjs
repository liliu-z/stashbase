const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createNativeNotifications } = require('../../dist/electron/notifications/native.cjs');
const pkg = require('../../package.json');

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: common native notification contract, identity, click and dismissal`, () => {
    const calls = [];
    class Native extends EventEmitter {
      constructor(options) { super(); this.options = options; calls.push(['create', options]); }
      static isSupported() { return true; }
      show() { this.emit('show'); }
      close() { calls.push(['close']); }
    }
    const driver = createNativeNotifications({ platform, desktop: '', openExternal: async () => {}, app: { setAppUserModelId: (id) => calls.push(['identity', id]) }, Notification: Native });
    assert.equal(driver.supported(), true);
    const notice = driver.create({ title: 'Task needs attention', body: 'Research' });
    let clicks = 0;
    notice.on('click', () => clicks++);
    notice.show(); notice.emit('click'); notice.close();
    assert.equal(clicks, 1);
    assert.deepEqual(notice.options, { title: 'Task needs attention', body: 'Research' });
    assert.equal(calls.at(-1)[0], 'close');
    if (platform === 'win32') {
      assert.deepEqual(calls[0], ['identity', pkg.build.appId], 'native AUMID must match the installer shortcut');
      assert.equal(pkg.build.nsis.createStartMenuShortcut, true);
    } else assert.equal(calls.some(([operation]) => operation === 'identity'), false);
  });
}

test('Linux without a usable notification service reports unsupported and does not claim permission', () => {
  class Unavailable {
    static isSupported() { throw new Error('No desktop notification service'); }
  }
  const driver = createNativeNotifications({ platform: 'linux', desktop: '', openExternal: async () => {}, app: {}, Notification: Unavailable });
  assert.equal(driver.supported(), false);
});

test('MSIX notifications retain the package identity supplied by Windows', () => {
  createNativeNotifications({ platform: 'win32', windowsStore: true, desktop: '',
    app: { setAppUserModelId() { assert.fail('MSIX must not use the NSIS identity'); } },
    Notification: {}, openExternal: async () => {} });
});
