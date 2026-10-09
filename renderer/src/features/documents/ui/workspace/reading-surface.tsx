import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useStore } from 'zustand';

import type { DocumentRuntime } from '@/features/documents/application/document-runtime';
import type { DocumentHistoryRuntime } from '@/features/documents/application/history-runtime';

// Sandboxed HTML owns its own viewport; it deliberately exposes no DOM to us.
const scrollerSelector = '.cm-scroller, .milkdown, [data-document-scroller]';

/** Retain the reader's viewport even when a bounded viewer unmounts. History
 * receives the same position, so replaced previews can return to it too. */
export function DocumentReadingSurface({
  runtime,
  history,
  active,
  children,
  onRead,
}: {
  runtime: DocumentRuntime;
  history: DocumentHistoryRuntime;
  active: boolean;
  onRead?: (() => void) | undefined;
  children: ReactNode;
}) {
  const request = useStore(runtime.store, (state) => state.readingRequest);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = root.current;
    if (!host || !active) return;
    let desired = runtime.readingPosition;
    const restore = () => {
      if (!desired) return;
      const scroller = host.querySelector<HTMLElement>(scrollerSelector);
      if (!scroller) return;
      scroller.scrollTop = desired.top;
      scroller.scrollLeft = desired.left;
    };
    const remember = (event: Event) => {
      const scroller = event.target;
      if (!(scroller instanceof HTMLElement) || !scroller.matches(scrollerSelector)) return;
      // Ignore layout clamping while the viewer is still loading.
      if (
        desired &&
        scroller.scrollTop !== desired.top &&
        scroller.scrollHeight - scroller.clientHeight < desired.top
      )
        return;
      desired = null;
      runtime.readingPosition = { top: scroller.scrollTop, left: scroller.scrollLeft };
      history.remember(runtime.scope.source, runtime.readingPosition);
    };
    const interact = (event: Event) => {
      desired = null;
      if (
        event.isTrusted &&
        host.ownerDocument.visibilityState === 'visible' &&
        host.ownerDocument.hasFocus()
      )
        onRead?.();
    };
    const observer = new MutationObserver(restore);
    const resize = new ResizeObserver(restore);
    observer.observe(host, { childList: true, subtree: true });
    resize.observe(host);
    host.addEventListener('scroll', remember, true);
    host.addEventListener('wheel', interact, { passive: true });
    host.addEventListener('pointerdown', interact);
    host.addEventListener('keydown', interact);
    restore();
    return () => {
      observer.disconnect();
      resize.disconnect();
      host.removeEventListener('scroll', remember, true);
      host.removeEventListener('wheel', interact);
      host.removeEventListener('pointerdown', interact);
      host.removeEventListener('keydown', interact);
    };
  }, [active, history, onRead, request, runtime]);
  return (
    <div className="flex min-h-0 flex-1 flex-col" ref={root}>
      {children}
    </div>
  );
}
