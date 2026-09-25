import { describe, expect, it } from 'vite-plus/test';

import {
  APPEARANCE_ROWS,
  appearanceChange,
  appearanceSurface,
  type AppearanceField,
} from './appearance';

const FIELDS: readonly AppearanceField[] = ['theme', 'uiScale', 'readingTextSize', 'readingFont'];

describe('appearanceChange', () => {
  it('accepts every value its own field names', () => {
    for (const row of APPEARANCE_ROWS) {
      for (const choice of row.choices) {
        expect(appearanceChange(row.field, choice.value)).toEqual({
          [row.field]: choice.value,
        });
      }
    }
  });

  it('refuses a value that belongs to a different field', () => {
    expect(appearanceChange('theme', 'small')).toBeNull();
    expect(appearanceChange('uiScale', 'dark')).toBeNull();
    expect(appearanceChange('readingTextSize', 'system')).toBeNull();
    expect(appearanceChange('readingFont', 'default')).toBeNull();
  });

  it('refuses a value no field names', () => {
    for (const field of FIELDS) {
      expect(appearanceChange(field, '')).toBeNull();
      expect(appearanceChange(field, 'sepia')).toBeNull();
      expect(appearanceChange(field, 'DEFAULT')).toBeNull();
    }
  });
});

describe('appearanceSurface', () => {
  it('drops the theme class only when the system decides', () => {
    const scales = { uiScale: 'small', readingTextSize: 'large', readingFont: 'serif' } as const;

    expect(appearanceSurface({ theme: 'system', ...scales }).themeClass).toBeNull();
    expect(appearanceSurface({ theme: 'light', ...scales }).themeClass).toBe('light');
    expect(appearanceSurface({ theme: 'dark', ...scales }).themeClass).toBe('dark');
  });

  it('carries both scales and the reading font through untouched', () => {
    expect(
      appearanceSurface({
        theme: 'dark',
        uiScale: 'large',
        readingTextSize: 'small',
        readingFont: 'sans',
      }),
    ).toEqual({
      themeClass: 'dark',
      uiScale: 'large',
      readingTextSize: 'small',
      readingFont: 'sans',
    });
  });
});
