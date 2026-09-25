import type { AppearanceSurface } from '@/shared/domain/appearance';

/** Stamps the surface on the document root. `globals.css` declares
 *  `color-scheme` inside the `.light` and `.dark` rules themselves and leaves
 *  `:root { color-scheme: light dark }` as the system default, so neither
 *  class is the whole instruction for following the operating system. */
export function applyAppearanceSurface(surface: AppearanceSurface): void {
  const root = document.documentElement;
  root.classList.toggle('light', surface.themeClass === 'light');
  root.classList.toggle('dark', surface.themeClass === 'dark');
  root.dataset.uiScale = surface.uiScale;
  root.dataset.readingTextSize = surface.readingTextSize;
  root.dataset.readingFont = surface.readingFont;
}

let channel: BroadcastChannel | undefined;

function appearanceChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined;
  channel ??= new BroadcastChannel('stashbase-appearance');
  return channel;
}

/** Keeps the other open windows in step without adding appearance state to the
 *  server's per-window folder context. A `BroadcastChannel` never delivers to
 *  the context that posted, which is why the window making the change is the
 *  one that applies it here. */
export function publishAppearanceSurface(surface: AppearanceSurface): void {
  applyAppearanceSurface(surface);
  appearanceChannel()?.postMessage(surface);
}

export function subscribeToAppearanceSurface(
  apply: (surface: AppearanceSurface) => void,
): () => void {
  const current = appearanceChannel();
  if (!current) return () => {};
  const onMessage = (event: MessageEvent<AppearanceSurface>) => apply(event.data);
  current.addEventListener('message', onMessage);
  return () => current.removeEventListener('message', onMessage);
}
