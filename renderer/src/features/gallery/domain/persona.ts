import type { PersonaIconName } from '@/shared/domain/persona-icon';

/**
 * One ready-made persona as the shop reads it.
 *
 * Adding one copies it into the reader's library, which the Agent feature
 * owns; the Gallery only describes it. A field the gallery has not published
 * is `null`, so the page states the absence rather than rendering less.
 */
export interface GalleryPersona {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  /** Null reads as the default glyph. */
  readonly icon: PersonaIconName | null;
  /** The exact text an added persona gives the Agent. */
  readonly prompt: string;
  /** A real exchange under this persona, shown where a Wiki shows screenshots. */
  readonly sample: { readonly request: string; readonly reply: string } | null;
}
