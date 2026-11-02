/** When a page loading behind the shown one may take its place. */
import { useEffect, useMemo, useRef, type RefObject } from 'react';

export interface ScrollPosition {
  x: number;
  y: number;
}

/** Counts the page's data loads, so its first view includes its data. */
export interface PageLoadObserver {
  started(): void;
  settled(): void;
}

/** A page asks for its data within a few frames of the ready signal. */
const SETTLE_MS = 80;
/** A covered frame may not paint, so it cannot always confirm its scroll. */
const RESTORE_MS = 250;
/** A page still loading after this is shown as it is rather than holding the old one. */
const CAP_MS = 3_000;

let nextRestore = 0;

export function scrollPosition(message: Record<string, unknown>): ScrollPosition | null {
  const { x, y } = message;
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)
    ? { x, y }
    : null;
}

/**
 * Calls `onReady` once the page has loaded, its data requests are answered,
 * and the reading position in `scrollRef` is restored, or after a cap. Without
 * `onReady` the page is shown as it loads.
 */
export function usePageReady(
  frame: RefObject<HTMLIFrameElement | null>,
  onReady: (() => void) | undefined,
  scrollRef: RefObject<ScrollPosition | null> | undefined,
): { loaded(): void; requests: PageLoadObserver } {
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const gate = useRef<{ loaded(): void; started(): void; settled(): void } | null>(null);
  const waits = onReady !== undefined;

  useEffect(() => {
    if (!waits) return;
    const id = ++nextRestore;
    let done = false;
    let loaded = false;
    let pending = 0;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let restore: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      done = true;
      clearTimeout(settle);
      clearTimeout(restore);
      clearTimeout(cap);
      globalThis.removeEventListener('message', receive);
    };
    const finish = () => {
      if (done) return;
      stop();
      onReadyRef.current?.();
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const message = event.data as { reqId?: unknown; type?: unknown } | null;
      if (message?.type === 'stashbase-scroll-restored' && message.reqId === id) finish();
    };
    const restoreScroll = () => {
      const position = scrollRef?.current;
      const target = frame.current?.contentWindow;
      if (!target || !position || (position.x === 0 && position.y === 0)) {
        finish();
        return;
      }
      target.postMessage({ reqId: id, type: 'stashbase-scroll-restore', ...position }, '*');
      restore = setTimeout(finish, RESTORE_MS);
    };
    const check = () => {
      clearTimeout(settle);
      if (!done && loaded && pending === 0) settle = setTimeout(restoreScroll, SETTLE_MS);
    };
    const cap = setTimeout(finish, CAP_MS);
    globalThis.addEventListener('message', receive);
    gate.current = {
      loaded() {
        loaded = true;
        check();
      },
      started() {
        pending++;
        clearTimeout(settle);
      },
      settled() {
        pending = Math.max(0, pending - 1);
        check();
      },
    };
    return () => {
      stop();
      gate.current = null;
    };
  }, [frame, scrollRef, waits]);

  return useMemo(
    () => ({
      loaded: () => gate.current?.loaded(),
      requests: {
        started: () => gate.current?.started(),
        settled: () => gate.current?.settled(),
      },
    }),
    [],
  );
}
