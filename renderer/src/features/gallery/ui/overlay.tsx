/** The Gallery overlay, and the personas shop that shares its catalog and frame. */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { GalleryEntry } from '@/features/gallery/domain/entry';
import type { GalleryPersona } from '@/features/gallery/domain/persona';
import { FailureLine } from '@/shared/ui/failure-notice';

import { GalleryEntryPage } from './detail';
import { GalleryIndexRecovery, type GalleryRecovery } from './index-recovery';
import { GalleryPersonaCard } from './persona-card';
import { GalleryPersonaPage } from './persona-page';
import { GalleryShop } from './shop';

/** Which shop the overlay holds. The entrance decides and the reader never
 *  switches inside it: the sidebar's Gallery is ready-made projects, and the
 *  persona picker's Browse personas is ready-made personas. Mixing the two
 *  under one name read as if personas were template projects. */
export type GallerySection = 'projects' | 'personas';

const HEADERS: Record<GallerySection, { title: string; description: string }> = {
  personas: {
    description: 'Ready-made voices for the Agent. Add one, then edit it like your own.',
    title: 'Personas',
  },
  projects: {
    description:
      'Explore how people organize files and write with agents. Find ideas for your own workflow.',
    title: 'Gallery',
  },
};

/** The personas the shop offers, and what adding one needs. Adding belongs to
 *  the reader's library, which another feature owns, so the composition
 *  layer supplies it. */
export interface GalleryPersonaShelf {
  personas: readonly GalleryPersona[];
  /** The open persona page, or null for the shelf. */
  persona: GalleryPersona | null;
  /** Gallery ids already in the reader's library. */
  added: ReadonlySet<string>;
  adding: boolean;
  onOpen(persona: GalleryPersona): void;
  onAdd(persona: GalleryPersona): void;
}

/**
 * The shop, and the entry page it opens inside itself.
 *
 * An overlay rather than a route: the window keeps the folder it was showing,
 * and closing puts the reader back exactly where they were. Copying uses the
 * shared project-entry flow, which decides whether to reuse or open a window.
 *
 * The entry page replaces the shelf rather than stacking a second modal over
 * it: one dismiss target for one decision, and one way home, which the page
 * draws on its own action row so this header reads the same over the shelf
 * and over a page.
 */
export function GalleryOverlay({
  copying,
  entries,
  entry,
  recovery = null,
  unavailable = false,
  onBack,
  onClose,
  onCopy,
  onOpen,
  open,
  personas,
  section,
}: {
  copying: boolean;
  entries: readonly GalleryEntry[];
  entry: GalleryEntry | null;
  recovery?: GalleryRecovery | null;
  unavailable?: boolean;
  onBack(): void;
  onClose(): void;
  onCopy(entry: GalleryEntry): void;
  onOpen(entry: GalleryEntry): void;
  open: boolean;
  personas: GalleryPersonaShelf;
  section: GallerySection;
}) {
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open={open}>
      {/* A shop, not a question: it takes the window the way a page does,
       * capped so a wide display does not stretch a shelf into a horizon.
       * One steady frame across both views, because the reader navigates
       * inside it and a dialog that resizes under a click reads as a jump. */}
      {/* A column, explicitly: the dialog primitive is a block, so without
       * this the header and the page below it simply stack and a long entry
       * walks out of the frame instead of scrolling inside it. */}
      <DialogContent
        className="@container flex h-[min(86vh,46rem)] max-w-[min(94vw,80rem)] flex-col"
        width="wide"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{HEADERS[section].title}</DialogTitle>
          <DialogDescription>{HEADERS[section].description}</DialogDescription>
        </DialogHeader>
        <GalleryIndexRecovery recovery={recovery} />
        {section === 'projects' && unavailable && (
          <FailureLine tone="capability">
            This project is no longer in the Gallery. Choose another project below.
          </FailureLine>
        )}
        {section === 'personas' ? (
          personas.persona ? (
            <GalleryPersonaPage
              key={personas.persona.id}
              added={personas.added.has(personas.persona.id)}
              adding={personas.adding}
              onAdd={personas.onAdd}
              onBack={onBack}
              persona={personas.persona}
            />
          ) : (
            <div className="@container min-h-0 flex-1 overflow-y-auto">
              <div className="grid grid-cols-1 gap-4 @xs:grid-cols-2 @md:grid-cols-3 @5xl:grid-cols-4">
                {personas.personas.map((persona) => (
                  <GalleryPersonaCard
                    added={personas.added.has(persona.id)}
                    key={persona.id}
                    onOpen={personas.onOpen}
                    persona={persona}
                  />
                ))}
              </div>
            </div>
          )
        ) : entry ? (
          <GalleryEntryPage
            key={entry.id}
            copying={copying}
            entry={entry}
            onBack={onBack}
            onCopy={onCopy}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <GalleryShop entries={entries} onOpen={onOpen} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
