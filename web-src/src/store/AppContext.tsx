/** React Context composition for the renderer.
 *
 * Pure state lives in `state.ts`; domain hooks own the async action
 * implementations. This module wires their shared refs into one stable
 * `AppActions` surface and owns window-level lifecycle effects.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import {
  api,
  ApiError,
  encodePath,
  getWindowId,
} from '../api';
import {
  getActiveTab,
  initialState,
  reducer,
  type Action,
  type CascadeDecision,
  type PendingHighlight,
  type State,
} from './state';
import type { SearchTypeCategory } from '../../../shared/search-types.ts';
import type { EditorHandle, EditorSession, FindController } from './actionTypes';
import { useDocumentActions } from './useDocumentActions';
import { useFeedbackActions } from './useFeedbackActions';
import { useFileActions } from './useFileActions';
import { useFindActions } from './useFindActions';
import { useFolderActions } from './useFolderActions';
import { useSearchActions } from './useSearchActions';

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
export type { EditorHandle, EditorSession, FindController, FindOptions, MatchInfo } from './actionTypes';

export interface AppActions {
  bootstrap: () => Promise<void>;
  openFolder: (path: string) => Promise<void>;
  /** Open/create a folder by name under the default folder home — a
   *  single path segment. `openFolder(path)` opens any folder in place. */
  openFolderByName: (
    name: string,
    opts?: { create?: boolean; exclusiveCreate?: boolean; optimisticPendingOnOpen?: boolean },
  ) => Promise<void>;
  goHome: () => Promise<boolean>;

  loadFiles: (expectedFolderPath?: string) => Promise<State['files']>;
  /** Optimistically mark the current visible files as pending for search. Used
   *  after the first embedder key is added and immediately after a
   *  folder import opens the new folder, before daemon status can catch
   *  up. */
  markVisibleFilesPendingForSearch: (files?: State['files']) => Promise<void>;
  refreshIndexState: (folderPath?: string) => Promise<void>;
  runSync: () => Promise<void>;
  /** Run a search. Pass `mode` to force a specific routing — useful
   *  when the caller has just dispatched `SEARCH_MODE` and can't rely
   *  on `stateRef` reflecting that yet (it updates after commit, not
   *  in-line with the dispatch). Default reads from state. */
  runSearch: (
    query: string,
    mode?: 'semantic' | 'keyword',
    opts?: {
      caseStrict?: boolean;
      wholeWord?: boolean;
      scope?: string | null;
      types?: SearchTypeCategory[];
    },
  ) => Promise<void>;
  /** Clear the active folder's background-index warning. */
  dismissIndexWarning: () => Promise<void>;
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
  /** Settle the pending cascade dialog with the user's choice. The
   *  rename action awaits this. */
  resolveCascadePrompt: (decision: CascadeDecision) => void;
  /** Show a modal alert and resolve once dismissed. Replaces
   *  `window.alert`. */
  alert: (message: string) => Promise<void>;
  /** Show a modal confirm and resolve to true (OK) / false (Cancel).
   *  Replaces `window.confirm`. */
  confirm: (message: string) => Promise<boolean>;
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
  dismissToast: (id: string) => void;
  /** Clear all toasts at once — backs the "Clear all" control that
   *  appears when the stack has more than one toast (persistent error
   *  toasts otherwise have to be dismissed one by one). */
  clearToasts: () => void;
  toggleEditMode: () => Promise<void>;

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

  registerEditor: (h: EditorHandle | null) => void;
  getEditorSession: (tabId: string) => EditorSession | undefined;
  setEditorSession: (tabId: string, session: EditorSession) => void;
  /** Sidebar SearchBox registers its input element on mount so
   *  `focusSearch` can reach it without a DOM query. Same shape as
   *  `registerEditor` — pass `null` on unmount. */
  registerSearchInput: (el: HTMLInputElement | null) => void;
  /** Focus + select the sidebar search input. Un-collapses the sidebar
   *  first if hidden; flashes a brief glow so the user can tell where
   *  focus landed. Used by the empty-tab landing and the `⌘O` hotkey. */
  focusSearch: () => void;

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

const AppContext = createContext<{
  state: State;
  actions: AppActions;
  dispatch: (a: Action) => void;
} | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  // Sidebar view (Files / Search) is deliberately NOT persisted: every
  // launch lands on Files. The file tree is the canonical landing spot;
  // Search is a task you actively enter, not a state worth restoring.
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlight = useRef<Promise<boolean> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<EditorHandle | null>(null);
  const editorSessions = useRef<Map<string, EditorSession>>(new Map());
  // A session belongs to an open document tab. Reading View temporarily
  // unmounts its editor, but closed/folder-reset tabs must release history.
  useEffect(() => {
    const openTabIds = new Set(state.tabs.map((tab) => tab.id));
    for (const tabId of editorSessions.current.keys()) {
      if (!openTabIds.has(tabId)) editorSessions.current.delete(tabId);
    }
  }, [state.tabs]);
  // Race protection for `runSearch`: every call bumps this counter and
  // remembers its own value; an older request's response is dropped
  // when it returns after a newer one has been issued.
  const searchGen = useRef(0);
  // Same idea for manual sync: switching folders cancels the renderer
  // ownership of the old sync so its `finally` can't clear a newer
  // folder's spinner.
  const syncGen = useRef(0);
  // Opening folders is multi-step (server bind → files/order load →
  // landing file). A newer open/home action invalidates older finishers.
  const openGen = useRef(0);
  // Last `treeVersion` we saw from `/api/index-status`. Any bump means
  // the watcher detected a disk change since last poll → refetch files.
  const lastTreeVersion = useRef<number>(-1);
  /** Recently imported convertible files awaiting server confirmation:
   *  folder-relative path → grace deadline (ms). On import we include a
   *  PDF/image/DOCX in search-readiness accounting immediately, but the server
   *  only registers the conversion after responding. `refreshIndexState`
   *  keeps these in `pendingConversions` until the server starts reporting
   *  them (hand-off) or the grace expires. */
  const importConversionGrace = useRef<Map<string, number>>(new Map());
  /** Same idea for indexed (md/html) imports, which never enter
   *  `pendingConversions`. The daemon serialises `status` behind the very
   *  embeds it would report (`indexer.mfs.ts` status note), so a bare
   *  poll right after a drop under-counts and lags. We optimistically
   *  mark every imported note as pending and
   *  keep it until the UI-visible pending set settles (the batch is done)
   *  or the grace expires. Unlike conversions we do NOT hand off per-file
   *  — mid-embed `pending` is unreliable, so the server sends a dedicated
   *  `visibleIndexingSettled` signal for this renderer-only state. */
  const importIndexGrace = useRef<Map<string, number>>(new Map());
  /** Same optimistic hold after an API key is added. The server schedules
   *  backfill asynchronously, so an immediate status poll can report no
   *  semantic pending work before the sync has started. */
  const keyBackfillGrace = useRef<Map<string, number>>(new Map());
  const {
    askCascadeForRename,
    askConfirm,
    clearToasts,
    dismissToast,
    resolveCascadePrompt,
    resolveModal,
    showAlert,
    toast,
  } = useFeedbackActions(dispatch);
  const {
    closeFind,
    findNext,
    findPrev,
    focusSearch,
    openFind,
    primeFind,
    registerFindController,
    registerSearchInput,
    setFindQuery,
    toggleFindCaseSensitive,
    toggleFindWholeWord,
  } = useFindActions(stateRef, dispatch);

  const loadFilesFromServer = useCallback(async (expectedFolderPath?: string) => {
    const j = await api.listFiles();
    const files = j.files ?? [];
    if (expectedFolderPath !== undefined && stateRef.current.folderPath !== expectedFolderPath) return null;
    dispatch({
      type: 'FILES_LOADED',
      files,
      folders: j.folders ?? [],
      folder: j.folder ?? 'notes',
      folderPath: expectedFolderPath,
    });
    return files;
  }, []);

  const loadFiles = useCallback(async (expectedFolderPath?: string) => {
    try {
      return (await loadFilesFromServer(expectedFolderPath)) ?? [];
    } catch (err: unknown) {
      if (expectedFolderPath !== undefined && stateRef.current.folderPath !== expectedFolderPath) return [];
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
  const loadFileOrder = useCallback(async (expectedFolderPath?: string) => {
    try {
      const order = await api.getFileOrder();
      if (expectedFolderPath !== undefined && stateRef.current.folderPath !== expectedFolderPath) return;
      dispatch({ type: 'FILE_ORDER_LOADED', order });
    } catch {
      if (expectedFolderPath !== undefined && stateRef.current.folderPath !== expectedFolderPath) return;
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
    try {
      if (
        tab.file.format === 'pdf'
        || tab.file.format === 'image'
        || tab.file.format === 'docx'
        || tab.file.format === 'audio'
      ) {
        const stat = await api.statFile(name);
        if (stateRef.current.folderPath !== folderPathAtStart) return;
        const latestActive = getActiveTab(stateRef.current);
        const latestFile = latestActive?.file;
        if (!latestFile || latestFile.name !== name || latestActive.dirty) return;
        if (stat.version !== latestFile.version) {
          dispatch({ type: 'FILE_PATCH', patch: { version: stat.version } });
        }
        if (opts.force) {
          dispatch({ type: 'SAVE_STATUS', status: { text: 'Reloaded from disk', cls: 'saved' } });
        }
        return;
      }
      const body = await api.getFile(name);
      // The active tab may have been swapped (or the file renamed) in
      // the time it took to fetch — re-check before patching.
      if (stateRef.current.folderPath !== folderPathAtStart) return;
      const latestActive = getActiveTab(stateRef.current);
      const latestFile = latestActive?.file;
      if (!latestFile || latestFile.name !== name) return;
      if (opts.force) {
        dispatch({
          type: 'FILE_OPEN',
          body: {
            name,
            format: latestFile.format,
            content: body.content,
            version: 'version' in body ? body.version : undefined,
          },
        });
        dispatch({ type: 'SAVE_STATUS', status: { text: 'Reloaded from disk', cls: 'saved' } });
        return;
      }
      if (latestActive?.dirty) return;
      if (body.content === latestFile.content) return;
      dispatch({
        type: 'FILE_PATCH',
        patch: { content: body.content, ...('version' in body ? { version: body.version } : {}) },
        invalidateEditorSession: latestFile.format === 'md',
      });
    } catch {
      /* swallow — sidebar will reflect a delete on the next poll */
    }
  }, []);

  // An inactive binary tab can miss a watcher refresh while another tab is
  // visible. Re-stat it whenever it becomes active so binary viewers
  // never reuse source bytes from before an external replacement.
  const versionRefreshTab = getActiveTab(state);
  const activeBinaryName = versionRefreshTab?.file
    && (versionRefreshTab.file.format === 'pdf'
      || versionRefreshTab.file.format === 'image'
      || versionRefreshTab.file.format === 'docx'
      || versionRefreshTab.file.format === 'audio')
    ? versionRefreshTab.file.name
    : null;
  const activeBinaryTabId = activeBinaryName ? versionRefreshTab?.id ?? null : null;
  useEffect(() => {
    if (!activeBinaryName || !activeBinaryTabId) return;
    const tabId = activeBinaryTabId;
    const folderPathAtStart = state.folderPath;
    void api.statFile(activeBinaryName).then((stat) => {
      if (stateRef.current.folderPath !== folderPathAtStart) return;
      const latest = getActiveTab(stateRef.current);
      if (latest?.id !== tabId || latest.file?.name !== activeBinaryName) return;
      if (latest.file.version !== stat.version) {
        dispatch({ type: 'FILE_PATCH', patch: { version: stat.version } });
      }
    }).catch(() => {
      // The tree/sidebar refresh owns deletion and error presentation.
    });
  }, [activeBinaryName, activeBinaryTabId, state.folderPath]);

  const {
    dismissIndexWarning,
    markVisibleFilesPendingForSearch,
    refreshIndexState,
    runSearch,
    runSync,
  } = useSearchActions(
    {
      stateRef,
      pollTimer,
      searchGeneration: searchGen,
      syncGeneration: syncGen,
      openGeneration: openGen,
      lastTreeVersion,
      importConversionGrace,
      importIndexGrace,
      keyBackfillGrace,
    },
    {
      loadFiles,
      loadFilesFromServer,
      refreshActiveTabFromDisk,
      toast,
    },
    dispatch,
  );

  const {
    activateTab,
    closeActiveTab,
    closeTab,
    consumePendingHighlight,
    consumePendingScroll,
    flushSave,
    navigateTo,
    newTab,
    openInNewTab,
    registerEditor,
    getEditorSession,
    setEditorSession,
    scheduleSave,
    selectFile,
    selectFileWithHighlight,
    toggleEditMode,
  } = useDocumentActions(
    { state: stateRef, editor: editorRef, editorSessions, saveTimer, saveInFlight },
    { loadFiles, refreshIndexState, toast, primeFind },
    dispatch,
  );
  const {
    deleteFile,
    deleteFolder,
    moveFile,
    newFolder,
    newNote,
    renameFile,
    renameFolder,
    upload,
  } = useFileActions(
    {
      stateRef,
      saveTimer,
      importConversionGrace,
      importIndexGrace,
    },
    {
      askCascadeForRename,
      askConfirm,
      flushSave,
      loadFiles,
      openInNewTab,
      refreshIndexState,
      toast,
    },
    dispatch,
  );

  const { bootstrap, goHome, openFolder, openFolderByName } = useFolderActions(
    {
      state: stateRef,
      editor: editorRef,
      openGeneration: openGen,
      syncGeneration: syncGen,
      searchGeneration: searchGen,
      lastTreeVersion,
      importConversionGrace,
      importIndexGrace,
      keyBackfillGrace,
    },
    {
      flushSave,
      loadFiles,
      loadFileOrder,
      markVisibleFilesPendingForSearch,
      refreshIndexState,
      toast,
    },
    dispatch,
  );


  const actions = useMemo<AppActions>(() => ({
    bootstrap, openFolder, openFolderByName, goHome,
    loadFiles, markVisibleFilesPendingForSearch, refreshIndexState, runSync, runSearch, setFolderOrder,
    dismissIndexWarning,
    selectFile, selectFileWithHighlight, openInNewTab, newTab, closeTab, closeActiveTab, activateTab,
    navigateTo, consumePendingScroll,
    consumePendingHighlight,
    resolveCascadePrompt,
    alert: showAlert, confirm: askConfirm, resolveModal,
    toast, dismissToast, clearToasts,
    toggleEditMode,
    newNote, newFolder, deleteFile, deleteFolder,
    renameFile, renameFolder, moveFile, upload,
    scheduleSave, flushSave,
    registerEditor,
    getEditorSession,
    setEditorSession,
    registerSearchInput, focusSearch,
    registerFindController, openFind, closeFind, setFindQuery,
    toggleFindCaseSensitive, toggleFindWholeWord, findNext, findPrev,
  }), [
    bootstrap, openFolder, openFolderByName, goHome,
    loadFiles, markVisibleFilesPendingForSearch, refreshIndexState, runSync, runSearch, setFolderOrder,
    dismissIndexWarning,
    selectFile, selectFileWithHighlight, openInNewTab, newTab, closeTab, closeActiveTab, activateTab,
    navigateTo, consumePendingScroll,
    consumePendingHighlight,
    resolveCascadePrompt,
    showAlert, askConfirm, resolveModal, toast, dismissToast, clearToasts,
    toggleEditMode,
    newNote, newFolder, deleteFile, deleteFolder,
    renameFile, renameFolder, moveFile, upload,
    scheduleSave, flushSave,
    registerEditor,
    getEditorSession,
    setEditorSession,
    registerSearchInput, focusSearch,
    registerFindController, openFind, closeFind, setFindQuery,
    toggleFindCaseSensitive, toggleFindWholeWord, findNext, findPrev,
  ]);

  // Bootstrap + start polling on first mount.
  useEffect(() => {
    void actions.bootstrap();
    void actions.refreshIndexState();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile on window focus — the replacement for the old fs.watch
  // layer. External edits made while StashBase wasn't focused (vim, git
  // checkout, scripts) fold in the moment the user comes back; while the
  // app IS focused, in-app and agent writes index on their own write
  // paths, so nothing is lost by not watching. Throttled so rapid
  // focus/blur cycles don't stack syncs; results surface through the
  // regular index-status poll (treeVersion bumps server-side).
  useEffect(() => {
    let lastFocusSync = 0;
    function onFocus() {
      const focusFolder = stateRef.current.folderPath;
      if (!focusFolder) return;
      const now = Date.now();
      if (now - lastFocusSync < 5000) return;
      lastFocusSync = now;
      void api.sync(focusFolder)
        .catch(() => { /* surfaced by the next status poll */ })
        .finally(() => { void refreshIndexState(); });
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshIndexState]);

  // Best-effort flush before unload. `sendBeacon` keeps the POST alive
  // past page teardown.
  useEffect(() => {
    function onUnload() {
      const cur = getActiveTab(stateRef.current)?.file ?? null;
      const h = editorRef.current;
      const liveValue = h?.getValue();
      if (cur && h && liveValue !== undefined && liveValue !== cur.content) {
        if (saveTimer.current !== null) {
          clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
        try {
          const qs = `?windowId=${encodeURIComponent(getWindowId())}`;
          const endpoint = `/api/files/${encodePath(cur.name)}${qs}`;
          navigator.sendBeacon?.(
            endpoint,
            new Blob(
              [JSON.stringify({ content: liveValue, ...(cur.version ? { baseVersion: cur.version } : {}) })],
              { type: 'application/json' },
            ),
          );
        } catch { /* swallow */ }
      }
    }
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

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
