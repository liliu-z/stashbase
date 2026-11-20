import { useCallback, useEffect, useState, type ReactNode } from 'react';

import {
  GalleryOverlay,
  GalleryShop,
  useGallery,
  type GalleryEntry,
  type GalleryPort,
} from '@/features/gallery/public';

export interface GalleryShopCommand {
  /** The shelf for the welcome screen. */
  band: ReactNode;
  /** Opens the shop while preserving the current workspace. */
  browse(): void;
  surfaces: ReactNode;
}

/** One catalog and copy operation shared by Welcome and the project sidebar. */
export function useGalleryShop(
  port: GalleryPort,
  copy: (entry: GalleryEntry) => void,
  pending: boolean,
  activePath: string | null,
): GalleryShopCommand {
  const [open, setOpen] = useState(false);
  const [entryId, setEntryId] = useState<string | null>(null);
  const gallery = useGallery(port);
  const entry = gallery.entries.find((candidate) => candidate.id === entryId) ?? null;
  useEffect(() => {
    if (activePath) {
      setOpen(false);
      setEntryId(null);
    }
  }, [activePath]);
  return {
    band: (
      <GalleryShop
        entries={gallery.entries}
        recovery={gallery.recovery}
        onOpen={(next) => {
          setEntryId(next.id);
          setOpen(true);
          gallery.recovery?.retry();
        }}
      />
    ),
    browse: useCallback(() => {
      setOpen(true);
      gallery.recovery?.retry();
    }, [gallery.recovery]),
    surfaces: (
      <GalleryOverlay
        copying={pending}
        entries={gallery.entries}
        entry={entry}
        recovery={gallery.recovery}
        unavailable={entryId !== null && entry === null}
        onBack={() => setEntryId(null)}
        onClose={() => {
          setOpen(false);
          setEntryId(null);
        }}
        onCopy={copy}
        onOpen={(next) => setEntryId(next.id)}
        open={open}
      />
    ),
  };
}
