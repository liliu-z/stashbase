/**
 * Pure renderer reducer. State and action definitions remain in the stable
 * state.ts facade; transition helpers live in stateHelpers.ts.
 */
import type { Action, OpenFile, State } from './state';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampChatWidth,
  forgetChatTab,
  getActiveTab,
  makeTab,
  mostRecentChatTab,
  patchActiveTab,
  remapFileOrder,
  remapOnePath,
  rememberChatTab,
} from './stateHelpers';

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'WELCOME_HIDE':
      return { ...s, welcomeVisible: false, welcomeError: null };
    case 'WELCOME_SHOW':
      return {
        ...s,
        welcomeVisible: true,
        recent: a.recent,
        homeDir: a.homeDir ?? s.homeDir,
        welcomeError: a.error ?? null,
      };
    case 'RECENT_LOADED':
      return {
        ...s,
        recent: a.recent,
        homeDir: a.homeDir ?? s.homeDir,
      };
    case 'WELCOME_ERROR':
      return { ...s, welcomeError: a.error };
    case 'LIBRARY_FOLDER_STATUS':
      return s.libraryFolderStatuses[a.path] === a.status
        ? s
        : {
            ...s,
            libraryFolderStatuses: {
              ...s.libraryFolderStatuses,
              [a.path]: a.status,
            },
          };
    case 'LIBRARY_FOLDER_STATUS_REMOVE': {
      if (!(a.path in s.libraryFolderStatuses)) return s;
      const { [a.path]: _removed, ...rest } = s.libraryFolderStatuses;
      return { ...s, libraryFolderStatuses: rest };
    }
    case 'FOLDER_CONTEXT':
      return s.folder === a.folder && s.folderPath === a.folderPath
        ? s
        : { ...s, folder: a.folder, folderPath: a.folderPath };
    case 'FILES_LOADED': {
      const folderPath = a.folderPath ?? (a.folder ? s.folderPath : '');
      const folderChanged = folderPath !== s.folderPath;
      return {
        ...s,
        files: a.files,
        folders: a.folders,
        folder: a.folder,
        folderPath,
        ...(folderChanged
          ? {
              activeSidebarView: 'files' as const,
              filterQuery: '',
              searching: false,
              searchHits: null,
              keywordResult: null,
              searchError: null,
              // Scope names a subfolder of the previous folder; type
              // filters are per-folder session state too.
              searchScope: null,
              searchTypes: [],
            }
          : {}),
      };
    }
    case 'FILE_ORDER_LOADED':
      return { ...s, fileOrder: a.order };
    case 'FILE_ORDER_SET': {
      const next = { ...s.fileOrder };
      if (a.names.length === 0) delete next[a.parentPath];
      else next[a.parentPath] = a.names.slice();
      return { ...s, fileOrder: next };
    }
    case 'FILE_OPEN': {
      const file: OpenFile = {
        name: a.body.name,
        format: a.body.format,
        content: a.body.content,
        version: a.body.version,
      };
      const liveEditing = file.format === 'md';
      // New-tab mode (double-click in tree, `+` then a click): create
      // a fresh tab and load into it. Otherwise replace the active
      // tab's file (VS Code single-click mode). If there's no active
      // tab at all, an open click implicitly creates one.
      if (a.newTab || s.activeTabId == null || !getActiveTab(s)) {
        const tab = makeTab();
        tab.file = file;
        tab.editMode = liveEditing;
        tab.dirty = false;
        tab.preview = a.preview ?? false;
        return {
          ...s,
          tabs: [...s.tabs, tab],
          activeTabId: tab.id,
          selectedPath: file.name,
        };
      }
      return {
        ...patchActiveTab(s, {
          file,
          editMode: liveEditing,
          dirty: false,
          editorSessionVersion: getActiveTab(s)!.editorSessionVersion + 1,
          saveStatus: { text: '', cls: '' },
          pendingAnchor: null,
          pendingHighlight: null,
          // Only touch `preview` when explicitly asked — in-place anchor
          // nav reuses the same tab and must keep its existing
          // preview/pinned status.
          ...(a.preview != null ? { preview: a.preview } : {}),
        }),
        selectedPath: file.name,
      };
    }
    case 'FILE_PATCH': {
      const tab = getActiveTab(s);
      if (!tab?.file) return s;
      const file = { ...tab.file, ...a.patch };
      const renamed = a.patch.name && s.selectedPath === tab.file.name;
      return {
        ...patchActiveTab(s, {
          file,
          ...(a.invalidateEditorSession
            ? { editorSessionVersion: tab.editorSessionVersion + 1 }
            : {}),
        }),
        selectedPath: renamed ? a.patch.name! : s.selectedPath,
      };
    }
    case 'DOCUMENT_DIRTY':
      return patchActiveTab(s, { dirty: a.dirty });
    case 'PRUNE_MISSING_FILE_TABS': {
      const names = new Set(a.names);
      const stale = new Set(
        s.tabs
          .filter((t) => t.file && !t.dirty && !names.has(t.file.name))
          .map((t) => t.id),
      );
      if (stale.size === 0) return s;

      const nextTabs = s.tabs.filter((t) => !stale.has(t.id));
      let activeId = s.activeTabId;
      const activeWasStale = !!activeId && stale.has(activeId);
      if (activeWasStale) {
        const oldIdx = s.tabs.findIndex((t) => t.id === activeId);
        activeId = nextTabs[oldIdx]?.id ?? nextTabs[oldIdx - 1]?.id ?? null;
      }
      const active = activeId ? nextTabs.find((t) => t.id === activeId) : null;
      return {
        ...s,
        tabs: nextTabs,
        activeTabId: activeId,
        selectedPath: activeWasStale ? active?.file?.name ?? '' : s.selectedPath,
      };
    }
    case 'REMAP_PATHS': {
      const files = s.files.map((f) => {
        const name = remapOnePath(f.name, a.from, a.to, a.kind);
        return name === f.name ? f : { ...f, name };
      });
      const folders = s.folders.map((f) => {
        const path = remapOnePath(f.path, a.from, a.to, a.kind);
        return path === f.path ? f : { ...f, path };
      });
      const tabs = s.tabs.map((t) => {
        if (!t.file) return t;
        const nextName = remapOnePath(t.file.name, a.from, a.to, a.kind);
        return nextName === t.file.name ? t : { ...t, file: { ...t.file, name: nextName } };
      });
      const expanded = new Set<string>();
      for (const p of s.expanded) expanded.add(remapOnePath(p, a.from, a.to, a.kind));
      return {
        ...s,
        files,
        folders,
        tabs,
        expanded,
        fileOrder: remapFileOrder(s.fileOrder, a.from, a.to, a.kind),
        activeFolder: remapOnePath(s.activeFolder, a.from, a.to, a.kind),
        selectedPath: remapOnePath(s.selectedPath, a.from, a.to, a.kind),
      };
    }
    case 'NEW_TAB': {
      const tab = makeTab();
      return {
        ...s,
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        selectedPath: '',
      };
    }
    case 'CLOSE_TAB': {
      const idx = s.tabs.findIndex((t) => t.id === a.id);
      if (idx < 0) return s;
      const next = s.tabs.slice(0, idx).concat(s.tabs.slice(idx + 1));
      let activeId = s.activeTabId;
      if (s.activeTabId === a.id) {
        activeId = next.length === 0
          ? null
          : (next[idx] ?? next[idx - 1]).id;
      }
      const active = activeId ? next.find((t) => t.id === activeId) : null;
      return {
        ...s,
        tabs: next,
        activeTabId: activeId,
        selectedPath: active?.file?.name ?? '',
      };
    }
    case 'ACTIVATE_TAB': {
      if (s.activeTabId === a.id) return s;
      const target = s.tabs.find((t) => t.id === a.id);
      if (!target) return s;
      return { ...s, activeTabId: a.id, selectedPath: target.file?.name ?? '' };
    }
    case 'TABS_RESET':
      return { ...s, tabs: [], activeTabId: null, selectedPath: '' };
    case 'EDIT_MODE': {
      const tab = getActiveTab(s);
      if (!tab) return s;
      return patchActiveTab(s, {
        editMode: a.on,
        saveStatus: a.on ? tab.saveStatus : { text: '', cls: '' },
        // Entering edit mode promotes a preview tab — the user is
        // committing to this file; the next sidebar single-click
        // shouldn't kick their in-progress changes out of the tab.
        ...(a.on && tab.preview ? { preview: false } : {}),
      });
    }
    case 'TOGGLE_FOLDER': {
      const next = new Set(s.expanded);
      if (next.has(a.path)) next.delete(a.path); else next.add(a.path);
      // Click on a folder row → it becomes the focused row + the
      // creation anchor.
      return { ...s, expanded: next, activeFolder: a.path, selectedPath: a.path };
    }
    case 'EXPAND_FOLDER': {
      if (s.expanded.has(a.path)) return s;
      const next = new Set(s.expanded);
      next.add(a.path);
      return { ...s, expanded: next };
    }
    case 'COLLAPSE_ALL_FOLDERS':
      return { ...s, expanded: new Set(), activeFolder: '' };
    case 'EXPAND_ALL_FOLDERS':
      return { ...s, expanded: new Set(a.paths) };
    case 'FOLDER_FOLD_TOGGLE':
      return { ...s, folderCollapsed: !s.folderCollapsed };
    case 'SIDEBAR_SET_COLLAPSED':
      return { ...s, sidebarCollapsed: a.collapsed };
    case 'SIDEBAR_WIDTH':
      // Snap into [MIN, MAX]. Dragging below MIN is what triggers a
      // collapse, but that decision lives in the drag handler (it has
      // the raw cursor delta); here we just keep the stored width sane.
      return { ...s, sidebarWidth: Math.max(SIDEBAR_MIN_WIDTH, Math.min(a.width, SIDEBAR_MAX_WIDTH)) };
    case 'CHAT_TOGGLE':
      return { ...s, chatOpen: !s.chatOpen };
    case 'CHAT_WIDTH':
      // Clamp to sensible bounds. Below ~280 the prompt wraps every
      // word; above ~70% of viewport leaves no room for content.
      return { ...s, chatWidth: clampChatWidth(a.width) };
    case 'AGENTS_LOADED':
      return { ...s, agents: a.agents };
    case 'CHAT_AGENT_TOGGLE': {
      const activeTab = s.chatTabs.find((tab) => tab.id === s.activeChatTabId);
      if (s.chatOpen && activeTab?.agent === a.agent) {
        return { ...s, chatOpen: false };
      }
      const existingTab = mostRecentChatTab(s, a.agent);
      if (existingTab) {
        return {
          ...s,
          chatOpen: true,
          activeChatTabId: existingTab.id,
          chatTabRecencyByAgent: rememberChatTab(s.chatTabRecencyByAgent, existingTab),
        };
      }
      if (!a.tab) return s;
      return {
        ...s,
        chatOpen: true,
        chatTabs: [...s.chatTabs, a.tab],
        activeChatTabId: a.tab.id,
        chatTabRecencyByAgent: rememberChatTab(s.chatTabRecencyByAgent, a.tab),
      };
    }
    case 'CHAT_TAB_NEW':
      return {
        ...s,
        chatTabs: [...s.chatTabs, a.tab],
        activeChatTabId: a.tab.id,
        chatTabRecencyByAgent: rememberChatTab(s.chatTabRecencyByAgent, a.tab),
      };
    case 'CHAT_TAB_CLOSE': {
      const idx = s.chatTabs.findIndex((t) => t.id === a.id);
      if (idx < 0) return s;
      const closedTab = s.chatTabs[idx];
      const nextTabs = s.chatTabs.filter((t) => t.id !== a.id);
      // If we just closed the active tab, jump to a neighbor (prefer
      // the one immediately to the right, fall back to the left).
      let nextActive = s.activeChatTabId;
      if (s.activeChatTabId === a.id) {
        nextActive = nextTabs[idx]?.id ?? nextTabs[idx - 1]?.id ?? null;
      }
      const nextActiveTab = nextTabs.find((tab) => tab.id === nextActive);
      return {
        ...s,
        chatTabs: nextTabs,
        activeChatTabId: nextActive,
        chatTabRecencyByAgent: nextActiveTab
          ? rememberChatTab(forgetChatTab(s.chatTabRecencyByAgent, closedTab), nextActiveTab)
          : forgetChatTab(s.chatTabRecencyByAgent, closedTab),
        // Closing the last chat window folds the panel — the launchers
        // are the only way back in, and an empty panel is just dead folder.
        chatOpen: nextTabs.length === 0 ? false : s.chatOpen,
      };
    }
    case 'CHAT_TAB_ACTIVATE':
      {
        const tab = s.chatTabs.find((candidate) => candidate.id === a.id);
        if (!tab) return s;
        return {
          ...s,
          activeChatTabId: a.id,
          chatTabRecencyByAgent: rememberChatTab(s.chatTabRecencyByAgent, tab),
        };
      }
    case 'CHAT_TAB_RENAME':
      return {
        ...s,
        chatTabs: s.chatTabs.map((t) => (t.id === a.id ? { ...t, title: a.title } : t)),
      };
    case 'CHAT_TABS_RESET':
      // Wipes ALL tabs — called on folder switch (the server kills every
      // agent session in that flow; the frontend drops its tab list too
      // or we'd render panels bound to the old folder). Fold the panel too,
      // mirroring CHAT_TAB_CLOSE: an empty panel is dead folder and the
      // launchers are the only way back in.
      return { ...s, chatTabs: [], activeChatTabId: null, chatTabRecencyByAgent: {}, chatOpen: false };
    case 'ACTIVE_FOLDER':
      // Semantically "make this folder the user's current target" —
      // also moves the visual focus there.
      return { ...s, activeFolder: a.path, selectedPath: a.path };
    case 'SELECT_PATH':
      return { ...s, selectedPath: a.path };
    case 'PENDING_SEMANTIC_NAMES':
      return { ...s, pendingSemanticNames: a.names };
    case 'PENDING_CONVERSIONS':
      return { ...s, pendingConversions: a.paths };
    case 'BLOCKED_CONVERSIONS':
      return { ...s, blockedConversions: a.paths };
    case 'CONVERSION_PROGRESS':
      return { ...s, conversionProgress: a.progress };
    case 'CONVERSION_SCHEDULER_STATE':
      return { ...s, conversionRevision: a.revision, conversionVersions: a.versions };
    case 'SAVE_STATUS':
      return patchActiveTab(s, { saveStatus: a.status });
    case 'SYNC_RUNNING':
      return { ...s, syncRunning: a.running };
    case 'FILTER':
      return { ...s, filterQuery: a.q };
    case 'SEARCH_START':
      return { ...s, searching: true, searchHits: null, keywordResult: null, searchError: null };
    case 'SEARCH_HITS':
      return { ...s, searching: false, searchHits: a.hits, keywordResult: null, searchError: null };
    case 'SEARCH_KEYWORD':
      return { ...s, searching: false, keywordResult: a.result, searchHits: null, searchError: null };
    case 'SEARCH_ERROR':
      return { ...s, searching: false, searchError: a.error, searchHits: null, keywordResult: null };
    case 'SEARCH_CLEAR':
      return { ...s, searching: false, searchHits: null, keywordResult: null, searchError: null };
    case 'SEARCH_MODE':
      // Clear prior results so the renderer shows the new mode's empty
      // state immediately; runSearch will repopulate if a query is live.
      return { ...s, searchMode: a.mode, searchHits: null, keywordResult: null, searchError: null };
    case 'EMBEDDER_KEY_STATE':
      return {
        ...s,
        embedderHasKey: a.hasKey,
        ...(a.hasKey ? {} : { searchHits: null }),
      };
    case 'SIDEBAR_VIEW':
      return { ...s, activeSidebarView: a.view };
    case 'SEARCH_CASE_STRICT':
      // Result set semantics change → clear and let runSearch refill.
      return { ...s, caseStrict: a.strict, keywordResult: null };
    case 'SEARCH_WHOLE_WORD':
      return { ...s, wholeWord: a.on, keywordResult: null };
    case 'SEARCH_SCOPE':
      // Scope and type filters change both modes' result sets.
      return { ...s, searchScope: a.scope, searchHits: null, keywordResult: null };
    case 'SEARCH_TYPES':
      return { ...s, searchTypes: a.types, searchHits: null, keywordResult: null };
    case 'INDEX_WARNING':
      return { ...s, indexWarning: a.warning };
    case 'PREPARATION_FAILURES':
      return { ...s, preparationFailures: a.failures };
    case 'CTX_MENU':
      return { ...s, ctxMenu: a.menu };
    case 'RENAMING':
      return { ...s, renaming: a.renaming };
    case 'MODAL_OPEN':
      return { ...s, modal: a.request };
    case 'MODAL_CLOSE':
      return { ...s, modal: null };
    case 'TOAST_ADD': {
      // Collapse rapid-fire duplicates: if an identical toast (same
      // level + message) is already on the stack, bump its count in
      // place instead of pushing a new one. Keeps its original id (so
      // React doesn't remount) and position; ToastItem re-arms its
      // auto-dismiss off the count change.
      const dup = s.toasts.findIndex(
        (t) => t.level === a.toast.level && t.message === a.toast.message,
      );
      if (dup !== -1) {
        const next = s.toasts.slice();
        next[dup] = { ...next[dup], count: (next[dup].count ?? 1) + 1 };
        return { ...s, toasts: next };
      }
      return { ...s, toasts: [...s.toasts, a.toast] };
    }
    case 'TOAST_DISMISS':
      return { ...s, toasts: s.toasts.filter((t) => t.id !== a.id) };
    case 'TOAST_CLEAR':
      return s.toasts.length === 0 ? s : { ...s, toasts: [] };
    case 'PROMOTE_TAB':
      return {
        ...s,
        tabs: s.tabs.map((t) => (t.id === a.id ? { ...t, preview: false } : t)),
      };
    case 'TABS_REORDER': {
      const fromIdx = s.tabs.findIndex((t) => t.id === a.id);
      if (fromIdx < 0) return s;
      const without = s.tabs.filter((t) => t.id !== a.id);
      let insertAt: number;
      if (a.beforeId == null) {
        insertAt = without.length;
      } else {
        insertAt = without.findIndex((t) => t.id === a.beforeId);
        if (insertAt < 0) insertAt = without.length;
      }
      // No-op when the resulting order matches what we have already.
      if (insertAt === fromIdx) return s;
      const next = [...without.slice(0, insertAt), s.tabs[fromIdx], ...without.slice(insertAt)];
      return { ...s, tabs: next };
    }
    case 'PENDING_SCROLL':
      return patchActiveTab(s, { pendingAnchor: a.anchor });
    case 'PENDING_HIGHLIGHT':
      return patchActiveTab(s, { pendingHighlight: a.highlight });
    case 'CASCADE_PROMPT':
      return { ...s, cascadePrompt: a.prompt };
    case 'NEW_FOLDER_INPUT':
      return { ...s, newFolderInputOpen: a.open };
    case 'FIND_OPEN':
      // Re-opening is a no-op on state but lets the bar's effect re-run
      // (e.g. user pressed Cmd+F again to refocus the input).
      return s.find.open ? s : { ...s, find: { ...s.find, open: true } };
    case 'FIND_CLOSE':
      // Keep `query` / `wholeWord` so reopening pre-fills the last term
      // (Chrome behavior). `current`/`total` zero out — they're stale
      // the moment the active controller drops its decorations.
      return { ...s, find: { ...s.find, open: false, current: 0, total: 0 } };
    case 'FIND_SET':
      return { ...s, find: { ...s.find, ...a.patch } };
  }
}
