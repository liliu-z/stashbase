import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApiError,
  encodePath,
  getWindowId,
  parseJsonOrThrow,
  requestHeaders,
} from '../apiTransport';

test('encodePath preserves separators while encoding individual segments', () => {
  assert.equal(encodePath('notes/a b#c.md'), 'notes/a%20b%23c.md');
  assert.equal(
    encodePath('\u4e2d\u6587/\u8ba1\u5212.md'),
    '%E4%B8%AD%E6%96%87/%E8%AE%A1%E5%88%92.md',
  );
});

test('window identity falls back to web outside a browser session', () => {
  assert.equal(getWindowId(), 'web');
  assert.equal(new Headers(requestHeaders()).get('x-stashbase-window-id'), 'web');
});

test('window identity prefers the Electron main-process assignment', () => {
  const originalWindow = globalThis.window;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electron: { windowId: 'native-window-7' },
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
      },
    },
  });
  try {
    assert.equal(getWindowId(), 'native-window-7');
    assert.equal(values.get('stashbase.windowId'), 'native-window-7');
    assert.equal(new Headers(requestHeaders()).get('x-stashbase-window-id'), 'native-window-7');
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: Window }).window;
    } else {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  }
});

test('2xx payloads that model failure as data resolve instead of throwing', async () => {
  const response = new Response(
    JSON.stringify({ status: 'failed', error: 'transcription failed' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

  const payload = await parseJsonOrThrow<{ status: string; error: string }>(response);
  assert.equal(payload.status, 'failed');
  assert.equal(payload.error, 'transcription failed');
});

test('JSON transport errors expose only server message, status, and code', async () => {
  const response = new Response(
    JSON.stringify({
      error: 'The file changed on disk.',
      code: 'STALE_VERSION',
      currentVersion: 'sha256:newer',
      unrelated: 'must not become an error property',
    }),
    { status: 409, headers: { 'content-type': 'application/json' } },
  );

  await assert.rejects(
    parseJsonOrThrow(response),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, 'The file changed on disk.');
      assert.equal(error.status, 409);
      assert.equal(error.code, 'STALE_VERSION');
      assert.equal('currentVersion' in error, false);
      assert.equal('unrelated' in error, false);
      return true;
    },
  );
});
