import { z } from 'zod';

import { DARK_THEME_IDS, LIGHT_THEME_IDS } from '../../appearance-themes';

export const appearanceThemeSchema = z.enum(['system', 'light', 'dark']);

export const appearanceScaleSchema = z.enum(['small', 'default', 'large']);

/** The two reading fonts StashBase ships for Markdown prose. */
export const readingFontSchema = z.enum(['serif', 'sans']);

/** A font family the reader chose from the fonts installed on their system.
 *  It is the one free-form appearance value, and it ends up inside a CSS
 *  `font-family` list, so anything that could close the quoted name or start
 *  another declaration is refused rather than escaped. */
export const fontFamilySchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[^"'`\\;:{}()<>[\]]+$/u)
  .refine((value) => !/\p{Cc}/u.test(value), 'control characters are not a font name');

/** A spellchecker language as Chromium names it (`en-US`, `pt-BR`, `fr`). */
export const spellcheckLanguageSchema = z
  .string()
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/u);

/** `GET /api/appearance` and the `PUT` echo. The response strips: an unknown
 *  key has no reader in this build, and carrying it forward is dead weight. */
export const appearancePreferencesSchema = z
  .object({
    theme: appearanceThemeSchema,
    lightTheme: z.enum(LIGHT_THEME_IDS),
    darkTheme: z.enum(DARK_THEME_IDS),
    uiScale: appearanceScaleSchema,
    readingTextSize: appearanceScaleSchema,
    readingFont: readingFontSchema,
    /** An installed font that overrides the reading font; null keeps the
     *  preset. The code font's null is the bundled Geist Mono. */
    writingFont: fontFamilySchema.nullable(),
    codeFont: fontFamilySchema.nullable(),
    lineSpacing: z.enum(['compact', 'default', 'relaxed']),
    lineWidth: z.enum(['narrow', 'default', 'wide', 'full']),
    reduceMotion: z.enum(['system', 'on']),
    spellcheck: z.boolean(),
    /** Null follows the system language. Ignored on macOS, whose checker
     *  detects the language itself. */
    spellcheckLanguage: spellcheckLanguageSchema.nullable(),
    focusMode: z.boolean(),
    typewriterScrolling: z.boolean(),
    wordCount: z.boolean(),
  })
  .strip();

/** The write is partial because one row's change is one field on the wire, and
 *  strict because it reaches durable configuration, so an unknown key is a
 *  caller mistake to refuse rather than a value to persist forever. */
export const appearancePreferencesRequestSchema = appearancePreferencesSchema
  .partial()
  .strict();

export const appearanceFailureSchema = z
  .object({ error: z.string().trim().min(1).max(500) })
  .passthrough();

export type AppearancePreferencesWire = z.infer<typeof appearancePreferencesSchema>;

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferencesWire = {
  theme: 'system',
  lightTheme: 'stashbase-light',
  darkTheme: 'stashbase-dark',
  uiScale: 'default',
  readingTextSize: 'default',
  readingFont: 'serif',
  writingFont: null,
  codeFont: null,
  lineSpacing: 'default',
  lineWidth: 'default',
  reduceMotion: 'system',
  spellcheck: true,
  spellcheckLanguage: null,
  focusMode: false,
  typewriterScrolling: false,
  wordCount: false,
};

/** Resolves stored preferences field by field, so one hand-edited or retired
 *  value falls back to its default without discarding the reader's others. */
export function normalizeAppearancePreferences(value: unknown): AppearancePreferencesWire {
  const raw: Record<string, unknown> =
    value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  const fields = appearancePreferencesSchema.shape;
  const resolved: Record<string, unknown> = {};
  for (const key of Object.keys(fields) as (keyof AppearancePreferencesWire)[]) {
    const parsed = fields[key].safeParse(raw[key]);
    resolved[key] = parsed.success ? parsed.data : DEFAULT_APPEARANCE_PREFERENCES[key];
  }
  return appearancePreferencesSchema.parse(resolved);
}
