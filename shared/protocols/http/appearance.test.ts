import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  contrastRatio,
  DARK_THEME_IDS,
  darkThemeTokens,
  LIGHT_THEME_IDS,
  lightThemeTokens,
  THEME_TOKENS,
} from '../../appearance-themes.ts';
import {
  appearancePreferencesRequestSchema,
  appearancePreferencesSchema,
  DEFAULT_APPEARANCE_PREFERENCES,
} from './appearance.ts';

test('a response drops a preference this renderer has no reader for', () => {
  assert.deepEqual(
    appearancePreferencesSchema.parse({ ...DEFAULT_APPEARANCE_PREFERENCES, accentColour: 'teal' }),
    DEFAULT_APPEARANCE_PREFERENCES,
  );
});

test('a response missing a preference is refused', () => {
  const { wordCount: _dropped, ...partial } = DEFAULT_APPEARANCE_PREFERENCES;
  assert.equal(appearancePreferencesSchema.safeParse(partial).success, false);
});

test('a write carries the one field a row changed and refuses unknown keys', () => {
  assert.deepEqual(appearancePreferencesRequestSchema.parse({ uiScale: 'large' }), {
    uiScale: 'large',
  });
  assert.equal(
    appearancePreferencesRequestSchema.safeParse({ theme: 'light', rogue: 1 }).success,
    false,
  );
});

const surfaces = ['surface-1', 'surface-2', 'surface-3'] as const;

test('every theme keeps body and secondary text readable on its surfaces (WCAG AA)', () => {
  const themes = [
    ...LIGHT_THEME_IDS.map((id) => [id, lightThemeTokens(id)] as const),
    ...DARK_THEME_IDS.map((id) => [id, darkThemeTokens(id)] as const),
  ];
  for (const [id, tokens] of themes) {
    if (!tokens) continue;
    assert.deepEqual(Object.keys(tokens).sort(), [...THEME_TOKENS].sort(), id);
    for (const text of ['foreground', 'muted-foreground', 'prose-accent'] as const) {
      for (const surface of surfaces) {
        const ratio = contrastRatio(tokens[text], tokens[surface]);
        assert.ok(ratio >= 4.5, `${id}: ${text} on ${surface} is ${ratio.toFixed(2)}:1`);
      }
    }
    assert.ok(contrastRatio(tokens['muted-foreground'], tokens.muted) >= 4.5, `${id}: muted text`);
  }
});
