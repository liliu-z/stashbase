import '../__tests__/isolated-home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import express from 'express';

import { mount } from './appearance.ts';
import { readAppConfigStrict, writeAppConfigStrict, normalizeAppearancePreferences } from '../app-config.ts';

const THEMES: readonly unknown[] = ['system', 'light', 'dark'];
const SCALES: readonly unknown[] = ['small', 'default', 'large'];
const READING_FONTS: readonly unknown[] = ['serif', 'sans'];

interface AppearanceBody {
  readingFont: unknown;
  readingTextSize: unknown;
  theme: unknown;
  uiScale: unknown;
}

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

function presetsOf(value: unknown): AppearanceBody {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('theme' in value) ||
    !('uiScale' in value) ||
    !('readingTextSize' in value) ||
    !('readingFont' in value)
  ) {
    return assert.fail('the read answers with every appearance preset');
  }
  return {
    readingFont: value.readingFont,
    readingTextSize: value.readingTextSize,
    theme: value.theme,
    uiScale: value.uiScale,
  };
}

test('partial appearance writes persist through the real route and preserve other configuration', async () => {
  writeAppConfigStrict({ appearance: { uiScale: 'large' }, updates: { autoCheck: false } });
  assert.equal(await put({ theme: 'dark', readingTextSize: 'small' }), 200);
  assert.deepEqual((await get()).body, {
    theme: 'dark', uiScale: 'large', readingTextSize: 'small', readingFont: 'serif',
  });
  const saved = readAppConfigStrict();
  assert.deepEqual(saved.updates, { autoCheck: false });
  for (const value of [[], { unknown: true }, { theme: 'light', unknown: true }]) {
    assert.equal(await put(value), 400);
    assert.deepEqual(readAppConfigStrict(), saved);
  }
  assert.deepEqual(normalizeAppearancePreferences({ theme: 'neon', uiScale: 'huge' }), {
    theme: 'system', uiScale: 'default', readingTextSize: 'default', readingFont: 'serif',
  });
});
test('a theme outside the three presets is refused rather than written', async () => {
  assert.equal(await put({ theme: 'midnight' }), 400);
});

test('an interface size outside the three presets is refused', async () => {
  assert.equal(await put({ uiScale: 'huge' }), 400);
});

test('a reading text size outside the three presets is refused', async () => {
  assert.equal(await put({ readingTextSize: 'tiny' }), 400);
});

test('a reading font outside its two presets is refused', async () => {
  assert.equal(await put({ readingFont: 'mono' }), 400);
});

test('a read answers with every preset inside its own allowed values', async () => {
  const read = await get();
  assert.equal(read.status, 200);
  const presets = presetsOf(read.body);
  assert.ok(THEMES.includes(presets.theme), `theme ${String(presets.theme)}`);
  assert.ok(SCALES.includes(presets.uiScale), `uiScale ${String(presets.uiScale)}`);
  assert.ok(
    SCALES.includes(presets.readingTextSize),
    `readingTextSize ${String(presets.readingTextSize)}`,
  );
  assert.ok(READING_FONTS.includes(presets.readingFont), `readingFont ${String(presets.readingFont)}`);
});
