import { useCallback, type MutableRefObject } from 'react';
import {
  CONVERTIBLE_SOURCE_EXTENSION_ALTERNATION,
  VIEWABLE_FILE_EXTENSION_ALTERNATION,
} from '../../../shared/file-formats.ts';
import { api, ApiError, errorMessage } from '../api';
import { isFolderFileTab } from './appContextHelpers';
import {
  getActiveTab,
  renamedFilePath,
  type Action,
  type State,
} from './state';
import type { ToastOptions } from './useFeedbackActions';

const CONVERTIBLE_SOURCE_RE = new RegExp(`\\.(${CONVERTIBLE_SOURCE_EXTENSION_ALTERNATION})$`, 'i');
const VIEWABLE_FILE_RE = new RegExp(`\\.(${VIEWABLE_FILE_EXTENSION_ALTERNATION})$`, 'i');

type Dispatch = (action: Action) => void;
type Toast = (message: string, opts?: ToastOptions) => string;

interface FileActionRefs {
  stateRef: MutableRefObject<State>;
  saveTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  importConversionGrace: MutableRefObject<Map<string, number>>;
  importIndexGrace: MutableRefObject<Map<string, number>>;
}

interface FileActionDependencies {
  askCascadeForRename: (
    kind: 'file' | 'folder',
    oldPath: string,
    newPath: string,
  ) => Promise<boolean | null>;
  askConfirm: (message: string) => Promise<boolean>;
  flushSave: () => Promise<boolean>;
  loadFiles: (expectedFolderPath?: string) => Promise<State['files']>;
  openInNewTab: (name: string, expectedFolder?: string) => Promise<void>;
  refreshIndexState: (folderPath?: string) => Promise<void>;
  toast: Toast;
}

function sameRenameTarget(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Owns visible file and folder mutations plus import bookkeeping. */
export function useFileActions(
  refs: FileActionRefs,
  dependencies: FileActionDependencies,
  dispatch: Dispatch,
) {
  const {
    importConversionGrace,
    importIndexGrace,
    saveTimer,
    stateRef,
  } = refs;
  const {
    askCascadeForRename,
    askConfirm,
    flushSave,
    loadFiles,
    openInNewTab,
    refreshIndexState,
    toast,
  } = dependencies;
  const newNote = useCallback(async () => {
    if (!(await flushSave())) return;
    const targetFolderPath = stateRef.current.folderPath;
    if (!targetFolderPath) return;
    const dir = stateRef.current.activeFolder;
    try {
      const created = await api.createNote('', dir);
      if (stateRef.current.folderPath !== targetFolderPath) return;
      const { name } = created;
      if (created.indexWarning) toast(created.indexWarning, { level: 'warning' });
      if (dir) dispatch({ type: 'EXPAND_FOLDER', path: dir });
      await loadFiles(targetFolderPath);
      if (stateRef.current.folderPath !== targetFolderPath) return;
      const body = await api.getFile(name);
      if (stateRef.current.folderPath !== targetFolderPath) return;
      dispatch({ type: 'FILE_OPEN', body });
      dispatch({ type: 'EDIT_MODE', on: true });
      dispatch({ type: 'RENAMING', renaming: { path: name, kind: 'file' } });
      void refreshIndexState();
    } catch (e: unknown) {
      toast('Failed to create: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    }
  }, [flushSave, loadFiles, refreshIndexState, toast]);

  const newFolder = useCallback(async (path: string) => {
    if (!path) return;
    const targetFolderPath = stateRef.current.folderPath;
    if (!targetFolderPath) return;
    try {
      const j = await api.createFolder(path);
      if (stateRef.current.folderPath !== targetFolderPath) return;
      dispatch({ type: 'EXPAND_FOLDER', path: j.path });
      dispatch({ type: 'ACTIVE_FOLDER', path: j.path });
      await loadFiles(targetFolderPath);
    } catch (e: unknown) {
      toast('Failed to create folder: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    }
  }, [loadFiles, toast]);

  const deleteFile = useCallback(async (name: string) => {
    const targetFolderPath = stateRef.current.folderPath;
    if (!targetFolderPath) return;
    // PDFs own a dot-prefixed derived note (`.paper.md`) + image
    // bundle (`.paper_files/`) sitting next to them — say so up front
    // so the user knows the index goes with it. Plain notes just
    // mention "file + index".
    const isPdf = /\.pdf$/i.test(name);
    const prompt = isPdf
      ? `Delete ${name}? This also removes the derived markdown + image bundle and the indexed content.`
      : `Delete ${name}? (removes file + index)`;
    if (!(await askConfirm(prompt))) return;
    if (stateRef.current.folderPath !== targetFolderPath) return;
    const activeFile = getActiveTab(stateRef.current)?.file;
    if (activeFile?.name === name) {
      if (!(await flushSave())) return;
      if (stateRef.current.folderPath !== targetFolderPath) return;
    }
    try {
      await api.deleteFile(name);
      if (stateRef.current.folderPath !== targetFolderPath) return;
      if (saveTimer.current && activeFile?.name === name) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const before = stateRef.current;
      const stale = before.tabs.filter((t) => isFolderFileTab(t, name));
      for (const t of stale) dispatch({ type: 'CLOSE_TAB', id: t.id });
      importConversionGrace.current.delete(name);
      importIndexGrace.current.delete(name);
      dispatch({ type: 'PENDING_SEMANTIC_NAMES', names: new Set([...before.pendingSemanticNames].filter((p) => p !== name)) });
      dispatch({ type: 'PENDING_CONVERSIONS', paths: before.pendingConversions.filter((p) => p !== name) });
      const { [name]: _deletedProgress, ...remainingProgress } = before.conversionProgress;
      dispatch({ type: 'CONVERSION_PROGRESS', progress: remainingProgress });
      dispatch({
        type: 'FILES_LOADED',
        files: before.files.filter((f) => f.name !== name),
        folders: before.folders,
        folder: before.folder,
      });
      await loadFiles(targetFolderPath);
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 404) {
        const files = await loadFiles(targetFolderPath);
        if (stateRef.current.folderPath !== targetFolderPath) return;
        dispatch({ type: 'PRUNE_MISSING_FILE_TABS', names: files.map((f) => f.name) });
        return;
      }
      await loadFiles(targetFolderPath);
      toast('Delete failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    }
  }, [flushSave, loadFiles, toast, askConfirm]);

  const deleteFolder = useCallback(async (path: string) => {
    if (!path) return;
    const targetFolderPath = stateRef.current.folderPath;
    if (!targetFolderPath) return;
    if (!(await askConfirm(`Delete folder "${path}" and everything inside?`))) return;
    if (stateRef.current.folderPath !== targetFolderPath) return;
    const activeFile = getActiveTab(stateRef.current)?.file;
    if (activeFile?.name.startsWith(path + '/')) {
      if (!(await flushSave())) return;
      if (stateRef.current.folderPath !== targetFolderPath) return;
    }
    try {
      await api.deleteFolder(path);
      if (stateRef.current.folderPath !== targetFolderPath) return;
      if (saveTimer.current && activeFile?.name.startsWith(path + '/')) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const before = stateRef.current;
      const stale = before.tabs.filter(
        (t) => t.file && t.file.name.startsWith(path + '/'),
      );
      for (const t of stale) dispatch({ type: 'CLOSE_TAB', id: t.id });
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (before.activeFolder === path || before.activeFolder.startsWith(path + '/')) {
        dispatch({ type: 'ACTIVE_FOLDER', path: parent });
      }
      if (before.selectedPath === path || before.selectedPath.startsWith(path + '/')) {
        dispatch({ type: 'SELECT_PATH', path: parent });
      }
      dispatch({
        type: 'FILES_LOADED',
        files: before.files.filter((f) => !f.name.startsWith(path + '/')),
        folders: before.folders.filter((f) => f.path !== path && !f.path.startsWith(path + '/')),
        folder: before.folder,
      });
      await loadFiles(targetFolderPath);
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 404) {
        const files = await loadFiles(targetFolderPath);
        if (stateRef.current.folderPath !== targetFolderPath) return;
        dispatch({ type: 'PRUNE_MISSING_FILE_TABS', names: files.map((f) => f.name) });
        return;
      }
      await loadFiles(targetFolderPath);
      toast('Delete failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    }
  }, [flushSave, loadFiles, toast, askConfirm]);

  const renameFile = useCallback(async (oldName: string, newBaseName: string) => {
    const targetFolderPath = stateRef.current.folderPath;
    if (!targetFolderPath) return;
    const newName = renamedFilePath(oldName, newBaseName);
    if (newName === oldName) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    if (
      stateRef.current.files.some((f) => sameRenameTarget(f.name, newName) && !sameRenameTarget(f.name, oldName))
      || stateRef.current.folders.some((f) => sameRenameTarget(f.path, newName))
    ) {
      toast('Rename failed: target exists', { level: 'error' });
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    const cascade = await askCascadeForRename('file', oldName, newName);
    if (stateRef.current.folderPath !== targetFolderPath) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    if (cascade === null) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    const activeFile = getActiveTab(stateRef.current)?.file;
    const wasActive = activeFile?.name === oldName;
    if (wasActive) {
      if (!(await flushSave())) {
        dispatch({ type: 'RENAMING', renaming: null });
        return;
      }
      if (stateRef.current.folderPath !== targetFolderPath) {
        dispatch({ type: 'RENAMING', renaming: null });
        return;
      }
      dispatch({ type: 'SAVE_STATUS', status: { text: 'Renaming…', cls: '' } });
    }
    dispatch({ type: 'REMAP_PATHS', from: oldName, to: newName, kind: 'file' });
    dispatch({ type: 'RENAMING', renaming: null });
    try {
      const j = await api.renameFile(oldName, newName, { cascade, asyncIndex: true });
      if (stateRef.current.folderPath !== targetFolderPath) return;
      if (j.name !== newName) {
        dispatch({ type: 'REMAP_PATHS', from: newName, to: j.name, kind: 'file' });
      }
      if (wasActive && activeFile) {
        dispatch({ type: 'SAVE_STATUS', status: { text: 'Saved', cls: 'saved' } });
      }
      await loadFiles(targetFolderPath);
      if (j.indexWarning) {
        toast('Renamed. ' + j.indexWarning, { level: 'warning' });
      } else if (j.indexDeferred) {
        toast('Renamed. Updating semantic index in the background.', { level: 'info' });
      }
    } catch (e: unknown) {
      if (stateRef.current.folderPath !== targetFolderPath) return;
      dispatch({ type: 'REMAP_PATHS', from: newName, to: oldName, kind: 'file' });
      const msg = e instanceof Error ? e.message : String(e);
      toast('Rename failed: ' + msg, { level: 'error' });
      if (wasActive) {
        dispatch({ type: 'SAVE_STATUS', status: { text: 'Rename failed', cls: 'error' } });
      }
    } finally {
      if (stateRef.current.folderPath === targetFolderPath) dispatch({ type: 'RENAMING', renaming: null });
    }
  }, [askCascadeForRename, flushSave, loadFiles, toast]);

  const renameFolder = useCallback(async (oldPath: string, newName: string) => {
    const targetFolderPath = stateRef.current.folderPath;
    if (!targetFolderPath) return;
    if (!newName || newName.includes('/')) {
      toast('Folder name cannot contain "/".', { level: 'warning' });
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    const lastSlash = oldPath.lastIndexOf('/');
    const parent = lastSlash >= 0 ? oldPath.slice(0, lastSlash + 1) : '';
    const newPath = parent + newName;
    if (newPath === oldPath) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    const cascade = await askCascadeForRename('folder', oldPath, newPath);
    if (stateRef.current.folderPath !== targetFolderPath) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    if (cascade === null) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    const activeFile = getActiveTab(stateRef.current)?.file;
    if (activeFile && activeFile.name.startsWith(oldPath + '/')) {
      if (!(await flushSave())) {
        dispatch({ type: 'RENAMING', renaming: null });
        return;
      }
      if (stateRef.current.folderPath !== targetFolderPath) {
        dispatch({ type: 'RENAMING', renaming: null });
        return;
      }
    }
    try {
      const j = await api.renameFolder(oldPath, newName, { cascade });
      if (stateRef.current.folderPath !== targetFolderPath) return;
      const s = stateRef.current;
      // Server has rewritten the on-disk path; mirror the expansion
      // across so the renamed folder stays open after `loadFiles`.
      // The orphan oldPath entry in the set is harmless — no folder
      // row matches it, so it just sits inert until the next reset.
      if (s.expanded.has(oldPath)) {
        dispatch({ type: 'EXPAND_FOLDER', path: j.path });
      }
      dispatch({ type: 'REMAP_PATHS', from: oldPath, to: j.path, kind: 'folder' });
      await loadFiles(targetFolderPath);
    } catch (e: unknown) {
      if (stateRef.current.folderPath !== targetFolderPath) return;
      toast('Rename failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    } finally {
      if (stateRef.current.folderPath === targetFolderPath) dispatch({ type: 'RENAMING', renaming: null });
    }
  }, [askCascadeForRename, flushSave, loadFiles, toast]);

  const moveFile = useCallback(async (oldPath: string, targetDir: string) => {
    const targetFolderPath = stateRef.current.folderPath;
    if (!targetFolderPath) return false;
    const basename = oldPath.split('/').pop() ?? oldPath;
    const newPath = targetDir ? `${targetDir}/${basename}` : basename;
    if (newPath === oldPath) return true;
    const cascade = await askCascadeForRename('file', oldPath, newPath);
    if (stateRef.current.folderPath !== targetFolderPath) return false;
    if (cascade === null) return false;
    const cur = getActiveTab(stateRef.current)?.file;
    if (cur?.name === oldPath && !(await flushSave())) return false;
    if (stateRef.current.folderPath !== targetFolderPath) return false;
    try {
      const j = await api.renameFile(oldPath, newPath, { cascade, asyncIndex: true });
      if (stateRef.current.folderPath !== targetFolderPath) return true;
      dispatch({ type: 'REMAP_PATHS', from: oldPath, to: j.name, kind: 'file' });
      if (targetDir) dispatch({ type: 'EXPAND_FOLDER', path: targetDir });
      await loadFiles(targetFolderPath);
      if (j.indexWarning) {
        toast('Moved. ' + j.indexWarning, { level: 'warning' });
      } else if (j.indexDeferred) {
        toast('Moved. Updating semantic index in the background.', { level: 'info' });
      }
      return true;
    } catch (e: unknown) {
      if (stateRef.current.folderPath !== targetFolderPath) return false;
      toast('Move failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
      return false;
    }
  }, [askCascadeForRename, flushSave, loadFiles, toast]);

  const upload = useCallback(async (
    items: { file: File; relPath: string }[],
    dir: string,
  ): Promise<boolean> => {
    const targetFolderPath = stateRef.current.folderPath;
    const targetFolderLabel = stateRef.current.folder;
    if (!targetFolderPath) {
      toast('Open a folder before importing files.', { level: 'warning' });
      return false;
    }
    if (dir) dispatch({ type: 'EXPAND_FOLDER', path: dir });
    try {
      const j = await api.upload(items, dir, targetFolderPath);
      const stillInTargetFolder = stateRef.current.folderPath === targetFolderPath;
      if (!stillInTargetFolder) {
        const failed = (j.files || []).filter((x) => x.error);
        if (failed.length) {
          console.warn('[upload] failed:', failed);
          toast(`${failed.length} file(s) failed to import into ${targetFolderLabel}.`, { level: 'error' });
        } else {
          toast(`Imported ${j.files?.length ?? items.length} file(s) into ${targetFolderLabel}.`, { level: 'info' });
        }
        return failed.length === 0;
      }
      await loadFiles(targetFolderPath);
      // Optimistically include convertible imports in search-readiness
      // accounting the instant the drop lands. The server registers each
      // conversion only after responding, so the immediate status poll can
      // otherwise briefly undercount pending PDF/image/DOCX work.
      const converting = (j.files || [])
        .filter((x) => !x.error && CONVERTIBLE_SOURCE_RE.test(x.file))
        .map((x) => x.file);
      if (converting.length) {
        // Protect the optimistic entries from being wiped by an index
        // poll that lands before the server registers the conversion.
        const deadline = Date.now() + 6000;
        for (const name of converting) importConversionGrace.current.set(name, deadline);
        const merged = [...new Set([...stateRef.current.pendingConversions, ...converting])].sort();
        dispatch({ type: 'PENDING_CONVERSIONS', paths: merged });
      }
      // Optimistically mark the indexable imports (md / html, non-hidden)
      // as pending too. These never enter `pendingConversions`; they live
      // in `pendingSemanticNames` until the folder is up-to-date.
      // `refreshIndexState` holds these until the folder is up-to-date.
      const indexing = (j.files || [])
        .filter((x) => !x.error && /\.(md|markdown|html?)$/i.test(x.file))
        .filter((x) => !x.file.split('/').some((seg) => seg.startsWith('.')))
        .map((x) => x.file);
      if (indexing.length) {
        const deadline = Date.now() + 60000;
        for (const name of indexing) importIndexGrace.current.set(name, deadline);
        const merged = new Set(stateRef.current.pendingSemanticNames);
        for (const name of indexing) merged.add(name);
        dispatch({ type: 'PENDING_SEMANTIC_NAMES', names: merged });
      }
      // Now the server has fired any PDF/image/DOCX conversions. Poll
      // immediately so search-readiness accounting catches up even when a
      // conversion finishes inside the regular poll window.
      void refreshIndexState();
      // Auto-open the first viewable file the drop produced — the
      // import was a deliberate user action, so showing what landed is
      // expected (mirrors dropping a file into an editor). Limited to
      // formats the viewer can actually render (md/html via getFile,
      // pdf + image + DOCX synthesized in `loadFile`). Opens at most ONE file,
      // so a batch drop doesn't explode into tabs.
      const first = j.files?.find(
        (x) => !x.error && VIEWABLE_FILE_RE.test(x.file),
      );
      // Pinned, not preview: a drop is a deliberate, committed gesture
      // (the double-click analog), so the imported file should stay open
      // rather than be a tentative tab the next sidebar click evicts.
      if (first) void openInNewTab(first.file, targetFolderPath);
      const failed = (j.files || []).filter((x) => x.error);
      if (failed.length) {
        console.warn('[upload] failed:', failed);
        toast(`${failed.length} file(s) failed to import. Check console for details.`, { level: 'error' });
      }
      return failed.length === 0;
    } catch (e: unknown) {
      console.warn('[upload] request failed:', e);
      toast(`Upload failed: ${errorMessage(e)}`, { level: 'error' });
      return false;
    }
  }, [loadFiles, refreshIndexState, openInNewTab, toast]);


  return {
    deleteFile,
    deleteFolder,
    moveFile,
    newFolder,
    newNote,
    renameFile,
    renameFolder,
    upload,
  };
}
