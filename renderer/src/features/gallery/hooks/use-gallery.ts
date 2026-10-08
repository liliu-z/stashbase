import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import type { GalleryPort } from '@/features/gallery/application/ports';
import { enrichedFromSnapshot, type GalleryEntry } from '@/features/gallery/domain/entry';
import type { GalleryPersona } from '@/features/gallery/domain/persona';
import { GALLERY_PERSONA_SNAPSHOT } from '@/features/gallery/domain/persona-snapshot';
import { GALLERY_SNAPSHOT } from '@/features/gallery/domain/snapshot';

const GALLERY_QUERY_KEY = ['gallery', 'index'] as const;

export interface GalleryView {
  entries: readonly GalleryEntry[];
  personas: readonly GalleryPersona[];
  bundled: boolean;
  recovery: { pending: boolean; retry(): void } | null;
}

/**
 * The freshest index this window can offer.
 *
 * Paint the bundled catalog until a publication is available. Successful data
 * stays fresh for the session; failure remains retryable on reconnect or entry.
 */
export function useGallery(port: Pick<GalleryPort, 'loadIndex'>): GalleryView {
  // Fetched once and kept: the gallery is browsed, not watched. No initial
  // data, because seeding the cache with the snapshot would mark the query
  // fresh and the published index would never be asked for.
  const query = useQuery({
    gcTime: Infinity,
    queryFn: async ({ signal }) => {
      const index = await port.loadIndex(signal);
      if (index === null) throw new Error('The Gallery catalog is unavailable.');
      return index;
    },
    queryKey: GALLERY_QUERY_KEY,
    retry: false,
    staleTime: Infinity,
  });

  const entries = useMemo(
    () =>
      query.data?.wikis.map((entry) => enrichedFromSnapshot(entry, GALLERY_SNAPSHOT)) ??
      GALLERY_SNAPSHOT,
    [query.data],
  );
  return {
    entries,
    personas: query.data?.personas ?? GALLERY_PERSONA_SNAPSHOT,
    bundled: query.data === undefined,
    recovery:
      query.isError || query.isPaused
        ? {
            pending: query.isFetching || query.isPaused,
            retry: () => {
              void query.refetch();
            },
          }
        : null,
  };
}
