import type { SubscribeDocumentInput } from '@/features/documents/application/ports';

/** DOM input does not bubble out of an opaque iframe. Native input presence is
 * independent of document scripts; focus/hover scope it without reading content. */
export function listenForFrameInput(
  host: HTMLElement,
  subscribe: SubscribeDocumentInput,
  onRead: () => void,
): () => void {
  let pending: number | undefined;
  const cancelPending = () => {
    if (pending !== undefined) cancelAnimationFrame(pending);
    pending = undefined;
  };
  const release = subscribe((kind) => {
    cancelPending();
    // Opaque-frame focus can trail the native notification. Allow two rendering
    // opportunities, with a short expiry so later focus cannot replay old input.
    const expires = performance.now() + 250;
    let attempts = 2;
    const sample = () => {
      pending = undefined;
      const owner = host.ownerDocument;
      const focused = owner.activeElement;
      if (performance.now() > expires || owner.visibilityState !== 'visible') return;
      if (
        owner.hasFocus() &&
        focused instanceof HTMLIFrameElement &&
        host.contains(focused) &&
        (kind === 'keyboard' || focused.matches(':hover'))
      ) {
        onRead();
        return;
      }
      if (--attempts > 0) pending = requestAnimationFrame(sample);
    };
    pending = requestAnimationFrame(sample);
  });
  return () => {
    cancelPending();
    release();
  };
}
