import { useCallback, useMemo, useRef, type MutableRefObject } from 'react';
import {
  CONVERTIBLE_SOURCE_EXTENSION_ALTERNATION,
  DIRECT_TEXT_EXTENSION_ALTERNATION,
} from '@shared/file-formats';
import { api, ApiError, errorMessage } from '@/common/api/api';
import { basename } from '@/common/lib/paths';
import { fileLinkTarget } from '@/common/lib/relativeLinkPath';
import { isFolderFileTab } from '@/store/lib/appContextHelpers';
import {
  getActiveTab,
  hasName,
  renamedFilePath,
  toNameSet,
  type Action,
  type State,
  type WorkspaceSlice,
} from '@/store/state/state';
import type { ToastOptions } from './useFeedbackActions';

const CONVERTIBLE_SOURCE_RE = new RegExp(`\\.(${CONVERTIBLE_SOURCE_EXTENSION_ALTERNATION})$`, 'i');
const DIRECT_TEXT_FILE_RE = new RegExp(`\\.(${DIRECT_TEXT_EXTENSION_ALTERNATION})$`, 'i');

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
  loadFiles: (expectedFolderPath?: string) => Promise<WorkspaceSlice['files']>;
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
  const hiddenVisibilityGeneration = useRef(0);
  const hiddenVisibilityIntent = useRef<boolean | null>(null);
  const hiddenPreferenceWrites = useRef<Promise<void>>(Promise.resolve());
  const newNote = useCallback(async () => {
    if (!(await flushSave())) return;
    const targetFolderPath = stateRef.current.workspace.folderPath;
    if (!targetFolderPath) return;
    const dir = stateRef.current.workspace.activeFolder;
    try {
      const created = await api.createNote('', dir);
      if (stateRef.current.workspace.folderPath !== targetFolderPath) return;
      const { name } = created;
      if (created.indexWarning) toast(created.indexWarning, { level: 'warning' });
      if (dir) dispatch({ type: 'EXPAND_FOLDER', path: dir });
      await loadFiles(targetFolderPath);
      if (stateRef.current.workspace.folderPath !== targetFolderPath) return;
      const body = await api.getFile(name);
      if (stateRef.current.workspace.folderPath !== targetFolderPath) return;
      dispatch({ type: 'FILE_OPEN', body });
      dispatch({ type: 'EDIT_MODE', on: true });
      dispatch({ type: 'RENAMING', renaming: { path: name, kind: 'file' } });
      void refreshIndexState();
    } catch (e: unknown) {
      toast('Failed to create: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    }
  }, [flushSave, loadFiles, refreshIndexState, toast]);

  /** Show the file in Finder / Explorer. Fire-and-forget: the OS surfaces
   *  its own failure, and there is nothing for the renderer to undo. */
  const revealFile = useCallback((name: string) => {
    void api.revealFile(name);
  }, []);

  /** Copy a pasteable Markdown link to a file in the tree. Pure client-side
   *  path math + clipboard write — no server round-trip, so this skips the
   *  request machinery the mutating actions above need, but still toasts a
   *  result: a silent clipboard write gives the user no way to confirm it
   *  worked, or that a fallback link may need adjusting before it's usable. */
  const copyFileLink = useCallback((targetPath: string) => {
    const activeFile = getActiveTab(stateRef.current.workspace)?.file;
    // Only an in-folder (not out-of-folder-tab) Markdown note gives a valid
    // "from" side: relativeLinkPath assumes both paths share one folder
    // root, which an out-of-folder tab's `file.folder` breaks. This is also
    // false whenever the active tab is a non-Markdown viewer (PDF, image,
    // audio, …), not just when no note is open at all.
    const hasActiveNote = !!activeFile && !activeFile.folder && activeFile.format === 'md';
    // No active note gives no "from" side to resolve a relative path
    // against; fileLinkTarget falls back to the target's own
    // workspace-relative path (still valid Markdown link syntax, but only
    // correct if pasted into a note at the folder root) rather than
    // blocking the action.
    const { displayName, href } = fileLinkTarget(hasActiveNote ? activeFile.name : null, targetPath);
    const link = `[${displayName}](${href})`;
    if (!navigator.clipboard) {
      toast('Could not copy link to clipboard.', { level: 'error' });
      return;
    }
    navigator.clipboard.writeText(link).then(
      () => {
        if (hasActiveNote) toast('Link copied.', { level: 'success' });
        else toast('Link copied — relative to the library, adjust if pasting elsewhere.', { level: 'info' });
      },
      () => toast('Could not copy link to clipboard.', { level: 'error' }),
    );
  }, [toast]);

  /** Rebuild a file's searchable version. The folder is captured at the
   *  call, so a reprocess started from a context menu still targets the
   *  file it was opened on if the workspace moves while the request runs.
   *  Progress arrives through the next index-status poll, not the reply. */
  const reprocessFile = useCallback(async (name: string, folder?: string) => {
    const targetFolder = folder ?? (stateRef.current.workspace.folderPath || undefined);
    toast('Reprocessing…', { level: 'info' });
    try {
      await api.reprocessFile(name, { folder: targetFolder });
      void refreshIndexState();
    } catch (e: unknown) {
      toast('Reprocess could not start. Try again.', { level: 'error' });
      console.warn('[reprocess] failed:', e instanceof Error ? e.message : String(e));
    }
  }, [refreshIndexState, toast]);

  /** Toggle the application-level hidden-files visibility. The server owns
   *  the durable value and bumps the shared tree version, so other windows
   *  converge on their next status poll; this window reloads immediately.
   *  Open tabs keep their documents — only tree rows, keyboard order,
   *  selection, and Quick Open (which reads the same listing) change. */
  const toggleShowHiddenFiles = useCallback(async () => {
    const targetFolderPath = stateRef.current.workspace.folderPath;
    const show = !(hiddenVisibilityIntent.current ?? stateRef.current.workspace.showHiddenFiles);
    hiddenVisibilityIntent.current = show;
    const generation = ++hiddenVisibilityGeneration.current;
    const write = hiddenPreferenceWrites.current.then(async () => {
      await api.putWorkspacePreferences({ showHiddenFiles: show });
    });
    // Preserve invocation order at the durable owner even when requests have
    // very different latency. A failed write does not poison later toggles.
    hiddenPreferenceWrites.current = write.catch(() => undefined);
    try {
      await write;
    } catch (e: unknown) {
      if (generation === hiddenVisibilityGeneration.current) {
        toast('Failed to update hidden files preference: ' + errorMessage(e), { level: 'error' });
        // An earlier queued write may have succeeded. Reload server truth so
        // the checked state converges instead of assuming the failed intent.
        if (targetFolderPath && stateRef.current.workspace.folderPath === targetFolderPath) {
          await loadFiles(targetFolderPath);
        }
        if (generation === hiddenVisibilityGeneration.current) hiddenVisibilityIntent.current = null;
      }
      return;
    }
    if (generation !== hiddenVisibilityGeneration.current) return;
    if (targetFolderPath && stateRef.current.workspace.folderPath === targetFolderPath) {
      await loadFiles(targetFolderPath);
    }
    if (generation === hiddenVisibilityGeneration.current) hiddenVisibilityIntent.current = null;
  }, [loadFiles, toast]);

  const newFolder = useCallback(async (path: string) => {
    if (!path) return;
    const targetFolderPath = stateRef.current.workspace.folderPath;
    if (!targetFolderPath) return;
    try {
      const j = await api.createFolder(path);
      if (stateRef.current.workspace.folderPath !== targetFolderPath) return;
      dispatch({ type: 'EXPAND_FOLDER', path: j.path });
      dispatch({ type: 'ACTIVE_FOLDER', path: j.path });
      await loadFiles(targetFolderPath);
    } catch (e: unknown) {
      toast('Failed to create folder: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    }
  }, [loadFiles, toast]);

  const deleteFile = useCallback(async (name: string) => {
    const targetFolderPath = stateRef.current.workspace.folderPath;
    if (!targetFolderPath) return;
    // PDFs own a dot-prefixed derived note (`.paper.md`) + image
    // bundle (`.paper_files/`) sitting next to them — say so up front
    // so the user knows the search data goes with it. Plain notes keep the
    // same product-level explanation.
    const isPdf = /\.pdf$/i.test(name);
    const prompt = isPdf
      ? `Delete ${name}? This also removes the derived markdown + image bundle and its search data.`
      : `Delete ${name}? This also removes its search data.`;
    if (!(await askConfirm(prompt))) return;
    if (stateRef.current.workspace.folderPath !== targetFolderPath) return;
    const activeFile = getActiveTab(stateRef.current.workspace)?.file;
    if (activeFile?.name === name) {
      if (!(await flushSave())) return;
      if (stateRef.current.workspace.folderPath !== targetFolderPath) return;
    }
    try {
      await api.deleteFile(name);
      if (stateRef.current.workspace.folderPath !== targetFolderPath) return;
      if (saveTimer.current && activeFile?.name === name) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const before = stateRef.current.workspace;
      const stale = before.tabs.filter((t) => isFolderFileTab(t, name));
      for (const t of stale) dispatch({ type: 'CLOSE_TAB', id: t.id });
      importConversionGrace.current.delete(name);
      importIndexGrace.current.delete(name);
      const { [name]: _deletedPending, ...remainingPending } = before.pendingSemanticNames;
      dispatch({ type: 'PENDING_SEMANTIC_NAMES', names: remainingPending });
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
        await loadFiles(targetFolderPath);
        if (stateRef.current.workspace.folderPath !== targetFolderPath) return;
        for (const tab of stateRef.current.workspace.tabs.filter((t) => isFolderFileTab(t, name))) {
          dispatch({ type: 'CLOSE_TAB', id: tab.id });
        }
        return;
      }
      await loadFiles(targetFolderPath);
      toast('Delete failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    }
  }, [flushSave, loadFiles, toast, askConfirm]);

  const deleteFolder = useCallback(async (path: string) => {
    if (!path) return;
    const targetFolderPath = stateRef.current.workspace.folderPath;
    if (!targetFolderPath) return;
    if (!(await askConfirm(`Delete folder "${path}" and everything inside?`))) return;
    if (stateRef.current.workspace.folderPath !== targetFolderPath) return;
    const activeFile = getActiveTab(stateRef.current.workspace)?.file;
    if (activeFile?.name.startsWith(path + '/')) {
      if (!(await flushSave())) return;
      if (stateRef.current.workspace.folderPath !== targetFolderPath) return;
    }
    try {
      await api.deleteFolder(path);
      if (stateRef.current.workspace.folderPath !== targetFolderPath) return;
      if (saveTimer.current && activeFile?.name.startsWith(path + '/')) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const before = stateRef.current.workspace;
      const stale = before.tabs.filter(
        // Out-of-folder tabs live elsewhere on disk — a same-named prefix
        // in the active folder must not close them.
        (t) => t.file && !t.file.folder && t.file.name.startsWith(path + '/'),
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
        await loadFiles(targetFolderPath);
        if (stateRef.current.workspace.folderPath !== targetFolderPath) return;
        for (const tab of stateRef.current.workspace.tabs.filter(
          (t) => t.file && !t.file.folder && t.file.name.startsWith(path + '/'),
        )) {
          dispatch({ type: 'CLOSE_TAB', id: tab.id });
        }
        return;
      }
      await loadFiles(targetFolderPath);
      toast('Delete failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    }
  }, [flushSave, loadFiles, toast, askConfirm]);

  const renameFile = useCallback(async (oldName: string, newBaseName: string) => {
    const targetFolderPath = stateRef.current.workspace.folderPath;
    if (!targetFolderPath) return;
    const newName = renamedFilePath(oldName, newBaseName);
    if (newName === oldName) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    if (
      stateRef.current.workspace.files.some((f) => sameRenameTarget(f.name, newName) && !sameRenameTarget(f.name, oldName))
      || stateRef.current.workspace.folders.some((f) => sameRenameTarget(f.path, newName))
    ) {
      toast('Rename failed: target exists', { level: 'error' });
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    const cascade = await askCascadeForRename('file', oldName, newName);
    if (stateRef.current.workspace.folderPath !== targetFolderPath) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    if (cascade === null) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    const activeFile = getActiveTab(stateRef.current.workspace)?.file;
    const wasActive = activeFile?.name === oldName;
    if (wasActive) {
      if (!(await flushSave())) {
        dispatch({ type: 'RENAMING', renaming: null });
        return;
      }
      if (stateRef.current.workspace.folderPath !== targetFolderPath) {
        dispatch({ type: 'RENAMING', renaming: null });
        return;
      }
      dispatch({ type: 'SAVE_STATUS', status: { text: 'Renaming…', cls: '' } });
    }
    dispatch({ type: 'RENAMING', renaming: null });
    try {
      const j = await api.renameFile(oldName, newName, { cascade, asyncIndex: true });
      if (stateRef.current.workspace.folderPath !== targetFolderPath) return;
      // Commit the visible path only after the disk rename succeeds. An
      // optimistic tab remap makes the active-document loader request the
      // not-yet-created target while async path resolution is still running.
      dispatch({ type: 'REMAP_PATHS', from: oldName, to: j.name, kind: 'file' });
      if (wasActive && activeFile) {
        dispatch({ type: 'SAVE_STATUS', status: { text: 'Saved', cls: 'saved' } });
      }
      await loadFiles(targetFolderPath);
      if (j.indexWarning) {
        toast('Renamed. ' + j.indexWarning, { level: 'warning' });
      } else if (j.indexDeferred) {
        toast('Renamed. Updating the file for search by meaning in the background.', { level: 'info' });
      }
    } catch (e: unknown) {
      if (stateRef.current.workspace.folderPath !== targetFolderPath) return;
      const msg = e instanceof Error ? e.message : String(e);
      toast('Rename failed: ' + msg, { level: 'error' });
      if (wasActive) {
        dispatch({ type: 'SAVE_STATUS', status: { text: 'Rename failed', cls: 'error' } });
      }
    } finally {
      if (stateRef.current.workspace.folderPath === targetFolderPath) dispatch({ type: 'RENAMING', renaming: null });
    }
  }, [askCascadeForRename, flushSave, loadFiles, toast]);

  const renameFolder = useCallback(async (oldPath: string, newName: string) => {
    const targetFolderPath = stateRef.current.workspace.folderPath;
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
    if (stateRef.current.workspace.folderPath !== targetFolderPath) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    if (cascade === null) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    const activeFile = getActiveTab(stateRef.current.workspace)?.file;
    if (activeFile && activeFile.name.startsWith(oldPath + '/')) {
      if (!(await flushSave())) {
        dispatch({ type: 'RENAMING', renaming: null });
        return;
      }
      if (stateRef.current.workspace.folderPath !== targetFolderPath) {
        dispatch({ type: 'RENAMING', renaming: null });
        return;
      }
    }
    try {
      const j = await api.renameFolder(oldPath, newName, { cascade });
      if (stateRef.current.workspace.folderPath !== targetFolderPath) return;
      const s = stateRef.current.workspace;
      // Server has rewritten the on-disk path; mirror the expansion
      // across so the renamed folder stays open after `loadFiles`.
      // The orphan oldPath entry in the set is harmless — no folder
      // row matches it, so it just sits inert until the next reset.
      if (hasName(s.expanded, oldPath)) {
        dispatch({ type: 'EXPAND_FOLDER', path: j.path });
      }
      dispatch({ type: 'REMAP_PATHS', from: oldPath, to: j.path, kind: 'folder' });
      await loadFiles(targetFolderPath);
    } catch (e: unknown) {
      if (stateRef.current.workspace.folderPath !== targetFolderPath) return;
      toast('Rename failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    } finally {
      if (stateRef.current.workspace.folderPath === targetFolderPath) dispatch({ type: 'RENAMING', renaming: null });
    }
  }, [askCascadeForRename, flushSave, loadFiles, toast]);

  const moveFile = useCallback(async (oldPath: string, targetDir: string) => {
    const targetFolderPath = stateRef.current.workspace.folderPath;
    if (!targetFolderPath) return false;
    const movedName = basename(oldPath);
    const newPath = targetDir ? `${targetDir}/${movedName}` : movedName;
    if (newPath === oldPath) return true;
    const cascade = await askCascadeForRename('file', oldPath, newPath);
    if (stateRef.current.workspace.folderPath !== targetFolderPath) return false;
    if (cascade === null) return false;
    const cur = getActiveTab(stateRef.current.workspace)?.file;
    if (cur?.name === oldPath && !(await flushSave())) return false;
    if (stateRef.current.workspace.folderPath !== targetFolderPath) return false;
    try {
      const j = await api.renameFile(oldPath, newPath, { cascade, asyncIndex: true });
      if (stateRef.current.workspace.folderPath !== targetFolderPath) return true;
      dispatch({ type: 'REMAP_PATHS', from: oldPath, to: j.name, kind: 'file' });
      if (targetDir) dispatch({ type: 'EXPAND_FOLDER', path: targetDir });
      await loadFiles(targetFolderPath);
      if (j.indexWarning) {
        toast('Moved. ' + j.indexWarning, { level: 'warning' });
      } else if (j.indexDeferred) {
        toast('Moved. Updating the file for search by meaning in the background.', { level: 'info' });
      }
      return true;
    } catch (e: unknown) {
      if (stateRef.current.workspace.folderPath !== targetFolderPath) return false;
      toast('Move failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
      return false;
    }
  }, [askCascadeForRename, flushSave, loadFiles, toast]);

  const upload = useCallback(async (
    items: { file: File; relPath: string }[],
    dir: string,
  ): Promise<boolean> => {
    const targetFolderPath = stateRef.current.workspace.folderPath;
    const targetFolderLabel = stateRef.current.workspace.folder;
    if (!targetFolderPath) {
      toast('Open a folder before importing files.', { level: 'warning' });
      return false;
    }
    if (dir) dispatch({ type: 'EXPAND_FOLDER', path: dir });
    try {
      const j = await api.upload(items, dir, targetFolderPath);
      const stillInTargetFolder = stateRef.current.workspace.folderPath === targetFolderPath;
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
        const merged = [...new Set([...stateRef.current.workspace.pendingConversions, ...converting])].sort();
        dispatch({ type: 'PENDING_CONVERSIONS', paths: merged });
      }
      // Optimistically mark direct-text imports (Markdown, HTML, JSON, .txt)
      // as pending too. These never enter `pendingConversions`; they live
      // in `pendingSemanticNames` until the folder is up-to-date.
      // `refreshIndexState` holds these until the folder is up-to-date.
      const indexing = (j.files || [])
        .filter((x) => !x.error && DIRECT_TEXT_FILE_RE.test(x.file))
        .filter((x) => !x.file.split('/').some((seg) => seg.startsWith('.')))
        .map((x) => x.file);
      if (indexing.length) {
        const deadline = Date.now() + 60000;
        for (const name of indexing) importIndexGrace.current.set(name, deadline);
        dispatch({
          type: 'PENDING_SEMANTIC_NAMES',
          names: { ...stateRef.current.workspace.pendingSemanticNames, ...toNameSet(indexing) },
        });
      }
      // Now the server has fired any PDF/image/DOCX conversions. Poll
      // immediately so search-readiness accounting catches up even when a
      // conversion finishes inside the regular poll window.
      void refreshIndexState();
      // Auto-open the first file the drop produced — the
      // import was a deliberate user action, so showing what landed is
      // expected (mirrors dropping a file into an editor). The truthful
      // workbench renders every regular file as a document, read-only text,
      // or an explicit placeholder. Opens at most one file so a batch drop
      // does not explode into tabs.
      const first = j.files?.find((x) => !x.error);
      // A drop is a deliberate gesture, so show what landed in its own
      // tab (mirrors dropping a file into an editor).
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


  // One stable actions object: the workspace memo depends on this object,
  // not on individually listed members, so a new action added here is
  // tracked automatically.
  return useMemo(() => ({
    copyFileLink,
    deleteFile,
    deleteFolder,
    moveFile,
    newFolder,
    newNote,
    renameFile,
    renameFolder,
    reprocessFile,
    revealFile,
    toggleShowHiddenFiles,
    upload,
  }), [
    copyFileLink,
    deleteFile,
    deleteFolder,
    moveFile,
    newFolder,
    newNote,
    renameFile,
    renameFolder,
    reprocessFile,
    revealFile,
    toggleShowHiddenFiles,
    upload,
  ]);
}
