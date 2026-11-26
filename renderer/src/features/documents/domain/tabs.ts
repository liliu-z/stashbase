/**
 * The open-tab set and the two kinds of tab in it.
 *
 * A kept tab stays until it is closed. A preview tab is the one a reader is
 * only looking at: there is at most one, and browsing to another source
 * reuses it in place rather than adding a tab beside it. A preview becomes a
 * kept tab when the reader asks for it to stay or edits it; a restored set is
 * kept tabs only, because a preview was never meant to outlive the look.
 */
import type { SourceReference } from '@/shared/domain/source-reference';

import { sameSource } from './document';

export interface DocumentTab {
  id: string;
  /** True while the tab is only a look at its source: the next browse
   *  replaces it, and it is left out of the saved session. */
  preview: boolean;
  source: SourceReference;
}

export interface DocumentTabsState {
  activeTabId: string | null;
  openRequest: SourceReference | null;
  openFailure: { source: SourceReference; message: string } | null;
  /** A close waiting on the reader, because the tab holds work that cannot be
   *  saved where it came from. Held here rather than in the strip so the X,
   *  the keyboard, and the close commands all ask the same question. */
  closeDecision: { source: SourceReference; tabId: string } | null;
  lifecycle: 'active' | 'disposed';
  tabs: DocumentTab[];
}

export interface RestoredDocumentTabs {
  activeTabId: string | null;
  tabs: Array<{ id: string; source: SourceReference }>;
}

/**
 * The one place `tabs` and `activeTabId` move together.
 *
 * The active tab is always a member of `tabs` or null. Every transition below
 * states which ids it would like active, in order of preference, and the first
 * that names a member wins; nothing else may assign either field, so the
 * invariant cannot be broken one call site at a time.
 */
function withTabs(
  state: DocumentTabsState,
  tabs: DocumentTab[],
  intended: ReadonlyArray<string | null>,
): DocumentTabsState {
  const activeTabId =
    intended.find((id) => id !== null && tabs.some((tab) => tab.id === id)) ?? null;
  return state.tabs === tabs && state.activeTabId === activeTabId
    ? state
    : { ...state, activeTabId, tabs };
}

export function createDocumentTabsState(
  restored: RestoredDocumentTabs | null = null,
): DocumentTabsState {
  const ids = new Set<string>();
  const sources: DocumentTab[] = [];
  const remappedIds = new Map<string, string>();

  for (const tab of restored?.tabs ?? []) {
    const matchingSource = sources.find((candidate) => sameSource(candidate.source, tab.source));
    if (matchingSource) {
      remappedIds.set(tab.id, matchingSource.id);
      continue;
    }
    if (ids.has(tab.id)) continue;
    ids.add(tab.id);
    // Only kept tabs are saved, so everything read back is a kept tab.
    sources.push({ id: tab.id, preview: false, source: { ...tab.source } });
  }

  const requestedActiveId = restored?.activeTabId ?? null;
  return withTabs(
    {
      activeTabId: null,
      closeDecision: null,
      openRequest: null,
      openFailure: null,
      lifecycle: 'active',
      tabs: [],
    },
    sources,
    [
      requestedActiveId,
      requestedActiveId === null ? null : (remappedIds.get(requestedActiveId) ?? null),
    ],
  );
}

/** The tab after (1) or before (-1) the one in front, wrapping at the ends,
 *  or null when there is no other tab to go to. */
export function adjacentDocumentTab(state: DocumentTabsState, step: 1 | -1): DocumentTab | null {
  const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  if (index < 0 || state.tabs.length < 2) return null;
  return state.tabs[(index + step + state.tabs.length) % state.tabs.length] ?? null;
}

/** The tab the reader is only looking at, if there is one. */
export function previewDocumentTab(state: DocumentTabsState): DocumentTab | null {
  return state.tabs.find((tab) => tab.preview) ?? null;
}

/**
 * Opens a source. One already open is activated, and kept if the open asked
 * for that. A new preview takes the standing preview's slot, so browsing
 * never piles up tabs; a new kept tab goes on the end.
 */
export function openDocumentTab(
  state: DocumentTabsState,
  tab: { id: string; source: SourceReference },
  preview: boolean,
): DocumentTabsState {
  if (state.lifecycle === 'disposed') return state;
  const existing = state.tabs.find((candidate) => sameSource(candidate.source, tab.source));
  if (existing) {
    const tabs =
      existing.preview && !preview
        ? state.tabs.map((candidate) =>
            candidate.id === existing.id ? { ...candidate, preview: false } : candidate,
          )
        : state.tabs;
    return withTabs(state, tabs, [existing.id]);
  }
  const opened: DocumentTab = {
    id: tab.id,
    preview,
    source: { ...tab.source },
  };
  const standing = preview ? previewDocumentTab(state) : null;
  const tabs = standing
    ? state.tabs.map((candidate) => (candidate.id === standing.id ? opened : candidate))
    : [...state.tabs, opened];
  return withTabs(state, tabs, [tab.id]);
}

/** Turns a preview into a kept tab. A kept tab stays as it is. */
export function keepDocumentTab(state: DocumentTabsState, tabId: string): DocumentTabsState {
  if (state.lifecycle === 'disposed') return state;
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  if (!tab || !tab.preview) return state;
  return {
    ...state,
    tabs: state.tabs.map((candidate) =>
      candidate.id === tabId ? { ...candidate, preview: false } : candidate,
    ),
  };
}

export function activateDocumentTab(state: DocumentTabsState, tabId: string): DocumentTabsState {
  if (state.lifecycle === 'disposed') return state;
  return withTabs(state, state.tabs, [tabId, state.activeTabId]);
}

export function closeDocumentTab(state: DocumentTabsState, tabId: string): DocumentTabsState {
  if (state.lifecycle === 'disposed') return state;
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  const neighbour = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
  const settled = clearDocumentCloseDecision(state, tabId);
  return withTabs(settled, tabs, [settled.activeTabId === tabId ? neighbour : settled.activeTabId]);
}

/**
 * Asks the reader before a close that would drop work. The tab stays open and
 * becomes the visible one, so the question and the draft it is about are on
 * screen together.
 */
export function requestDocumentClose(state: DocumentTabsState, tabId: string): DocumentTabsState {
  if (state.lifecycle === 'disposed') return state;
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return state;
  return withTabs({ ...state, closeDecision: { source: tab.source, tabId } }, state.tabs, [
    tabId,
    state.activeTabId,
  ]);
}

/** Drops a standing close question: the named tab's, or whichever stands. */
export function clearDocumentCloseDecision(
  state: DocumentTabsState,
  tabId?: string,
): DocumentTabsState {
  if (state.closeDecision === null) return state;
  if (tabId !== undefined && state.closeDecision.tabId !== tabId) return state;
  return { ...state, closeDecision: null };
}

export function disposeDocumentTabsState(state: DocumentTabsState): DocumentTabsState {
  return state.lifecycle === 'disposed' ? state : { ...state, lifecycle: 'disposed' };
}

/** Only kept tabs in this project are restored from saved files. */
export function documentTabsSession(state: DocumentTabsState, folderPath: string) {
  const tabs = state.tabs
    .filter((tab) => !tab.preview && tab.source.folderPath === folderPath)
    .map((tab) => ({ id: tab.id, path: tab.source.path }));
  return {
    activeTabId: tabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : null,
    tabs,
  };
}
