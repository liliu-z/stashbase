import { useCallback, type MutableRefObject } from 'react';
import { api } from '../api';
import { folderRefsEqual, isAbsoluteFolderRef } from '../folderPath';
import type { FolderMutationQueue } from '../folderTransition';
import type { EditorHandle } from './actionTypes';
import type { Action, LibraryFolderStatus, State } from './state';
import type { ToastOptions } from './useFeedbackActions';

type Dispatch = (action: Action) => void;
type Toast = (message: string, opts?: ToastOptions) => string;

interface FolderActionRefs {
  state: MutableRefObject<State>;
  editor: MutableRefObject<EditorHandle | null>;
  openGeneration: MutableRefObject<number>;
  syncGeneration: MutableRefObject<number>;
  searchGeneration: MutableRefObject<number>;
  lastTreeVersion: MutableRefObject<number>;
  importConversionGrace: MutableRefObject<Map<string, number>>;
  importIndexGrace: MutableRefObject<Map<string, number>>;
  keyBackfillGrace: MutableRefObject<Map<string, number>>;
  folderMutations: MutableRefObject<FolderMutationQueue>;
}

interface FolderActionDependencies {
  flushSave: () => Promise<boolean>;
  loadFiles: (expectedFolderPath?: string) => Promise<State['files']>;
  loadFileOrder: (expectedFolderPath?: string) => Promise<void>;
  markVisibleFilesPendingForSearch: (files?: State['files']) => Promise<void>;
  refreshIndexState: (folderPath?: string) => Promise<void>;
  toast: Toast;
}

function libraryStatusFromActiveFolder(state: State): LibraryFolderStatus {
  const hasPreparationFailure = state.preparationFailures.some((problem) => problem.status !== 'cancelled');
  if (state.indexWarning || hasPreparationFailure || state.blockedConversions.length > 0) return 'failed';
  const semanticPending = state.embedderHasKey !== false && state.pendingSemanticNames.size > 0;
  if (state.syncRunning || semanticPending || state.pendingConversions.length > 0) return 'preparing';
  return 'ready';
}

/** Owns folder-session transitions and invalidates stale async finishers. */
export function useFolderActions(
  refs: FolderActionRefs,
  dependencies: FolderActionDependencies,
  dispatch: Dispatch,
) {
  const {
    editor,
    importConversionGrace,
    importIndexGrace,
    keyBackfillGrace,
    lastTreeVersion,
    openGeneration,
    searchGeneration,
    state,
    syncGeneration,
  } = refs;
  const {
    flushSave,
    loadFileOrder,
    loadFiles,
    markVisibleFilesPendingForSearch,
    refreshIndexState,
    toast,
  } = dependencies;
  const { folderMutations } = refs;

  const resetFolderScopedState = useCallback(() => {
    const previous = state.current;
    if (previous.folderPath) {
      dispatch({
        type: 'LIBRARY_FOLDER_STATUS',
        path: previous.folderPath,
        status: libraryStatusFromActiveFolder(previous),
      });
    }
    syncGeneration.current += 1;
    searchGeneration.current += 1;
    lastTreeVersion.current = -1;
    importConversionGrace.current.clear();
    importIndexGrace.current.clear();
    keyBackfillGrace.current.clear();
    dispatch({ type: 'TABS_RESET' });
    dispatch({ type: 'CHAT_TABS_RESET' });
    dispatch({ type: 'SIDEBAR_VIEW', view: 'files' });
    dispatch({ type: 'FILTER', q: '' });
    dispatch({ type: 'SEARCH_CLEAR' });
    dispatch({ type: 'ACTIVE_FOLDER', path: '' });
    dispatch({ type: 'PENDING_SEMANTIC_NAMES', names: new Set() });
    dispatch({ type: 'PENDING_CONVERSIONS', paths: [] });
    dispatch({ type: 'BLOCKED_CONVERSIONS', paths: [] });
    dispatch({ type: 'CONVERSION_PROGRESS', progress: {} });
    dispatch({ type: 'CONVERSION_SCHEDULER_STATE', revision: 0, versions: {} });
    dispatch({ type: 'INDEX_WARNING', warning: null });
    dispatch({ type: 'PREPARATION_FAILURES', failures: [] });
    dispatch({ type: 'SYNC_RUNNING', running: false });
    dispatch({ type: 'FILE_ORDER_LOADED', order: {} });
  }, [
    dispatch,
    importConversionGrace,
    importIndexGrace,
    keyBackfillGrace,
    lastTreeVersion,
    searchGeneration,
    state,
    syncGeneration,
  ]);

  const finishOpenFolder = useCallback(async (
    expected: { path: string; name: string },
    generation: number,
    opts: { optimisticPendingOnOpen?: boolean } = {},
  ) => {
    if (generation !== openGeneration.current) return;
    const expectedFolderPath = expected.path;
    resetFolderScopedState();
    dispatch({ type: 'COLLAPSE_ALL_FOLDERS' });
    dispatch({
      type: 'FILES_LOADED',
      files: [],
      folders: [],
      folder: expected.name,
      folderPath: expectedFolderPath,
    });
    dispatch({ type: 'WELCOME_HIDE' });
    const [files] = await Promise.all([
      loadFiles(expectedFolderPath),
      loadFileOrder(expectedFolderPath),
    ]);
    if (
      generation !== openGeneration.current
      || state.current.folderPath !== expectedFolderPath
    ) return;
    if (opts.optimisticPendingOnOpen && state.current.embedderHasKey !== false) {
      await markVisibleFilesPendingForSearch(files);
    }
    setTimeout(() => {
      if (
        generation !== openGeneration.current
        || state.current.folderPath !== expectedFolderPath
      ) return;
      void refreshIndexState(expectedFolderPath);
    }, 500);
  }, [
    dispatch,
    loadFileOrder,
    loadFiles,
    markVisibleFilesPendingForSearch,
    openGeneration,
    refreshIndexState,
    resetFolderScopedState,
    state,
  ]);

  const refreshRecent = useCallback(async () => {
    const result = await api.getFolder();
    dispatch({ type: 'RECENT_LOADED', recent: result.recent ?? [], homeDir: result.homeDir });
  }, [dispatch]);

  const openFolder = useCallback(async (path: string) => {
    if (editor.current && !(await flushSave())) {
      throw new Error('Current file could not be saved. Resolve the save error before switching folders.');
    }
    const generation = ++openGeneration.current;
    const opened = await folderMutations.current.run(() => api.openFolder(path));
    const current = opened.current;
    if (!current || generation !== openGeneration.current) return;
    void refreshRecent().catch((err) => {
      console.warn('[recent] refresh after open failed:', err);
    });
    await finishOpenFolder(current, generation);
  }, [editor, finishOpenFolder, flushSave, folderMutations, openGeneration, refreshRecent]);

  const openFolderByName = useCallback(async (
    name: string,
    opts?: { create?: boolean; exclusiveCreate?: boolean; optimisticPendingOnOpen?: boolean },
  ) => {
    if (editor.current && !(await flushSave())) {
      throw new Error('Current file could not be saved. Resolve the save error before switching folders.');
    }
    const generation = ++openGeneration.current;
    const opened = await folderMutations.current.run(() => api.openFolderByName(name, {
      create: opts?.create,
      exclusiveCreate: opts?.exclusiveCreate,
    }));
    const current = opened.current;
    if (!current || generation !== openGeneration.current) return;
    void refreshRecent().catch((err) => {
      console.warn('[recent] refresh after open failed:', err);
    });
    await finishOpenFolder(current, generation, {
      optimisticPendingOnOpen: opts?.optimisticPendingOnOpen,
    });
  }, [editor, finishOpenFolder, flushSave, folderMutations, openGeneration, refreshRecent]);

  const goHome = useCallback(async () => {
    if (editor.current && !(await flushSave())) return false;
    openGeneration.current += 1;
    resetFolderScopedState();
    dispatch({ type: 'FILES_LOADED', files: [], folders: [], folder: '', folderPath: '' });
    dispatch({
      type: 'WELCOME_SHOW',
      recent: state.current.recent,
      homeDir: state.current.homeDir,
    });
    try {
      await folderMutations.current.run(() => api.closeFolder());
    } catch (err: unknown) {
      toast(
        'Could not close the current folder: ' + (err instanceof Error ? err.message : String(err)),
        { level: 'error' },
      );
      return false;
    }
    try {
      const result = await api.getFolder();
      dispatch({
        type: 'WELCOME_SHOW',
        recent: result.recent ?? [],
        homeDir: result.homeDir,
      });
    } catch {
      // Keep the last known library list.
    }
    return true;
  }, [
    dispatch,
    editor,
    flushSave,
    folderMutations,
    openGeneration,
    resetFolderScopedState,
    state,
    toast,
  ]);

  const prepareForFolderRemoval = useCallback((removedPath: string) => {
    if (!state.current.folderPath || !folderRefsEqual(state.current.folderPath, removedPath)) return;
    openGeneration.current += 1;
    resetFolderScopedState();
    dispatch({ type: 'FILES_LOADED', files: [], folders: [], folder: '', folderPath: '' });
    dispatch({
      type: 'WELCOME_SHOW',
      recent: state.current.recent.filter((entry) => !folderRefsEqual(entry.path, removedPath)),
      homeDir: state.current.homeDir,
    });
  }, [dispatch, openGeneration, resetFolderScopedState, state]);

  const handleFolderRemoved = useCallback((removedPath: string) => {
    const affected = Boolean(
      state.current.folderPath
      && folderRefsEqual(state.current.folderPath, removedPath),
    );
    if (affected) prepareForFolderRemoval(removedPath);
    if (affected || state.current.welcomeVisible) {
      void api.getFolder().then((result) => dispatch({
        type: 'WELCOME_SHOW',
        recent: result.recent ?? [],
        homeDir: result.homeDir,
      }))
      .catch(() => { /* Keep the optimistic membership removal. */ });
    }
  }, [dispatch, prepareForFolderRemoval, state]);

  const bootstrap = useCallback(async () => {
    try {
      const result = await api.getFolder();
      dispatch({ type: 'WELCOME_SHOW', recent: result.recent ?? [], homeDir: result.homeDir });
      const initialFolder = new URLSearchParams(window.location.search).get('folder');
      if (initialFolder) {
        window.history.replaceState(null, '', window.location.pathname);
        try {
          if (isAbsoluteFolderRef(initialFolder)) {
            await openFolder(initialFolder);
          } else {
            await openFolderByName(initialFolder);
          }
        } catch (err: unknown) {
          dispatch({
            type: 'WELCOME_SHOW',
            recent: result.recent ?? [],
            homeDir: result.homeDir,
            error: `Could not open "${initialFolder}": ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } else if (result.current) {
        const generation = ++openGeneration.current;
        await finishOpenFolder(result.current, generation);
        const restoredFolderPath = result.current.path;
        if (
          generation === openGeneration.current
          && state.current.folderPath === restoredFolderPath
        ) {
          void api.sync(restoredFolderPath)
            .catch(() => { /* Surfaced by the next status poll. */ })
            .finally(() => { void refreshIndexState(); });
        }
      }
    } catch {
      dispatch({ type: 'WELCOME_SHOW', recent: [], error: 'Server unreachable' });
    }
  }, [
    dispatch,
    finishOpenFolder,
    openFolder,
    openFolderByName,
    openGeneration,
    refreshIndexState,
    state,
  ]);

  return {
    bootstrap,
    goHome,
    handleFolderRemoved,
    openFolder,
    openFolderByName,
    prepareForFolderRemoval,
  };
}
