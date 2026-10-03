import { z } from 'zod';

import { fontFamilySchema, spellcheckLanguageSchema } from '../http/appearance';

export const TEXT_SERVICES_CAPABILITY = 'text.services';
export const TEXT_SERVICES_FONTS_CHANNEL = 'text-services:fonts';
export const TEXT_SERVICES_SPELLCHECK_LANGUAGES_CHANNEL = 'text-services:spellcheck-languages';

const failureSchema = z
  .object({ ok: z.literal(false), error: z.string().trim().min(1).max(500) })
  .strict();

/** The font families installed on this computer, as the operating system
 *  names them. Only names Settings could store are listed. They never leave
 *  the device. */
export const systemFontsResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), families: z.array(fontFamilySchema).max(10_000) }).strict(),
  failureSchema,
]);

/** Languages the spellchecker can check. Empty on macOS, whose checker picks
 *  the language itself. */
export const spellcheckLanguagesResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), languages: z.array(spellcheckLanguageSchema).max(500) }).strict(),
  failureSchema,
]);

export type SystemFontsResponse = z.infer<typeof systemFontsResponseSchema>;
export type SpellcheckLanguagesResponse = z.infer<typeof spellcheckLanguagesResponseSchema>;
