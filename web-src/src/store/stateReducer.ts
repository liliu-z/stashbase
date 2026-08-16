/**
 * Pure renderer reducer. State and action definitions remain in the stable
 * state.ts facade; transition helpers live in stateHelpers.ts.
 */
import type { Action, OpenFile, State, Tab } from './state';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampChatWidth,
  forgetChatTab,
  forgetClosedTabs,
  getActiveTab,
  makeTab,
  mostRecentChatTab,
  patchActiveTab,
  rememberActivatedTab,
  rememberRecentFile,
  remapFileOrder,
  remapOnePath,
  rememberChatTab,
} from './stateHelpers';

/** The sidebar's focused row for a tab — '' for an out-of-folder tab, whose
 *  rel name would otherwise highlight an unrelated same-named row of the
 *  ACTIVE folder's tree. */
function selectablePath(tab: Tab | null | undefined): string {
  return tab?.file && !tab.file.folder ? tab.file.name : '';
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'BOOTED':
      return s.booted ? s : { ...s, booted: true };
    case 'RECENT_LOADED':
      return {
        ...s,
        recent: a.recent,
        homeDir: a.homeDir ?? s.homeDir,
      };
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
        unsupportedFiles: a.unsupportedFiles,
        ...(folderChanged
          ? {
              recentFilePaths: [],
              editorHistory: [],
              unsupportedModalOpen: false,
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
        ...(a.libraryFolder ? { folder: a.libraryFolder } : {}),
      };
      // Out-of-folder tabs are strictly read-only viewers: never Live
      // Editing, never the tree's focused row, never in the folder-local
      // recents (Quick Open would resolve the rel name in the wrong folder).
      const outOfFolder = Boolean(a.libraryFolder);
      const liveEditing = file.format === 'md' && !outOfFolder;
      // New-tab mode (the normal sidebar open, or `+` then a click):
      // create a fresh tab and load into it. Without `newTab` the file
      // replaces the active tab's file (blank-tab reuse, back/forward,
      // anchor nav). If there's no active tab at all, an open click
      // implicitly creates one.
      if (a.newTab || s.activeTabId == null || !getActiveTab(s)) {
        const tab = makeTab();
        tab.file = file;
        tab.editMode = liveEditing;
        tab.dirty = false;
        return {
          ...s,
          tabs: [...s.tabs, tab],
          recentFilePaths: outOfFolder ? s.recentFilePaths : rememberRecentFile(s.recentFilePaths, file.name),
          editorHistory: rememberActivatedTab(s.editorHistory, tab.id),
          activeTabId: tab.id,
          selectedPath: outOfFolder ? '' : file.name,
        };
      }
      return {
        ...patchActiveTab(s, {
          file,
          editMode: liveEditing,
          dirty: false,
          saveStatus: { text: '', cls: '' },
          pendingAnchor: null,
          pendingHighlight: null,
          pdfPage: undefined,
        }),
        recentFilePaths: outOfFolder ? s.recentFilePaths : rememberRecentFile(s.recentFilePaths, file.name),
        // The branch above already returned unless `s.activeTabId` is set.
        editorHistory: rememberActivatedTab(s.editorHistory, s.activeTabId!),
        selectedPath: outOfFolder ? '' : file.name,
      };
    }
    case 'FILE_PATCH': {
      const tab = getActiveTab(s);
      if (!tab?.file) return s;
      const file = { ...tab.file, ...a.patch };
      const pdfSourceChanged = tab.file.format === 'pdf'
        && a.patch.version !== undefined
        && a.patch.version !== tab.file.version;
      const renamed = a.patch.name && s.selectedPath === tab.file.name;
      return {
        ...patchActiveTab(s, {
          file,
          ...(pdfSourceChanged ? { pdfPage: undefined } : {}),
        }),
        selectedPath: renamed ? a.patch.name! : s.selectedPath,
      };
    }
    case 'DOCUMENT_DIRTY':
      return patchActiveTab(s, { dirty: a.dirty });
    case 'PRUNE_MISSING_FILE_TABS': {
      const names = new Set(a.names);
      // `names` is the ACTIVE folder's listing; out-of-folder tabs are
      // legitimately absent from it and must never be pruned by it.
      const stale = new Set(
        s.tabs
          .filter((t) => t.file && !t.file.folder && !t.dirty && !names.has(t.file.name))
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
        editorHistory: forgetClosedTabs(s.editorHistory, new Set(nextTabs.map((t) => t.id))),
        activeTabId: activeId,
        selectedPath: activeWasStale ? selectablePath(active) : s.selectedPath,
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
        // Renames happen in the active folder; an out-of-folder tab's disk
        // file did not move even when its rel name collides.
        if (!t.file || t.file.folder) return t;
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
        recentFilePaths: s.recentFilePaths.map((path) => remapOnePath(path, a.from, a.to, a.kind)),
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
        editorHistory: rememberActivatedTab(s.editorHistory, tab.id),
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
        editorHistory: forgetClosedTabs(s.editorHistory, new Set(next.map((t) => t.id))),
        activeTabId: activeId,
        selectedPath: selectablePath(active),
      };
    }
    case 'ACTIVATE_TAB': {
      if (s.activeTabId === a.id) return s;
      const target = s.tabs.find((t) => t.id === a.id);
      if (!target) return s;
      return {
        ...s,
        activeTabId: a.id,
        recentFilePaths: target.file && !target.file.folder
          ? rememberRecentFile(s.recentFilePaths, target.file.name)
          : s.recentFilePaths,
        editorHistory: rememberActivatedTab(s.editorHistory, a.id),
        selectedPath: selectablePath(target),
      };
    }
    case 'TABS_RESET':
      return { ...s, tabs: [], recentFilePaths: [], editorHistory: [], activeTabId: null, selectedPath: '' };
    case 'EDIT_MODE': {
      const tab = getActiveTab(s);
      if (!tab) return s;
      // Out-of-folder tabs are read-only: their save path would write a
      // same-named file into the ACTIVE folder.
      if (a.on && tab.file?.folder) return s;
      return patchActiveTab(s, {
        editMode: a.on,
        saveStatus: a.on ? tab.saveStatus : { text: '', cls: '' },
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
    case 'CHAT_AGENT_OPEN': {
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
        // Closing the last chat window folds the panel — the sidebar's
        // New Chat button is the way back in, and an empty panel is just
        // dead folder.
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
    case 'CHAT_TAB_SET_BLANK':
      return {
        ...s,
        chatTabs: s.chatTabs.map((t) => (t.id === a.id ? { ...t, blank: a.blank } : t)),
      };
    case 'CHAT_TAB_SET_AGENT': {
      const tab = s.chatTabs.find((t) => t.id === a.id);
      // Blank tabs only: a tab with content, a draft, attachments, or a
      // resumed session is user work and must never switch agent in place.
      // (`undefined` blank means the tab's AgentView hasn't reported yet —
      // fresh tabs start blank, so treat it as blank.)
      if (!tab || tab.blank === false || tab.agent === a.agent) return s;
      // Re-number the placeholder title for the new agent so "New Chat N"
      // stays consistent with makeChatTab's per-agent numbering. A
      // non-placeholder title is preserved (should not occur on a blank tab).
      const sameAgentOthers = s.chatTabs.filter((t) => t.id !== a.id && t.agent === a.agent);
      const title = /^New Chat( \d+)?$/.test(tab.title.trim())
        ? (sameAgentOthers.length === 0 ? 'New Chat' : `New Chat ${sameAgentOthers.length + 1}`)
        : tab.title;
      const next = { ...tab, agent: a.agent, title };
      return {
        ...s,
        chatTabs: s.chatTabs.map((t) => (t.id === a.id ? next : t)),
        // Move the tab's recency entry from the old agent's list to the
        // new agent's, so per-agent most-recent lookups stay coherent.
        chatTabRecencyByAgent: rememberChatTab(forgetChatTab(s.chatTabRecencyByAgent, tab), next),
      };
    }
    case 'CHAT_TAB_SET_SCOPE':
      return {
        ...s,
        chatTabs: s.chatTabs.map((t) => (t.id === a.id ? { ...t, boundFolder: a.folder } : t)),
      };
    case 'CHAT_RESUME_REQUEST':
      // A fresh request replaces an unconsumed one — the sidebar ensures a
      // suitable tab in the same interaction, so at most one is in flight.
      return { ...s, pendingResume: a.resume };
    case 'CHAT_RESUME_CONSUMED':
      return s.pendingResume ? { ...s, pendingResume: null } : s;
    case 'CHAT_TABS_RESET':
      // Wipes ALL tabs — called when the window LOSES its folder context
      // (library removal / another window closing the folder; the server
      // ends this window's agent sessions in those flows). A plain folder
      // switch never dispatches this: sessions are folder-bound and tabs
      // survive the switch. Fold the panel too, mirroring CHAT_TAB_CLOSE:
      // an empty panel is dead folder and the sidebar's New Chat button
      // is the way back in.
      return { ...s, chatTabs: [], activeChatTabId: null, chatTabRecencyByAgent: {}, pendingResume: null, chatOpen: false };
    case 'ACTIVE_FOLDER':
      // Semantically "make this folder the user's current target" —
      // also moves the visual focus there.
      return { ...s, activeFolder: a.path, selectedPath: a.path };
    case 'SELECT_PATH':
      return { ...s, selectedPath: a.path };
    case 'PENDING_SEMANTIC_NAMES':
      return { ...s, pendingSemanticNames: a.names };
    case 'SEMANTIC_INDEXING_STATE':
      return { ...s, semanticIndexing: a.state };
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
    case 'EMBEDDER_KEY_STATE':
      return { ...s, embedderHasKey: a.hasKey };
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
    case 'TAB_PDF_PAGE':
      return {
        ...s,
        tabs: s.tabs.map((t) => (t.id === a.id ? { ...t, pdfPage: a.page } : t)),
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
    case 'UNSUPPORTED_MODAL':
      return { ...s, unsupportedModalOpen: a.open };
  }
}
