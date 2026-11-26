import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * Whether the open tabs need more room than the strip gives them, and so the
 * list of all open tabs beside them.
 *
 * The list's trigger takes its width from the same row the tabs live in, so
 * the room is what the tabs have plus what the trigger holds while it shows.
 * Measured on the tabs' box alone, the trigger would keep itself shown by
 * narrowing the tabs, and one width would show or hide it depending on
 * whether the pane got there from narrower or wider.
 *
 * Read when the tab list resizes and when the tabs change, since a tab added
 * to a list already at its widest changes what it holds, not its box.
 */
export function useTabOverflow(watch: unknown) {
  const [overflowing, setOverflowing] = useState(false);
  const list = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback(() => {
    const node = list.current;
    if (!node) return setOverflowing(false);
    const room = node.clientWidth + (trigger.current?.offsetWidth ?? 0);
    setOverflowing(node.scrollWidth > room + 1);
  }, []);
  const listRef = useCallback(
    (node: HTMLDivElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      list.current = node;
      if (!node) return;
      measure();
      if (typeof ResizeObserver === 'undefined') return;
      observer.current = new ResizeObserver(measure);
      observer.current.observe(node);
    },
    [measure],
  );
  const triggerRef = useCallback((node: HTMLElement | null) => {
    trigger.current = node;
  }, []);
  useLayoutEffect(measure, [measure, watch]);
  return { listRef, overflowing, triggerRef };
}
