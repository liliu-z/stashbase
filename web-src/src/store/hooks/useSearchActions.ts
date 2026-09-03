import { useCallback, useMemo, type MutableRefObject } from 'react';
import { api, ApiError } from '@/common/api/api';
import { rebindFolderIfStillInLibrary } from '@/store/lib/folderPath';
import {
  shallowEqualConversionProgress,
  shallowEqualIndexWarning,
  shallowEqualNumberRecord,
  planSemanticPollDispatches,
  shallowEqualPreparationFailures,
} from '@/store/lib/appContextHelpers';
import {
  optimisticKeyBackfillPaths,
  toNameSet,
  type Action,
  type State,
  type WorkspaceSlice,
} from '@/store/state/state';
import { folderScopedPreparationResetActions } from '@/store/lib/folderScopedReset';
import type { ToastOptions } from './useFeedbackActions';
import { hasAggregatePreparationFailure } from '@/store/lib/fileReadiness';
import { runIndexStatusRequest } from '@/store/lib/indexStatusRequest';
import type { LoadedFileListing } from './useActiveFolderWorkspace';

const POLL_PENDING_MS = 1500;
const POLL_IDLE_MS = 8000;

/** One pass over an optimistic import/backfill grace map: entries the
 *  server now reports as its own (`serverOwns`) hand off and leave the
 *  map, entries past their absolute deadline expire, and the rest stay
 *  graced — returned so the caller can fold them into the optimistic
 *  pending view. */
function foldGraceMap(
  map: Map<string, number>,
  serverOwns: (name: string) => boolean,
  now: number,
): string[] {
  const stillGracing: string[] = [];
  for (const [name, deadline] of map) {
    if (serverOwns(name)) {
      map.delete(name); // server owns it now
    } else if (now <= deadline) {
      stillGracing.push(name);
    } else {
      map.delete(name); // grace expired
    }
  }
  return stillGracing;
}

type Dispatch = (action: Action) => void;
type Toast = (message: string, opts?: ToastOptions) => string;

interface SearchActionRefs {
  stateRef: MutableRefObject<State>;
  folderContextPath: MutableRefObject<string>;
  pollTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  syncGeneration: MutableRefObject<number>;
  openGeneration: MutableRefObject<number>;
  openingFolderGeneration: MutableRefObject<number | null>;
  lastTreeVersion: MutableRefObject<number>;
  importConversionGrace: MutableRefObject<Map<string, number>>;
  importIndexGrace: MutableRefObject<Map<string, number>>;
  keyBackfillGrace: MutableRefObject<Map<string, number>>;
}

interface SearchActionDependencies {
  loadFiles: (expectedFolderPath?: string) => Promise<WorkspaceSlice['files']>;
  loadFilesFromServer: (
    expectedFolderPath?: string,
  ) => Promise<LoadedFileListing | null>;
  refreshActiveTabFromDisk: (opts?: { force?: boolean }) => Promise<void>;
  toast: Toast;
}

/** Recovery ladder for a 412 index-status response: the server no longer
 *  has a folder bound to this window. First try to re-bind (server
 *  restart / dev reload with the folder still a library member); failing
 *  that, hard-reset every folder-scoped indicator and — when a folder was
 *  visibly open — the workspace itself.
 *
 *  The preparation-indicator half comes from the shared
 *  `folderScopedPreparationResetActions` builder, so this ladder and the
 *  folder-switch plan cannot disagree about which indicators are
 *  folder-scoped. The rest is deliberately NOT `folderScopedResetActions`
 *  ('folder-lost'): this ladder clears the shared indicators even when no
 *  folder is open, resets the workspace only conditionally, and orders the
 *  two halves the other way round. Returns `'rebound'` when the folder was
 *  re-bound (a fast follow-up poll is already scheduled); `'reset'` when the
 *  caller should schedule its own next poll.
 *
 *  Exported for `store/__tests__/folder-scoped-reset.test.ts`, which pins
 *  both the shared set and this ladder's dispatch order; nothing outside the
 *  poll calls it. */
export async function recoverLostFolderContext({
  folderPathAtStart,
  openGenAtStart,
  refs,
  dispatch,
  loadFilesFromServer,
  schedulePoll,
}: {
  folderPathAtStart: string;
  openGenAtStart: number;
  refs: Pick<
    SearchActionRefs,
    'stateRef' | 'folderContextPath' | 'lastTreeVersion' | 'syncGeneration' | 'openGeneration'
  >;
  dispatch: Dispatch;
  loadFilesFromServer: SearchActionDependencies['loadFilesFromServer'];
  schedulePoll: (delay: number) => void;
}): Promise<'rebound' | 'reset'> {
  const { folderContextPath, lastTreeVersion, openGeneration, stateRef, syncGeneration } = refs;
  let latestLibrary: Awaited<ReturnType<typeof api.getFolder>> | null = null;
  if (folderPathAtStart && openGenAtStart === openGeneration.current) {
    try {
      // Server restart / dev tsx reload drops the in-memory
      // window → folder binding while the renderer still has the
      // right folder and possibly an unsaved editor buffer. Membership
      // distinguishes that case from another window intentionally
      // removing the folder from the library.
      const recovery = await rebindFolderIfStillInLibrary(folderPathAtStart, {
        getLibrary: api.getFolder,
        openFolder: api.openFolder,
      });
      latestLibrary = recovery.library;
      if (!recovery.opened) {
        throw new Error('folder was removed from the library');
      }
      const opened = recovery.opened;
      if (
        stateRef.current.workspace.folderPath === folderPathAtStart
        && opened.current?.path
      ) {
        folderContextPath.current = opened.current.path;
        lastTreeVersion.current = -1;
        dispatch({
          type: 'FOLDER_CONTEXT',
          folder: opened.current.name,
          folderPath: opened.current.path,
        });
        void loadFilesFromServer(folderPathAtStart);
        schedulePoll(POLL_PENDING_MS);
        return 'rebound';
      }
    } catch {
      // Folder was deleted/renamed, or the server is still not ready.
      // Drop through to the hard reset below.
    }
  }
  // No folder open. Clear every folder-scoped indicator so a stale
  // banner from the previous folder doesn't bleed into the
  // no-folder / next-folder view.
  syncGeneration.current += 1;
  openGeneration.current += 1;
  folderContextPath.current = '';
  for (const action of folderScopedPreparationResetActions()) dispatch(action);
  lastTreeVersion.current = -1;
  if (stateRef.current.workspace.folderPath) {
    // Another window may have deleted/closed the folder. The server
    // has already cleared this window's current-folder context; make
    // the renderer match instead of leaving a stale tree open.
    dispatch({ type: 'TABS_RESET' });
    dispatch({ type: 'ACTIVE_FOLDER', path: '' });
    dispatch({ type: 'FILE_ORDER_LOADED', order: {} });
    dispatch({ type: 'FILES_LOADED', files: [], folders: [], folder: '', folderPath: '' });
    if (latestLibrary) {
      dispatch({
        type: 'RECENT_LOADED',
        recent: latestLibrary.recent ?? [],
        homeDir: latestLibrary.homeDir,
      });
    } else {
      void api.getFolder()
        .then((j) => dispatch({ type: 'RECENT_LOADED', recent: j.recent ?? [], homeDir: j.homeDir }))
        .catch(() => { /* the library list can stay stale until the next refresh */ });
    }
  }
  return 'reset';
}

/** Owns index-status polling and sync progress state. (Search requests
 *  themselves live in the search popup — see `librarySearch.ts`.) */
export function useSearchActions(
  refs: SearchActionRefs,
  dependencies: SearchActionDependencies,
  dispatch: Dispatch,
) {
  const {
    folderContextPath,
    importConversionGrace,
    importIndexGrace,
    keyBackfillGrace,
    lastTreeVersion,
    openGeneration: openGen,
    openingFolderGeneration,
    pollTimer,
    stateRef,
    syncGeneration: syncGen,
  } = refs;
  const {
    loadFiles,
    loadFilesFromServer,
    refreshActiveTabFromDisk,
    toast,
  } = dependencies;
  const markVisibleFilesPendingForSearch = useCallback(async (files?: WorkspaceSlice['files']) => {
    const folderPath = stateRef.current.workspace.folderPath;
    const source = files ?? (stateRef.current.workspace.files.length ? stateRef.current.workspace.files : folderPath ? await loadFiles(folderPath) : []);
    if (stateRef.current.workspace.folderPath !== folderPath) return;
    const paths = optimisticKeyBackfillPaths(source);
    if (paths.length === 0) return;
    const deadline = Date.now() + 15000;
    for (const path of paths) keyBackfillGrace.current.set(path, deadline);
    dispatch({
      type: 'PENDING_SEMANTIC_NAMES',
      names: { ...stateRef.current.workspace.pendingSemanticNames, ...toNameSet(paths) },
    });
  }, [loadFiles]);


  const refreshIndexState = useCallback(async (folderPathOverride?: string) => {
    let nextDelay = POLL_IDLE_MS;
    const scheduleNextPoll = (delay: number) => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      pollTimer.current = setTimeout(() => { void refreshIndexState(); }, delay);
    };
    const explicitFolderPath = folderPathOverride?.trim() || undefined;
    const activeFolderPathAtStart = folderContextPath.current;
    const folderPathAtStart = explicitFolderPath ?? activeFolderPathAtStart;
    const openGenAtStart = openGen.current;
    try {
      const outcome = await runIndexStatusRequest({
        activeFolderPath: activeFolderPathAtStart,
        activeFolderTransitionInProgress: openingFolderGeneration.current != null,
        explicitFolderPath,
        openGenerationAtStart: openGenAtStart,
        getCurrentFolderPath: () => stateRef.current.workspace.folderPath,
        getCurrentOpenGeneration: () => openGen.current,
        request: (folderPath) => api.indexStatus(folderPath),
      });
      if (outcome.kind === 'stale' || outcome.kind === 'skipped') {
        scheduleNextPoll(nextDelay);
        return;
      }
      if (outcome.kind === 'error') throw outcome.error;
      const s = outcome.status;
      const indexReady = s.indexReady !== false;
      const semanticEnabled = s.semanticEnabled !== false;
      const semanticAvailable = s.semanticAvailable !== false;
      if (stateRef.current.workspace.embedderHasKey !== semanticEnabled) {
        dispatch({ type: 'EMBEDDER_KEY_STATE', hasKey: semanticEnabled });
      }
      const newPending = semanticEnabled && semanticAvailable && indexReady ? new Set(s.pending ?? []) : new Set<string>();
      const visibleIndexingSettled =
        !semanticAvailable
        || (indexReady && (s.visibleIndexingSettled ?? newPending.size === 0));
      let newConv = s.pendingConversions ?? [];
      const newBlocked = s.blockedConversions ?? [];
      // Fold in optimistically-marked imports the server hasn't started
      // reporting yet (it registers the conversion only after responding
      // to the upload). Hand off once the server tracks a path; expire
      // the grace otherwise so a never-converted file doesn't stick.
      if (importConversionGrace.current.size > 0) {
        const stillGracing = foldGraceMap(
          importConversionGrace.current,
          (name) => newConv.includes(name),
          Date.now(),
        );
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
      if (semanticAvailable && importIndexGrace.current.size > 0) {
        const stillGracing = foldGraceMap(
          importIndexGrace.current,
          () => visibleIndexingSettled, // batch fully indexed
          Date.now(),
        );
        for (const name of stillGracing) newPending.add(name);
      } else if (!semanticAvailable && importIndexGrace.current.size > 0) {
        importIndexGrace.current.clear();
      }
      // And for key-backfill marks: the daemon owns a name once it shows
      // up in its own pending set.
      if (semanticAvailable && keyBackfillGrace.current.size > 0) {
        const stillGracing = foldGraceMap(
          keyBackfillGrace.current,
          (name) => newPending.has(name),
          Date.now(),
        );
        for (const name of stillGracing) newPending.add(name);
      } else if (!semanticAvailable && keyBackfillGrace.current.size > 0) {
        keyBackfillGrace.current.clear();
      }
      const prev = stateRef.current.workspace;
      // Guarded in `planSemanticPollDispatches` rather than inline: both
      // actions land in the workspace slice and this poll runs every
      // POLL_PENDING_MS while indexing, so dispatching unconditionally
      // re-rendered every `useWorkspace()` consumer on each tick. Planned
      // here (it is pure) but dispatched in the established position below.
      const semanticPollDispatches = planSemanticPollDispatches(prev, {
        pending: newPending,
        semanticIndexing: s.semanticIndexing ?? null,
      });
      // Trigger a `/api/files` refresh whenever the indexer's
      // awareness of the disk grew or shrank — covers new files
      // landing from the watcher (vim edits) AND `.html` notes
      // appearing after PDF conversion finishes, both of which
      // would otherwise leave the sidebar tree stale until the
      // next user action. That is the same membership question the plan
      // above already answered, so read it off the plan.
      const pendingChanged = semanticPollDispatches.some(
        (action) => action.type === 'PENDING_SEMANTIC_NAMES',
      );
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
      for (const action of semanticPollDispatches) dispatch(action);
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
      const canRefreshVisibleFiles = stateRef.current.workspace.folderPath === folderPathAtStart;
      if (canRefreshVisibleFiles && (pendingChanged || convChanged || blockedChanged || treeChanged)) {
        if (treeChanged) {
          const expectedFolderPath = folderPathAtStart;
          void loadFilesFromServer(expectedFolderPath)
            .then(async (listing) => {
              if (!listing) return;
              const present = new Set(listing.files.map((file) => file.name));
              const absentFromVisibleListing = stateRef.current.workspace.tabs
                .filter((tab) => tab.file && !tab.file.folder && !tab.dirty && !present.has(tab.file.name))
                .map((tab) => tab.file!.name);
              const confirmedMissing = new Set<string>();
              // A hidden-visibility change in another window also bumps the
              // tree version. Confirm absence on disk before pruning tabs;
              // omission from the visible listing is not deletion.
              await Promise.all(absentFromVisibleListing.map(async (name) => {
                try {
                  await api.statFile(name, { folder: expectedFolderPath });
                } catch (err: unknown) {
                  // Fail closed for tab lifetime: only a definite 404 proves
                  // the file disappeared. Transient/server errors retain it.
                  if (err instanceof ApiError && err.status === 404) confirmedMissing.add(name);
                }
              }));
              if (!listing.isCurrent() || stateRef.current.workspace.folderPath !== expectedFolderPath) return;
              // Close only tabs that this still-current batch proved missing.
              // A tab opened or dirtied while HEAD requests were in flight
              // was not part of that proof and keeps its lifetime.
              for (const tab of stateRef.current.workspace.tabs) {
                if (!tab.file || tab.file.folder || tab.dirty || !confirmedMissing.has(tab.file.name)) continue;
                dispatch({ type: 'CLOSE_TAB', id: tab.id });
              }
            })
            .catch((err) => {
              console.warn('[files] refresh after tree change failed:', err);
            });
        } else {
          void loadFiles(folderPathAtStart);
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
      const busy = (semanticAvailable && (!indexReady || !visibleIndexingSettled)) || newConv.length > 0;
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
      if (err instanceof ApiError && err.status === 412) {
        const outcome = await recoverLostFolderContext({
          folderPathAtStart,
          openGenAtStart,
          refs: {
            stateRef,
            folderContextPath,
            lastTreeVersion,
            syncGeneration: syncGen,
            openGeneration: openGen,
          },
          dispatch,
          loadFilesFromServer,
          schedulePoll: scheduleNextPoll,
        });
        if (outcome === 'rebound') return;
      }
    }
    scheduleNextPoll(nextDelay);
  }, [loadFiles, loadFilesFromServer, refreshActiveTabFromDisk]);

  const runSync = useCallback(async () => {
    if (stateRef.current.workspace.syncRunning) return;
    const targetFolderPath = stateRef.current.workspace.folderPath;
    if (!targetFolderPath) return;
    const myGen = ++syncGen.current;
    dispatch({ type: 'SYNC_RUNNING', running: true });
    void refreshIndexState();
    try {
      const result = await api.sync(targetFolderPath);
      if (stateRef.current.workspace.folderPath !== targetFolderPath) return;
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
    const folderAtStart = stateRef.current.workspace.folderPath;
    dispatch({ type: 'INDEX_WARNING', warning: null });
    try { await api.dismissIndexWarning(folderAtStart || undefined); }
    catch (err) {
      console.warn('[index-warning] dismiss failed:', err instanceof Error ? err.message : String(err));
    }
  }, []);

  const decideSemanticIndexing = useCallback(async (decision: 'start' | 'defer') => {
    const folderAtStart = stateRef.current.workspace.folderPath;
    if (!folderAtStart) return;
    await api.semanticIndexingDecision(decision, folderAtStart);
    await refreshIndexState(folderAtStart);
  }, [refreshIndexState]);

  // One stable actions object: the workspace memo depends on this object,
  // not on individually listed members, so a new action added here is
  // tracked automatically.
  return useMemo(() => ({
    decideSemanticIndexing,
    dismissIndexWarning,
    markVisibleFilesPendingForSearch,
    refreshIndexState,
    runSync,
  }), [
    decideSemanticIndexing,
    dismissIndexWarning,
    markVisibleFilesPendingForSearch,
    refreshIndexState,
    runSync,
  ]);
}
