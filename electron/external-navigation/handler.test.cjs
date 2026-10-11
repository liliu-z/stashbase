'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EXTERNAL_NAVIGATION_CAPABILITY,
  registerExternalNavigation,
} = require('../../dist/electron/external-navigation/handler.cjs');

function harness({ authorized = true, openExternal = async () => undefined } = {}) {
  const handlers = new Map();
  const frame = { url: 'app://renderer/' };
  const webContents = { mainFrame: frame };
  const window = { isDestroyed: () => false };
  registerExternalNavigation({
    BrowserWindow: { fromWebContents: (candidate) => (candidate === webContents ? window : null) },
    expectedOrigins: new Set(['app://renderer']),
    hasCapability: (_window, capability) =>
      authorized && capability === EXTERNAL_NAVIGATION_CAPABILITY,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    isLiveWindow: (candidate) => candidate === window,
    openExternal,
  });
  return {
    event: { sender: webContents, senderFrame: frame },
    open: handlers.get('external-navigation:open'),
  };
}

test('external navigation opens one validated HTTP(S) URL for an authorized main frame', async () => {
  const opened = [];
  const setup = harness({ openExternal: async (url) => opened.push(url) });

  assert.deepEqual(await setup.open(setup.event, { url: 'https://example.com/docs' }), {
    ok: true,
  });
  assert.deepEqual(opened, ['https://example.com/docs']);
});

test('external navigation rejects unsafe URLs and unauthorized senders before shell access', async () => {
  const opened = [];
  const setup = harness({ openExternal: async (url) => opened.push(url) });
  const denied = harness({ authorized: false, openExternal: async (url) => opened.push(url) });

  assert.equal((await setup.open(setup.event, { url: 'file:///etc/passwd' })).ok, false);
  assert.equal((await denied.open(denied.event, { url: 'https://example.com' })).ok, false);
  assert.deepEqual(opened, []);
});

test('a stalled system browser returns a failure and permits another attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish;
  const setup = harness({ openExternal: () => new Promise(resolve => { finish = resolve; }) });
  const opening = setup.open(setup.event, { url: 'https://billing.stripe.com/test' });
  t.mock.timers.tick(10_000);
  assert.equal((await opening).ok, false);
  finish(); // A late OS acknowledgement cannot turn the old result into success.
  const retry = setup.open(setup.event, { url: 'https://billing.stripe.com/test' });
  finish();
  assert.deepEqual(await retry, { ok: true });
});
