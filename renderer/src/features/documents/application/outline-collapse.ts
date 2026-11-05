/**
 * Collapsed outline sections, kept per tab. Navigation holds them rather than
 * the outline component, so they survive the outline unmounting while its
 * sidebar tab is hidden and a round trip between documents.
 */
const NONE: ReadonlySet<string> = new Set();

export interface OutlineCollapse {
  /** The tab's collapsed sections; none for a tab that has collapsed nothing. */
  of(tabId: string | null): ReadonlySet<string>;
  /** Keeps only the sections the tab's outline still has. */
  prune(tabId: string, headings: Iterable<{ id: string }>): ReadonlySet<string>;
  toggle(tabId: string, headingId: string): ReadonlySet<string>;
  forget(tabId: string): void;
  clear(): void;
}

export function createOutlineCollapse(): OutlineCollapse {
  const byTab = new Map<string, ReadonlySet<string>>();
  const of = (tabId: string | null) => (tabId === null ? NONE : (byTab.get(tabId) ?? NONE));
  return {
    of,
    prune(tabId, headings) {
      const current = of(tabId);
      const ids = new Set(Array.from(headings, (heading) => heading.id));
      const kept = [...current].filter((id) => ids.has(id));
      if (kept.length === current.size) return current;
      const next = new Set(kept);
      byTab.set(tabId, next);
      return next;
    },
    toggle(tabId, headingId) {
      const next = new Set(of(tabId));
      if (!next.delete(headingId)) next.add(headingId);
      byTab.set(tabId, next);
      return next;
    },
    forget(tabId) {
      byTab.delete(tabId);
    },
    clear() {
      byTab.clear();
    },
  };
}
