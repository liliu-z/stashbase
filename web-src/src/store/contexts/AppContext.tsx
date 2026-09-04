/** React Context composition for the renderer.
 *
 * Pure state lives in `state.ts`. Shell-owned interaction hooks are composed
 * here; active-folder orchestration lives in `useActiveFolderWorkspace.ts`.
 *
 * State is NOT delivered through one merged context. `AppProvider` owns the
 * single `useReducer` and the action hooks, then hands the resulting
 * `state` / `actions` / `dispatch` to `AppProviders`, which mounts four
 * independent contexts side by side: `WorkspaceContext`, `ChatContext`, and
 * `UiShellContext` (each publishing the one nested slice of `State` it owns,
 * which the composed reducer rebuilds only for that slice's own actions), and
 * `ActionsContext` (stable across every dispatch, so it doesn't need
 * slicing). Components call `useWorkspace()`,
 * `useChat()`, `useUiShell()`, and/or `useAppActions()` for exactly what
 * they read — never a merged `useApp()` — so a dispatch that only touches
 * one slice can't re-render a component that reads a different one.
 * `AppProviders` is also what test harnesses use to inject fake state
 * without going through the real reducer.
 */
import {
  useCallback,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import {
  api,
  ApiError,
} from '@/common/api/api';
import {
  getActiveTab,
  initialState,
  makeChatTab,
  reducer,
  type State,
  type WorkspaceSlice,
} from '@/store/state/state';
import { rememberPreferredAgent } from '@/common/lib/agentPreference';
import { openGalleryOverlay } from '@/common/lib/galleryTrigger';
import { newChatPlan } from '@/store/lib/chatTabPlan';
import { useLatestRef } from '@/common/hooks/useLatestRef';
import { useFeedbackActions } from '@/store/hooks/useFeedbackActions';
import { useFindActions } from '@/store/hooks/useFindActions';
import { createFileListingGeneration } from '@/store/lib/fileListingGeneration';
import {
  useActiveFolderWorkspace,
  type LoadedFileListing,
} from '@/store/hooks/useActiveFolderWorkspace';
import { ActionsProvider, type AppActions } from './ActionsContext';
import { WorkspaceProvider } from './WorkspaceContext';
import { ChatProvider } from './ChatContext';
import { UiShellProvider } from './UiShellContext';

// Re-export the state types from a single barrel so consumers that
// import from `'@/store/contexts/AppContext'` keep working. The Provider
// itself owns the React-side surface (AppActions, EditorHandle); the
// data shapes live in `state.ts`.
export type {
  Action,
  CascadeDecision,
  CascadePrompt,
  CtxMenu,
  ModalRequest,
  OpenFile,
  PendingHighlight,
  SaveStatus,
  State,
  Tab,
} from '@/store/state/state';
export type { EditorHandle, FindController, FindOptions, MatchInfo } from '@/store/state/editorTypes';
export type { AppActions } from './ActionsContext';
export { useWorkspace, type WorkspaceState } from './WorkspaceContext';
export { useChat, type ChatState } from './ChatContext';
export { useUiShell, type UiShellState } from './UiShellContext';
export { useAppActions, type AppActionsValue } from './ActionsContext';

/** Re-check external text refresh ownership after its asynchronous disk read. */
export function canApplyExternalTextRefresh(
  workspace: WorkspaceSlice,
  folderPathAtStart: string,
  name: string,
): boolean {
  const latest = getActiveTab(workspace);
  return workspace.folderPath === folderPathAtStart
    && latest?.file?.name === name
    && !latest.dirty;
}

class FileListingRequestError {
  constructor(
    readonly cause: unknown,
    readonly isCurrent: () => boolean,
  ) {}
}

/**
 * Mounts the four state/action contexts around `children` from an already-
 * computed `state` / `actions` / `dispatch` triple. `AppProvider` (below)
 * is the production caller; test harnesses that need to inject fake state
 * without the real reducer call this directly instead of reaching for a
 * removed merged context.
 */
export function AppProviders({
  state,
  actions,
  dispatch,
  children,
}: {
  state: State;
  actions: AppActions;
  dispatch: (a: import('@/store/state/state').Action) => void;
  children: ReactNode;
}) {
  return (
    <ActionsProvider actions={actions} dispatch={dispatch}>
      <WorkspaceProvider state={state}>
        <ChatProvider state={state}>
          <UiShellProvider state={state}>
            {children}
          </UiShellProvider>
        </ChatProvider>
      </WorkspaceProvider>
    </ActionsProvider>
  );
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useLatestRef(state);
  // Folder transitions update this ref before React commits. Async tree/order
  // refreshes use it as their ownership boundary so an old folder cannot
  // repopulate the workspace during the render gap.
  const folderContextPath = useRef(state.workspace.folderPath);
  folderContextPath.current = state.workspace.folderPath;
  // Every listing shares one ownership generation. A slow response issued
  // before a newer preference write or tree refresh must not restore stale
  // visibility after the newer listing has started.
  const fileListingGeneration = useRef(createFileListingGeneration());
  const {
    askCascadeForRename,
    askConfirm,
    resolveCascadePrompt,
    resolveModal,
    showAlert,
    toast,
  } = useFeedbackActions(dispatch);
  const {
    closeFind,
    findNext,
    findPrev,
    openFind,
    primeFind,
    registerFindController,
    setFindQuery,
    toggleFindCaseSensitive,
    toggleFindWholeWord,
  } = useFindActions(stateRef, dispatch);

  const loadFilesFromServer = useCallback(async (
    expectedFolderPath?: string,
    ownsRequest?: () => boolean,
  ): Promise<LoadedFileListing | null> => {
    const ownership = fileListingGeneration.current.begin(() => ownsRequest
      ? ownsRequest()
      : expectedFolderPath === undefined || folderContextPath.current === expectedFolderPath);
    const { isCurrent } = ownership;
    let j: Awaited<ReturnType<typeof api.listFiles>>;
    try {
      j = await api.listFiles();
    } catch (err: unknown) {
      // A stale failure has no authority to clear or otherwise replace a
      // newer successful tree. Current failures keep their existing recovery
      // behavior in `loadFiles` below.
      if (!isCurrent()) return null;
      throw new FileListingRequestError(err, isCurrent);
    }
    const files = j.files ?? [];
    if (!isCurrent()) return null;
    dispatch({
      type: 'FILES_LOADED',
      files,
      folders: j.folders ?? [],
      folder: j.folder ?? 'notes',
      folderPath: expectedFolderPath,
      ...(typeof j.showHiddenFiles === 'boolean' ? { showHiddenFiles: j.showHiddenFiles } : {}),
    });
    return { files, isCurrent };
  }, []);

  const loadFiles = useCallback(async (
    expectedFolderPath?: string,
    ownsRequest?: () => boolean,
  ) => {
    try {
      return (await loadFilesFromServer(expectedFolderPath, ownsRequest))?.files ?? [];
    } catch (failure: unknown) {
      if (failure instanceof FileListingRequestError && !failure.isCurrent()) return [];
      const err = failure instanceof FileListingRequestError ? failure.cause : failure;
      const requestIsCurrent = ownsRequest
        ? ownsRequest()
        : expectedFolderPath === undefined || folderContextPath.current === expectedFolderPath;
      if (!requestIsCurrent) return [];
      const fallbackFolder = err instanceof ApiError && err.status === 412
        ? ''
        : stateRef.current.workspace.folder;
      dispatch({
        type: 'FILES_LOADED',
        files: [],
        folders: [],
        folder: fallbackFolder,
        folderPath: fallbackFolder ? stateRef.current.workspace.folderPath : '',
      });
      return [];
    }
  }, [loadFilesFromServer]);

  /** Fetch the per-folder manual ordering map. Called alongside
   *  `loadFiles` on folder switch and on bootstrap. Errors are
   *  swallowed — the tree falls back to default sort. */
  const loadFileOrder = useCallback(async (
    expectedFolderPath?: string,
    ownsRequest?: () => boolean,
  ) => {
    try {
      const order = await api.getFileOrder();
      const requestIsCurrent = ownsRequest
        ? ownsRequest()
        : expectedFolderPath === undefined || folderContextPath.current === expectedFolderPath;
      if (!requestIsCurrent) return;
      dispatch({ type: 'FILE_ORDER_LOADED', order });
    } catch {
      const requestIsCurrent = ownsRequest
        ? ownsRequest()
        : expectedFolderPath === undefined || folderContextPath.current === expectedFolderPath;
      if (!requestIsCurrent) return;
      dispatch({ type: 'FILE_ORDER_LOADED', order: {} });
    }
  }, []);

  const setFolderOrder = useCallback(async (parentPath: string, names: string[]) => {
    // Optimistic — render the new order now, persist behind it.
    dispatch({ type: 'FILE_ORDER_SET', parentPath, names });
    try {
      await api.putFileOrder(parentPath, names);
    } catch (err) {
      console.warn('[file-order] PUT failed; will resync on next folder load', err);
    }
  }, []);

  /** Re-fetch the active tab's body from disk and patch the open file
   *  if it changed. Used after the watcher detects an external edit
   *  (typically: Claude Code wrote to the file via its `Edit` tool from
   *  the panel). No-op when nothing's open, when the active tab is dirty
   *  (would clobber the unsaved buffer), or when disk + tab
   *  agree. `force` is only for an explicit user reload after a save
   *  conflict; it discards the editor buffer and reopens the tab from
   *  disk. Failures are swallowed — the sidebar reload that runs in
   *  the same poll cycle covers the "file got deleted externally" case. */
  const refreshActiveTabFromDisk = useCallback(async (opts: { force?: boolean } = {}) => {
    const tab = getActiveTab(stateRef.current.workspace);
    if (!tab?.file) return;
    if (tab.dirty && !opts.force) return;
    const folderPathAtStart = stateRef.current.workspace.folderPath;
    const name = tab.file.name;
    // Out-of-folder tabs re-read against their own folder — a bare rel
    // fetch would resolve a same-named file in the ACTIVE folder.
    const libraryFolder = tab.file.folder;
    const readOpts = libraryFolder ? { folder: libraryFolder } : undefined;
    const sameDocument = (file: { name: string; folder?: string } | null | undefined) =>
      !!file && file.name === name && file.folder === libraryFolder;
    try {
      if (tab.file.format === 'generic') {
        const genericPreview = await api.getGenericFilePreview(name, readOpts);
        if (stateRef.current.workspace.folderPath !== folderPathAtStart) return;
        const latestActive = getActiveTab(stateRef.current.workspace);
        const latestFile = latestActive?.file;
        if (!sameDocument(latestFile) || latestActive?.dirty) return;
        dispatch({
          type: 'FILE_PATCH',
          patch: {
            genericPreview,
            content: genericPreview.kind === 'text' ? genericPreview.content : '',
            version: genericPreview.kind === 'text' ? genericPreview.version : undefined,
          },
        });
        return;
      }
      if (
        tab.file.format === 'pdf'
        || tab.file.format === 'image'
        || tab.file.format === 'docx'
        || tab.file.format === 'audio'
      ) {
        const stat = await api.statFile(name, readOpts);
        if (stateRef.current.workspace.folderPath !== folderPathAtStart) return;
        const latestActive = getActiveTab(stateRef.current.workspace);
        const latestFile = latestActive?.file;
        if (!sameDocument(latestFile) || latestActive?.dirty) return;
        if (stat.version !== latestFile!.version) {
          dispatch({ type: 'FILE_PATCH', patch: { version: stat.version } });
        }
        if (opts.force) {
          dispatch({ type: 'SAVE_STATUS', status: { text: 'Reloaded from disk', cls: 'saved' } });
        }
        return;
      }
      const body = await api.getFile(name, readOpts);
      // The active tab may have been swapped (or the file renamed) in
      // the time it took to fetch — re-check before patching.
      if (!canApplyExternalTextRefresh(stateRef.current.workspace, folderPathAtStart, name) && !opts.force) return;
      if (stateRef.current.workspace.folderPath !== folderPathAtStart) return;
      const latestActive = getActiveTab(stateRef.current.workspace);
      const latestFile = latestActive?.file;
      if (!sameDocument(latestFile)) return;
      if (opts.force) {
        dispatch({
          type: 'FILE_OPEN',
          body: {
            name,
            format: latestFile!.format,
            content: body.content,
            version: 'version' in body ? body.version : undefined,
          },
          libraryFolder,
        });
        dispatch({ type: 'SAVE_STATUS', status: { text: 'Reloaded from disk', cls: 'saved' } });
        return;
      }
      if (latestActive?.dirty) return;
      if (body.content === latestFile!.content) return;
      dispatch({
        type: 'FILE_PATCH',
        patch: { content: body.content, ...('version' in body ? { version: body.version } : {}) },
      });
    } catch {
      /* swallow — sidebar will reflect a delete on the next poll */
    }
  }, []);

  // The workspace owns all folder/document liveness bookkeeping internally;
  // the shell hands over only the always-current state ref plus callbacks.
  const workspace = useActiveFolderWorkspace(stateRef, {
    folderContextPath,
    state,
    dispatch,
    loadFiles,
    loadFilesFromServer,
    loadFileOrder,
    setFolderOrder,
    refreshActiveTabFromDisk,
    askCascadeForRename,
    askConfirm,
    toast,
    primeFind,
  });

  const actions = useMemo<AppActions>(() => {
    const activateChatTab: AppActions['activateChatTab'] = (agent) => {
      rememberPreferredAgent(agent);
      const current = stateRef.current.chat;
      const plan = newChatPlan(current.chatTabs, agent);
      if (plan.kind === 'reuse') {
        if (plan.switchAgent) dispatch({ type: 'CHAT_TAB_SET_AGENT', id: plan.id, agent });
        dispatch({ type: 'CHAT_TAB_ACTIVATE', id: plan.id });
      } else {
        dispatch({ type: 'CHAT_TAB_NEW', tab: makeChatTab(agent, current.chatTabs) });
      }
      if (!current.chatOpen) dispatch({ type: 'CHAT_TOGGLE' });
    };
    return {
    bootstrap: workspace.bootstrap, openFolder: workspace.openFolder, openFolderByName: workspace.openFolderByName,
    loadFiles: workspace.loadFiles, markVisibleFilesPendingForSearch: workspace.markVisibleFilesPendingForSearch,
    refreshIndexState: workspace.refreshIndexState, runSync: workspace.runSync,
    setFolderOrder: workspace.setFolderOrder, dismissIndexWarning: workspace.dismissIndexWarning,
    decideSemanticIndexing: workspace.decideSemanticIndexing,
    selectFile: workspace.selectFile, selectFileWithHighlight: workspace.selectFileWithHighlight,
    openLibraryFile: workspace.openLibraryFile,
    openInNewTab: workspace.openInNewTab, newTab: workspace.newTab, closeTab: workspace.closeTab,
    closeActiveTab: workspace.closeActiveTab, activateTab: workspace.activateTab,
    navigateTo: workspace.navigateTo, consumePendingScroll: workspace.consumePendingScroll,
    consumePendingHighlight: workspace.consumePendingHighlight,
    updateTabPdfPage: workspace.updateTabPdfPage,
    resolveCascadePrompt,
    alert: showAlert, confirm: askConfirm, resolveModal,
    toast,
    toggleEditMode: workspace.toggleEditMode,
    openAgent: (agent) => {
      rememberPreferredAgent(agent);
      const current = stateRef.current.chat;
      const hasOpenTab = current.chatTabs.some((tab) => tab.agent === agent);
      dispatch({
        type: 'CHAT_AGENT_OPEN',
        agent,
        tab: hasOpenTab ? undefined : makeChatTab(agent, current.chatTabs),
      });
    },
    activateChatTab,
    openGallery: () => openGalleryOverlay(),
    newNote: workspace.newNote, newFolder: workspace.newFolder, deleteFile: workspace.deleteFile, deleteFolder: workspace.deleteFolder,
    renameFile: workspace.renameFile, renameFolder: workspace.renameFolder, moveFile: workspace.moveFile,
    reprocessFile: workspace.reprocessFile, revealFile: workspace.revealFile, toggleShowHiddenFiles: workspace.toggleShowHiddenFiles, copyFileLink: workspace.copyFileLink, upload: workspace.upload,
    scheduleSave: workspace.scheduleSave, flushSave: workspace.flushSave,
    resolveConflictOverwrite: workspace.resolveConflictOverwrite,
    resolveConflictReload: workspace.resolveConflictReload,
    resolveConflictMerge: workspace.resolveConflictMerge,
    registerEditor: workspace.registerEditor,
    registerFindController, openFind, closeFind, setFindQuery,
    toggleFindCaseSensitive, toggleFindWholeWord, findNext, findPrev,
    };
  }, [
    workspace,
    resolveCascadePrompt,
    showAlert, askConfirm, resolveModal, toast,
    registerFindController, openFind, closeFind, setFindQuery,
    toggleFindCaseSensitive, toggleFindWholeWord, findNext, findPrev,
  ]);

  return (
    <AppProviders state={state} actions={actions} dispatch={dispatch}>
      {children}
    </AppProviders>
  );
}
