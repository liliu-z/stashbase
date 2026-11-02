/** Following a growing log: it keeps to the newest output until the reader
 *  scrolls toward the start, telling the reader's own gestures apart from the
 *  scrolling that output and layout cause. */
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

import { prefersReducedMotion } from '@/shared/runtime/appearance-surface';

/** Distance from the end that still counts as reading the latest. */
const NEAR_END_PX = 50;
/** How long after a glide output that lands keeps gliding instead of jumping. */
const SETTLE_MS = 2_000;
/** How long a reader's gesture explains the scroll events that follow it. */
const INTENT_MS = 300;
const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);
const DOWN_KEYS = new Set(['ArrowDown', 'PageDown', 'End']);
// A field takes these keys itself; a button also takes Space.
const OWNS_KEYS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const OWNS_SPACE = `button, [role="button"], ${OWNS_KEYS}`;

function distanceToEnd(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

function glide(element: HTMLElement) {
  if (prefersReducedMotion(element.ownerDocument.defaultView)) {
    element.scrollTop = element.scrollHeight;
  } else element.scrollTo({ behavior: 'smooth', top: element.scrollHeight });
}

/** A nested scroll area under the gesture moves itself, not the container. */
function innerAreaScrolls(target: EventTarget | null, container: HTMLElement, up: boolean) {
  const view = container.ownerDocument.defaultView;
  let node = view && target instanceof view.Element ? target : null;
  while (node && node !== container) {
    if (node.scrollHeight > node.clientHeight + 1) {
      const overflow = view?.getComputedStyle(node).overflowY;
      const movable = up
        ? node.scrollTop > 0
        : node.scrollTop + node.clientHeight < node.scrollHeight - 1;
      if ((overflow === 'auto' || overflow === 'scroll') && movable) return true;
    }
    node = node.parentElement;
  }
  return false;
}

/** Keeps a scroll container at its end until the reader scrolls toward the
 *  start. Only the reader's own gesture (wheel, touch, keys, scrollbar) leaves
 *  the end, so output that lands or moves never strands them; a gesture back
 *  to the end follows again. A new `key` (another conversation) opens at the
 *  end. `followLatest` resumes following for the reader's own send: from far
 *  up it glides, including output landing meanwhile. `isFollowing` reads that
 *  same state, and `pauseFollowing` preserves a deliberately expanded section. */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, key: string) {
  const away = useRef(false);
  // When the last glide began; output landing soon after continues it.
  const settling = useRef<number | null>(null);
  const followLatest = useCallback(() => {
    const element = ref.current;
    away.current = false;
    if (!element) return;
    if (distanceToEnd(element) >= NEAR_END_PX) {
      settling.current = Date.now();
      glide(element);
    } else element.scrollTop = element.scrollHeight;
  }, [ref]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    away.current = false;
    settling.current = null;
    element.scrollTop = element.scrollHeight;
    let lastTop = element.scrollTop;
    let lastHeight = element.scrollHeight;
    let intent: 'up' | 'down' | null = null;
    let intentAt = 0;
    let touchY: number | null = null;

    const follow = () => {
      const since = settling.current;
      settling.current = null;
      if (away.current) return;
      if (
        since !== null &&
        Date.now() - since < SETTLE_MS &&
        distanceToEnd(element) >= NEAR_END_PX
      ) {
        settling.current = Date.now();
        glide(element);
      } else element.scrollTop = element.scrollHeight;
    };
    const intend = (up: boolean) => {
      if (up && element.scrollTop <= 0) return;
      intent = up ? 'up' : 'down';
      intentAt = Date.now();
      if (up) away.current = true;
      else if (distanceToEnd(element) < NEAR_END_PX) away.current = false;
    };
    const gesture = (target: EventTarget | null, up: boolean) => {
      if (!innerAreaScrolls(target, element, up)) intend(up);
    };

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.shiftKey) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      gesture(event.target, event.deltaY < 0);
    };
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y === undefined || touchY === null || y === touchY) return;
      // A finger moving down drags the content toward its start.
      const up = y > touchY;
      touchY = y;
      gesture(event.target, up);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const view = element.ownerDocument.defaultView;
      const target = view && event.target instanceof view.Element ? event.target : null;
      if (target?.closest(event.key === ' ' ? OWNS_SPACE : OWNS_KEYS)) return;
      if (event.key === ' ') gesture(event.target, event.shiftKey);
      else if (UP_KEYS.has(event.key)) gesture(event.target, true);
      else if (DOWN_KEYS.has(event.key)) gesture(event.target, false);
    };
    // A scroll with no gesture behind it is a scrollbar drag, a clamp, or the
    // browser holding the reader's place while output grows above it.
    const onScroll = () => {
      const top = element.scrollTop;
      const grew = element.scrollHeight - lastHeight;
      const recent = Date.now() - intentAt < INTENT_MS ? intent : null;
      const anchored = recent === null && grew > 0 && Math.abs(top - lastTop - grew) <= 1;
      const atEnd = distanceToEnd(element) <= 1;
      const movedUp = top < lastTop;
      const movedDown = top > lastTop;
      lastTop = top;
      lastHeight = element.scrollHeight;
      intent = null;
      if (movedUp) {
        // Content shrinking under the reader clamps them up; they did not leave.
        if (grew < 0 && !atEnd && recent !== 'up') return;
        away.current = !atEnd || recent === 'up';
      } else if (
        movedDown &&
        distanceToEnd(element) < NEAR_END_PX &&
        recent !== 'up' &&
        !anchored
      ) {
        away.current = false;
      }
    };
    const onScrollEnd = () => {
      if (settling.current !== null) follow();
    };

    element.addEventListener('wheel', onWheel, { passive: true });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: true });
    element.addEventListener('keydown', onKeyDown);
    element.addEventListener('scroll', onScroll, { passive: true });
    element.addEventListener('scrollend', onScrollEnd, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(follow);
    observer?.observe(element);
    for (const child of element.children) observer?.observe(child);
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('keydown', onKeyDown);
      element.removeEventListener('scroll', onScroll);
      element.removeEventListener('scrollend', onScrollEnd);
      observer?.disconnect();
    };
  }, [key, ref]);
  const isFollowing = useCallback(() => !away.current, []);
  const pauseFollowing = useCallback(() => {
    away.current = true;
  }, []);
  return { followLatest, isFollowing, pauseFollowing };
}
