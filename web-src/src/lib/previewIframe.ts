/**
 * Click forwarding for the same-origin (`sandbox=allow-same-origin`)
 * preview iframes: in-iframe `<img>` / `<a>` clicks are forwarded to the
 * host (image lightbox / in-app nav / external open) via `postMessage`.
 */

/** Click handler for a preview iframe's document: a clicked image opens
 *  the shared lightbox; a clicked link forwards to in-app nav (relative
 *  notes) or external open (`http(s)`). Other schemes fall through.
 *
 *  Duck-types the target instead of `instanceof Element` because events
 *  fired inside the iframe carry elements from the iframe's separate JS
 *  realm (the parent's `Element` constructor won't match even with
 *  `allow-same-origin`). */
export function previewClickHandler(e: Event, currentPath?: string): void {
  const target = e.target as (Element & { closest?: typeof Element.prototype.closest }) | null;
  if (!target || typeof target.closest !== 'function') return;
  const img = target.closest('img') as HTMLImageElement | null;
  if (img) {
    const src = img.currentSrc || img.src;
    if (!src) return;
    e.preventDefault();
    window.postMessage({ type: 'stashbase-preview-image', src, alt: img.alt || '' }, window.location.origin);
    return;
  }
  const anchor = target.closest('a') as HTMLAnchorElement | null;
  if (anchor) forwardAnchorClick(anchor, e, currentPath);
}

function forwardAnchorClick(anchor: HTMLAnchorElement, e: Event, currentPath?: string): void {
  const raw = anchor.getAttribute('href');
  if (!raw) return;
  if (raw.startsWith('#')) {
    const hash = raw.slice(1);
    if (!currentPath || !hash) return; // in-doc anchor without app context → let iframe handle it
    e.preventDefault();
    // The app owns scrolling for same-file navigation, but preserve the
    // iframe's native fragment state so :target styles and URL semantics work.
    const iframeWindow = anchor.ownerDocument.defaultView;
    if (iframeWindow) iframeWindow.location.hash = hash;
    window.postMessage({ type: 'stashbase-nav', path: currentPath, anchor: hash }, window.location.origin);
    return;
  }
  // `anchor.href` is browser-resolved against the iframe's `<base>`.
  let url: URL;
  try { url = new URL(anchor.href, window.location.href); } catch { return; }
  if (url.origin === window.location.origin && url.pathname.startsWith('/asset/')) {
    let decoded: { path: string; folder?: string };
    try { decoded = decodeAssetPathname(url.pathname); } catch { return; }
    if (/\.(md|markdown|html|htm)$/i.test(decoded.path)) {
      // Notes navigate in-app; a `__folder/` token keeps the target inside
      // an out-of-folder document's own member folder.
      e.preventDefault();
      const hash = url.hash.startsWith('#') ? url.hash.slice(1) : '';
      window.postMessage({
        type: 'stashbase-nav',
        path: decoded.path,
        folder: decoded.folder,
        anchor: hash || undefined,
      }, window.location.origin);
      return;
    }
    // Non-note assets (recording webm, PDFs, images linked explicitly)
    // open in the system browser — the same-origin /asset/ URL streams
    // from our local server, and the browser can play/preview formats the
    // in-app viewers don't (notably MediaRecorder webm, which lacks the
    // header duration an inline <video> needs). Without this they'd fall
    // through and navigate the app shell away from the workspace.
    e.preventDefault();
    window.postMessage({ type: 'stashbase-open-external', href: url.href }, window.location.origin);
    return;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    e.preventDefault();
    window.postMessage({ type: 'stashbase-open-external', href: url.href }, window.location.origin);
  }
}

function decodeAssetPathname(pathname: string): { path: string; folder?: string } {
  let encoded = pathname.slice('/asset/'.length);
  if (encoded.startsWith('__window/')) {
    const slash = encoded.indexOf('/', '__window/'.length);
    encoded = slash >= 0 ? encoded.slice(slash + 1) : '';
  }
  let folder: string | undefined;
  if (encoded.startsWith('__folder/')) {
    const slash = encoded.indexOf('/', '__folder/'.length);
    if (slash >= 0) {
      // Double-encoded in the URL: one decode here, one for the author's.
      folder = decodeURIComponent(decodeURIComponent(encoded.slice('__folder/'.length, slash)));
      encoded = encoded.slice(slash + 1);
    }
  }
  return { path: encoded.split('/').map(decodeURIComponent).join('/'), folder };
}
