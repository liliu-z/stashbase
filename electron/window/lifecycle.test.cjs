'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  WINDOW_LIFECYCLE_CAPABILITY,
  registerWindowLifecycle,
} = require('../../dist/electron/window/lifecycle.cjs');

function harness({ load = true, timeoutMs = 1_000, beforeClose } = {}) {
  const handlers = new Map();
  const windowHandlers = new Map();
  const webContentsHandlers = new Map();
  const sent = [];
  // The fullscreen mirror is its own stream, so the barrier tests below can
  // keep counting their own messages.
  const fullscreenSent = [];
  const frame = { url: 'app://renderer/' };
  let closeCalls = 0;
  let fullscreen = false;
  let focused = true;
  let visible = true;
  let blocked = 0;
  const webContents = {
    id: 41,
    isDestroyed: () => false,
    mainFrame: frame,
    on: (event, handler) => webContentsHandlers.set(event, handler),
    send: (channel, payload) =>
      (channel === 'window:fullscreen' ? fullscreenSent : sent).push([channel, payload]),
  };
  const window = {
    close: () => {
      closeCalls += 1;
    },
    isDestroyed: () => false,
    isFullScreen: () => fullscreen,
    isFocused: () => focused,
    isVisible: () => visible,
    on: (event, handler) => windowHandlers.set(event, handler),
    webContents,
  };
  const dependencies = {
    beforeClose,
    onCloseBlocked: () => { blocked += 1; },
    BrowserWindow: { fromWebContents: (candidate) => (candidate === webContents ? window : null) },
    expectedOrigins: new Set(['app://renderer']),
    hasCapability: (_window, capability) => capability === WINDOW_LIFECYCLE_CAPABILITY,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    isLiveWindow: (candidate) => candidate === window,
  };
  const lifecycle = registerWindowLifecycle(dependencies, {
    createRequestId: () => `request-${sent.length + 1}`,
    timeoutMs,
  });
  lifecycle.attach(window);
  const finishLoad = () => webContentsHandlers.get('did-finish-load')();
  if (load) finishLoad();
  const event = { sender: webContents, senderFrame: frame };
  return {
    close: (payload) => windowHandlers.get('close')(payload),
    closeCalls: () => closeCalls,
    blocked: () => blocked,
    event,
    finishLoad,
    crash: () => webContentsHandlers.get('render-process-gone')(),
    fullscreenSent,
    handlers,
    lifecycle,
    sent,
    setFullScreen: (value) => {
      fullscreen = value;
      windowHandlers.get(value ? 'enter-full-screen' : 'leave-full-screen')();
    },
    window,
    input: (input) => webContentsHandlers.get('input-event')({}, input),
    setForeground: (nextFocused, nextVisible = true) => { focused = nextFocused; visible = nextVisible; },
  };
}

test('native activity reports only foreground input presence without raw fields', () => {
  const setup = harness();
  setup.input({ type: 'mouseMove', x: 123, y: 456 });
  setup.input({ type: 'keyUp', key: 'private text' });
  assert.deepEqual(setup.sent, []);
  setup.input({ type: 'keyDown', key: 'private text', modifiers: ['meta'] });
  setup.input({ type: 'mouseDown', x: 123, y: 456 });
  setup.input({ type: 'mouseWheel', x: 123, deltaY: 100 });
  setup.setForeground(false);
  setup.input({ type: 'keyDown' });
  setup.setForeground(true, false);
  setup.input({ type: 'mouseDown' });
  assert.deepEqual(setup.sent, [
    ['window:input-activity', 'keyboard'],
    ['window:input-activity', 'pointer'],
    ['window:input-activity', 'pointer'],
  ]);
});

test('a live interactive barrier extends only its current request and still expires when heartbeats stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const setup = harness();
  let settled = false;
  const pending = setup.lifecycle.requestContextRelease(setup.window, 'window-close').then(value => { settled = true; return value; });
  const payload = setup.sent[0][1];
  t.mock.timers.tick(900);
  setup.handlers.get('window:context-release-pending')(setup.event, payload);
  t.mock.timers.tick(900);
  await Promise.resolve();
  assert.equal(settled, false, 'a visible confirmation can outlive the normal close deadline');
  setup.handlers.get('window:context-release-pending')({ ...setup.event, senderFrame: { url: 'app://renderer/' } }, payload);
  t.mock.timers.tick(101);
  assert.equal(await pending, false, 'a subframe cannot extend the deadline and lost heartbeats refuse close');
  setup.handlers.get('window:context-release-pending')(setup.event, payload);
  setup.handlers.get('window:context-release-ready')(setup.event, { ...payload, ready: true });
  assert.equal(setup.closeCalls(), 0, 'late consent cannot resurrect a timed-out request');
});

test('native fullscreen is mirrored to the renderer on load and on every change', () => {
  const setup = harness({ load: false });
  assert.deepEqual(setup.fullscreenSent, []);
  setup.finishLoad();
  assert.deepEqual(setup.fullscreenSent, [['window:fullscreen', { fullscreen: false }]]);
  setup.setFullScreen(true);
  setup.setFullScreen(false);
  assert.deepEqual(setup.fullscreenSent.slice(1), [
    ['window:fullscreen', { fullscreen: true }],
    ['window:fullscreen', { fullscreen: false }],
  ]);
  // The barrier's own stream saw none of it.
  assert.deepEqual(setup.sent, []);
});

test('native close waits for the renderer barrier and remains open after failure', async () => {
  const setup = harness();
  let prevented = 0;
  setup.close({
    preventDefault: () => {
      prevented += 1;
    },
  });
  const request = setup.sent.at(-1)[1];
  setup.close({
    preventDefault: () => {
      prevented += 1;
    },
  });
  assert.equal(prevented, 2);
  assert.equal(setup.sent.length, 1);
  assert.equal(setup.closeCalls(), 0);

  const ready = setup.handlers.get('window:context-release-ready');
  await ready(setup.event, { ...request, ready: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setup.closeCalls(), 0);
  assert.equal(setup.blocked(), 1, 'a refusal revokes pending app-quit intent');

  setup.close({
    preventDefault: () => {
      prevented += 1;
    },
  });
  const retry = setup.sent.at(-1)[1];
  await ready(setup.event, { ...retry, ready: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setup.closeCalls(), 1);
  assert.equal(setup.blocked(), 1, 'a successful retry does not revoke quit intent');
});

test('host retirement happens after accepted saves and before window sockets disappear', async () => {
  let retired = 0;
  let release;
  const setup = harness({ beforeClose: async () => {
    retired++;
    await new Promise(resolve => { release = resolve; });
  } });
  const closeEvent = { preventDefault() {} };
  const ready = setup.handlers.get('window:context-release-ready');
  setup.close(closeEvent);
  await ready(setup.event, { ...setup.sent.at(-1)[1], ready: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(retired, 0, 'a refused save must preserve the live host sessions');
  setup.close(closeEvent);
  await ready(setup.event, { ...setup.sent.at(-1)[1], ready: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(retired, 1);
  assert.equal(setup.closeCalls(), 0, 'the renderer remains alive until host retirement answers');
  setup.close(closeEvent);
  assert.equal(retired, 1, 'repeat close requests share the pending retirement');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(setup.closeCalls(), 1);
  setup.close({ preventDefault: () => assert.fail('the final native close must proceed') });
});

test('an update-approved close retires the host once and a failed host cannot pin the window', async () => {
  let retired = 0;
  const setup = harness({ beforeClose: async () => { retired++; throw new Error('host unavailable'); } });
  setup.lifecycle.approveClose(setup.window);
  setup.close({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(setup.sent.length, 0, 'the update already settled the save barrier');
  assert.equal(retired, 1);
  assert.equal(setup.closeCalls(), 1);
  setup.close({ preventDefault: () => assert.fail('retirement is not repeated') });
});

test('the active save barrier rejects mismatched senders, request IDs, and reasons', async () => {
  const setup = harness();
  const releasing = setup.lifecycle.requestContextRelease(setup.window, 'window-close');
  const request = setup.sent.at(-1)[1];
  const ready = setup.handlers.get('window:context-release-ready');
  let settled = false;
  void releasing.then(() => { settled = true; });
  await ready({ ...setup.event, sender: { id: 99 } }, { ...request, ready: true });
  await ready(setup.event, { ...request, requestId: 'stale-request', ready: true });
  await ready(setup.event, { ...request, reason: 'update-install', ready: true });
  assert.equal(settled, false);
  await ready(setup.event, { ...request, ready: true });
  assert.equal(await releasing, true);
});

test('native close remains blocked when its save barrier times out', async () => {
  const setup = harness({ timeoutMs: 10 });
  let prevented = false;
  setup.close({ preventDefault: () => { prevented = true; } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(prevented, true);
  assert.equal(setup.closeCalls(), 0);
  assert.equal(setup.handlers.has('window:safe-reload'), false);
});

test('the lifecycle service reports renderer readiness only after the first load', () => {
  const setup = harness({ load: false });
  assert.equal(setup.lifecycle.hasLoadedRenderer(setup.window), false);
  setup.finishLoad();
  assert.equal(setup.lifecycle.hasLoadedRenderer(setup.window), true);
});

test('an update install release crosses the same renderer barrier', async () => {
  const setup = harness();
  const releasing = setup.lifecycle.requestContextRelease(setup.window, 'update-install');
  assert.deepEqual(setup.sent.at(-1), [
    'window:prepare-context-release',
    { reason: 'update-install', requestId: 'request-1' },
  ]);

  const ready = setup.handlers.get('window:context-release-ready');
  await ready(setup.event, { ...setup.sent.at(-1)[1], ready: true });
  assert.equal(await releasing, true);
  assert.equal(setup.closeCalls(), 0);
});

test('an approved close skips the barrier until the approval is revoked', async () => {
  const setup = harness();
  let prevented = 0;
  const closeEvent = {
    preventDefault: () => {
      prevented += 1;
    },
  };

  setup.lifecycle.approveClose(setup.window);
  setup.close(closeEvent);
  assert.equal(prevented, 0);
  assert.equal(setup.sent.length, 0);

  setup.lifecycle.revokeCloseApproval(setup.window);
  setup.close(closeEvent);
  assert.equal(prevented, 1);
  assert.equal(setup.sent.length, 1);
  assert.equal(setup.sent.at(-1)[1].reason, 'window-close');

  const ready = setup.handlers.get('window:context-release-ready');
  await ready(setup.event, { ...setup.sent.at(-1)[1], ready: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setup.closeCalls(), 0);
});


test('a gone renderer releases an outstanding close and a reloaded renderer needs saving again', async () => {
  const setup = harness();
  const release = setup.lifecycle.requestContextRelease(setup.window, 'window-close');
  setup.crash();
  assert.equal(await release, true);
  assert.equal(setup.lifecycle.hasLoadedRenderer(setup.window), false);
  setup.close({ preventDefault: () => assert.fail('a crashed renderer cannot acknowledge') });
  setup.finishLoad();
  assert.equal(setup.lifecycle.hasLoadedRenderer(setup.window), true);
  const next = setup.lifecycle.requestContextRelease(setup.window, 'window-close');
  const request = setup.sent.at(-1)[1];
  await setup.handlers.get('window:context-release-ready')(setup.event, { ...request, ready: false });
  assert.equal(await next, false);
});
