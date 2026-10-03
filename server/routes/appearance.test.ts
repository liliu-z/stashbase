import '../__tests__/isolated-home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import express from 'express';

import { mount } from './appearance.ts';
import { readAppConfigStrict, writeAppConfigStrict, normalizeAppearancePreferences } from '../app-config.ts';
import { DEFAULT_APPEARANCE_PREFERENCES } from '../../shared/protocols/http/appearance.ts';

async function withRoute<T>(read: (url: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  mount(app);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    return await read(`http://127.0.0.1:${port}/api/appearance`);
  } finally {
    server.close();
  }
}

function put(body: unknown): Promise<number> {
  return withRoute(async (url) => {
    const res = await fetch(url, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'PUT',
    });
    return res.status;
  });
}

function get(): Promise<{ body: unknown; status: number }> {
  return withRoute(async (url) => {
    const res = await fetch(url);
    return { body: await res.json(), status: res.status };
  });
}

test('partial appearance writes persist through the real route and preserve other configuration', async () => {
  writeAppConfigStrict({ appearance: { uiScale: 'large' }, updates: { autoCheck: false } });
  assert.equal(
    await put({ theme: 'dark', darkTheme: 'catppuccin-mocha', writingFont: 'Iosevka Aile' }),
    200,
  );
  assert.deepEqual((await get()).body, {
    ...DEFAULT_APPEARANCE_PREFERENCES,
    darkTheme: 'catppuccin-mocha',
    theme: 'dark',
    uiScale: 'large',
    writingFont: 'Iosevka Aile',
  });
  const saved = readAppConfigStrict();
  assert.deepEqual(saved.updates, { autoCheck: false });
  for (const value of [[], { unknown: true }, { theme: 'light', unknown: true }]) {
    assert.equal(await put(value), 400);
    assert.deepEqual(readAppConfigStrict(), saved);
  }
});

test('values outside a preference are refused rather than written', async () => {
  const invalid = [
    { theme: 'midnight' },
    { uiScale: 'huge' },
    { lightTheme: 'catppuccin-mocha' },
    { darkTheme: 'dracula' },
    { lineWidth: 'enormous' },
    { spellcheck: 'yes' },
    { spellcheckLanguage: 'english please' },
  ];
  for (const body of invalid) assert.equal(await put(body), 400, JSON.stringify(body));
});

test('a font name that could escape its CSS declaration is refused', async () => {
  for (const writingFont of ['Inter"; color: red', 'a;b', 'x}', 'url(x)', '', 'a\u0000b']) {
    assert.equal(await put({ writingFont }), 400, writingFont);
  }
  assert.equal(await put({ codeFont: 'JetBrains Mono NL' }), 200);
  assert.equal(await put({ codeFont: null }), 200);
});

test('a stored value this build cannot read falls back alone', () => {
  assert.deepEqual(
    normalizeAppearancePreferences({
      darkTheme: 'tokyo-night',
      theme: 'neon',
      uiScale: 'huge',
      writingFont: 'Inter"}',
    }),
    { ...DEFAULT_APPEARANCE_PREFERENCES, darkTheme: 'tokyo-night' },
  );
});
