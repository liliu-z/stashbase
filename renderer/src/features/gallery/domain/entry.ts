/** One project in the Gallery: its cover, introduction, and acquisition target. */
export interface GalleryEntry {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly about: string | null;
  readonly repo: string;
  /** Already pointed at the daemon proxy. */
  readonly screenshot: string | null;
}

/** Published values win; the bundled introduction and cover fill empty slots. */
export function enrichedFromSnapshot(
  entry: GalleryEntry,
  snapshot: readonly GalleryEntry[],
): GalleryEntry {
  const bundled = snapshot.find((candidate) => candidate.id === entry.id);
  if (!bundled) return entry;
  return {
    ...entry,
    about: entry.about ?? bundled.about,
    screenshot: entry.screenshot ?? bundled.screenshot,
  };
}
