/** How any surface summons the Gallery overlay — the sidebar's Gallery
 * row today, a band-level "View all" tomorrow. Mirrors
 * `embeddingSetupTrigger`: the overlay gate listens at the app root, and
 * the alternative is threading a callback down to lazily-loaded chrome.
 * The inline band under a bare window's blank chat needs NO trigger — it
 * derives from window state (no folder open). */

export const OPEN_GALLERY_EVENT = 'stashbase-open-gallery';

export function openGalleryOverlay(): void {
  window.dispatchEvent(new CustomEvent(OPEN_GALLERY_EVENT));
}
