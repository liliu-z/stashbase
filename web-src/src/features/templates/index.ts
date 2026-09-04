/** The Gallery — ready-made Wikis to download and open, rendered below a
 * blank Chat's hero composer (see design-docs/design/agent-panel.md for
 * the product contract). The index behind it is a GitHub-hosted file;
 * `gallery.ts` owns the snapshot-plus-fetch data story.
 *
 * The view is exported pre-wrapped in `lazyWithRetry`, the same shape the
 * agent panel gives `ChatPane`: the gallery is a surface many sessions
 * never show, so the barrel is what keeps it out of the initial chunk —
 * callers render it inside their own `LazyLoadBoundary`/`Suspense`.
 *
 * The barrel deliberately re-exports NOTHING from `gallery.ts`: the data
 * module (snapshot included) belongs to the lazy view chunk, and one
 * stray barrel export would drag it into every barrel consumer's chunk. */
import { lazyWithRetry } from '@/common/components/ErrorBoundary';

export const TemplatesView = lazyWithRetry(() =>
  import('@/features/templates/TemplatesView'));

// The app-root gate is only an event listener; everything heavier lives
// behind its own lazy edge (see GalleryOverlayGate.tsx).
export { GalleryOverlayGate } from '@/features/templates/GalleryOverlayGate';
