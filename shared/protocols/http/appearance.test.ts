import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appearancePreferencesRequestSchema,
  appearancePreferencesSchema,
} from './appearance.ts';

test('the response carries every preset the server applied', () => {
  assert.deepEqual(
    appearancePreferencesSchema.parse({
      readingFont: 'serif',
      readingTextSize: 'large',
      theme: 'dark',
      uiScale: 'small',
    }),
    { readingFont: 'serif', readingTextSize: 'large', theme: 'dark', uiScale: 'small' },
  );
});

test('a response drops a preference this renderer has no reader for', () => {
  assert.deepEqual(
    appearancePreferencesSchema.parse({
      readingFont: 'sans',
      readingTextSize: 'default',
      theme: 'system',
      uiScale: 'default',
      accentColour: 'teal',
    }),
    { readingFont: 'sans', readingTextSize: 'default', theme: 'system', uiScale: 'default' },
  );
});

test('a response missing a preference is refused', () => {
  assert.equal(
    appearancePreferencesSchema.safeParse({ theme: 'light', uiScale: 'default' }).success,
    false,
  );
});

test('a write refuses an unknown key rather than persisting it', () => {
  assert.equal(
    appearancePreferencesRequestSchema.safeParse({ theme: 'light', rogue: 1 }).success,
    false,
  );
});

test('a write refuses a value outside the preset ramp', () => {
  assert.equal(appearancePreferencesRequestSchema.safeParse({ theme: 'sepia' }).success, false);
  assert.equal(
    appearancePreferencesRequestSchema.safeParse({ uiScale: 'medium' }).success,
    false,
  );
});

test('a write carries the one field a row changed', () => {
  assert.deepEqual(appearancePreferencesRequestSchema.parse({ uiScale: 'large' }), {
    uiScale: 'large',
  });
});
