/**
 * The active-folder workspace is the renderer's working context for one local
 * folder. It owns folder/document/retrieval transitions and their liveness
 * rules. Shell presentation (chat, modals, toasts, Find UI, and layout) stays
 * outside this module and crosses its small interaction seams as callbacks.
 */
import { useEffect, useMemo, type MutableRefObject } from 'react';
import { api, encodePath, getWindowId } from '../api';
import { getActiveTab, type Action, type PendingHighlight, type State } from './state';
import type { EditorHandle } from './actionTypes';
import { useDocumentActions } from './useDocumentActions';
import { useFileActions } from './useFileActions';
import { useFolderActions } from './useFolderActions';
import { useSearchActions } from './useSearchActions';

interface ElectronLifecycleBridge {
  onPrepareContextRelease?: (handler: (reason: string) => Promise<boolean>) => (() => void);
  onFolderRemoved?: (handler: (folder: string) => void) => (() => void);
}

type Dispatch = (action: Action) => void;
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
  goHome: () => Promise<boolean>;
  loadFiles: (expectedFolderPath?: string) => Promise<State['files']>;
  markVisibleFilesPendingForSearch: (files?: State['files']) => Promise<void>;
  refreshIndexState: (folderPath?: string) => Promise<void>;
  runSync: () => Promise<void>;
  runSearch: (
    query: string,
    mode?: 'semantic' | 'keyword',
    opts?: {
      caseStrict?: boolean;
      wholeWord?: boolean;
      scope?: string | null;
      types?: import('../../../shared/search-types.ts').SearchTypeCategory[];
    },
  ) => Promise<void>;
  dismissIndexWarning: () => Promise<void>;
  setFolderOrder: (parentPath: string, names: string[]) => Promise<void>;
  selectFile: (name: string) => Promise<void>;
  selectFileWithHighlight: (name: string, hit: PendingHighlight) => Promise<void>;
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
}

interface WorkspaceRefs {
  state: MutableRefObject<State>;
  folderContextPath: MutableRefObject<string>;
  editor: MutableRefObject<EditorHandle | null>;
  saveTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  saveInFlight: MutableRefObject<Promise<boolean> | null>;
  pollTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  searchGeneration: MutableRefObject<number>;
  syncGeneration: MutableRefObject<number>;
  openGeneration: MutableRefObject<number>;
  openingFolderGeneration: MutableRefObject<number | null>;
  lastTreeVersion: MutableRefObject<number>;
  importConversionGrace: MutableRefObject<Map<string, number>>;
  importIndexGrace: MutableRefObject<Map<string, number>>;
  keyBackfillGrace: MutableRefObject<Map<string, number>>;
}

interface WorkspaceDependencies {
  state: State;
  dispatch: Dispatch;
  loadFiles: (expectedFolderPath?: string) => Promise<State['files']>;
  loadFilesFromServer: (expectedFolderPath?: string) => Promise<State['files'] | null>;
  loadFileOrder: (expectedFolderPath?: string) => Promise<void>;
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
 * at the lifecycle seam.
 */
export function useActiveFolderWorkspace(
  refs: WorkspaceRefs,
  dependencies: WorkspaceDependencies,
): ActiveFolderWorkspace {
  const {
    state, folderContextPath, editor, saveTimer, saveInFlight, pollTimer,
    searchGeneration, syncGeneration, openGeneration, openingFolderGeneration,
    lastTreeVersion, importConversionGrace, importIndexGrace, keyBackfillGrace,
  } = refs;
  const {
    state: renderedState, dispatch, loadFiles, loadFilesFromServer, loadFileOrder,
    setFolderOrder, refreshActiveTabFromDisk, askCascadeForRename, askConfirm,
    toast, primeFind,
  } = dependencies;

  const search = useSearchActions(
    { stateRef: state, folderContextPath, pollTimer, searchGeneration, syncGeneration, openGeneration, openingFolderGeneration, lastTreeVersion, importConversionGrace, importIndexGrace, keyBackfillGrace },
    { loadFiles, loadFilesFromServer, refreshActiveTabFromDisk, toast }, dispatch,
  );
  const documents = useDocumentActions(
    { state, editor, saveTimer, saveInFlight },
    { loadFiles, refreshIndexState: search.refreshIndexState, toast, primeFind }, dispatch,
  );
  const files = useFileActions(
    { stateRef: state, saveTimer, importConversionGrace, importIndexGrace },
    { askCascadeForRename, askConfirm, flushSave: documents.flushSave, loadFiles, openInNewTab: documents.openInNewTab, refreshIndexState: search.refreshIndexState, toast }, dispatch,
  );
  const folders = useFolderActions(
    { state, folderContextPath, editor, openGeneration, openingFolderGeneration, syncGeneration, searchGeneration, lastTreeVersion, importConversionGrace, importIndexGrace, keyBackfillGrace },
    { flushSave: documents.flushSave, loadFiles, loadFileOrder, markVisibleFilesPendingForSearch: search.markVisibleFilesPendingForSearch, refreshIndexState: search.refreshIndexState, toast }, dispatch,
  );

  // An inactive binary tab can miss a watcher refresh while another tab is
  // visible. Re-stat it whenever it becomes active so previews never reuse
  // source bytes from before an external replacement.
  const activeTab = getActiveTab(renderedState);
  const activeBinaryName = activeTab?.file && ['pdf', 'image', 'docx', 'audio'].includes(activeTab.file.format)
    ? activeTab.file.name
    : null;
  const activeBinaryTabId = activeBinaryName ? activeTab?.id ?? null : null;
  useEffect(() => {
    if (!activeBinaryName || !activeBinaryTabId) return;
    const folderPathAtStart = renderedState.folderPath;
    void api.statFile(activeBinaryName).then((stat) => {
      if (state.current.folderPath !== folderPathAtStart) return;
      const latest = getActiveTab(state.current);
      if (latest?.id !== activeBinaryTabId || latest.file?.name !== activeBinaryName) return;
      if (latest.file.version !== stat.version) dispatch({ type: 'FILE_PATCH', patch: { version: stat.version } });
    }).catch(() => {
      // The tree refresh owns deletion and error presentation.
    });
  }, [activeBinaryName, activeBinaryTabId, dispatch, renderedState.folderPath, state]);

  useEffect(() => {
    const bridge = (window as { electron?: ElectronLifecycleBridge }).electron;
    return bridge?.onPrepareContextRelease?.(async (reason) => {
      const folderAtStart = state.current.folderPath;
      const saved = await documents.flushSave();
      if (saved && reason === 'folder-removal' && folderAtStart) folders.prepareForFolderRemoval(folderAtStart);
      return saved;
    });
  }, [documents.flushSave, folders.prepareForFolderRemoval, state]);

  useEffect(() => {
    const bridge = (window as { electron?: ElectronLifecycleBridge }).electron;
    return bridge?.onFolderRemoved?.(folders.handleFolderRemoved);
  }, [folders.handleFolderRemoved]);

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
      const focusFolder = state.current.folderPath;
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
  }, [search.refreshIndexState, state]);

  useEffect(() => {
    const bridge = (window as { electron?: ElectronLifecycleBridge }).electron;
    if (typeof bridge?.onPrepareContextRelease === 'function') return;
    function onUnload() {
      const cur = getActiveTab(state.current)?.file ?? null;
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
  }, [editor, saveTimer, state]);

  // The workspace interface is consumed by document effects. Keep its identity
  // stable across ordinary state updates: recreating it would re-register an
  // open Find controller, which immediately reapplies its query and loops.
  return useMemo(() => ({
    ...folders,
    ...search,
    ...documents,
    ...files,
    loadFiles,
    setFolderOrder,
  }), [
    folders.bootstrap,
    folders.goHome,
    folders.handleFolderRemoved,
    folders.openFolder,
    folders.openFolderByName,
    folders.prepareForFolderRemoval,
    search.dismissIndexWarning,
    search.markVisibleFilesPendingForSearch,
    search.refreshIndexState,
    search.runSearch,
    search.runSync,
    documents.activateTab,
    documents.closeActiveTab,
    documents.closeTab,
    documents.consumePendingHighlight,
    documents.consumePendingScroll,
    documents.flushSave,
    documents.navigateTo,
    documents.newTab,
    documents.openInNewTab,
    documents.registerEditor,
    documents.scheduleSave,
    documents.selectFile,
    documents.selectFileWithHighlight,
    documents.toggleEditMode,
    documents.updateTabPdfPage,
    files.deleteFile,
    files.deleteFolder,
    files.moveFile,
    files.newFolder,
    files.newNote,
    files.renameFile,
    files.renameFolder,
    files.upload,
    loadFiles,
    setFolderOrder,
  ]);
}
