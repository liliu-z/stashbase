import { useCallback, type MutableRefObject } from 'react';
import { api, ApiError } from '../api';
import {
  filterGuiSemanticHits,
  shallowEqualConversionProgress,
  shallowEqualIndexWarning,
  shallowEqualNumberRecord,
  shallowEqualPreparationFailures,
} from './appContextHelpers';
import {
  optimisticKeyBackfillPaths,
  type Action,
  type State,
} from './state';
import type { ToastOptions } from './useFeedbackActions';
import { hasAggregatePreparationFailure } from './fileReadiness';
import type { SearchTypeCategory } from '../../../shared/search-types.ts';

const SEMANTIC_SEARCH_CANDIDATES = 30;
const POLL_PENDING_MS = 1500;
const POLL_IDLE_MS = 8000;

type Dispatch = (action: Action) => void;
type Toast = (message: string, opts?: ToastOptions) => string;

interface SearchActionRefs {
  stateRef: MutableRefObject<State>;
  pollTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  searchGeneration: MutableRefObject<number>;
  syncGeneration: MutableRefObject<number>;
  openGeneration: MutableRefObject<number>;
  lastTreeVersion: MutableRefObject<number>;
  importConversionGrace: MutableRefObject<Map<string, number>>;
  importIndexGrace: MutableRefObject<Map<string, number>>;
  keyBackfillGrace: MutableRefObject<Map<string, number>>;
}

interface SearchActionDependencies {
  loadFiles: (expectedFolderPath?: string) => Promise<State['files']>;
  loadFilesFromServer: (
    expectedFolderPath?: string,
  ) => Promise<State['files'] | null>;
  refreshActiveTabFromDisk: (opts?: { force?: boolean }) => Promise<void>;
  toast: Toast;
}

/** Owns search requests, index-status polling, and sync progress state. */
export function useSearchActions(
  refs: SearchActionRefs,
  dependencies: SearchActionDependencies,
  dispatch: Dispatch,
) {
  const {
    importConversionGrace,
    importIndexGrace,
    keyBackfillGrace,
    lastTreeVersion,
    openGeneration: openGen,
    pollTimer,
    searchGeneration: searchGen,
    stateRef,
    syncGeneration: syncGen,
  } = refs;
  const {
    loadFiles,
    loadFilesFromServer,
    refreshActiveTabFromDisk,
    toast,
  } = dependencies;
  const markVisibleFilesPendingForSearch = useCallback(async (files?: State['files']) => {
    const folderPath = stateRef.current.folderPath;
    const source = files ?? (stateRef.current.files.length ? stateRef.current.files : folderPath ? await loadFiles(folderPath) : []);
    if (stateRef.current.folderPath !== folderPath) return;
    const paths = optimisticKeyBackfillPaths(source);
    if (paths.length === 0) return;
    const deadline = Date.now() + 15000;
    const merged = new Set(stateRef.current.pendingSemanticNames);
    for (const path of paths) {
      keyBackfillGrace.current.set(path, deadline);
      merged.add(path);
    }
    dispatch({ type: 'PENDING_SEMANTIC_NAMES', names: merged });
  }, [loadFiles]);


  const refreshIndexState = useCallback(async (folderPathOverride?: string) => {
    let nextDelay = POLL_IDLE_MS;
    const scheduleNextPoll = (delay: number) => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      pollTimer.current = setTimeout(() => { void refreshIndexState(); }, delay);
    };
    const explicitFolderPath = folderPathOverride?.trim() || undefined;
    const folderPathAtStart = explicitFolderPath ?? stateRef.current.folderPath;
    const openGenAtStart = openGen.current;
    const stillTargetFolder = () =>
      stateRef.current.folderPath === folderPathAtStart
      || (explicitFolderPath != null && openGenAtStart === openGen.current);
    try {
      const s = await api.indexStatus(folderPathAtStart || undefined);
      if (!stillTargetFolder()) {
        scheduleNextPoll(nextDelay);
        return;
      }
      const indexReady = s.indexReady !== false;
      const semanticEnabled = s.semanticEnabled !== false;
      if (stateRef.current.embedderHasKey !== semanticEnabled) {
        dispatch({ type: 'EMBEDDER_KEY_STATE', hasKey: semanticEnabled });
      }
      const newPending = semanticEnabled && indexReady ? new Set(s.pending ?? []) : new Set<string>();
      const visibleIndexingSettled =
        !semanticEnabled
        || (indexReady && (s.visibleIndexingSettled ?? newPending.size === 0));
      let newConv = s.pendingConversions ?? [];
      const newBlocked = s.blockedConversions ?? [];
      // Fold in optimistically-marked imports the server hasn't started
      // reporting yet (it registers the conversion only after responding
      // to the upload). Hand off once the server tracks a path; expire
      // the grace otherwise so a never-converted file doesn't stick.
      if (importConversionGrace.current.size > 0) {
        const now = Date.now();
        const stillGracing: string[] = [];
        for (const [name, deadline] of importConversionGrace.current) {
          if (newConv.includes(name)) {
            importConversionGrace.current.delete(name); // server owns it now
          } else if (now <= deadline) {
            stillGracing.push(name);
          } else {
            importConversionGrace.current.delete(name); // grace expired
          }
        }
        if (stillGracing.length) {
          newConv = [...new Set([...newConv, ...stillGracing])].sort();
        }
      }
      // Same fold for optimistically-marked note imports — but keyed on
      // the renderer-facing visibleIndexingSettled signal, not raw daemon
      // upToDate. The daemon serialises `status` behind in-flight embeds,
      // so a fresh drop's files flicker in and out of `pending`
      // unreliably. Hold every graced import in `newPending` until the
      // UI-visible pending set settles (batch done) or the grace expires.
      if (semanticEnabled && importIndexGrace.current.size > 0) {
        const now = Date.now();
        for (const [name, deadline] of importIndexGrace.current) {
          if (visibleIndexingSettled) {
            importIndexGrace.current.delete(name); // batch fully indexed
          } else if (now <= deadline) {
            newPending.add(name);
          } else {
            importIndexGrace.current.delete(name); // grace expired
          }
        }
      } else if (!semanticEnabled && importIndexGrace.current.size > 0) {
        importIndexGrace.current.clear();
      }
      if (semanticEnabled && keyBackfillGrace.current.size > 0) {
        const now = Date.now();
        for (const [name, deadline] of keyBackfillGrace.current) {
          if (newPending.has(name)) {
            keyBackfillGrace.current.delete(name); // daemon owns it now
          } else if (now <= deadline) {
            newPending.add(name);
          } else {
            keyBackfillGrace.current.delete(name);
          }
        }
      } else if (!semanticEnabled && keyBackfillGrace.current.size > 0) {
        keyBackfillGrace.current.clear();
      }
      const prev = stateRef.current;
      // Trigger a `/api/files` refresh whenever the indexer's
      // awareness of the disk grew or shrank — covers new files
      // landing from the watcher (vim edits) AND `.html` notes
      // appearing after PDF conversion finishes, both of which
      // would otherwise leave the sidebar tree stale until the
      // next user action.
      const pendingChanged =
        newPending.size !== prev.pendingSemanticNames.size
        || [...newPending].some((n) => !prev.pendingSemanticNames.has(n))
        || [...prev.pendingSemanticNames].some((n) => !newPending.has(n));
      const convChanged =
        newConv.length !== prev.pendingConversions.length
        || newConv.some((p, i) => p !== prev.pendingConversions[i]);
      const blockedChanged =
        newBlocked.length !== prev.blockedConversions.length
        || newBlocked.some((p, i) => p !== prev.blockedConversions[i]);
      // `treeVersion` covers writes the indexer's `pending` set wouldn't
      // catch — non-indexable files (`.json`, `.csv`, empty dirs) and
      // fast embeds whose pending flips empty between polls. First
      // poll initialises the ref (no spurious reload).
      const newTreeVersion = typeof s.treeVersion === 'number' ? s.treeVersion : -1;
      const treeChanged =
        lastTreeVersion.current >= 0 && newTreeVersion !== lastTreeVersion.current;
      lastTreeVersion.current = newTreeVersion;
      dispatch({ type: 'PENDING_SEMANTIC_NAMES', names: newPending });
      if (convChanged) dispatch({ type: 'PENDING_CONVERSIONS', paths: newConv });
      if (blockedChanged) dispatch({ type: 'BLOCKED_CONVERSIONS', paths: newBlocked });
      const incomingProgress = s.conversionProgress ?? {};
      if (!shallowEqualConversionProgress(prev.conversionProgress, incomingProgress)) {
        dispatch({ type: 'CONVERSION_PROGRESS', progress: incomingProgress });
      }
      const incomingConversionRevision = s.conversionRevision ?? 0;
      const incomingConversionVersions = s.conversionVersions ?? {};
      if (
        prev.conversionRevision !== incomingConversionRevision
        || !shallowEqualNumberRecord(prev.conversionVersions, incomingConversionVersions)
      ) {
        dispatch({
          type: 'CONVERSION_SCHEDULER_STATE',
          revision: incomingConversionRevision,
          versions: incomingConversionVersions,
        });
      }
      const incomingIndexWarning = s.indexWarning ?? null;
      if (!shallowEqualIndexWarning(prev.indexWarning, incomingIndexWarning)) {
        dispatch({ type: 'INDEX_WARNING', warning: incomingIndexWarning });
      }
      const incomingFailures = s.preparationFailures ?? [];
      if (!shallowEqualPreparationFailures(prev.preparationFailures, incomingFailures)) {
        dispatch({ type: 'PREPARATION_FAILURES', failures: incomingFailures });
      }
      const canRefreshVisibleFiles = stateRef.current.folderPath === folderPathAtStart;
      if (canRefreshVisibleFiles && (pendingChanged || convChanged || blockedChanged || treeChanged)) {
        if (treeChanged) {
          const expectedFolderPath = folderPathAtStart;
          void loadFilesFromServer(expectedFolderPath)
            .then((files) => {
              if (!files) return;
              dispatch({ type: 'PRUNE_MISSING_FILE_TABS', names: files.map((f) => f.name) });
            })
            .catch((err) => {
              console.warn('[files] refresh after tree change failed:', err);
            });
        } else {
          void loadFiles();
        }
      }
      // Tree changed = someone else wrote to disk (Claude Code in the
      // chat panel is the common case). Re-read the active tab's
      // body so the preview / read-only editor doesn't keep showing
      // stale content. Skipped while the user is editing — clobbering
      // their unsaved buffer is worse than showing slightly old text;
      // a "this file changed on disk, reload?" prompt belongs here
      // long-term, but for now silent reload-when-safe is the best
      // tradeoff vs. silently stale.
      if (treeChanged && canRefreshVisibleFiles) void refreshActiveTabFromDisk();
      // Keep polling fast while a conversion is in flight, even if
      // the index itself is settled — the user is waiting on a file
      // to appear.
      const busy = (semanticEnabled && (!indexReady || !visibleIndexingSettled)) || newConv.length > 0;
      if (folderPathAtStart) {
        dispatch({
          type: 'LIBRARY_FOLDER_STATUS',
          path: folderPathAtStart,
          status: incomingIndexWarning || hasAggregatePreparationFailure(incomingFailures)
            ? 'failed'
            : busy ? 'preparing' : 'ready',
        });
      }
      nextDelay = busy ? POLL_PENDING_MS : POLL_IDLE_MS;
    } catch (err) {
      if (!stillTargetFolder()) {
        scheduleNextPoll(nextDelay);
        return;
      }
      if (err instanceof ApiError && err.status === 412) {
        if (folderPathAtStart && openGenAtStart === openGen.current) {
          try {
            // Server restart / dev tsx reload drops the in-memory
            // window → folder binding while the renderer still has the
            // right folder and possibly an unsaved editor buffer. Rebind
            // first; only fall back to Welcome if the folder is truly gone.
            const opened = await api.openFolder(folderPathAtStart);
            if (
              stateRef.current.folderPath === folderPathAtStart
              && opened.current?.path
            ) {
              lastTreeVersion.current = -1;
              dispatch({
                type: 'FOLDER_CONTEXT',
                folder: opened.current.name,
                folderPath: opened.current.path,
              });
              void loadFilesFromServer(folderPathAtStart);
              scheduleNextPoll(POLL_PENDING_MS);
              return;
            }
          } catch {
            // Folder was deleted/renamed, or the server is still not ready.
            // Drop through to the hard reset below.
          }
        }
        // No folder open (e.g. just went home). Clear every folder-scoped
        // indicator so a stale banner from the previous folder doesn't
        // bleed into the welcome / next-folder view.
        syncGen.current += 1;
        openGen.current += 1;
        dispatch({ type: 'PENDING_SEMANTIC_NAMES', names: new Set() });
        dispatch({ type: 'PENDING_CONVERSIONS', paths: [] });
        dispatch({ type: 'BLOCKED_CONVERSIONS', paths: [] });
        dispatch({ type: 'CONVERSION_PROGRESS', progress: {} });
        dispatch({ type: 'CONVERSION_SCHEDULER_STATE', revision: 0, versions: {} });
        dispatch({ type: 'INDEX_WARNING', warning: null });
        dispatch({ type: 'PREPARATION_FAILURES', failures: [] });
        dispatch({ type: 'SYNC_RUNNING', running: false });
        lastTreeVersion.current = -1;
        if (stateRef.current.folderPath) {
          // Another window may have deleted/closed the folder. The server
          // has already cleared this window's current-folder context; make
          // the renderer match instead of leaving a stale tree open.
          dispatch({ type: 'TABS_RESET' });
          dispatch({ type: 'CHAT_TABS_RESET' });
          dispatch({ type: 'FILTER', q: '' });
          dispatch({ type: 'SEARCH_CLEAR' });
          dispatch({ type: 'ACTIVE_FOLDER', path: '' });
          dispatch({ type: 'FILE_ORDER_LOADED', order: {} });
          dispatch({ type: 'FILES_LOADED', files: [], folders: [], folder: '', folderPath: '' });
          dispatch({ type: 'WELCOME_SHOW', recent: [] });
          void api.getFolder()
            .then((j) => dispatch({ type: 'WELCOME_SHOW', recent: j.recent ?? [], homeDir: j.homeDir }))
            .catch(() => { /* welcome can stay empty until bootstrap/focus */ });
        }
      }
    }
    scheduleNextPoll(nextDelay);
  }, [loadFiles, loadFilesFromServer, refreshActiveTabFromDisk]);

  /** Fire whichever search the current `searchMode` selects and dispatch
   *  the result. Empty query clears (back to tree view). Bails out on
   *  stale responses so fast typing doesn't show flashes of older
   *  results — also covers the case where the user toggled mode while a
   *  prior query was in flight.
   *
   *  `modeOverride` exists because `stateRef.current.searchMode`
   *  updates AFTER React commits, not in-line with a dispatch — so a
   *  caller that just dispatched `SEARCH_MODE` and synchronously calls
   *  `runSearch` would otherwise read the stale mode and fire the
   *  wrong API. Mode-toggle callers pass the new mode explicitly. */
  const runSearch = useCallback(async (
    query: string,
    modeOverride?: 'semantic' | 'keyword',
    opts?: {
      caseStrict?: boolean;
      wholeWord?: boolean;
      scope?: string | null;
      types?: SearchTypeCategory[];
    },
  ) => {
    const myGen = ++searchGen.current;
    const q = query.trim();
    if (!q) {
      dispatch({ type: 'SEARCH_CLEAR' });
      return;
    }
    const mode = modeOverride ?? stateRef.current.searchMode;
    const folderPathAtStart = stateRef.current.folderPath;
    const isStaleSearch = () => (
      myGen !== searchGen.current ||
      stateRef.current.folderPath !== folderPathAtStart ||
      stateRef.current.filterQuery.trim() !== q
    );
    dispatch({ type: 'SEARCH_START' });
    try {
      if (mode === 'keyword') {
        // Pull case-strict / whole-word / current folder straight from
        // state. The `folder` field is the active folder of THIS window;
        // passing it explicitly avoids the server falling back to the
        // process-wide `currentFolder` singleton, which would pick the
        // wrong folder in multi-window sessions.
        const s = stateRef.current;
        const scope = opts?.scope !== undefined ? opts.scope : s.searchScope;
        const result = await api.keywordSearch(q, {
          caseStrict: opts?.caseStrict ?? s.caseStrict,
          wholeWord: opts?.wholeWord ?? s.wholeWord,
          folder: folderPathAtStart || undefined,
          pathPrefix: scope ?? undefined,
          types: opts?.types ?? s.searchTypes,
        });
        if (isStaleSearch()) return;
        dispatch({ type: 'SEARCH_KEYWORD', result });
      } else {
        const embedder = await api.getEmbedder();
        if (isStaleSearch()) return;
        dispatch({ type: 'EMBEDDER_KEY_STATE', hasKey: embedder.hasKey });
        if (!embedder.hasKey) {
          dispatch({
            type: 'SEARCH_ERROR',
            error: 'Semantic search is disabled until you add an OpenAI API key. Switch to keyword search to search without embeddings.',
          });
          return;
        }
        const s = stateRef.current;
        const scope = opts?.scope !== undefined ? opts.scope : s.searchScope;
        const { hits } = await api.search(q, SEMANTIC_SEARCH_CANDIDATES, {
          folder: folderPathAtStart || undefined,
          pathPrefix: scope ?? undefined,
          types: opts?.types ?? s.searchTypes,
        });
        if (isStaleSearch()) return;
        dispatch({ type: 'SEARCH_HITS', hits: filterGuiSemanticHits(hits) });
      }
    } catch (err) {
      if (isStaleSearch()) return;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[search:${mode}] failed:`, msg);
      // 412 = no folder open: just clear (there's nothing to search), no
      // error banner. Any other failure is a real error — surface it as
      // such instead of a misleading empty "No matches".
      if (err instanceof ApiError && err.status === 412) {
        dispatch({ type: 'SEARCH_CLEAR' });
      } else {
        dispatch({ type: 'SEARCH_ERROR', error: msg });
      }
    }
  }, []);

  const runSync = useCallback(async () => {
    if (stateRef.current.syncRunning) return;
    const targetFolderPath = stateRef.current.folderPath;
    if (!targetFolderPath) return;
    const myGen = ++syncGen.current;
    dispatch({ type: 'SYNC_RUNNING', running: true });
    void refreshIndexState();
    try {
      const result = await api.sync(targetFolderPath);
      if (stateRef.current.folderPath !== targetFolderPath) return;
      if (result.failed?.length || result.cancelled) {
        await refreshIndexState();
      } else {
        dispatch({ type: 'INDEX_WARNING', warning: null });
      }
      await loadFiles(targetFolderPath);
    } catch (e: unknown) {
      toast('Sync failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    } finally {
      if (myGen === syncGen.current) dispatch({ type: 'SYNC_RUNNING', running: false });
    }
  }, [loadFiles, refreshIndexState]);

  const dismissIndexWarning = useCallback(async () => {
    const folderAtStart = stateRef.current.folderPath;
    dispatch({ type: 'INDEX_WARNING', warning: null });
    try { await api.dismissIndexWarning(folderAtStart || undefined); }
    catch (err) {
      console.warn('[index-warning] dismiss failed:', err instanceof Error ? err.message : String(err));
    }
  }, []);

  return {
    dismissIndexWarning,
    markVisibleFilesPendingForSearch,
    refreshIndexState,
    runSearch,
    runSync,
  };
}
