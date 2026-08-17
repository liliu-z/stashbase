import { useCallback, useMemo, useRef, type MutableRefObject } from 'react';
import { AUDIO_SOURCE_EXTENSION_ALTERNATION } from '../../../shared/file-formats.ts';
import { api, ApiError } from '../api';
import { electronBridge } from '../electronBridge';
import { folderRefsEqual } from '../folderPath';
import { basename } from '../lib/paths';
import type { EditorHandle } from './actionTypes';
import { buildConflictMarkerDraft } from './conflictDiff';
import {
  isFolderFileTab,
  keywordFindCaseSensitive,
  waitForNextFrame,
} from './appContextHelpers';
import { getActiveTab, type Action, type PendingHighlight, type State, type TabConflict, type ModalRequest } from './state';
import type { ToastOptions } from './useFeedbackActions';

const AUTOSAVE_DEBOUNCE_MS = 1200;
const AUDIO_SOURCE_RE = new RegExp(`\\.(${AUDIO_SOURCE_EXTENSION_ALTERNATION})$`, 'i');
const scheduleWithTimeout = (callback: () => void, delayMs: number) => setTimeout(callback, delayMs);
const cancelTimeout = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer);

type Dispatch = (action: Action) => void;
type Toast = (message: string, opts?: ToastOptions) => string;

interface DocumentActionRefs {
  state: MutableRefObject<State>;
  editor: MutableRefObject<EditorHandle | null>;
  saveTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  saveInFlight: MutableRefObject<Promise<boolean> | null>;
}

interface DocumentActionDependencies {
  loadFiles: (expectedFolderPath?: string) => Promise<State['files']>;
  refreshIndexState: (folderPath?: string) => Promise<void>;
  toast: Toast;
  askConfirm: (message: string, opts?: Pick<ModalRequest, 'title' | 'confirmLabel' | 'destructive'>) => Promise<boolean>;
  primeFind: (query: string, opts: { wholeWord: boolean; caseSensitive: boolean }) => void;
  scheduleAfter?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelScheduled?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface ConflictSettlement {
  tabId: string;
  fileName: string;
  durableContent: string;
  durableVersion: string;
  supersededVersions: Array<string | undefined>;
  nextContent: string;
  dirty: boolean;
  status: State['tabs'][number]['saveStatus'];
}

function isDocxName(name: string): boolean {
  // Names reaching loadFile are POSIX rel paths (listings, search hits, and
  // preview links already URL-resolved, which folds `\` into `/`), so no
  // backslash normalization is needed before taking the basename.
  const base = basename(name);
  return /\.docx$/i.test(base) && !base.startsWith('~$') && !base.startsWith('.~');
}

function isAudioName(name: string): boolean {
  return AUDIO_SOURCE_RE.test(name);
}

/** Owns editor persistence, document loading, and tab navigation semantics. */
export function useDocumentActions(
  refs: DocumentActionRefs,
  dependencies: DocumentActionDependencies,
  dispatch: Dispatch,
) {
  const { editor, saveInFlight, saveTimer, state } = refs;
  /** The latest durable disk baseline. `state` is a render-time mirror, so a
   *  flush can start before the reducer commits a save acknowledgement or a
   *  conflict-resolution snapshot. This ref carries that baseline across the
   *  render gap. `superseded` holds every older baseVersion in the chain. */
  const latestDurableBaseline = useRef<{
    name: string; content: string; version?: string; superseded: Set<string | undefined>;
  } | null>(null);
  // The state flag disables the UI after React commits; this ref closes the
  // earlier same-tick window so two resolution callbacks cannot both mutate
  // one conflict.
  const conflictResolutionsInFlight = useRef(new Set<string>());
  // A renderer dirty dispatch may commit one render after the editor change.
  // Track edit intent synchronously per tab so the live buffer can remain save
  // authority without treating an editor's mount-time normalization as a user
  // edit.
  const pendingEditorChangeTabs = useRef(new Set<string>());
  const { loadFiles, refreshIndexState, toast, primeFind, askConfirm } = dependencies;
  const scheduleAfter = dependencies.scheduleAfter ?? scheduleWithTimeout;
  const cancelScheduled = dependencies.cancelScheduled ?? cancelTimeout;

  const flushSave = useCallback(async () => {
    // Loop, not a single await: while we waited, another caller may have
    // started a fresh run (timer + close-tab + folder-switch can stack).
    while (saveInFlight.current) {
      const ok = await saveInFlight.current;
      if (!ok) return false;
    }
    if (saveTimer.current) {
      cancelScheduled(saveTimer.current);
      saveTimer.current = null;
    }

    const run = (async () => {
      const tabAtStart = getActiveTab(state.current);
      if (!tabAtStart?.file) return true;
      const currentFile = tabAtStart.file;
      const tabId = tabAtStart.id;
      const folderPathAtSave = state.current.folderPath;
      // Out-of-folder tabs are read-only; a PUT would write a same-named
      // file into the ACTIVE folder.
      if (currentFile.folder || currentFile.isExternal || currentFile.isReadOnly) return true;
      // The conflict surface intentionally replaces the editor. Treat that as
      // an unresolved save barrier, not as evidence that there is nothing to
      // save; native close/reload and renderer navigation must remain blocked.
      if (tabAtStart.conflict) return false;
      const handle = editor.current;
      if (!handle) return tabAtStart.dirty !== true;
      if (!pendingEditorChangeTabs.current.has(tabId) && tabAtStart.dirty !== true) {
        return true;
      }
      // The editor callback can update its live value one render before the
      // reducer's dirty flag reaches state.current. Context release may land
      // in that gap, so the UI flag is presentation, not save authority.
      const content = handle.getValue();
      // If the state mirror still shows a version the durable baseline
      // replaced, its reducer patch has not committed yet: compare and base
      // the PUT on the ref instead, or this run would use a stale version.
      const durable = latestDurableBaseline.current;
      const stateLagsDurable = durable != null
        && durable.name === currentFile.name
        && durable.superseded.has(currentFile.version);
      const baselineContent = stateLagsDurable ? durable.content : currentFile.content;
      if (content === baselineContent) {
        pendingEditorChangeTabs.current.delete(tabId);
        dispatch({ type: 'DOCUMENT_DIRTY', dirty: false });
        dispatch({ type: 'SAVE_STATUS', status: { text: 'Saved', cls: 'saved' } });
        return true;
      }
      const baseVersion = stateLagsDurable ? durable.version : currentFile.version;
      dispatch({ type: 'SAVE_STATUS', status: { text: 'Saving…', cls: '' } });
      const saveContent = async (base?: string) => {
        const result = await api.putFile(currentFile.name, content, base);
        if (result.indexWarning) toast(result.indexWarning, { level: 'warning' });
        return result;
      };
      try {
        let savedResult: Awaited<ReturnType<typeof saveContent>>;
        try {
          savedResult = await saveContent(baseVersion);
        } catch (err: unknown) {
          if (!(err instanceof ApiError && err.status === 409)) throw err;
          let diskContent: string;
          let diskVersion: string;
          try {
            const body = await api.getFile(currentFile.name);
            if (!body.version) throw new Error('conflicted file read did not include a version');
            diskContent = body.content;
            diskVersion = body.version;
          } catch (fetchErr: unknown) {
            console.error('Failed to fetch conflicted file content from disk:', fetchErr);
            throw err;
          }
          const latestTab = getActiveTab(state.current);
          const sameTab = latestTab?.id === tabId && latestTab.file?.name === currentFile.name;
          if (!sameTab) return false;
          // The request may have been in flight while the user kept typing.
          // Capture the live buffer immediately before the conflict surface
          // replaces and unmounts the editor.
          const latestEditorContent = editor.current?.getValue() ?? content;
          dispatch({
            type: 'SET_CONFLICT',
            id: tabId,
            conflict: {
              diskContent,
              diskVersion,
              editorContent: latestEditorContent,
            },
          });
          dispatch({ type: 'SAVE_STATUS', status: { text: 'Conflict detected', cls: 'error' } });
          return false;
        }
        const superseded = stateLagsDurable && durable ? durable.superseded : new Set<string | undefined>();
        superseded.add(baseVersion);
        latestDurableBaseline.current = {
          name: currentFile.name,
          content,
          version: savedResult.version,
          superseded,
        };
        const latestTab = getActiveTab(state.current);
        const sameTab = latestTab?.id === tabId && latestTab.file?.name === currentFile.name;
        if (!sameTab) return true;

        const liveValue = editor.current?.getValue();
        // Keep the tab's retained source aligned with the accepted save so a
        // later tab reactivation does not remount from its original content.
        // Document surfaces ignore incoming source while dirty; for a clean
        // acknowledgement this value already equals the live editor.
        dispatch({ type: 'FILE_PATCH', patch: { content, version: savedResult.version } });
        if (liveValue === content) {
          pendingEditorChangeTabs.current.delete(tabId);
          dispatch({ type: 'DOCUMENT_DIRTY', dirty: false });
          dispatch({ type: 'SAVE_STATUS', status: { text: 'Saved', cls: 'saved' } });
        } else {
          pendingEditorChangeTabs.current.add(tabId);
          dispatch({ type: 'SAVE_STATUS', status: { text: 'Unsaved', cls: '' } });
          if (!saveTimer.current) {
            saveTimer.current = scheduleAfter(() => { void flushSave(); }, AUTOSAVE_DEBOUNCE_MS);
          }
        }
        // Expected-folder guard: a slow listing response must not repopulate
        // the tree after a folder switch (this save's folder may be gone).
        void loadFiles(folderPathAtSave);
        return true;
      } catch (err: unknown) {
        const latestTab = getActiveTab(state.current);
        const sameTab = latestTab?.id === tabId && latestTab.file?.name === currentFile.name;
        if (!sameTab) return false;
        const message = err instanceof Error ? err.message : String(err);
        dispatch({ type: 'SAVE_STATUS', status: { text: 'Save failed: ' + message, cls: 'error' } });
        return false;
      }
    })();

    saveInFlight.current = run;
    try {
      return await run;
    } finally {
      if (saveInFlight.current === run) saveInFlight.current = null;
    }
  }, [cancelScheduled, dispatch, editor, loadFiles, saveInFlight, saveTimer, scheduleAfter, state, toast]);

  const scheduleSave = useCallback(() => {
    const tabId = state.current.activeTabId;
    if (tabId) pendingEditorChangeTabs.current.add(tabId);
    dispatch({ type: 'DOCUMENT_DIRTY', dirty: true });
    dispatch({ type: 'SAVE_STATUS', status: { text: 'Unsaved', cls: '' } });
    if (saveTimer.current) cancelScheduled(saveTimer.current);
    saveTimer.current = scheduleAfter(() => { void flushSave(); }, AUTOSAVE_DEBOUNCE_MS);
  }, [cancelScheduled, dispatch, flushSave, saveTimer, scheduleAfter, state]);

  const claimConflictResolution = useCallback((tabId: string) => {
    const tab = state.current.tabs.find((candidate) => candidate.id === tabId);
    if (
      !tab?.conflict
      || !tab.file
      || tab.conflict.resolving
      || conflictResolutionsInFlight.current.has(tabId)
    ) {
      return null;
    }
    conflictResolutionsInFlight.current.add(tabId);
    dispatch({ type: 'SET_CONFLICT_RESOLVING', id: tabId, resolving: true });
    return tab;
  }, [dispatch, state]);

  const releaseConflictResolution = useCallback((tabId: string) => {
    conflictResolutionsInFlight.current.delete(tabId);
    // Successful settlement clears the conflict first, making this a no-op.
    // Failure or a cancelled close keeps the comparison visible and
    // re-enables every choice.
    dispatch({ type: 'SET_CONFLICT_RESOLVING', id: tabId, resolving: false });
  }, [dispatch]);

  const loadFile = useCallback(async (
    name: string,
    opts: {
      newTab?: boolean;
      anchor?: string;
      expectedFolder?: string;
      /** Read from this explicit member folder instead of the window's own —
       *  the resulting tab is an out-of-folder read-only viewer. */
      libraryFolder?: string;
    },
  ) => {
    if (opts.expectedFolder && state.current.folderPath !== opts.expectedFolder) return;
    const currentFile = getActiveTab(state.current)?.file ?? null;
    if (currentFile && currentFile.name !== name && !opts.newTab) {
      if (!(await flushSave())) return;
    }
    if (opts.expectedFolder && state.current.folderPath !== opts.expectedFolder) return;
    const readOpts = opts.libraryFolder ? { folder: opts.libraryFolder } : undefined;

    let body;
    if (/\.pdf$/i.test(name)) {
      try {
        const stat = await api.statFile(name, readOpts);
        body = { name, format: 'pdf' as const, content: '', version: stat.version };
      } catch (err: unknown) {
        // A failed open is navigation feedback, not the active document's
        // save state — SAVE_STATUS would paint the error onto the tab the
        // user is leaving (and is invisible outside edit mode).
        toast(`Could not open ${basename(name)}: ${err instanceof Error ? err.message : String(err)}`, { level: 'error' });
        return;
      }
    } else if (isDocxName(name)) {
      try {
        const stat = await api.statFile(name, readOpts);
        body = { name, format: 'docx' as const, content: '', version: stat.version };
      } catch (err: unknown) {
        // A failed open is navigation feedback, not the active document's
        // save state — SAVE_STATUS would paint the error onto the tab the
        // user is leaving (and is invisible outside edit mode).
        toast(`Could not open ${basename(name)}: ${err instanceof Error ? err.message : String(err)}`, { level: 'error' });
        return;
      }
      const folder = opts.libraryFolder ?? opts.expectedFolder ?? state.current.folderPath;
      void api.prepareDocx(name, { folder: folder || undefined })
        .then(() => refreshIndexState(folder || undefined))
        .catch((err: unknown) => {
          console.warn('[docx] interactive preparation request failed:', err);
        });
    } else if (isAudioName(name)) {
      try {
        const stat = await api.statFile(name, readOpts);
        body = { name, format: 'audio' as const, content: '', version: stat.version };
      } catch (err: unknown) {
        // A failed open is navigation feedback, not the active document's
        // save state — SAVE_STATUS would paint the error onto the tab the
        // user is leaving (and is invisible outside edit mode).
        toast(`Could not open ${basename(name)}: ${err instanceof Error ? err.message : String(err)}`, { level: 'error' });
        return;
      }
      const folder = opts.libraryFolder ?? opts.expectedFolder ?? state.current.folderPath;
      void api.prepareAudio(name, { folder: folder || undefined })
        .then(() => refreshIndexState(folder || undefined))
        .catch((err: unknown) => {
          console.warn('[audio] interactive preparation request failed:', err);
        });
    } else if (/\.(png|jpe?g|webp)$/i.test(name)) {
      try {
        const stat = await api.statFile(name, readOpts);
        body = { name, format: 'image' as const, content: '', version: stat.version };
      } catch (err: unknown) {
        // A failed open is navigation feedback, not the active document's
        // save state — SAVE_STATUS would paint the error onto the tab the
        // user is leaving (and is invisible outside edit mode).
        toast(`Could not open ${basename(name)}: ${err instanceof Error ? err.message : String(err)}`, { level: 'error' });
        return;
      }
    } else {
      try {
        body = await api.getFile(name, readOpts);
      } catch (err: unknown) {
        // A failed open is navigation feedback, not the active document's
        // save state — SAVE_STATUS would paint the error onto the tab the
        // user is leaving (and is invisible outside edit mode).
        toast(`Could not open ${basename(name)}: ${err instanceof Error ? err.message : String(err)}`, { level: 'error' });
        return;
      }
    }
    if (opts.expectedFolder && state.current.folderPath !== opts.expectedFolder) return;
    const noActiveTab = state.current.activeTabId == null || !getActiveTab(state.current);
    const newTabMode = !!opts.newTab || noActiveTab;
    dispatch({
      type: 'FILE_OPEN',
      body,
      newTab: newTabMode ? !noActiveTab : undefined,
      libraryFolder: opts.libraryFolder,
    });
    dispatch({ type: 'PENDING_SCROLL', anchor: opts.anchor ?? null });
  }, [dispatch, editor, flushSave, refreshIndexState, state, toast]);

  // A sidebar single-click opens the file in its own persistent tab.
  // Already open → focus it; the active tab is a blank `+` tab → fill
  // it in place; otherwise open a fresh tab. No preview/replace mode:
  // one click, one lasting tab.
  const selectFile = useCallback(async (name: string) => {
    const expectedFolder = state.current.folderPath;
    if (!(await flushSave())) return;
    if (state.current.folderPath !== expectedFolder) return;
    const currentState = state.current;
    const existing = currentState.tabs.find((tab) => isFolderFileTab(tab, name));
    if (existing) {
      if (currentState.activeTabId !== existing.id) dispatch({ type: 'ACTIVATE_TAB', id: existing.id });
      return;
    }
    const active = getActiveTab(currentState);
    if (active && !active.file) {
      await loadFile(name, { expectedFolder });
      return;
    }
    await loadFile(name, { newTab: true, expectedFolder });
  }, [dispatch, editor, flushSave, loadFile, state]);

  const armHighlight = useCallback((hit: PendingHighlight) => {
    dispatch({ type: 'PENDING_HIGHLIGHT', highlight: hit });
    if (hit.openFindBar && hit.chunkText) {
      primeFind(hit.chunkText, {
        wholeWord: false,
        caseSensitive: keywordFindCaseSensitive(hit.chunkText, false),
      });
    }
  }, [dispatch, primeFind]);

  const selectFileWithHighlight = useCallback(async (name: string, hit: PendingHighlight) => {
    const expectedFolder = state.current.folderPath;
    const isTarget = () => {
      const file = getActiveTab(state.current)?.file;
      // Same rel name on an out-of-folder tab is a different document.
      return file?.name === name && !file.folder;
    };
    await selectFile(name);
    if (state.current.folderPath !== expectedFolder) return;
    for (let i = 0; i < 8; i++) {
      if (isTarget()) break;
      await waitForNextFrame();
      if (state.current.folderPath !== expectedFolder) return;
    }
    if (!isTarget()) return;
    armHighlight(hit);
  }, [armHighlight, selectFile, state]);

  const openInNewTab = useCallback(async (name: string, expectedFolder?: string) => {
    const targetFolder = expectedFolder ?? state.current.folderPath;
    if (targetFolder && state.current.folderPath !== targetFolder) return;
    if (!(await flushSave())) return;
    if (targetFolder && state.current.folderPath !== targetFolder) return;
    const currentState = state.current;
    const existing = currentState.tabs.find((tab) => isFolderFileTab(tab, name));
    if (existing) {
      if (currentState.activeTabId !== existing.id) dispatch({ type: 'ACTIVATE_TAB', id: existing.id });
      return;
    }
    await loadFile(name, { newTab: true, expectedFolder: targetFolder });
  }, [dispatch, editor, flushSave, loadFile, state]);

  const newTab = useCallback(async () => {
    if (!(await flushSave())) return;
    dispatch({ type: 'NEW_TAB' });
  }, [dispatch, editor, flushSave]);

  const closeTab = useCallback(async (id: string) => {
    const currentState = state.current;
    const tab = currentState.tabs.find((t) => t.id === id);
    if (tab?.conflict) {
      const ownedTab = claimConflictResolution(id);
      if (!ownedTab) return;
      try {
        const confirmed = await askConfirm(
          `"${ownedTab.file?.name}" has unresolved conflicts. Closing this tab will discard your changes.`,
          {
            title: 'Discard Conflicted Changes?',
            confirmLabel: 'Close and Discard',
            destructive: true,
          }
        );
        if (!confirmed) return;
        pendingEditorChangeTabs.current.delete(id);
        dispatch({ type: 'RESOLVE_CONFLICT_DISCARD', id });
        dispatch({ type: 'CLOSE_TAB', id });
      } finally {
        releaseConflictResolution(id);
      }
      return;
    }
    if (currentState.activeTabId === id && !(await flushSave())) return;
    dispatch({ type: 'CLOSE_TAB', id });
    if (tab?.file?.isExternal && tab.file.grantId) {
      const bridge = electronBridge();
      void bridge?.revokePreviewGrant?.(tab.file.grantId);
    }
  }, [askConfirm, claimConflictResolution, dispatch, flushSave, releaseConflictResolution, state]);

  const closeActiveTab = useCallback(async () => {
    const id = state.current.activeTabId;
    if (id) await closeTab(id);
  }, [closeTab, state]);

  const activateTab = useCallback(async (id: string) => {
    const currentState = state.current;
    if (currentState.activeTabId === id) return;
    if (!(await flushSave())) return;
    dispatch({ type: 'ACTIVATE_TAB', id });
  }, [dispatch, editor, flushSave, state]);

  const navigateTo = useCallback(async (name: string, anchor?: string) => {
    const expectedFolder = state.current.folderPath;
    const currentFile = getActiveTab(state.current)?.file ?? null;
    if (currentFile?.name === name) {
      if (anchor) dispatch({ type: 'PENDING_SCROLL', anchor });
      return;
    }
    if (!(await flushSave())) return;
    if (state.current.folderPath !== expectedFolder) return;
    const existing = state.current.tabs.find((tab) => isFolderFileTab(tab, name));
    if (existing) {
      if (state.current.activeTabId !== existing.id) dispatch({ type: 'ACTIVATE_TAB', id: existing.id });
      if (anchor) dispatch({ type: 'PENDING_SCROLL', anchor });
      return;
    }
    await loadFile(name, { newTab: true, anchor, expectedFolder });
  }, [dispatch, editor, flushSave, loadFile, state]);

  /** Open a file by (member folder, rel path). A target in the window's
   *  own folder goes through the normal selection path; anything else opens
   *  an out-of-folder read-only tab WITHOUT switching the window's folder. */
  const openLibraryFile = useCallback(async (
    folder: string,
    name: string,
    opts?: { hit?: PendingHighlight; anchor?: string },
  ) => {
    const startState = state.current;
    if (startState.folderPath && folderRefsEqual(folder, startState.folderPath)) {
      if (opts?.hit) await selectFileWithHighlight(name, opts.hit);
      else if (opts?.anchor) await navigateTo(name, opts.anchor);
      else await selectFile(name);
      return;
    }
    if (!(await flushSave())) return;
    const isTarget = () => {
      const file = getActiveTab(state.current)?.file;
      return file?.name === name && file.folder != null && folderRefsEqual(file.folder, folder);
    };
    const existing = state.current.tabs.find((tab) =>
      tab.file?.name === name && tab.file.folder != null && folderRefsEqual(tab.file.folder, folder));
    if (existing) {
      if (state.current.activeTabId !== existing.id) dispatch({ type: 'ACTIVATE_TAB', id: existing.id });
      if (opts?.anchor) dispatch({ type: 'PENDING_SCROLL', anchor: opts.anchor });
    } else {
      // Mirror selectFile: fill a blank tab in place, otherwise open a
      // fresh persistent tab.
      const active = getActiveTab(state.current);
      if (active && !active.file) {
        await loadFile(name, { libraryFolder: folder, anchor: opts?.anchor });
      } else {
        await loadFile(name, { newTab: true, libraryFolder: folder, anchor: opts?.anchor });
      }
    }
    const hit = opts?.hit;
    if (!hit) return;
    for (let i = 0; i < 8; i++) {
      if (isTarget()) break;
      await waitForNextFrame();
    }
    if (!isTarget()) return;
    armHighlight(hit);
  }, [armHighlight, dispatch, editor, flushSave, loadFile, navigateTo, selectFile, selectFileWithHighlight, state]);


  const consumePendingScroll = useCallback(() => {
    dispatch({ type: 'PENDING_SCROLL', anchor: null });
  }, [dispatch]);

  const consumePendingHighlight = useCallback(() => {
    dispatch({ type: 'PENDING_HIGHLIGHT', highlight: null });
  }, [dispatch]);

  const toggleEditMode = useCallback(async () => {
    const tab = getActiveTab(state.current);
    if (!tab?.file) return;
    // Out-of-folder or external tabs never edit — their save path would write into
    // the ACTIVE folder.
    if (tab.file.folder || tab.file.isExternal || tab.file.isReadOnly) return;
    if (tab.editMode) {
      if (!(await flushSave())) return;
      dispatch({ type: 'EDIT_MODE', on: false });
    } else {
      dispatch({ type: 'EDIT_MODE', on: true });
    }
  }, [dispatch, flushSave, state]);

  const registerEditor = useCallback((handle: EditorHandle | null) => {
    editor.current = handle;
  }, [editor]);

  const openExternalFilePath = useCallback(async (filePath: string, opts?: { suppressToast?: boolean }) => {
    const { openExternalFilePath: openPath } = await import('./externalFileOpen');
    return openPath({
      filePath,
      suppressToast: opts?.suppressToast === true,
      selectFile,
      getState: () => state.current,
      dispatch,
      toast,
    });
  }, [dispatch, selectFile, state, toast]);

  const openExternalFiles = useCallback(async (files: File[]) => {
    const { openExternalFiles: openFiles } = await import('./externalFileOpen');
    await openFiles({ files, openPath: openExternalFilePath, toast });
  }, [openExternalFilePath, toast]);

  const updateTabPdfPage = useCallback((tabId: string, page: number) => {
    dispatch({ type: 'TAB_PDF_PAGE', id: tabId, page });
  }, [dispatch]);

  const setUnsupportedModalOpen = useCallback((open: boolean) => {
    dispatch({ type: 'UNSUPPORTED_MODAL', open });
  }, [dispatch]);

  const settleConflict = useCallback((settlement: ConflictSettlement) => {
    const activeTab = getActiveTab(state.current);
    if (
      activeTab?.id !== settlement.tabId
      || activeTab.file?.name !== settlement.fileName
      || !activeTab.conflict
    ) {
      return false;
    }
    latestDurableBaseline.current = {
      name: settlement.fileName,
      content: settlement.durableContent,
      version: settlement.durableVersion,
      superseded: new Set(settlement.supersededVersions),
    };
    if (settlement.dirty) pendingEditorChangeTabs.current.add(settlement.tabId);
    else pendingEditorChangeTabs.current.delete(settlement.tabId);
    dispatch({
      type: 'FILE_PATCH',
      patch: { content: settlement.nextContent, version: settlement.durableVersion },
    });
    dispatch({ type: 'SET_CONFLICT', id: settlement.tabId, conflict: null });
    dispatch({ type: 'DOCUMENT_DIRTY', dirty: settlement.dirty });
    dispatch({ type: 'SAVE_STATUS', status: settlement.status });
    return true;
  }, [dispatch, state]);

  const resolveConflictOverwrite = useCallback(async (tabId: string) => {
    const tab = claimConflictResolution(tabId);
    if (!tab?.conflict || !tab.file) return;
    const folderPathAtStart = state.current.folderPath;
    const { editorContent } = tab.conflict;
    const fileName = tab.file.name;
    dispatch({ type: 'SAVE_STATUS', status: { text: 'Saving…', cls: '' } });
    try {
      const savedResult = await api.putFile(fileName, editorContent, undefined);
      if (savedResult.indexWarning) toast(savedResult.indexWarning, { level: 'warning' });

      if (!savedResult.version) throw new Error('save response did not include a version');
      if (!settleConflict({
        tabId,
        fileName,
        durableContent: editorContent,
        durableVersion: savedResult.version,
        supersededVersions: [tab.file.version],
        nextContent: editorContent,
        dirty: false,
        status: { text: 'Saved', cls: 'saved' },
      })) return;
      void loadFiles(folderPathAtStart);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const activeTab = getActiveTab(state.current);
      if (activeTab?.id === tabId && activeTab.file?.name === fileName && activeTab.conflict) {
        dispatch({ type: 'SAVE_STATUS', status: { text: 'Save failed: ' + message, cls: 'error' } });
      }
      toast('Failed to overwrite: ' + message, { level: 'error' });
    } finally {
      releaseConflictResolution(tabId);
    }
  }, [claimConflictResolution, dispatch, loadFiles, releaseConflictResolution, settleConflict, state, toast]);

  const resolveConflictReload = useCallback(async (tabId: string) => {
    const tab = claimConflictResolution(tabId);
    if (!tab?.conflict || !tab.file) return;
    const folderPathAtStart = state.current.folderPath;
    const { diskContent, diskVersion } = tab.conflict;
    try {
      if (!settleConflict({
        tabId,
        fileName: tab.file.name,
        durableContent: diskContent,
        durableVersion: diskVersion,
        supersededVersions: [tab.file.version],
        nextContent: diskContent,
        dirty: false,
        status: { text: '', cls: '' },
      })) return;
      void loadFiles(folderPathAtStart);
    } finally {
      releaseConflictResolution(tabId);
    }
  }, [claimConflictResolution, loadFiles, releaseConflictResolution, settleConflict, state]);

  const resolveConflictMerge = useCallback(async (tabId: string) => {
    const tab = claimConflictResolution(tabId);
    if (!tab?.conflict || !tab.file) return;
    const { diskContent, editorContent, diskVersion } = tab.conflict;

    const mergedContent = buildConflictMarkerDraft(editorContent, diskContent);

    // The merge is an editor draft based on the disk snapshot, not a durable
    // save. Preserve the disk content/version as the comparison baseline so
    // the remounted editor must PUT the merged draft before any transition.
    try {
      settleConflict({
        tabId,
        fileName: tab.file.name,
        durableContent: diskContent,
        durableVersion: diskVersion,
        supersededVersions: [tab.file.version, diskVersion],
        nextContent: mergedContent,
        dirty: true,
        status: { text: 'Merged', cls: '' },
      });
    } finally {
      releaseConflictResolution(tabId);
    }
  }, [claimConflictResolution, releaseConflictResolution, settleConflict]);

  // One stable actions object: the workspace memo depends on this object,
  // not on individually listed members, so a new action added here is
  // tracked automatically.
  return useMemo(() => ({
    activateTab,
    closeActiveTab,
    closeTab,
    consumePendingHighlight,
    consumePendingScroll,
    flushSave,
    openExternalFilePath,
    openExternalFiles,
    navigateTo,
    newTab,
    openInNewTab,
    openLibraryFile,
    registerEditor,
    scheduleSave,
    selectFile,
    selectFileWithHighlight,
    setUnsupportedModalOpen,
    toggleEditMode,
    updateTabPdfPage,
    resolveConflictOverwrite,
    resolveConflictReload,
    resolveConflictMerge,
  }), [
    activateTab,
    closeActiveTab,
    closeTab,
    consumePendingHighlight,
    consumePendingScroll,
    flushSave,
    navigateTo,
    newTab,
    openInNewTab,
    openLibraryFile,
    registerEditor,
    scheduleSave,
    selectFile,
    selectFileWithHighlight,
    setUnsupportedModalOpen,
    toggleEditMode,
    updateTabPdfPage,
    resolveConflictOverwrite,
    resolveConflictReload,
    resolveConflictMerge,
  ]);
}
