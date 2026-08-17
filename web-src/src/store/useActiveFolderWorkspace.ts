/**
 * The active-folder workspace is the renderer's working context for one local
 * folder. It owns folder/document/retrieval transitions and their liveness
 * rules. Shell presentation (chat, modals, toasts, Find UI, and layout) stays
 * outside this module and crosses its small interaction seams as callbacks.
 */
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { api, encodePath, getWindowId } from '../api';
import { electronBridge } from '../electronBridge';
import { getActiveTab, type Action, type PendingHighlight, type State } from './state';
import type { EditorHandle } from './actionTypes';
import { useDocumentActions } from './useDocumentActions';
import { useFileActions } from './useFileActions';
import { useFolderActions } from './useFolderActions';
import { useSearchActions } from './useSearchActions';

type Dispatch = (action: Action) => void;
const ACTIVATION_REVALIDATED_FORMATS = new Set(['md', 'pdf', 'image', 'docx', 'audio']);

type Toast = (message: string, opts?: {
  level?: 'info' | 'success' | 'warning' | 'error';
  ttl?: number | null;
  action?: { label: string; onClick: () => void };
}) => string;

export interface ActiveFolderWorkspace {
  bootstrap: () => Promise<void>;
  openFolder: (path: string) => Promise<void>;
  openFolderByName: (
    name: string,
    opts?: { create?: boolean; exclusiveCreate?: boolean; optimisticPendingOnOpen?: boolean },
  ) => Promise<void>;
  loadFiles: (expectedFolderPath?: string) => Promise<State['files']>;
  markVisibleFilesPendingForSearch: (files?: State['files']) => Promise<void>;
  refreshIndexState: (folderPath?: string) => Promise<void>;
  runSync: () => Promise<void>;
  dismissIndexWarning: () => Promise<void>;
  decideSemanticIndexing: (decision: 'start' | 'defer') => Promise<void>;
  setFolderOrder: (parentPath: string, names: string[]) => Promise<void>;
  selectFile: (name: string) => Promise<void>;
  selectFileWithHighlight: (name: string, hit: PendingHighlight) => Promise<void>;
  openLibraryFile: (folder: string, name: string, opts?: { hit?: PendingHighlight; anchor?: string }) => Promise<void>;
  openInNewTab: (name: string) => Promise<void>;
  newTab: () => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  closeActiveTab: () => Promise<void>;
  activateTab: (id: string) => Promise<void>;
  navigateTo: (name: string, anchor?: string) => Promise<void>;
  consumePendingScroll: () => void;
  consumePendingHighlight: () => void;
  toggleEditMode: () => Promise<void>;
  updateTabPdfPage: (tabId: string, page: number) => void;
  setUnsupportedModalOpen: (open: boolean) => void;
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
  registerEditor: (handle: EditorHandle | null) => void;
  openExternalFilePath: (filePath: string, opts?: { suppressToast?: boolean }) => Promise<{ ok: boolean; error?: string } | void>;
  openExternalFiles: (files: File[]) => Promise<void>;
  resolveConflictOverwrite: (tabId: string) => Promise<void>;
  resolveConflictReload: (tabId: string) => Promise<void>;
  resolveConflictMerge: (tabId: string) => Promise<void>;
}

interface WorkspaceDependencies {
  state: State;
  folderContextPath: MutableRefObject<string>;
  dispatch: Dispatch;
  loadFiles: (expectedFolderPath?: string, ownsRequest?: () => boolean) => Promise<State['files']>;
  loadFilesFromServer: (expectedFolderPath?: string, ownsRequest?: () => boolean) => Promise<State['files'] | null>;
  loadFileOrder: (expectedFolderPath?: string, ownsRequest?: () => boolean) => Promise<void>;
  setFolderOrder: (parentPath: string, names: string[]) => Promise<void>;
  refreshActiveTabFromDisk: (opts?: { force?: boolean }) => Promise<void>;
  askCascadeForRename: (kind: 'file' | 'folder', oldPath: string, newPath: string) => Promise<boolean | null>;
  askConfirm: (message: string) => Promise<boolean>;
  toast: Toast;
  primeFind: (query: string, opts: { wholeWord: boolean; caseSensitive: boolean }) => void;
}

/**
 * Keep all active-folder state transitions behind one interface. The Electron
 * lifecycle bridge and browser unload fallback are the two concrete adapters
 * at the lifecycle seam. All liveness bookkeeping (generations, timers, grace
 * maps) is created here — the shell only supplies the rendered state, its
 * always-current ref, and the presentation callbacks.
 */
export function useActiveFolderWorkspace(
  stateRef: MutableRefObject<State>,
  dependencies: WorkspaceDependencies,
): ActiveFolderWorkspace {
  const {
    state: renderedState, folderContextPath, dispatch, loadFiles, loadFilesFromServer, loadFileOrder,
    setFolderOrder, refreshActiveTabFromDisk, askCascadeForRename, askConfirm,
    toast, primeFind,
  } = dependencies;

  const editor = useRef<EditorHandle | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlight = useRef<Promise<boolean> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Race protection for manual sync: switching folders cancels the
  // renderer ownership of the old sync so its `finally` can't clear a
  // newer folder's spinner.
  const syncGeneration = useRef(0);
  // Opening folders is multi-step (server bind → files/order load →
  // landing file). A newer open/home action invalidates older finishers.
  const openGeneration = useRef(0);
  const openingFolderGeneration = useRef<number | null>(null);
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

  const search = useSearchActions(
    { stateRef, folderContextPath, pollTimer, syncGeneration, openGeneration, openingFolderGeneration, lastTreeVersion, importConversionGrace, importIndexGrace, keyBackfillGrace },
    { loadFiles, loadFilesFromServer, refreshActiveTabFromDisk, toast }, dispatch,
  );
  const documents = useDocumentActions(
    { state: stateRef, editor, saveTimer, saveInFlight },
    { loadFiles, refreshIndexState: search.refreshIndexState, toast, primeFind, askConfirm }, dispatch,
  );
  const files = useFileActions(
    { stateRef, saveTimer, importConversionGrace, importIndexGrace },
    { askCascadeForRename, askConfirm, flushSave: documents.flushSave, loadFiles, openInNewTab: documents.openInNewTab, refreshIndexState: search.refreshIndexState, toast }, dispatch,
  );
  const folders = useFolderActions(
    { state: stateRef, folderContextPath, openGeneration, openingFolderGeneration, syncGeneration, lastTreeVersion, importConversionGrace, importIndexGrace, keyBackfillGrace },
    { flushSave: documents.flushSave, loadFiles, loadFileOrder, markVisibleFilesPendingForSearch: search.markVisibleFilesPendingForSearch, refreshIndexState: search.refreshIndexState, toast }, dispatch,
  );

  // An inactive tab can miss a watcher refresh while another tab is visible.
  // Revalidate it whenever it becomes active so retained Markdown editors and
  // binary previews never reuse source data from before an external change.
  const activeTab = getActiveTab(renderedState);
  const revalidatedFileName = activeTab?.file && ACTIVATION_REVALIDATED_FORMATS.has(activeTab.file.format)
    ? activeTab.file.name
    : null;
  const revalidatedTabId = revalidatedFileName ? activeTab?.id ?? null : null;
  useEffect(() => {
    if (!revalidatedFileName || !revalidatedTabId) return;
    void refreshActiveTabFromDisk();
  }, [refreshActiveTabFromDisk, revalidatedFileName, revalidatedTabId]);

  useEffect(() => {
    return electronBridge()?.onPrepareContextRelease?.(async (reason) => {
      const folderAtStart = stateRef.current.folderPath;
      const saved = await documents.flushSave();
      if (saved && reason === 'folder-removal' && folderAtStart) folders.prepareForFolderRemoval(folderAtStart);
      return saved;
    });
  }, [documents.flushSave, folders.prepareForFolderRemoval, stateRef]);

  useEffect(() => {
    return electronBridge()?.onFolderRemoved?.(folders.handleFolderRemoved);
  }, [folders.handleFolderRemoved]);

  useEffect(() => {
    return electronBridge()?.onLibraryFolderAdded?.(folders.handleLibraryFolderAdded);
  }, [folders.handleLibraryFolderAdded]);

  useEffect(() => {
    void folders.bootstrap();
    void search.refreshIndexState();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  // Bootstrap must run exactly once per mounted workspace.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let lastFocusSync = 0;
    function onFocus() {
      const focusFolder = stateRef.current.folderPath;
      if (!focusFolder) return;
      const now = Date.now();
      if (now - lastFocusSync < 5000) return;
      lastFocusSync = now;
      void api.sync(focusFolder)
        .catch(() => { /* The regular status refresh presents errors. */ })
        .finally(() => { void search.refreshIndexState(); });
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [search.refreshIndexState, stateRef]);

  useEffect(() => {
    if (typeof electronBridge()?.onPrepareContextRelease === 'function') return;
    function onUnload() {
      const cur = getActiveTab(stateRef.current)?.file ?? null;
      const liveValue = editor.current?.getValue();
      if (!cur || !editor.current || liveValue === undefined || liveValue === cur.content) return;
      if (saveTimer.current !== null) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      try {
        const endpoint = `/api/files/${encodePath(cur.name)}?windowId=${encodeURIComponent(getWindowId())}`;
        navigator.sendBeacon?.(
          endpoint,
          new Blob(
            [JSON.stringify({ content: liveValue, ...(cur.version ? { baseVersion: cur.version } : {}) })],
            { type: 'application/json' },
          ),
        );
      } catch { /* Browser shutdown is best effort. */ }
    }
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [editor, saveTimer, stateRef]);

  // The workspace interface is consumed by document effects. Keep its identity
  // stable across ordinary state updates: recreating it would re-register an
  // open Find controller, which immediately reapplies its query and loops.
  // Each sub-hook returns one memoized actions object, so depending on the
  // four objects (plus the two shell loaders) is exhaustive by construction —
  // a sub-hook gaining an action cannot silently fall out of this list.
  return useMemo(() => ({
    ...folders,
    ...search,
    ...documents,
    ...files,
    loadFiles,
    setFolderOrder,
  }), [documents, files, folders, loadFiles, search, setFolderOrder]);
}
