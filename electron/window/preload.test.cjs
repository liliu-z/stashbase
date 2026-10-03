'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createWindowLifecyclePreload } = require('../../dist/electron/window/preload.cjs');

function ipcFixture() {
  const invocations = [];
  const listeners = new Map();
  return {
    invocations,
    emit(channel, payload) {
      listeners.get(channel)?.({}, payload);
    },
    async invoke(channel, payload) {
      invocations.push([channel, payload]);
      return { ok: true };
    },
    on(channel, listener) {
      listeners.set(channel, listener);
    },
  };
}

test('window preload flushes registered barriers and refuses release after unsubscription', async () => {
  const ipc = ipcFixture();
  const preload = createWindowLifecyclePreload(ipc);
  const reasons = [];
  const unsubscribe = preload.onPrepareContextRelease(async (reason) => {
    reasons.push(reason);
    return true;
  });

  ipc.emit('window:prepare-context-release', {
    reason: 'window-close',
    requestId: 'close-1',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(reasons, ['window-close']);
  assert.deepEqual(ipc.invocations.at(-1), [
    'window:context-release-ready',
    { ready: true, reason: 'window-close', requestId: 'close-1' },
  ]);

  unsubscribe();
  ipc.emit('window:prepare-context-release', {
    reason: 'window-close',
    requestId: 'close-2',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ipc.invocations.at(-1), [
    'window:context-release-ready',
    { ready: false, reason: 'window-close', requestId: 'close-2' },
  ]);

  assert.deepEqual(Object.keys(preload), ['onPrepareContextRelease', 'setAppearance']);
});

test('window preload carries an update install release across the boundary', async () => {
  const ipc = ipcFixture();
  const preload = createWindowLifecyclePreload(ipc);
  const reasons = [];
  preload.onPrepareContextRelease(async (reason) => {
    reasons.push(reason);
    return true;
  });

  ipc.emit('window:prepare-context-release', {
    reason: 'update-install',
    requestId: 'install-7',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(reasons, ['update-install']);
  assert.deepEqual(ipc.invocations.at(-1), [
    'window:context-release-ready',
    { ready: true, reason: 'update-install', requestId: 'install-7' },
  ]);
});

test('window preload sends only a valid appearance record to the desktop', async () => {
  const ipc = ipcFixture();
  const preload = createWindowLifecyclePreload(ipc);
  const appearance = {
    theme: 'dark', lightTheme: 'stashbase-light', darkTheme: 'nord', uiScale: 'default',
    readingTextSize: 'default', readingFont: 'serif', writingFont: 'Literata', codeFont: null, lineSpacing: 'default',
    lineWidth: 'wide', reduceMotion: 'system', spellcheck: true, spellcheckLanguage: null,
    focusMode: false, typewriterScrolling: false, wordCount: true,
  };

  await preload.setAppearance(appearance);
  assert.deepEqual(ipc.invocations.at(-1), ['window:appearance', appearance]);

  await assert.rejects(preload.setAppearance({ ...appearance, darkTheme: 'sepia' }));
  assert.equal(ipc.invocations.length, 1);
});
