/**
 * The rows the tree renders, and the row the window asks it to bring into
 * view.
 *
 * The tree renders its rows a page at a time. A reveal is the document in
 * front of the reader: the store has already selected its row and opened the
 * folders above it, and the request waits there until the row can be shown.
 * A listing that has not arrived, or does not list the file yet, holds it; a
 * row past the rendered page extends the page; a tree hidden behind another
 * panel has nothing to scroll and keeps it until it is laid out again.
 */
import { useEffect, useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import { useStore } from 'zustand';

import type { WorkspaceRuntime } from '@/features/workspace/application/runtime';
import type { TreeRow } from '@/features/workspace/domain/tree';
import { clearTreeReveal } from '@/features/workspace/domain/workspace';

const TREE_PAGE_SIZE = 240;
const NOTHING_OPENED: readonly string[] = [];

export function useTreePage(
  runtime: WorkspaceRuntime,
  rows: readonly TreeRow[],
  treeElement: RefObject<HTMLElement | null>,
) {
  const [limit, setLimit] = useState(TREE_PAGE_SIZE);
  /** Bumped when a row waiting behind another panel is laid out again. */
  const [laidOut, setLaidOut] = useState(0);
  const reveal = useStore(runtime.store, (state) => state.pendingReveal);
  const renderedRows = useMemo(() => rows.slice(0, limit), [limit, rows]);

  useEffect(() => setLimit(TREE_PAGE_SIZE), [runtime.scope.generation]);

  useLayoutEffect(() => {
    if (!reveal) return;
    const index = rows.findIndex((row) => row.node.path === reveal.path);
    if (index < 0) return;
    if (index >= limit) {
      setLimit(Math.ceil((index + 1) / TREE_PAGE_SIZE) * TREE_PAGE_SIZE);
      return;
    }
    const element = Array.from(
      treeElement.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
    ).find((row) => row.dataset.path === reveal.path);
    if (!element) return;
    if (element.getClientRects().length > 0) {
      runtime.store.setState(clearTreeReveal);
      element.scrollIntoView({ block: 'nearest' });
      return;
    }
    // The observer reports the hidden row once on observing it, at no size;
    // only a size of its own means the tree is on screen again.
    const observer = new ResizeObserver((entries) => {
      if (entries.some((entry) => entry.contentRect.height > 0)) setLaidOut((count) => count + 1);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [laidOut, limit, reveal, rows, runtime, treeElement]);

  return {
    /** How many rows the next page adds. */
    more: Math.min(TREE_PAGE_SIZE, rows.length - renderedRows.length),
    /** The folders a pending reveal opened, which appear at once rather than
     *  easing open, so the row already stands where the scroll lands. */
    opened: reveal?.opened ?? NOTHING_OPENED,
    renderedRows,
    showMore: () => setLimit((current) => current + TREE_PAGE_SIZE),
  };
}
