/**
 * The active document's Find and outline authority.
 *
 * Exactly one viewer owns Find at a time: it claims the controller while it is
 * on screen and releases it on unmount, so a stale controller from a hidden
 * tab can never answer a query. Outline publication follows the same claim.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';

import type {
  DocumentSearchPurpose,
  DocumentSearchTarget,
  FindOptions,
} from '@/features/documents/domain/location';
import type { DocumentHeading } from '@/features/documents/domain/outline';

export type { FindOptions };

export interface FindMatchInfo {
  current: number;
  total: number;
}

export interface DocumentFindController {
  close(): void;
  next(): FindMatchInfo | Promise<FindMatchInfo>;
  previous(): FindMatchInfo | Promise<FindMatchInfo>;
  restoreQuery?(query: string, options: FindOptions): FindMatchInfo | Promise<FindMatchInfo>;
  setQuery(query: string, options: FindOptions): FindMatchInfo | Promise<FindMatchInfo>;
}

interface DocumentFindState extends FindOptions, FindMatchInfo {
  available: boolean;
  focusRevision: number;
  open: boolean;
  query: string;
}

interface DocumentOutlineState {
  activeId: string | null;
  available: boolean;
  headings: DocumentHeading[];
}

interface PendingDocumentAnchor {
  id: string;
  tabId: string;
}

interface DocumentNavigationState {
  searchNotice: string | null;
  /** The purpose of the last requested search, for notices the viewer adds. */
  searchPurpose: DocumentSearchPurpose;
  outlineFailed: boolean;
  find: DocumentFindState;
  outline: DocumentOutlineState;
  pendingAnchor: PendingDocumentAnchor | null;
}

export interface DocumentNavigationRuntime {
  readonly store: StoreApi<DocumentNavigationState>;
  activate(tabId: string | null): void;
  dismissSearchNotice(): void;
  setOutlineFailed(tabId: string, failed: boolean): void;
  claimFind(tabId: string, owner: symbol, controller: DocumentFindController): () => void;
  claimOutline(tabId: string, owner: symbol): () => void;
  /** Closes Find; answers whether it was open. */
  closeFind(): boolean;
  consumeAnchor(tabId: string, id: string): void;
  dispose(): void;
  /** Steps Find forward; answers whether Find was open to take the step. */
  findNext(): boolean;
  /** Steps Find backward; answers whether Find was open to take the step. */
  findPrevious(): boolean;
  openFind(): boolean;
  publishOutline(
    tabId: string,
    owner: symbol,
    outline: Omit<DocumentOutlineState, 'available'>,
    select: (heading: DocumentHeading) => void,
  ): void;
  requestAnchor(tabId: string, id: string): void;
  requestSearch(tabId: string, target: DocumentSearchTarget): void;
  selectHeading(heading: DocumentHeading): void;
  setFindCaseSensitive(value: boolean): void;
  setFindQuery(query: string): void;
  setFindWholeWord(value: boolean): void;
}

interface SearchNotices {
  locating: string;
  missing: string;
  failed: string;
  /** Shown instead of any notice when the open preview has no Find. */
  unavailable: string;
}

export const SEARCH_NOTICES: Readonly<Record<DocumentSearchPurpose, SearchNotices>> = {
  match: {
    locating: 'The file is open. Locating the search result in this preview…',
    missing: 'This search match could not be located. The source may have changed.',
    failed: 'The search match could not be located in this preview.',
    unavailable: 'This preview cannot locate search matches.',
  },
  passage: {
    locating: 'The file is open. Locating the passage…',
    missing: 'This passage could not be found. The file may have changed.',
    failed: 'The passage could not be located in this preview.',
    unavailable: 'This preview cannot locate passages.',
  },
};

const emptyOutline = (): DocumentOutlineState => ({
  activeId: null,
  available: false,
  headings: [],
});

export function createDocumentNavigationRuntime(
  initialActiveTabId: string | null,
): DocumentNavigationRuntime {
  const store = createStore<DocumentNavigationState>(() => ({
    searchNotice: null,
    searchPurpose: 'match',
    outlineFailed: false,
    find: {
      available: false,
      caseSensitive: false,
      current: 0,
      focusRevision: 0,
      open: false,
      query: '',
      total: 0,
      wholeWord: false,
    },
    outline: emptyOutline(),
    pendingAnchor: null,
  }));
  let activeTabId = initialActiveTabId;
  let disposed = false;
  let findController: DocumentFindController | null = null;
  let findOwner: symbol | null = null;
  let outlineOwner: symbol | null = null;
  let outlineSelect: ((heading: DocumentHeading) => void) | null = null;
  let requestSequence = 0;
  let pendingSearch: { tabId: string; target: DocumentSearchTarget } | null = null;

  const updateFind = (patch: Partial<DocumentFindState>) => {
    store.setState((state) => ({
      ...state,
      find: { ...state.find, ...patch },
    }));
  };

  const applyMatch = (pending: FindMatchInfo | Promise<FindMatchInfo>) => {
    const sequence = ++requestSequence;
    const expectedController = findController;
    void Promise.resolve(pending)
      .then((match) => {
        if (disposed || sequence !== requestSequence || findController !== expectedController)
          return;
        updateFind({ current: match.current, total: match.total });
      })
      .catch(() => {
        if (disposed || sequence !== requestSequence || findController !== expectedController)
          return;
        updateFind({ current: 0, total: 0 });
      });
  };

  const runQuery = (restore: boolean) => {
    const controller = findController;
    if (!controller) {
      updateFind({ current: 0, total: 0 });
      return;
    }
    const { caseSensitive, query, wholeWord } = store.getState().find;
    const command =
      restore && controller.restoreQuery ? controller.restoreQuery : controller.setQuery;
    applyMatch(command.call(controller, query, { caseSensitive, wholeWord }));
  };

  const deliverSearch = () => {
    const pending = pendingSearch;
    const controller = findController;
    if (!pending || !controller || pending.tabId !== activeTabId) return;
    pendingSearch = null;
    const sequence = ++requestSequence;
    const { caseSensitive, occurrenceIndex, query, wholeWord } = pending.target;
    const notices = SEARCH_NOTICES[pending.target.purpose ?? 'match'];
    updateFind({
      caseSensitive,
      current: 0,
      open: false,
      query,
      total: 0,
      wholeWord,
    });
    void Promise.resolve(controller.setQuery(query, { caseSensitive, wholeWord }))
      .then(async (initial) => {
        if (disposed || sequence !== requestSequence || findController !== controller) return;
        if (initial.total === 0 || occurrenceIndex >= initial.total) {
          updateFind(initial);
          store.setState({ searchNotice: notices.missing });
          return;
        }
        store.setState({ searchNotice: null });
        let match = initial;
        const steps = Math.min(Math.max(0, occurrenceIndex), Math.max(0, initial.total - 1));
        for (let index = 0; index < steps; index += 1) {
          match = await controller.next();
          if (disposed || sequence !== requestSequence || findController !== controller) return;
        }
        if (disposed || sequence !== requestSequence || findController !== controller) return;
        updateFind(match);
      })
      .catch(() => {
        if (disposed || sequence !== requestSequence || findController !== controller) return;
        updateFind({ current: 0, total: 0 });
        store.setState({ searchNotice: notices.failed });
      });
  };

  const clearFindOwner = () => {
    requestSequence += 1;
    findController?.close();
    findController = null;
    findOwner = null;
    updateFind({ available: false, current: 0, total: 0 });
  };

  const clearOutlineOwner = () => {
    outlineOwner = null;
    outlineSelect = null;
    store.setState((state) => ({ ...state, outline: emptyOutline() }));
  };

  return {
    store,
    dismissSearchNotice() {
      store.setState({ searchNotice: null });
    },
    setOutlineFailed(tabId, failed) {
      if (!disposed && tabId === activeTabId) store.setState({ outlineFailed: failed });
    },
    activate(tabId) {
      if (disposed || tabId === activeTabId) return;
      activeTabId = tabId;
      store.setState({ searchNotice: null, outlineFailed: false });
      clearFindOwner();
      clearOutlineOwner();
      pendingSearch = null;
      store.setState((state) => ({ ...state, pendingAnchor: null }));
    },
    claimFind(tabId, owner, controller) {
      if (disposed || tabId !== activeTabId) return () => undefined;
      if (findOwner !== owner || findController !== controller) clearFindOwner();
      findOwner = owner;
      findController = controller;
      updateFind({ available: true });
      const { open, query } = store.getState().find;
      if (pendingSearch?.tabId === tabId) deliverSearch();
      else if (open && query) runQuery(true);
      return () => {
        if (findOwner !== owner) return;
        clearFindOwner();
      };
    },
    claimOutline(tabId, owner) {
      if (disposed || tabId !== activeTabId) return () => undefined;
      outlineOwner = owner;
      outlineSelect = null;
      store.setState((state) => ({
        ...state,
        outline: { activeId: null, available: true, headings: [] },
      }));
      return () => {
        if (outlineOwner !== owner) return;
        clearOutlineOwner();
      };
    },
    closeFind() {
      if (disposed) return false;
      const wasOpen = store.getState().find.open;
      requestSequence += 1;
      findController?.close();
      updateFind({ current: 0, open: false, total: 0 });
      return wasOpen;
    },
    consumeAnchor(tabId, id) {
      if (disposed) return;
      store.setState((state) =>
        state.pendingAnchor?.tabId === tabId && state.pendingAnchor.id === id
          ? { ...state, pendingAnchor: null }
          : state,
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearFindOwner();
      clearOutlineOwner();
      activeTabId = null;
      pendingSearch = null;
      store.setState((state) => ({ ...state, pendingAnchor: null }));
    },
    findNext() {
      if (disposed || !store.getState().find.open) return false;
      if (findController) applyMatch(findController.next());
      return true;
    },
    findPrevious() {
      if (disposed || !store.getState().find.open) return false;
      if (findController) applyMatch(findController.previous());
      return true;
    },
    openFind() {
      if (disposed || !findController) return false;
      const state = store.getState().find;
      updateFind({ focusRevision: state.focusRevision + 1, open: true });
      if (state.query) runQuery(true);
      return true;
    },
    publishOutline(tabId, owner, outline, select) {
      if (disposed || tabId !== activeTabId || outlineOwner !== owner) return;
      outlineSelect = select;
      store.setState((state) => ({
        ...state,
        outline: { ...outline, available: true },
      }));
    },
    requestAnchor(tabId, id) {
      if (disposed || tabId !== activeTabId || !id) return;
      store.setState((state) => ({ ...state, pendingAnchor: { id, tabId } }));
    },
    requestSearch(tabId, target) {
      if (
        disposed ||
        tabId !== activeTabId ||
        !target.query ||
        !Number.isSafeInteger(target.occurrenceIndex) ||
        target.occurrenceIndex < 0
      ) {
        return;
      }
      const purpose = target.purpose ?? 'match';
      store.setState({ searchNotice: SEARCH_NOTICES[purpose].locating, searchPurpose: purpose });
      pendingSearch = { tabId, target: { ...target } };
      deliverSearch();
    },
    selectHeading(heading) {
      if (!disposed) outlineSelect?.(heading);
    },
    setFindCaseSensitive(value) {
      if (disposed) return;
      updateFind({ caseSensitive: value });
      runQuery(false);
    },
    setFindQuery(query) {
      if (disposed) return;
      updateFind({ query });
      runQuery(false);
    },
    setFindWholeWord(value) {
      if (disposed) return;
      updateFind({ wholeWord: value });
      runQuery(false);
    },
  };
}
