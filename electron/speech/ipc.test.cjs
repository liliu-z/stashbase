const assert = require('node:assert/strict');
const test = require('node:test');
const { registerSpeechCapture } = require('../../dist/electron/speech/ipc.cjs');

test('capture grants require a live capable main frame and reject extra options', () => {
  let invoke;
  const frame = { url: 'app://renderer/' };
  const window = { capable: true, live: true, webContents: { mainFrame: frame } };
  const grants = [];
  registerSpeechCapture({
    ipcMain: { handle: (_channel, handler) => { invoke = handler; } },
    BrowserWindow: { fromWebContents: (sender) => sender === window.webContents ? window : undefined },
    expectedOrigins: new Set(['app://renderer']),
    isLiveWindow: (target) => target.live,
    hasCapability: (target) => target.capable,
    authorize: (target, active) => { grants.push([target, active]); return true; },
  });
  const event = { sender: window.webContents, senderFrame: frame };
  assert.deepEqual(invoke(event, { active: true }), { ok: true });
  assert.deepEqual(invoke(event, { active: false }), { ok: true });
  assert.deepEqual(grants.map(([, active]) => active), [true, false]);
  for (const payload of [null, { active: 'yes' }, { active: true, device: 'camera' }]) assert.deepEqual(invoke(event, payload), { ok: false });
  assert.deepEqual(invoke({ ...event, senderFrame: { url: 'app://renderer/' } }, { active: true }), { ok: false });
  window.capable = false;
  assert.deepEqual(invoke(event, { active: true }), { ok: false });
  window.capable = true;
  window.live = false;
  assert.deepEqual(invoke(event, { active: true }), { ok: false });
  assert.equal(grants.length, 2);
});
