import { z } from 'zod';

import { appearancePreferencesSchema } from '../http/appearance';

export const WINDOW_LIFECYCLE_CAPABILITY = 'window.lifecycle';
export const WINDOW_PREPARE_CONTEXT_RELEASE_CHANNEL = 'window:prepare-context-release';
export const WINDOW_CONTEXT_RELEASE_READY_CHANNEL = 'window:context-release-ready';
export const WINDOW_FULLSCREEN_CHANNEL = 'window:fullscreen';
export const WINDOW_APPEARANCE_CHANNEL = 'window:appearance';

export const windowContextReleaseReasonSchema = z.enum([
  'window-close',
  'update-install',
]);

export const windowContextReleaseRequestSchema = z
  .object({
    reason: windowContextReleaseReasonSchema,
    requestId: z.string().trim().min(1).max(128),
  })
  .strict();

export const windowContextReleaseReadySchema = windowContextReleaseRequestSchema
  .extend({ ready: z.boolean() })
  .strict();

export const windowContextReleaseResponseSchema = z
  .object({ ok: z.literal(true) })
  .strict();

/** Main to renderer: whether the window is in native fullscreen, sent on every
 *  change and once the document has loaded. The shell lays itself out around
 *  the platform's own chrome, which fullscreen hides. */
export const windowFullScreenSchema = z.object({ fullscreen: z.boolean() }).strict();

/** Renderer to main: the appearance this window applied. Main owns what the
 *  stylesheet cannot reach (native menus, dialogs, form controls, the
 *  window's own background, and the spellchecker) and remembers the record so
 *  the next window paints it before its Settings read returns. */
export const windowAppearanceSchema = appearancePreferencesSchema.strict();

export const windowAppearanceResponseSchema = z.object({ ok: z.literal(true) }).strict();

export type WindowAppearance = z.infer<typeof windowAppearanceSchema>;
export type WindowContextReleaseReason = z.infer<typeof windowContextReleaseReasonSchema>;
