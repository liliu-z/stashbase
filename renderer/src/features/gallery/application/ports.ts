import type { GalleryEntry } from '@/features/gallery/domain/entry';

/** One published catalog of ready-made projects. */
export interface GalleryIndex {
  readonly wikis: readonly GalleryEntry[];
}

/** Project acquisition belongs to Workspace. */
export interface GalleryPort {
  loadIndex(signal: AbortSignal): Promise<GalleryIndex | null>;
}
