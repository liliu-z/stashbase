/**
 * Workspace sub-reducer: folder identity, the file tree, document tabs, the
 * sidebar, and folder-level indexing/preparation state. Composed with the
 * chat and ui-shell sub-reducers by `stateReducer.ts`; every case rebuilds
 * only `WorkspaceSlice`, and an action this slice does not own answers
 * `undefined` so the other contexts keep their value identity.
 *
 * Multi-step transitions live in the named helpers above the switch rather
 * than inline, so a case reads as its intent and the branching is testable
 * on its own terms.
 */
import type { Action, NameSet, OpenFile, Tab, WorkspaceSlice } from './state';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  forgetClosedTabs,
  getActiveTab,
  hasName,
  makeTab,
  patchActiveTab,
  rememberActivatedTab,
  rememberRecentFile,
  remapFileOrder,
  remapOnePath,
  toNameSet,
} from './stateHelpers';
import { folderRefsEqual } from '../lib/folderPath';

/** The sidebar's focused row for a tab — '' for an out-of-folder tab, whose
 *  rel name would otherwise highlight an unrelated same-named row of the
 *  ACTIVE folder's tree. */
function selectablePath(tab: Tab | null | undefined): string {
  return tab?.file && !tab.file.folder ? tab.file.name : '';
}

function activateTab(w: WorkspaceSlice, tab: Tab): WorkspaceSlice {
  if (w.activeTabId === tab.id) return w;
  return {
    ...w,
    activeTabId: tab.id,
    recentFilePaths: tab.file && !tab.file.folder
      ? rememberRecentFile(w.recentFilePaths, tab.file.name)
      : w.recentFilePaths,
    editorHistory: rememberActivatedTab(w.editorHistory, tab.id),
    selectedPath: selectablePath(tab),
  };
}

/**
 * Load a file body into the workspace's tabs.
 *
 * Out-of-folder tabs (`libraryFolder` set — a library-wide search hit in
 * another member folder) are strictly read-only viewers: never Live Editing,
 * never the tree's focused row, never in the folder-local recents, where
 * Quick Open would resolve the rel name against the wrong folder.
 *
 * New-tab mode (the normal sidebar open, or `+` then a click) activates the
 * source's existing tab or creates a fresh one. Without `newTab` the file
 * replaces the active tab's file (blank-tab reuse, back/forward, anchor nav);
 * an open click with no active tab at all implicitly creates one.
 */
function openFile(w: WorkspaceSlice, a: Extract<Action, { type: 'FILE_OPEN' }>): WorkspaceSlice {
  const file: OpenFile = {
    name: a.body.name,
    format: a.body.format,
    content: a.body.content,
    version: a.body.version,
    ...(a.body.genericPreview ? { genericPreview: a.body.genericPreview } : {}),
    error: a.body.error,
    ...(a.libraryFolder ? { folder: a.libraryFolder } : {}),
  };
  const outOfFolder = Boolean(a.libraryFolder);
  const liveEditing = file.format === 'md' && !outOfFolder && !file.error;
  const recentFilePaths = outOfFolder
    ? w.recentFilePaths
    : rememberRecentFile(w.recentFilePaths, file.name);
  const selectedPath = outOfFolder ? '' : file.name;

  // Async navigation preflights cannot own uniqueness: two quick opens can
  // both start before either file read commits. Resolve that race at the
  // reducer's atomic state boundary. A new-tab open is navigation, not a
  // reload, so preserve any live buffer already held by the source's tab.
  if (a.newTab) {
    const existing = w.tabs.find(({ file: open }) => open?.name === file.name
      && folderRefsEqual(open.folder ?? '', file.folder ?? ''));
    if (existing) return activateTab(w, existing);
  }

  // A kind tab (the Wiki Templates gallery) holds `file: null` like a blank
  // tab but is a PLACE, not an empty slot — filling it in place would leave
  // a stale `kind` under a document. Route those opens to a fresh tab.
  const activeIsKindTab = Boolean(getActiveTab(w)?.kind);
  if (a.newTab || w.activeTabId == null || !getActiveTab(w) || activeIsKindTab) {
    const tab = makeTab();
    tab.file = file;
    tab.editMode = liveEditing;
    tab.dirty = false;
    return {
      ...w,
      tabs: [...w.tabs, tab],
      recentFilePaths,
      editorHistory: rememberActivatedTab(w.editorHistory, tab.id),
      activeTabId: tab.id,
      selectedPath,
    };
  }
  return {
    ...patchActiveTab(w, {
      file,
      editMode: liveEditing,
      dirty: false,
      saveStatus: { text: '', cls: '' },
      pendingAnchor: null,
      pendingHighlight: null,
      pdfPage: undefined,
    }),
    recentFilePaths,
    // The branch above already returned unless `w.activeTabId` is set.
    editorHistory: rememberActivatedTab(w.editorHistory, w.activeTabId!),
    selectedPath,
  };
}

/**
 * Close the tabs whose files vanished from the ACTIVE folder's listing.
 *
 * `names` is that listing, so out-of-folder tabs are legitimately absent from
 * it and must never be pruned by it; a dirty tab holds unsaved work and stays
 * regardless. When the active tab is one of the casualties, focus falls to
 * whatever now occupies its strip position, else the tab to its left, else
 * nothing.
 */
function pruneMissingFileTabs(w: WorkspaceSlice, names: string[]): WorkspaceSlice {
  const present = new Set(names);
  const stale = new Set(
    w.tabs
      .filter((t) => t.file && !t.file.folder && !t.dirty && !present.has(t.file.name))
      .map((t) => t.id),
  );
  if (stale.size === 0) return w;

  const nextTabs = w.tabs.filter((t) => !stale.has(t.id));
  let activeId = w.activeTabId;
  const activeWasStale = !!activeId && stale.has(activeId);
  if (activeWasStale) {
    const oldIdx = w.tabs.findIndex((t) => t.id === activeId);
    activeId = nextTabs[oldIdx]?.id ?? nextTabs[oldIdx - 1]?.id ?? null;
  }
  const active = activeId ? nextTabs.find((t) => t.id === activeId) : null;
  return {
    ...w,
    tabs: nextTabs,
    editorHistory: forgetClosedTabs(w.editorHistory, new Set(nextTabs.map((t) => t.id))),
    activeTabId: activeId,
    selectedPath: activeWasStale ? selectablePath(active) : w.selectedPath,
  };
}

/**
 * Close one document tab. When it was the active one, focus hands over to its
 * strip neighbour — the tab that slid into its slot, else the one on its left,
 * else nothing — and the sidebar's focused row follows.
 */
function closeTab(w: WorkspaceSlice, id: string): WorkspaceSlice {
  const idx = w.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return w;
  const next = w.tabs.slice(0, idx).concat(w.tabs.slice(idx + 1));
  let activeId = w.activeTabId;
  if (w.activeTabId === id) {
    activeId = next.length === 0 ? null : (next[idx] ?? next[idx - 1]).id;
  }
  const active = activeId ? next.find((t) => t.id === activeId) : null;
  return {
    ...w,
    tabs: next,
    editorHistory: forgetClosedTabs(w.editorHistory, new Set(next.map((t) => t.id))),
    activeTabId: activeId,
    selectedPath: selectablePath(active),
  };
}

/** Apply a rename/move across every path-keyed workspace field at once. */
function remapPaths(w: WorkspaceSlice, a: Extract<Action, { type: 'REMAP_PATHS' }>): WorkspaceSlice {
  const remap = (path: string) => remapOnePath(path, a.from, a.to, a.kind);
  return {
    ...w,
    files: w.files.map((f) => {
      const name = remap(f.name);
      return name === f.name ? f : { ...f, name };
    }),
    folders: w.folders.map((f) => {
      const path = remap(f.path);
      return path === f.path ? f : { ...f, path };
    }),
    tabs: w.tabs.map((t) => {
      // Renames happen in the active folder; an out-of-folder tab's disk
      // file did not move even when its rel name collides.
      if (!t.file || t.file.folder) return t;
      const nextName = remap(t.file.name);
      return nextName === t.file.name ? t : { ...t, file: { ...t.file, name: nextName } };
    }),
    recentFilePaths: w.recentFilePaths.map(remap),
    expanded: toNameSet(Object.keys(w.expanded).map(remap)),
    fileOrder: remapFileOrder(w.fileOrder, a.from, a.to, a.kind),
    activeFolder: remap(w.activeFolder),
    selectedPath: remap(w.selectedPath),
  };
}

/** Move tab `id` to sit immediately before `beforeId` (`null` appends). */
function reorderTabs(w: WorkspaceSlice, id: string, beforeId: string | null): WorkspaceSlice {
  const fromIdx = w.tabs.findIndex((t) => t.id === id);
  if (fromIdx < 0) return w;
  const without = w.tabs.filter((t) => t.id !== id);
  let insertAt = beforeId == null ? without.length : without.findIndex((t) => t.id === beforeId);
  if (insertAt < 0) insertAt = without.length;
  // No-op when the resulting order matches what we have already — a
  // hover-and-snap-back drag must not churn the React keys.
  if (insertAt === fromIdx) return w;
  return { ...w, tabs: [...without.slice(0, insertAt), w.tabs[fromIdx], ...without.slice(insertAt)] };
}

export function workspaceReducer(w: WorkspaceSlice, a: Action): WorkspaceSlice | undefined {
  switch (a.type) {
    case 'BOOTED':
      return w.booted ? w : { ...w, booted: true };
    case 'RECENT_LOADED':
      return { ...w, membershipLoaded: true, recent: a.recent, homeDir: a.homeDir ?? w.homeDir };
    case 'LIBRARY_FOLDER_STATUS':
      return w.libraryFolderStatuses[a.path] === a.status
        ? w
        : { ...w, libraryFolderStatuses: { ...w.libraryFolderStatuses, [a.path]: a.status } };
    case 'LIBRARY_FOLDER_STATUS_REMOVE': {
      if (!(a.path in w.libraryFolderStatuses)) return w;
      const { [a.path]: _removed, ...rest } = w.libraryFolderStatuses;
      return { ...w, libraryFolderStatuses: rest };
    }
    case 'FOLDER_CONTEXT':
      return w.folder === a.folder && w.folderPath === a.folderPath
        ? w
        : { ...w, folder: a.folder, folderPath: a.folderPath };
    case 'FILES_LOADED': {
      const folderPath = a.folderPath ?? (a.folder ? w.folderPath : '');
      const folderChanged = folderPath !== w.folderPath;
      return {
        ...w,
        files: a.files,
        folders: a.folders,
        folder: a.folder,
        folderPath,
        // Only a listing that consulted the server carries the flag;
        // optimistic local FILES_LOADED patches keep the last known value.
        showHiddenFiles: a.showHiddenFiles ?? w.showHiddenFiles,
        ...(folderChanged
          ? { recentFilePaths: [], editorHistory: [] }
          : {}),
      };
    }
    case 'FILE_ORDER_LOADED':
      return { ...w, fileOrder: a.order };
    case 'FILE_ORDER_SET': {
      const next = { ...w.fileOrder };
      if (a.names.length === 0) delete next[a.parentPath];
      else next[a.parentPath] = a.names.slice();
      return { ...w, fileOrder: next };
    }
    case 'FILE_OPEN':
      return openFile(w, a);
    case 'FILE_PATCH': {
      const tab = getActiveTab(w);
      if (!tab?.file) return w;
      const pdfSourceChanged = tab.file.format === 'pdf'
        && a.patch.version !== undefined
        && a.patch.version !== tab.file.version;
      const renamed = a.patch.name && w.selectedPath === tab.file.name;
      return {
        ...patchActiveTab(w, {
          file: { ...tab.file, ...a.patch },
          ...(pdfSourceChanged ? { pdfPage: undefined } : {}),
        }),
        selectedPath: renamed ? a.patch.name! : w.selectedPath,
      };
    }
    case 'DOCUMENT_DIRTY':
      return patchActiveTab(w, { dirty: a.dirty });
    case 'PRUNE_MISSING_FILE_TABS':
      return pruneMissingFileTabs(w, a.names);
    case 'REMAP_PATHS':
      return remapPaths(w, a);
    case 'NEW_TAB': {
      const tab = makeTab();
      return {
        ...w,
        tabs: [...w.tabs, tab],
        editorHistory: rememberActivatedTab(w.editorHistory, tab.id),
        activeTabId: tab.id,
        selectedPath: '',
      };
    }
    case 'TEMPLATES_OPEN': {
      // Singleton: the gallery is a place you return to, not a document
      // you multiply — reopening focuses the existing tab.
      const existing = w.tabs.find((t) => t.kind === 'templates');
      if (existing) return activateTab(w, existing);
      const tab: Tab = { ...makeTab(), kind: 'templates' };
      return {
        ...w,
        tabs: [...w.tabs, tab],
        editorHistory: rememberActivatedTab(w.editorHistory, tab.id),
        activeTabId: tab.id,
        selectedPath: '',
      };
    }
    case 'CLOSE_TAB':
      return closeTab(w, a.id);
    case 'ACTIVATE_TAB': {
      const target = w.tabs.find((t) => t.id === a.id);
      return target ? activateTab(w, target) : w;
    }
    case 'TABS_RESET':
      return { ...w, tabs: [], recentFilePaths: [], editorHistory: [], activeTabId: null, selectedPath: '' };
    case 'EDIT_MODE': {
      const tab = getActiveTab(w);
      if (!tab) return w;
      // Out-of-folder tabs are read-only: their save path would write a
      // same-named file into the ACTIVE folder.
      if (a.on && (tab.file?.folder || tab.file?.error)) return w;
      return patchActiveTab(w, {
        editMode: a.on,
        saveStatus: a.on ? tab.saveStatus : { text: '', cls: '' },
      });
    }
    case 'TOGGLE_FOLDER': {
      // Computed-key spread and rest-destructuring both define/copy own
      // properties, so a folder literally named `__proto__` toggles like any
      // other row instead of reassigning the record's prototype.
      let next: NameSet;
      if (hasName(w.expanded, a.path)) {
        const { [a.path]: _collapsed, ...rest } = w.expanded;
        next = rest;
      } else {
        next = { ...w.expanded, [a.path]: true };
      }
      // Click on a folder row → it becomes the focused row + the
      // creation anchor.
      return { ...w, expanded: next, activeFolder: a.path, selectedPath: a.path };
    }
    case 'EXPAND_FOLDER':
      return hasName(w.expanded, a.path)
        ? w
        : { ...w, expanded: { ...w.expanded, [a.path]: true } };
    case 'COLLAPSE_ALL_FOLDERS':
      return { ...w, expanded: {}, activeFolder: '' };
    case 'EXPAND_ALL_FOLDERS':
      return { ...w, expanded: toNameSet(a.paths) };
    case 'FOLDER_FOLD_TOGGLE':
      return { ...w, folderCollapsed: !w.folderCollapsed };
    case 'SIDEBAR_SET_COLLAPSED':
      return { ...w, sidebarCollapsed: a.collapsed };
    case 'SIDEBAR_WIDTH':
      // Snap into [MIN, MAX]. Dragging below MIN is what triggers a
      // collapse, but that decision lives in the drag handler (it has
      // the raw cursor delta); here we just keep the stored width sane.
      return { ...w, sidebarWidth: Math.max(SIDEBAR_MIN_WIDTH, Math.min(a.width, SIDEBAR_MAX_WIDTH)) };
    case 'ACTIVE_FOLDER':
      // Semantically "make this folder the user's current target" —
      // also moves the visual focus there.
      return { ...w, activeFolder: a.path, selectedPath: a.path };
    case 'SELECT_PATH':
      return { ...w, selectedPath: a.path };
    case 'PENDING_SEMANTIC_NAMES':
      return { ...w, pendingSemanticNames: a.names };
    case 'SEMANTIC_INDEXING_STATE':
      return { ...w, semanticIndexing: a.state };
    case 'PENDING_CONVERSIONS':
      return { ...w, pendingConversions: a.paths };
    case 'BLOCKED_CONVERSIONS':
      return { ...w, blockedConversions: a.paths };
    case 'CONVERSION_PROGRESS':
      return { ...w, conversionProgress: a.progress };
    case 'CONVERSION_SCHEDULER_STATE':
      return { ...w, conversionRevision: a.revision, conversionVersions: a.versions };
    case 'SAVE_STATUS':
      return patchActiveTab(w, { saveStatus: a.status });
    case 'SET_CONFLICT':
      return {
        ...w,
        tabs: w.tabs.map((t) => (t.id === a.id ? { ...t, conflict: a.conflict } : t)),
      };
    case 'SET_CONFLICT_RESOLVING':
      return {
        ...w,
        tabs: w.tabs.map((t) => (
          t.id === a.id && t.conflict
            ? { ...t, conflict: { ...t.conflict, resolving: a.resolving } }
            : t
        )),
      };
    case 'RESOLVE_CONFLICT_DISCARD':
      return {
        ...w,
        tabs: w.tabs.map((t) => (t.id === a.id ? { ...t, conflict: null, dirty: false } : t)),
      };
    case 'SYNC_RUNNING':
      return { ...w, syncRunning: a.running };
    case 'EMBEDDER_KEY_STATE':
      return { ...w, embedderHasKey: a.hasKey };
    case 'INDEX_WARNING':
      return { ...w, indexWarning: a.warning };
    case 'PREPARATION_FAILURES':
      return { ...w, preparationFailures: a.failures };
    case 'PENDING_SCROLL':
      return patchActiveTab(w, { pendingAnchor: a.anchor });
    case 'PENDING_HIGHLIGHT':
      return patchActiveTab(w, { pendingHighlight: a.highlight });
    case 'TAB_PDF_PAGE':
      return { ...w, tabs: w.tabs.map((t) => (t.id === a.id ? { ...t, pdfPage: a.page } : t)) };
    case 'TABS_REORDER':
      return reorderTabs(w, a.id, a.beforeId);
    case 'NEW_FOLDER_INPUT':
      return { ...w, newFolderInputOpen: a.open };
    default:
      // Not this slice's action — see the composition note in `stateReducer.ts`.
      return undefined;
  }
}
