import { z } from 'zod';

export const appearanceThemeSchema = z.enum(['system', 'light', 'dark']);

export const appearanceScaleSchema = z.enum(['small', 'default', 'large']);

export const readingFontSchema = z.enum(['serif', 'sans']);

/** `GET /api/appearance` and the `PUT` echo. The response strips: the renderer
 *  has exactly one reader per preset and each becomes state stamped on
 *  the document root, so an unknown key has no reader and carrying it forward
 *  is dead weight. */
export const appearancePreferencesSchema = z
  .object({
    readingFont: readingFontSchema,
    readingTextSize: appearanceScaleSchema,
    theme: appearanceThemeSchema,
    uiScale: appearanceScaleSchema,
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
