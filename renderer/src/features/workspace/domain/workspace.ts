import type { ActiveProjectFolder } from './project';
import type { FolderSessionState } from './session';
import { parentTreePath, renamedTreePath, treePathWithin, type ExpandedFolders } from './tree';

export interface WorkspaceScope {
  readonly folder: ActiveProjectFolder;
  readonly generation: number;
}

/** A create the window asked the tree to make beside the selection: a
 *  draft, an `Untitled.md` opened at once and renamed in place, or a folder,
 *  which starts the tree's own name-first create where the selection sits.
 *  The tree's menu keeps both as explicit rows; the request is how the
 *  folder header and the titlebar reach the same flows. */
export interface TreeCreateRequest {
  kind: 'draft' | 'folder' | 'interactive-note';
  /** Distinguishes one request from the next of the same kind, so asking
   *  twice starts the naming twice. */
  revision: number;
}

/** A row the window asked the tree to bring into view: the document in front
 *  of the reader, already selected, with the folders above it opened. */
export interface TreeRevealRequest {
  /** The folders this reveal opened. They appear at once rather than easing
   *  open, so the row already stands where the scroll lands. */
  opened: readonly string[];
  path: string;
}

export interface WorkspaceState {
  expanded: ExpandedFolders;
  lifecycle: 'active' | 'disposed';
  /** The create the tree has been asked to start and has not yet taken up. */
  pendingCreate: TreeCreateRequest | null;
  /** The row the tree has been asked to bring into view and has not yet shown. */
  pendingReveal: TreeRevealRequest | null;
  selectedPath: string | null;
  scope: WorkspaceScope;
}

export function createWorkspaceState(
  scope: WorkspaceScope,
  restored: FolderSessionState | null = null,
): WorkspaceState {
  return {
    expanded: Object.fromEntries(restored?.expandedPaths.map((path) => [path, true]) ?? []),
    lifecycle: 'active',
    pendingCreate: null,
    pendingReveal: null,
    scope,
    selectedPath: restored?.selectedPath ?? null,
  };
}

/** Asks the tree to create a new entry of `kind`. */
export function requestTreeCreate(
  state: WorkspaceState,
  kind: TreeCreateRequest['kind'],
): WorkspaceState {
  const revision = (state.pendingCreate?.revision ?? 0) + 1;
  return { ...state, pendingCreate: { kind, revision } };
}

/** The tree took the request up, or the reader cancelled it. */
export function clearTreeCreate(state: WorkspaceState): WorkspaceState {
  return state.pendingCreate === null ? state : { ...state, pendingCreate: null };
}

export function disposeWorkspaceState(state: WorkspaceState): WorkspaceState {
  return state.lifecycle === 'disposed' ? state : { ...state, lifecycle: 'disposed' };
}

/** Points the tree at `selectedPath`, or at no row at all with `null`. */
export function selectTreePath(state: WorkspaceState, selectedPath: string | null): WorkspaceState {
  return state.selectedPath === selectedPath ? state : { ...state, selectedPath };
}

/** Selects `path`, opens every folder above it, and asks the tree to bring
 *  its row into view. */
export function revealTreePath(state: WorkspaceState, path: string): WorkspaceState {
  const opened: string[] = [];
  for (let folder = parentTreePath(path); folder !== ''; folder = parentTreePath(folder)) {
    if (!state.expanded[folder]) opened.push(folder);
  }
  const expanded = { ...state.expanded };
  for (const folder of opened) expanded[folder] = true;
  return { ...state, expanded, pendingReveal: { opened, path }, selectedPath: path };
}

/** The tree brought the revealed row into view. */
export function clearTreeReveal(state: WorkspaceState): WorkspaceState {
  return state.pendingReveal === null ? state : { ...state, pendingReveal: null };
}

export function toggleTreeFolder(state: WorkspaceState, folderPath: string): WorkspaceState {
  const expanded = { ...state.expanded };
  if (expanded[folderPath]) delete expanded[folderPath];
  else expanded[folderPath] = true;
  return { ...state, expanded };
}

/** Folds every expanded folder, so the tree shows the root's own entries
 *  and nothing beneath them. */
export function collapseAllTreeFolders(state: WorkspaceState): WorkspaceState {
  return Object.keys(state.expanded).length === 0 ? state : { ...state, expanded: {} };
}

export function expandTreeFolder(state: WorkspaceState, folderPath: string): WorkspaceState {
  return state.expanded[folderPath]
    ? state
    : { ...state, expanded: { ...state.expanded, [folderPath]: true } };
}

/** Moves expansion and selection with an entry that took a new leaf name,
 *  so a renamed folder stays open and its selected descendant stays selected. */
export function renameTreePath(
  state: WorkspaceState,
  entryPath: string,
  name: string,
): WorkspaceState {
  return moveTreePath(state, entryPath, renamedTreePath(entryPath, name));
}

/** Moves expansion and selection with an entry that settled at `nextPath`,
 *  under a new name or a new parent. */
export function moveTreePath(
  state: WorkspaceState,
  entryPath: string,
  nextPath: string,
): WorkspaceState {
  if (nextPath === entryPath) return state;
  const move = (path: string) =>
    treePathWithin(path, entryPath) ? `${nextPath}${path.slice(entryPath.length)}` : path;
  const expanded: ExpandedFolders = {};
  for (const path of Object.keys(state.expanded)) expanded[move(path)] = true;
  return {
    ...state,
    expanded,
    selectedPath: state.selectedPath === null ? null : move(state.selectedPath),
  };
}

/** Drops expansion and selection under an entry that left the tree. */
export function forgetTreePath(state: WorkspaceState, entryPath: string): WorkspaceState {
  const expanded: ExpandedFolders = {};
  for (const path of Object.keys(state.expanded)) {
    if (!treePathWithin(path, entryPath)) expanded[path] = true;
  }
  const selectedPath =
    state.selectedPath !== null && treePathWithin(state.selectedPath, entryPath)
      ? null
      : state.selectedPath;
  return { ...state, expanded, selectedPath };
}
