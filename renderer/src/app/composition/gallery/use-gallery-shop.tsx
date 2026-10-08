import { useCallback, useEffect, useState, type ReactNode } from 'react';

import {
  GalleryOverlay,
  GalleryShop,
  useGallery,
  type GalleryEntry,
  type GalleryPersona,
  type GalleryPort,
  type GallerySection,
} from '@/features/gallery/public';

export interface GalleryShopCommand {
  /** The shelf on its own, for a surface that holds the shop inline rather
   *  than opening it over what is already there. */
  band: ReactNode;
  /** Puts the shop on screen. The window keeps whatever it was showing. */
  browse(): void;
  /** Puts the personas shop on screen, for the composer's picker. It shares
   *  the Gallery's catalog and frame but not its name or shelf. */
  browsePersonas(): void;
  /** The shop and the entry page it opens, rendered by the shell. */
  surfaces: ReactNode;
}

/**
 * The one shop this window can open, and everything it needs to run.
 *
 * Two entrances reach this same command. The bare window derives the band on
 * its welcome screen, and a folder window offers a sidebar row. One shop means
 * one index and one copy in flight rather than a second shop per surface. A
 * band card opens that entry's page directly, where the sidebar row opens the
 * shelf.
 *
 */
export interface GalleryPersonaLibrary {
  /** Gallery ids already in the reader's library. */
  readonly added: ReadonlySet<string>;
  /** Copies a Gallery persona into the library; answers whether it landed. */
  add(persona: GalleryPersona): Promise<boolean>;
}

export function useGalleryShop(
  port: GalleryPort,
  copy: (entry: GalleryEntry) => void,
  pending: boolean,
  activePath: string | null,
  library: GalleryPersonaLibrary,
): GalleryShopCommand {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<GallerySection>('projects');
  const [entryId, setEntryId] = useState<string | null>(null);
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const gallery = useGallery(port);
  const entry = gallery.entries.find((candidate) => candidate.id === entryId) ?? null;
  const persona = gallery.personas.find((candidate) => candidate.id === personaId) ?? null;
  useEffect(() => {
    if (activePath) {
      setOpen(false);
      setEntryId(null);
      setPersonaId(null);
    }
  }, [activePath]);
  const add = async (next: GalleryPersona) => {
    if (adding) return;
    setAdding(true);
    try {
      await library.add(next);
    } finally {
      setAdding(false);
    }
  };

  return {
    band: (
      <GalleryShop
        entries={gallery.entries}
        recovery={gallery.recovery}
        onOpen={(next) => {
          setSection('projects');
          setEntryId(next.id);
          setOpen(true);
          gallery.recovery?.retry();
        }}
      />
    ),
    browse: useCallback(() => {
      setSection('projects');
      setOpen(true);
      gallery.recovery?.retry();
    }, [gallery.recovery]),
    browsePersonas: useCallback(() => {
      setSection('personas');
      setPersonaId(null);
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
        onBack={() => {
          setEntryId(null);
          setPersonaId(null);
        }}
        onClose={() => {
          setOpen(false);
          // Closing the shop ends the visit: reopening starts at the shelf
          // rather than on whichever entry was last read.
          setEntryId(null);
          setPersonaId(null);
        }}
        onCopy={copy}
        onOpen={(next) => setEntryId(next.id)}
        open={open}
        personas={{
          added: library.added,
          adding,
          onAdd: (next) => void add(next),
          onOpen: (next) => setPersonaId(next.id),
          persona,
          personas: gallery.personas,
        }}
        section={section}
      />
    ),
  };
}
