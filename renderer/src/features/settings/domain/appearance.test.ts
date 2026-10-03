import { describe, expect, it } from 'vite-plus/test';

import { PRESET_ROWS, presetChange, spellcheckLanguageLabel } from './appearance';

describe('presetChange', () => {
  it('accepts every value its own row names', () => {
    for (const row of Object.values(PRESET_ROWS)) {
      for (const choice of row.choices) {
        expect(presetChange(row, choice.value)).toEqual({ [row.field]: choice.value });
      }
    }
  });

  it('refuses a value that belongs to a different row or to none', () => {
    expect(presetChange(PRESET_ROWS.theme, 'small')).toBeNull();
    expect(presetChange(PRESET_ROWS.lineWidth, 'relaxed')).toBeNull();
    expect(presetChange(PRESET_ROWS.reduceMotion, 'off')).toBeNull();
    expect(presetChange(PRESET_ROWS.uiScale, '')).toBeNull();
  });
});

describe('spellcheckLanguageLabel', () => {
  it('names a language and keeps a code it cannot name', () => {
    expect(spellcheckLanguageLabel('en-US')).toBe('English (United States)');
    expect(spellcheckLanguageLabel('zz-invalid-!')).toBe('zz-invalid-!');
  });
});
