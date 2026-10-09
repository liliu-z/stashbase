/** Own the open set, serialize releases and mutations, and retain navigation independently of saves. */
import { createStore } from 'zustand/vanilla';

import {
  createDocumentRuntime,
  type DocumentRuntime,
} from '@/features/documents/application/document-runtime';
import { isDocumentDirty, sourceIdentity } from '@/features/documents/domain/document';
import type { DocumentVisit } from '@/features/documents/domain/history';
import type { DocumentLocation } from '@/features/documents/domain/location';
import {
  activateDocumentTab,
  clearDocumentCloseDecision,
  createDocumentTabsState,
  disposeDocumentTabsState,
  documentTabsSession,
  keepDocumentTab,
  openDocumentTab,
  previewDocumentTab,
  type DocumentTabsState,
} from '@/features/documents/domain/tabs';
import type { SourceReference } from '@/shared/domain/source-reference';
import { createScopeGuard } from '@/shared/runtime/scope-guard';

import {
  askAboutDraft,
  closeDecidedTab,
  dropSettledTab,
  isDetachedDraft,
  mutateOpenSources,
  type DraftSettlementContext,
} from './draft-settlement';
import { createDocumentHistoryRuntime } from './history-runtime';
import { createDocumentNavigationRuntime } from './navigation-runtime';
import type {
  DocumentOpenOptions,
  DocumentTabsRuntime,
  DocumentTabsRuntimeOptions,
  DocumentTabsScope,
} from './tabs-contract';

export type { DocumentOpenOptions, DocumentTabsRuntime, DocumentTabsRuntimeOptions };

export function createDocumentTabsRuntime({
  api,
  prepare,
  createId,
  createQueries,
  folderPath,
  generation,
  restored = null,
  recordUsage,
}: DocumentTabsRuntimeOptions): DocumentTabsRuntime {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Document tabs generation must be a positive safe integer.');
  }
  if (folderPath.trim().length === 0) {
    throw new Error('Document tabs folder path must not be empty.');
  }

  const scope: DocumentTabsScope = Object.freeze({ folderPath, generation });
  const controller = new AbortController();
  const initialState = createDocumentTabsState(restored);
  const store = createStore<DocumentTabsState>(() => initialState);
  const navigation = createDocumentNavigationRuntime(initialState.activeTabId);
  const history = createDocumentHistoryRuntime();
  const documents = new Map<string, DocumentRuntime>();
  const sourceIds = new Map<string, string>();
  const editWatches = new Map<string, () => void>();
  let nextDocumentGeneration = 0;
  let disposed = false;
  const uncertainMutations = new Set<string>();
  let sourcesCache: { tabs: unknown; sources: readonly SourceReference[] } = {
    sources: [],
    tabs: null,
  };
  let preparing: ReturnType<typeof createQueries> | null = null;
  let retryOpen: (() => Promise<DocumentRuntime | null>) | null = null;
  let transitionTail: Promise<void> = Promise.resolve();

  const guard = createScopeGuard<DocumentTabsScope>({
    disposed: () => disposed,
    sameScope: (captured, live) =>
      captured.generation === live.generation && captured.folderPath === live.folderPath,
    scope: () => scope,
  });

  function enqueueTransition<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = transitionTail.then(operation, operation);
    transitionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  const saveDocuments = async (items: Iterable<DocumentRuntime>): Promise<boolean> => {
    for (const document of items) {
      if (!(await document.save(api))) {
        store.setState((state) => activateDocumentTab(state, document.scope.id));
        navigation.activate(document.scope.id);
        return false;
      }
    }
    return true;
  };

  const keep = (tabId: string): boolean => {
    if (!documents.has(tabId)) return false;
    store.setState((current) => keepDocumentTab(current, tabId));
    return true;
  };

  const createChild = (id: string, source: SourceReference) => {
    const childGeneration = ++nextDocumentGeneration;
    const childScope = { generation: childGeneration, id, source };
    const runtime = createDocumentRuntime({
      api,
      activeFolderPath: folderPath,
      generation: childGeneration,
      id,
      queries: createQueries(childScope),
      recordUsage,
      source,
    });
    documents.set(id, runtime);
    sourceIds.set(sourceIdentity(source), id);

    editWatches.set(
      id,
      runtime.store.subscribe((state) => {
        if (state.editor && isDocumentDirty(state.editor)) keep(id);
      }),
    );
    return runtime;
  };

  const retireChild = (id: string) => {
    const document = documents.get(id);
    if (!document) return;
    editWatches.get(id)?.();
    editWatches.delete(id);
    document.dispose();
    documents.delete(id);
    sourceIds.delete(sourceIdentity(document.scope.source));
  };

  const requestDocumentLocation = (document: DocumentRuntime, options: DocumentLocation) => {
    if (options.scroll) {
      document.readingPosition = options.scroll;
      document.store.setState((state) => ({ ...state, readingRequest: state.readingRequest + 1 }));
    } else if (options.anchor || options.search) document.readingPosition = null;
    if (options.anchor) navigation.requestAnchor(document.scope.id, options.anchor);
    if (!options.search) return;
    navigation.requestSearch(document.scope.id, options.search);
  };

  const openSource = (
    source: SourceReference,
    identity: string,
    options: DocumentOpenOptions,
    record: boolean,
    preparedId?: string,
  ): DocumentRuntime | null => {
    const preview = options.preview === true;
    const existingId = sourceIds.get(identity);
    if (existingId !== undefined) {
      const existing = documents.get(existingId) ?? null;
      if (existing) {
        store.setState((current) => openDocumentTab(current, { id: existingId, source }, preview));
        navigation.activate(existingId);
        requestDocumentLocation(existing, options);
        if (record) history.record({ source, ...options });
        guard.retireOperations();
      }
      return existing;
    }
    const id = preparedId ?? createId();
    if (id.trim().length === 0 || documents.has(id)) {
      throw new Error('Document tab IDs must be non-empty and unique.');
    }

    const standing = preview ? previewDocumentTab(store.getState()) : null;
    const standingEditor = standing ? documents.get(standing.id)?.store.getState().editor : null;
    if (standing && standingEditor && isDocumentDirty(standingEditor)) keep(standing.id);
    const replaced = preview ? previewDocumentTab(store.getState()) : null;
    const document = createChild(id, source);
    store.setState((current) => openDocumentTab(current, { id, source }, preview));
    if (replaced) retireChild(replaced.id);
    navigation.activate(id);
    requestDocumentLocation(document, options);
    if (record) history.record({ source, ...options });
    guard.retireOperations();
    return document;
  };

  const openTransition = async (
    source: SourceReference,
    options: DocumentOpenOptions,
    record: boolean,
  ): Promise<DocumentRuntime | null> => {
    if (disposed) return null;
    store.setState({ openRequest: { ...source } });
    const identity = sourceIdentity(source);
    const openedId = sourceIds.get(identity);
    const captured = guard.capture();
    let preparedId: string | undefined;
    if (openedId === undefined && prepare) {
      preparedId = createId();
      const candidate = { generation: nextDocumentGeneration + 1, id: preparedId, source };
      const candidateQueries = createQueries(candidate);
      preparing = candidateQueries;
      const message = await prepare(candidate);
      if (preparing === candidateQueries) preparing = null;
      if (!guard.accept(captured, () => undefined)) {
        createQueries(candidate).remove();
        return null;
      }
      if (message) {
        createQueries(candidate).remove();
        retryOpen = () => openTransition(source, options, record);
        store.setState((state) => ({ ...state, openFailure: { source, message } }));
        return null;
      }
    }
    store.setState((state) => ({ ...state, openFailure: null }));
    let opened: DocumentRuntime | null = null;
    guard.accept(captured, () => {
      opened = openSource(source, identity, options, record, preparedId);
    });
    return opened;
  };

  const stepHistory = (
    visit: () => DocumentVisit | null,
    step: () => void,
  ): Promise<DocumentRuntime | null> =>
    enqueueTransition(async () => {
      const target = visit();
      if (!target) return null;
      const opened = await openTransition(target.source, { ...target, preview: true }, false);
      if (opened) step();
      return opened;
    });

  for (const tab of initialState.tabs) createChild(tab.id, tab.source);

  const settlement: DraftSettlementContext = {
    createQueries,
    disposed: () => disposed,
    documents,
    folderPath,
    history,
    keep,
    navigation,
    retireChild,
    retireOperations: () => guard.retireOperations(),
    saveDocuments,
    sourceIds,
    store,
    uncertainMutations,
  };

  const restoredActive = initialState.tabs.find((tab) => tab.id === initialState.activeTabId);
  if (restoredActive) history.record({ source: restoredActive.source });

  const runtime: DocumentTabsRuntime = {
    history,
    navigation,
    scope,
    signal: controller.signal,
    store,
    activeSource() {
      const { activeTabId, tabs } = store.getState();
      return tabs.find((tab) => tab.id === activeTabId)?.source ?? null;
    },
    accept: guard.accept,
    activate(tabId) {
      return enqueueTransition(async () => {
        const tab = store.getState().tabs.find((candidate) => candidate.id === tabId);
        if (disposed || !tab) return false;
        if (store.getState().activeTabId === tabId) return true;
        return (
          openSource(tab.source, sourceIdentity(tab.source), { preview: tab.preview }, true) !==
          null
        );
      });
    },
    back: () => stepHistory(history.previous, history.stepBack),
    capture: guard.capture,
    closeActive() {
      const activeTabId = store.getState().activeTabId;
      return activeTabId === null ? Promise.resolve(false) : runtime.close(activeTabId);
    },
    closeSource(source) {
      const tabId = sourceIds.get(sourceIdentity(source));
      return tabId === undefined ? Promise.resolve(false) : runtime.close(tabId);
    },
    close(tabId) {
      return enqueueTransition(async () => {
        if (disposed) return false;
        const document = documents.get(tabId);
        const captured = guard.capture();
        if (!document || document.store.getState().mutationPending) return false;
        // A draft with no file cannot be settled by saving it, so the barrier
        // below would refuse this close forever. Ask instead of doing nothing.
        if (isDetachedDraft(document)) return askAboutDraft(settlement, tabId);
        if (!(await document.save(api))) return false;
        let closed = false;
        guard.accept(captured, () => {
          if (documents.get(tabId) !== document) return;
          dropSettledTab(settlement, tabId);
          closed = true;
        });
        return closed;
      });
    },
    retryOpen() {
      return enqueueTransition(() => retryOpen?.() ?? Promise.resolve(null));
    },
    dismissOpenFailure() {
      store.setState((state) => ({ ...state, openFailure: null }));
    },
    closeWithoutSaving() {
      return enqueueTransition(async () => closeDecidedTab(settlement));
    },
    dismissCloseDecision() {
      store.setState((state) => clearDocumentCloseDecision(state));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      guard.retireOperations();
      controller.abort();
      void preparing?.cancel();
      preparing?.remove();
      preparing = null;

      for (const id of documents.keys()) retireChild(id);
      navigation.dispose();
      store.setState(disposeDocumentTabsState);
    },
    flush() {
      return enqueueTransition(async () => {
        if (disposed || uncertainMutations.size) return false;
        // Quitting or leaving the project cannot settle such a draft either,
        // so the release is refused with the question rather than in silence.
        // Both exits are then on screen: the document's own restore, or the
        // close that drops the draft.
        const detached = [...documents.values()].find(isDetachedDraft);
        if (detached) return askAboutDraft(settlement, detached.scope.id);
        return saveDocuments([...documents.values()]);
      });
    },
    mutate(path, operation) {
      return enqueueTransition(() => mutateOpenSources(settlement, path, operation));
    },
    forward: () => stepHistory(history.next, history.stepForward),
    getDocument: (tabId) => documents.get(tabId) ?? null,
    hasDocuments() {
      return store.getState().tabs.length > 0 || store.getState().openFailure !== null;
    },
    keep,
    openSources() {
      const { tabs } = store.getState();
      if (sourcesCache.tabs !== tabs) {
        sourcesCache = { sources: tabs.map((tab) => tab.source), tabs };
      }
      return sourcesCache.sources;
    },
    subscribe: store.subscribe,
    open(source, options = {}) {
      return enqueueTransition(() => openTransition(source, options, true));
    },
    toSession: () => documentTabsSession(store.getState(), scope.folderPath),
  };

  return runtime;
}
