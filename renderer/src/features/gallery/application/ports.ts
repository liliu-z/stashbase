import type { GalleryEntry } from '@/features/gallery/domain/entry';
import type { GalleryPersona } from '@/features/gallery/domain/persona';

/** One published index: the Wikis, and the personas when it publishes them.
 *  Null personas means the index predates them, so the bundled ones stand. */
export interface GalleryIndex {
  readonly wikis: readonly GalleryEntry[];
  readonly personas: readonly GalleryPersona[] | null;
}

/** The Gallery supplies examples; project acquisition belongs to Workspace,
 *  and a persona's library belongs to the Agent. */
export interface GalleryPort {
  loadIndex(signal: AbortSignal): Promise<GalleryIndex | null>;
}
