/** React Context composition for the renderer.
 *
 * Pure state lives in `state.ts`. Shell-owned interaction hooks are composed
 * here; active-folder orchestration lives in `useActiveFolderWorkspace.ts`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import {
  api,
  ApiError,
} from '../api';
import {
  getActiveTab,
  initialState,
  makeChatTab,
  reducer,
  type Action,
  type CascadeDecision,
  type PendingHighlight,
  type State,
} from './state';
import type { AgentKind } from '../agentCatalog';
import { rememberPreferredAgent } from '../agentPreference';
import type { EditorHandle, FindController } from './actionTypes';
import { useLatestRef } from '../hooks/useLatestRef';
import { useFeedbackActions } from './useFeedbackActions';
import { useFindActions } from './useFindActions';
import { useActiveFolderWorkspace } from './useActiveFolderWorkspace';

// Re-export the state types from a single barrel so consumers that
// import from `'../store/AppContext'` keep working. The Provider
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
} from './state';
export type { EditorHandle, FindController, FindOptions, MatchInfo } from './actionTypes';

export interface AppActions {
  bootstrap: () => Promise<void>;
  openFolder: (path: string) => Promise<void>;
  /** Open/create a folder by name under the default folder home — a
   *  single path segment. `openFolder(path)` opens any folder in place. */
  openFolderByName: (
    name: string,
    opts?: { create?: boolean; exclusiveCreate?: boolean; optimisticPendingOnOpen?: boolean },
  ) => Promise<void>;

  loadFiles: (expectedFolderPath?: string) => Promise<State['files']>;
  /** Optimistically mark the current visible files as pending for search. Used
   *  after the first embedder key is added and immediately after a
   *  folder import opens the new folder, before daemon status can catch
   *  up. */
  markVisibleFilesPendingForSearch: (files?: State['files']) => Promise<void>;
  refreshIndexState: (folderPath?: string) => Promise<void>;
  runSync: () => Promise<void>;
  /** Clear the active folder's background-index warning. */
  dismissIndexWarning: () => Promise<void>;
  decideSemanticIndexing: (decision: 'start' | 'defer') => Promise<void>;
  /** Replace a folder's ordered child list (manual sidebar ordering).
   *  Optimistic — state updates immediately, then a PUT is fired.
   *  Failure of the PUT rolls the renderer back to whatever the server
   *  has next time we reload. */
  setFolderOrder: (parentPath: string, names: string[]) => Promise<void>;

  selectFile: (name: string) => Promise<void>;
  /** Same as `selectFile` but additionally arms the viewer to highlight
   *  a specific chunk on next render (typically from a search hit
   *  click). HTML / MD / Code viewers use `startLine` / `endLine` for
   *  line-range overlay; PdfPreview uses `chunkText` to find the
   *  passage via pdfjs's find controller. */
  selectFileWithHighlight: (name: string, hit: PendingHighlight) => Promise<void>;
  /** Open a search hit by (member folder, rel path). Same-folder targets go
   *  through normal selection; anything else opens a read-only
   *  out-of-folder tab WITHOUT switching the window's folder. */
  openLibraryFile: (folder: string, name: string, opts?: { hit?: PendingHighlight; anchor?: string }) => Promise<void>;
  /** Open a file in a new tab (double-click in sidebar / drag-out
   *  semantics). Always creates a new tab even if the file is already
   *  open in another tab — VS Code does the same with the explicit
   *  "Open in New Tab" command. */
  openInNewTab: (name: string) => Promise<void>;
  newTab: () => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  /** Close whichever tab is currently active. Convenience for keyboard
   *  shortcuts (`⌘W`) and UI buttons that don't have a tab id handy. */
  closeActiveTab: () => Promise<void>;
  activateTab: (id: string) => Promise<void>;
  openExternalFilePath: (filePath: string, opts?: { suppressToast?: boolean }) => Promise<{ ok: boolean; error?: string } | void>;
  openExternalFiles: (files: File[]) => Promise<void>;
  /** Cross-file link nav: open `name` (with optional anchor) and push a
   *  new entry into the back/forward stack. Used by preview iframes
   *  forwarding `<a>` clicks. */
  navigateTo: (name: string, anchor?: string) => Promise<void>;
  /** Called by the preview iframe after it has consumed the pending
   *  anchor / scrollY so a follow-up keystroke / re-render won't
   *  re-scroll. */
  consumePendingScroll: () => void;
  /** Called by the viewer after it has applied a pending-highlight
   *  (rendered the chunk overlay / kicked off the PDF text search)
   *  so a re-render doesn't re-trigger the effect. */
  consumePendingHighlight: () => void;
  /** Update the last viewed PDF page for tabId to page. */
  updateTabPdfPage: (tabId: string, page: number) => void;
  /** Settle the pending cascade dialog with the user's choice. The
   *  rename action awaits this. */
  resolveCascadePrompt: (decision: CascadeDecision) => void;
  /** Show a modal alert and resolve once dismissed. Replaces
   *  `window.alert`. */
  alert: (message: string) => Promise<void>;
  /** Show a modal confirm and resolve to true (OK) / false (Cancel).
   *  Replaces `window.confirm`. Options title the dialog and restyle the
   *  action button; omitted, it renders the generic 'Confirm action'. */
  confirm: (
    message: string,
    opts?: { title?: string; confirmLabel?: string; destructive?: boolean },
  ) => Promise<boolean>;
  /** Settle the pending alert/confirm modal with the user's choice.
   *  Called by the rendered modal's buttons. */
  resolveModal: (value: boolean) => void;
  /** Push a toast — lightweight non-blocking feedback. Use this for
   *  "operation succeeded / failed" messages instead of `alert` when
   *  the user can just keep working. Returns the new toast's id so
   *  the caller can dismiss it programmatically (e.g. when a long-
   *  running operation finally settles).
   *
   *  Default ttl: info / success 3000ms, warning 5000ms, error null
   *  (persistent — error toasts only go away when the user dismisses them). */
  toast: (
    message: string,
    opts?: {
      level?: 'info' | 'success' | 'warning' | 'error';
      ttl?: number | null;
      action?: { label: string; onClick: () => void };
    },
  ) => string;
  toggleEditMode: () => Promise<void>;
  setUnsupportedModalOpen: (open: boolean) => void;
  /** Reveal an existing Agent Panel session or create its first tab. This only
   * changes renderer layout; permissions and Agent context remain unchanged. */
  openAgent: (agent: AgentKind) => void;

  newNote: () => Promise<void>;
  newFolder: (path: string) => Promise<void>;
  deleteFile: (name: string) => Promise<void>;
  deleteFolder: (path: string) => Promise<void>;
  renameFile: (oldName: string, newBaseName: string) => Promise<void>;
  renameFolder: (oldPath: string, newName: string) => Promise<void>;
  moveFile: (oldPath: string, targetDir: string) => Promise<boolean>;
  upload: (items: { file: File; relPath: string }[], dir: string) => Promise<boolean>;

  scheduleSave: () => void;
  flushSave: () => Promise<boolean>;

  /** Resolve a save-conflict by overwriting the disk file with the editor's current content. */
  resolveConflictOverwrite: (tabId: string) => Promise<void>;
  /** Resolve a save-conflict by reloading the disk version, discarding unsaved edits. */
  resolveConflictReload: (tabId: string) => Promise<void>;
  /** Resolve a save-conflict by inserting inline conflict markers and returning to the editor. */
  resolveConflictMerge: (tabId: string) => Promise<void>;

  registerEditor: (h: EditorHandle | null) => void;

  /** A view registers its find driver on mount; `null` on unmount.
   *  Switching tabs / toggling edit mode replaces it. */
  registerFindController: (c: FindController | null) => void;
  /** Open the in-document find bar (Cmd+F). No-op if already open;
   *  the bar's own effect re-focuses the input on re-open. */
  openFind: () => void;
  /** Close the find bar + tear down whatever the active controller
   *  highlighted. Also called implicitly on folder switch / tab close. */
  closeFind: () => void;
  setFindQuery: (q: string) => void;
  toggleFindCaseSensitive: () => void;
  toggleFindWholeWord: () => void;
  findNext: () => void;
  findPrev: () => void;
}

export const AppContext = createContext<{
  state: State;
  actions: AppActions;
  dispatch: (a: Action) => void;
} | null>(null);

/** Re-check external text refresh ownership after its asynchronous disk read. */
export function canApplyExternalTextRefresh(
  state: State,
  folderPathAtStart: string,
  name: string,
): boolean {
  const latest = getActiveTab(state);
  return state.folderPath === folderPathAtStart
    && latest?.file?.name === name
    && !latest.dirty;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useLatestRef(state);
  // Folder transitions update this ref before React commits. Async tree/order
  // refreshes use it as their ownership boundary so an old folder cannot
  // repopulate the workspace during the render gap.
  const folderContextPath = useRef(state.folderPath);
  folderContextPath.current = state.folderPath;
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
  ) => {
    const j = await api.listFiles();
    const files = j.files ?? [];
    const requestIsCurrent = ownsRequest
      ? ownsRequest()
      : expectedFolderPath === undefined || folderContextPath.current === expectedFolderPath;
    if (!requestIsCurrent) return null;
    dispatch({
      type: 'FILES_LOADED',
      files,
      folders: j.folders ?? [],
      folder: j.folder ?? 'notes',
      folderPath: expectedFolderPath,
      unsupportedFiles: j.unsupportedFiles,
    });
    return files;
  }, []);

  const loadFiles = useCallback(async (
    expectedFolderPath?: string,
    ownsRequest?: () => boolean,
  ) => {
    try {
      return (await loadFilesFromServer(expectedFolderPath, ownsRequest)) ?? [];
    } catch (err: unknown) {
      const requestIsCurrent = ownsRequest
        ? ownsRequest()
        : expectedFolderPath === undefined || folderContextPath.current === expectedFolderPath;
      if (!requestIsCurrent) return [];
      const fallbackFolder = err instanceof ApiError && err.status === 412
        ? ''
        : stateRef.current.folder;
      dispatch({
        type: 'FILES_LOADED',
        files: [],
        folders: [],
        folder: fallbackFolder,
        folderPath: fallbackFolder ? stateRef.current.folderPath : '',
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
    const tab = getActiveTab(stateRef.current);
    if (!tab?.file) return;
    if (tab.dirty && !opts.force) return;
    const folderPathAtStart = stateRef.current.folderPath;
    const name = tab.file.name;
    // Out-of-folder tabs re-read against their own folder — a bare rel
    // fetch would resolve a same-named file in the ACTIVE folder.
    const libraryFolder = tab.file.folder;
    const readOpts = libraryFolder ? { folder: libraryFolder } : undefined;
    const sameDocument = (file: { name: string; folder?: string } | null | undefined) =>
      !!file && file.name === name && file.folder === libraryFolder;
    try {
      if (tab.file.isExternal) {
        const { refreshExternalFile } = await import('./externalFileRefresh');
        await refreshExternalFile({
          file: tab.file,
          folderPathAtStart,
          force: opts.force === true,
          getFolderPath: () => stateRef.current.folderPath,
          getActiveFile: () => getActiveTab(stateRef.current)?.file ?? null,
          dispatch,
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
        if (stateRef.current.folderPath !== folderPathAtStart) return;
        const latestActive = getActiveTab(stateRef.current);
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
      if (!canApplyExternalTextRefresh(stateRef.current, folderPathAtStart, name) && !opts.force) return;
      if (stateRef.current.folderPath !== folderPathAtStart) return;
      const latestActive = getActiveTab(stateRef.current);
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

  const actions = useMemo<AppActions>(() => ({
    bootstrap: workspace.bootstrap, openFolder: workspace.openFolder, openFolderByName: workspace.openFolderByName,
    loadFiles: workspace.loadFiles, markVisibleFilesPendingForSearch: workspace.markVisibleFilesPendingForSearch,
    refreshIndexState: workspace.refreshIndexState, runSync: workspace.runSync,
    setFolderOrder: workspace.setFolderOrder, dismissIndexWarning: workspace.dismissIndexWarning,
    decideSemanticIndexing: workspace.decideSemanticIndexing,
    selectFile: workspace.selectFile, selectFileWithHighlight: workspace.selectFileWithHighlight,
    openLibraryFile: workspace.openLibraryFile,
    openInNewTab: workspace.openInNewTab, newTab: workspace.newTab, closeTab: workspace.closeTab,
    closeActiveTab: workspace.closeActiveTab, activateTab: workspace.activateTab,
    openExternalFilePath: workspace.openExternalFilePath, openExternalFiles: workspace.openExternalFiles,
    navigateTo: workspace.navigateTo, consumePendingScroll: workspace.consumePendingScroll,
    consumePendingHighlight: workspace.consumePendingHighlight,
    updateTabPdfPage: workspace.updateTabPdfPage,
    resolveCascadePrompt,
    alert: showAlert, confirm: askConfirm, resolveModal,
    toast,
    toggleEditMode: workspace.toggleEditMode,
    setUnsupportedModalOpen: workspace.setUnsupportedModalOpen,
    openAgent: (agent) => {
      rememberPreferredAgent(agent);
      const current = stateRef.current;
      const hasOpenTab = current.chatTabs.some((tab) => tab.agent === agent);
      dispatch({
        type: 'CHAT_AGENT_OPEN',
        agent,
        tab: hasOpenTab ? undefined : makeChatTab(agent, current.chatTabs),
      });
    },
    newNote: workspace.newNote, newFolder: workspace.newFolder, deleteFile: workspace.deleteFile, deleteFolder: workspace.deleteFolder,
    renameFile: workspace.renameFile, renameFolder: workspace.renameFolder, moveFile: workspace.moveFile, upload: workspace.upload,
    scheduleSave: workspace.scheduleSave, flushSave: workspace.flushSave,
    resolveConflictOverwrite: workspace.resolveConflictOverwrite,
    resolveConflictReload: workspace.resolveConflictReload,
    resolveConflictMerge: workspace.resolveConflictMerge,
    registerEditor: workspace.registerEditor,
    registerFindController, openFind, closeFind, setFindQuery,
    toggleFindCaseSensitive, toggleFindWholeWord, findNext, findPrev,
  }), [
    workspace,
    resolveCascadePrompt,
    showAlert, askConfirm, resolveModal, toast,
    registerFindController, openFind, closeFind, setFindQuery,
    toggleFindCaseSensitive, toggleFindWholeWord, findNext, findPrev,
  ]);


  const value = useMemo(() => ({ state, actions, dispatch }), [state, actions]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  // Derive the active tab once per render so consumers don't repeat the
  // lookup. `null` when there are no tabs (initial / after closing the
  // last tab) — components that depended on the old `state.current`
  // should now read `activeTab?.file`.
  const activeTab = ctx.state.activeTabId
    ? ctx.state.tabs.find((t) => t.id === ctx.state.activeTabId) ?? null
    : null;
  return { ...ctx, activeTab };
}
