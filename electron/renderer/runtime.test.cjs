'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createRuntimeConfig,
} = require('../../dist/electron/renderer/runtime.cjs');

test('runtime preload exposes only a frozen validated server origin', () => {
  const runtime = createRuntimeConfig([
    '/path/to/electron',
    '--stashbase-server-origin=http://127.0.0.1:43123',
  ]);
  assert.deepEqual(runtime, { serverOrigin: 'http://127.0.0.1:43123' });
  assert.equal(Object.isFrozen(runtime), true);
  assert.throws(() => createRuntimeConfig([
    '--stashbase-server-origin=https://example.com',
  ]));
  assert.throws(() => createRuntimeConfig([]));
});

test('runtime preload carries a readable remembered appearance and drops anything else', () => {
  const origin = '--stashbase-server-origin=http://127.0.0.1:43123';
  const appearance = {
    theme: 'light', lightTheme: 'gruvbox-light', darkTheme: 'stashbase-dark', uiScale: 'large',
    readingTextSize: 'default', readingFont: 'serif', writingFont: null, codeFont: null, lineSpacing: 'relaxed',
    lineWidth: 'default', reduceMotion: 'on', spellcheck: true, spellcheckLanguage: null,
    focusMode: true, typewriterScrolling: false, wordCount: false,
  };
  assert.deepEqual(
    createRuntimeConfig([origin, `--stashbase-appearance=${JSON.stringify(appearance)}`]),
    { appearance, serverOrigin: 'http://127.0.0.1:43123' },
  );
  for (const bad of ['{', JSON.stringify({ ...appearance, theme: 'neon' })]) {
    assert.deepEqual(createRuntimeConfig([origin, `--stashbase-appearance=${bad}`]), {
      serverOrigin: 'http://127.0.0.1:43123',
    });
  }
});
