import { Suspense } from 'react';
import { Dialog, DialogContent } from '@/common/components/ui/dialog';
import { lazyWithRetry } from '@/common/components/ErrorBoundary';

/** Own lazy edge, NOT the feature barrel: reaching the view through the
 *  barrel would couple this chunk to the gallery data module graph. */
const LazyTemplatesView = lazyWithRetry(() =>
  import('@/features/templates/TemplatesView'));

/** The Gallery overlay's body — everything heavier than the event
 *  listener lives here, behind the gate's lazy edge, so the Dialog
 *  primitive graph stays out of the initial chunk. */
export default function GalleryOverlay({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        aria-label="Gallery"
        className="inset-6 flex max-w-none translate-x-0 translate-y-0 flex-col overflow-y-auto rounded-xl border border-border bg-background p-0 text-foreground"
      >
        <Suspense
          fallback={(
            <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
              Loading the Gallery…
            </div>
          )}
        >
          <LazyTemplatesView heading="Gallery" />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}
