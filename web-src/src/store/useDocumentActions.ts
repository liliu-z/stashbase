import { useCallback, type MutableRefObject } from 'react';
import { AUDIO_SOURCE_EXTENSION_ALTERNATION } from '../../../shared/file-formats.ts';
import { api, ApiError } from '../api';
import type { EditorHandle, EditorSession } from './actionTypes';
import {
  isFolderFileTab,
  keywordFindCaseSensitive,
  waitForNextFrame,
} from './appContextHelpers';
import { getActiveTab, type Action, type PendingHighlight, type State } from './state';
import type { ToastOptions } from './useFeedbackActions';

const AUTOSAVE_DEBOUNCE_MS = 1200;
const AUDIO_SOURCE_RE = new RegExp(`\\.(${AUDIO_SOURCE_EXTENSION_ALTERNATION})$`, 'i');

type Dispatch = (action: Action) => void;
type Toast = (message: string, opts?: ToastOptions) => string;

interface DocumentActionRefs {
  state: MutableRefObject<State>;
  editor: MutableRefObject<EditorHandle | null>;
  saveTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  saveInFlight: MutableRefObject<Promise<boolean> | null>;
  editorSessions: MutableRefObject<Map<string, EditorSession>>;
}

interface DocumentActionDependencies {
  loadFiles: (expectedFolderPath?: string) => Promise<State['files']>;
  refreshIndexState: (folderPath?: string) => Promise<void>;
  toast: Toast;
  primeFind: (query: string, opts: { wholeWord: boolean; caseSensitive: boolean }) => void;
}

function isDocxName(name: string): boolean {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? name;
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
  const { editor, editorSessions, saveInFlight, saveTimer, state } = refs;
  const { loadFiles, refreshIndexState, toast, primeFind } = dependencies;

  const flushSave = useCallback(async () => {
    const inFlight = saveInFlight.current;
    if (inFlight) {
      const ok = await inFlight;
      if (!ok) return false;
    }
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    const run = (async () => {
      const tabAtStart = getActiveTab(state.current);
      const currentFile = tabAtStart?.file ?? null;
      const tabId = tabAtStart?.id ?? null;
      const handle = editor.current;
      if (!currentFile || !handle) return true;
      if (!tabAtStart?.dirty) return true;
      const content = handle.getValue();
      if (content === currentFile.content) {
        dispatch({ type: 'DOCUMENT_DIRTY', dirty: false });
        dispatch({ type: 'SAVE_STATUS', status: { text: 'Saved', cls: 'saved' } });
        return true;
      }
      dispatch({ type: 'SAVE_STATUS', status: { text: 'Saving…', cls: '' } });
      const saveContent = async (baseVersion?: string) => {
        const result = await api.putFile(currentFile.name, content, baseVersion);
        if (result.indexWarning) toast(result.indexWarning, { level: 'warning' });
        return result;
      };
      try {
        let savedResult: Awaited<ReturnType<typeof saveContent>>;
        try {
          savedResult = await saveContent(currentFile.version);
        } catch (err: unknown) {
          if (!(err instanceof ApiError && err.status === 409)) throw err;
          const latestTab = getActiveTab(state.current);
          const sameTab = latestTab?.id === tabId && latestTab.file?.name === currentFile.name;
          const liveValue = editor.current?.getValue();
          if (!sameTab || liveValue !== content) return false;
          savedResult = await saveContent(undefined);
          toast('Saved over a newer disk copy from sync.', { level: 'info' });
        }
        const latestTab = getActiveTab(state.current);
        const sameTab = latestTab?.id === tabId && latestTab.file?.name === currentFile.name;
        if (!sameTab) return true;

        const liveValue = editor.current?.getValue();
        dispatch({ type: 'FILE_PATCH', patch: { content: savedResult.content, version: savedResult.version } });
        if (liveValue === content) {
          dispatch({ type: 'DOCUMENT_DIRTY', dirty: false });
          dispatch({ type: 'SAVE_STATUS', status: { text: 'Saved', cls: 'saved' } });
        } else {
          dispatch({ type: 'SAVE_STATUS', status: { text: 'Unsaved', cls: '' } });
          if (!saveTimer.current) {
            saveTimer.current = setTimeout(() => { void flushSave(); }, AUTOSAVE_DEBOUNCE_MS);
          }
        }
        void loadFiles();
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
  }, [dispatch, editor, loadFiles, saveInFlight, saveTimer, state, toast]);

  const scheduleSave = useCallback(() => {
    dispatch({ type: 'DOCUMENT_DIRTY', dirty: true });
    dispatch({ type: 'SAVE_STATUS', status: { text: 'Unsaved', cls: '' } });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flushSave(); }, AUTOSAVE_DEBOUNCE_MS);
  }, [dispatch, flushSave, saveTimer]);

  const loadFile = useCallback(async (
    name: string,
    opts: { newTab?: boolean; preview?: boolean; anchor?: string; expectedFolder?: string },
  ) => {
    if (opts.expectedFolder && state.current.folderPath !== opts.expectedFolder) return;
    const currentFile = getActiveTab(state.current)?.file ?? null;
    if (editor.current && currentFile && currentFile.name !== name && !opts.newTab) {
      if (!(await flushSave())) return;
    }
    if (opts.expectedFolder && state.current.folderPath !== opts.expectedFolder) return;

    let body;
    if (/\.pdf$/i.test(name)) {
      try {
        const stat = await api.statFile(name);
        body = { name, format: 'pdf' as const, content: '', version: stat.version };
      } catch (err: unknown) {
        dispatch({ type: 'SAVE_STATUS', status: { text: err instanceof Error ? err.message : String(err), cls: 'error' } });
        return;
      }
    } else if (isDocxName(name)) {
      try {
        const stat = await api.statFile(name);
        body = { name, format: 'docx' as const, content: '', version: stat.version };
      } catch (err: unknown) {
        dispatch({ type: 'SAVE_STATUS', status: { text: err instanceof Error ? err.message : String(err), cls: 'error' } });
        return;
      }
      const folder = opts.expectedFolder ?? state.current.folderPath;
      void api.prepareDocx(name, { folder: folder || undefined })
        .then(() => refreshIndexState(folder || undefined))
        .catch((err: unknown) => {
          console.warn('[docx] interactive preparation request failed:', err);
        });
    } else if (isAudioName(name)) {
      try {
        const stat = await api.statFile(name);
        body = { name, format: 'audio' as const, content: '', version: stat.version };
      } catch (err: unknown) {
        dispatch({ type: 'SAVE_STATUS', status: { text: err instanceof Error ? err.message : String(err), cls: 'error' } });
        return;
      }
      const folder = opts.expectedFolder ?? state.current.folderPath;
      void api.prepareAudio(name, { folder: folder || undefined })
        .then(() => refreshIndexState(folder || undefined))
        .catch((err: unknown) => {
          console.warn('[audio] interactive preparation request failed:', err);
        });
    } else if (/\.(png|jpe?g|webp)$/i.test(name)) {
      try {
        const stat = await api.statFile(name);
        body = { name, format: 'image' as const, content: '', version: stat.version };
      } catch (err: unknown) {
        dispatch({ type: 'SAVE_STATUS', status: { text: err instanceof Error ? err.message : String(err), cls: 'error' } });
        return;
      }
    } else {
      try {
        body = await api.getFile(name);
      } catch (err: unknown) {
        dispatch({ type: 'SAVE_STATUS', status: { text: err instanceof Error ? err.message : String(err), cls: 'error' } });
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
      preview: opts.preview,
    });
    dispatch({ type: 'PENDING_SCROLL', anchor: opts.anchor ?? null });
  }, [dispatch, editor, flushSave, refreshIndexState, state]);

  const selectFile = useCallback(async (name: string) => {
    const expectedFolder = state.current.folderPath;
    if (editor.current && !(await flushSave())) return;
    if (state.current.folderPath !== expectedFolder) return;
    const currentState = state.current;
    const existing = currentState.tabs.find((tab) => isFolderFileTab(tab, name));
    if (existing) {
      if (currentState.activeTabId !== existing.id) dispatch({ type: 'ACTIVATE_TAB', id: existing.id });
      return;
    }
    const active = getActiveTab(currentState);
    if (active && !active.file) {
      await loadFile(name, { preview: true, expectedFolder });
      return;
    }
    const previewTab = currentState.tabs.find((tab) => tab.preview);
    if (previewTab) {
      if (currentState.activeTabId !== previewTab.id) dispatch({ type: 'ACTIVATE_TAB', id: previewTab.id });
      await loadFile(name, { expectedFolder });
      return;
    }
    await loadFile(name, { newTab: true, preview: true, expectedFolder });
  }, [dispatch, editor, flushSave, loadFile, state]);

  const selectFileWithHighlight = useCallback(async (name: string, hit: PendingHighlight) => {
    const expectedFolder = state.current.folderPath;
    await selectFile(name);
    if (state.current.folderPath !== expectedFolder) return;
    for (let i = 0; i < 8; i++) {
      if (getActiveTab(state.current)?.file?.name === name) break;
      await waitForNextFrame();
      if (state.current.folderPath !== expectedFolder) return;
    }
    if (getActiveTab(state.current)?.file?.name !== name) return;
    dispatch({ type: 'PENDING_HIGHLIGHT', highlight: hit });
    if (hit.openFindBar && hit.chunkText) {
      const currentState = state.current;
      primeFind(hit.chunkText, {
        wholeWord: currentState.wholeWord,
        caseSensitive: keywordFindCaseSensitive(hit.chunkText, currentState.caseStrict),
      });
    }
  }, [dispatch, primeFind, selectFile, state]);

  const openInNewTab = useCallback(async (name: string, expectedFolder?: string) => {
    const targetFolder = expectedFolder ?? state.current.folderPath;
    if (targetFolder && state.current.folderPath !== targetFolder) return;
    if (editor.current && !(await flushSave())) return;
    if (targetFolder && state.current.folderPath !== targetFolder) return;
    const currentState = state.current;
    const existing = currentState.tabs.find((tab) => isFolderFileTab(tab, name));
    if (existing) {
      if (currentState.activeTabId !== existing.id) dispatch({ type: 'ACTIVATE_TAB', id: existing.id });
      if (existing.preview) dispatch({ type: 'PROMOTE_TAB', id: existing.id });
      return;
    }
    await loadFile(name, { newTab: true, expectedFolder: targetFolder });
  }, [dispatch, editor, flushSave, loadFile, state]);

  const newTab = useCallback(async () => {
    if (editor.current && !(await flushSave())) return;
    dispatch({ type: 'NEW_TAB' });
  }, [dispatch, editor, flushSave]);

  const closeTab = useCallback(async (id: string) => {
    const currentState = state.current;
    if (currentState.activeTabId === id && editor.current && !(await flushSave())) return;
    dispatch({ type: 'CLOSE_TAB', id });
  }, [dispatch, editor, flushSave, state]);

  const closeActiveTab = useCallback(async () => {
    const id = state.current.activeTabId;
    if (id) await closeTab(id);
  }, [closeTab, state]);

  const activateTab = useCallback(async (id: string) => {
    const currentState = state.current;
    if (currentState.activeTabId === id) return;
    if (editor.current && !(await flushSave())) return;
    dispatch({ type: 'ACTIVATE_TAB', id });
  }, [dispatch, editor, flushSave, state]);

  const navigateTo = useCallback(async (name: string, anchor?: string) => {
    const expectedFolder = state.current.folderPath;
    const currentFile = getActiveTab(state.current)?.file ?? null;
    if (currentFile?.name === name) {
      if (anchor) dispatch({ type: 'PENDING_SCROLL', anchor });
      return;
    }
    if (editor.current && !(await flushSave())) return;
    if (state.current.folderPath !== expectedFolder) return;
    const existing = state.current.tabs.find((tab) => isFolderFileTab(tab, name));
    if (existing) {
      if (state.current.activeTabId !== existing.id) dispatch({ type: 'ACTIVATE_TAB', id: existing.id });
      if (existing.preview) dispatch({ type: 'PROMOTE_TAB', id: existing.id });
      if (anchor) dispatch({ type: 'PENDING_SCROLL', anchor });
      return;
    }
    await loadFile(name, { newTab: true, anchor, expectedFolder });
  }, [dispatch, editor, flushSave, loadFile, state]);

  const consumePendingScroll = useCallback(() => {
    dispatch({ type: 'PENDING_SCROLL', anchor: null });
  }, [dispatch]);

  const consumePendingHighlight = useCallback(() => {
    dispatch({ type: 'PENDING_HIGHLIGHT', highlight: null });
  }, [dispatch]);

  const toggleEditMode = useCallback(async () => {
    const tab = getActiveTab(state.current);
    if (!tab?.file) return;
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

  const getEditorSession = useCallback((tabId: string) => editorSessions.current.get(tabId), [editorSessions]);
  const setEditorSession = useCallback((tabId: string, session: EditorSession) => {
    editorSessions.current.set(tabId, session);
  }, [editorSessions]);

  return {
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
  };
}
