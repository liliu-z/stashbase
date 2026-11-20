/** A ready-made project's detail replaces the shelf inside one Gallery frame. */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { GalleryEntry } from '@/features/gallery/domain/entry';
import { FailureLine } from '@/shared/ui/failure-notice';

import { GalleryEntryPage } from './detail';
import { GalleryIndexRecovery, type GalleryRecovery } from './index-recovery';
import { GalleryShop } from './shop';

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
}) {
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open={open}>
      <DialogContent
        className="@container flex h-[min(86vh,46rem)] max-w-[min(94vw,80rem)] flex-col"
        width="wide"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>Gallery</DialogTitle>
          <DialogDescription>Find ideas for your own workflow.</DialogDescription>
        </DialogHeader>
        <GalleryIndexRecovery recovery={recovery} />
        {unavailable && (
          <FailureLine tone="capability">
            This project is no longer in the Gallery. Choose another project below.
          </FailureLine>
        )}
        {entry ? (
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
