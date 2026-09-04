import { Suspense, useEffect, useState } from 'react';
import { lazyWithRetry } from '@/common/components/ErrorBoundary';
import { OPEN_GALLERY_EVENT } from '@/common/lib/galleryTrigger';

const LazyGalleryOverlay = lazyWithRetry(() =>
  import('@/features/templates/GalleryOverlay'));

/**
 * The Gallery as a summoned LAYER — a near-fullscreen dialog over the
 * workspace, raised by `openGalleryOverlay()` (the sidebar row).
 *
 * This is the shop's only form inside a folder window: the inline band
 * belongs to a bare window's blank chat (derived there, never flagged),
 * and a folder window must not lend a chat tab to a shop. A framed
 * layer keeps the explore feel — browse, take a copy, Esc back to work
 * — and the entry detail stacks above it as a second dialog.
 *
 * Mounted once at the app root, but the gate itself is only this event
 * listener: the dialog body, the Dialog primitive graph, and the
 * gallery view all live behind a lazy edge so the initial chunk carries
 * none of it (the same shape as `EmbedderRequireKeyGate`).
 */
export function GalleryOverlayGate() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onOpen() { setOpen(true); }
    window.addEventListener(OPEN_GALLERY_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_GALLERY_EVENT, onOpen);
  }, []);

  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <LazyGalleryOverlay onClose={() => setOpen(false)} />
    </Suspense>
  );
}
