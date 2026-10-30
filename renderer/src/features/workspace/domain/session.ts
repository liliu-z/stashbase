/**
 * The durable shape of a workspace session: which folders were open, what each
 * one had expanded and selected, and the pane widths the window restores. Every
 * bound here is a restore-time guard — a snapshot read back from disk is
 * untrusted input, so it is clamped and truncated rather than believed.
 */
import { clamp } from '@/shared/utils/clamp';

import type { WorkspaceState } from './workspace';

const WORKSPACE_SESSION_VERSION = 1 as const;
const DEFAULT_SIDEBAR_WIDTH = 288;
/** Mirrors the rail's drag floor (components/ui/sidebar-rail.tsx): the
 *  narrowest width that still shows the titlebar band's whole row, the
 *  control trio and the mode switch at its far end. A restored snapshot
 *  below it would clip the band the rail refuses to. */
const MIN_SIDEBAR_WIDTH = 272;
const MAX_SIDEBAR_WIDTH = 360;
/** The Agent pane's remembered width and the bounds it is clamped to. One
 *  record, because a caller that reads one of these always reads the others. */
export const AGENT_PANE_WIDTH = {
  default: 576,
  max: 960,
  min: 320,
} as const;
const MAX_SESSION_FOLDERS = 32;
const MAX_SESSION_EXPANDED_PATHS = 2_048;
const MAX_SESSION_TABS = 50;

interface WorkspaceTabIdentity {
  id: string;
  path: string;
}

export interface WorkspaceDocumentSession {
  activeTabId: string | null;
  tabs: WorkspaceTabIdentity[];
}

export interface FolderSessionState {
  activeTabId: string | null;
  expandedPaths: string[];
  folderPath: string;
  mathMode: boolean;
  selectedPath: string | null;
  tabs: WorkspaceTabIdentity[];
}

interface WorkspaceShellSessionState {
  agentPaneWidth: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
}

export interface WorkspaceSessionSnapshot {
  activeFolderPath: string | null;
  folders: FolderSessionState[];
  shell: WorkspaceShellSessionState;
  version: typeof WORKSPACE_SESSION_VERSION;
}

export function createWorkspaceSessionSnapshot(): WorkspaceSessionSnapshot {
  return {
    activeFolderPath: null,
    folders: [],
    shell: {
      agentPaneWidth: AGENT_PANE_WIDTH.default,
      // A fresh window lands on the welcome screen with the bare sidebar
      // away, the same way every other arrival there does (`arriveAtWelcome`).
      sidebarOpen: false,
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    },
    version: WORKSPACE_SESSION_VERSION,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * No folder is the welcome screen, and the welcome screen is arrived at with
 * the bare sidebar put away: its column holds nothing the screen does not
 * already offer, so a relaunch, a new window, and a folder leaving the project
 * mid-session all show the same collapsed rail. Every route there passes
 * through this one transition rather than each remembering the rule. Only
 * arriving collapses it — the corner toggle still brings the footer's rows
 * back while there — which is why the callers below apply it once, on the
 * change into "no folder", and treat a repeat of that state as nothing new.
 */
function arriveAtWelcome(snapshot: WorkspaceSessionSnapshot): WorkspaceSessionSnapshot {
  const shell = snapshot.shell.sidebarOpen
    ? { ...snapshot.shell, sidebarOpen: false }
    : snapshot.shell;
  if (snapshot.activeFolderPath === null && shell === snapshot.shell) return snapshot;
  return { ...snapshot, activeFolderPath: null, shell };
}

function normalizeFolder(folder: FolderSessionState): FolderSessionState {
  const seenTabs = new Set<string>();
  const tabs = folder.tabs.filter((tab) => {
    if (seenTabs.has(tab.id)) return false;
    seenTabs.add(tab.id);
    return true;
  });
  return {
    ...folder,
    activeTabId: tabs.some((tab) => tab.id === folder.activeTabId) ? folder.activeTabId : null,
    expandedPaths: unique(folder.expandedPaths),
    tabs,
  };
}

export function normalizeWorkspaceSession(
  snapshot: WorkspaceSessionSnapshot,
): WorkspaceSessionSnapshot {
  const seenFolders = new Set<string>();
  const folders = snapshot.folders.flatMap((folder) => {
    if (seenFolders.has(folder.folderPath)) return [];
    seenFolders.add(folder.folderPath);
    return [normalizeFolder(folder)];
  });
  const normalized: WorkspaceSessionSnapshot = {
    ...snapshot,
    activeFolderPath:
      snapshot.activeFolderPath && seenFolders.has(snapshot.activeFolderPath)
        ? snapshot.activeFolderPath
        : null,
    folders,
    shell: {
      agentPaneWidth: clampAgentPaneWidth(snapshot.shell.agentPaneWidth),
      sidebarOpen: snapshot.shell.sidebarOpen,
      sidebarWidth: Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(MAX_SIDEBAR_WIDTH, Math.round(snapshot.shell.sidebarWidth)),
      ),
    },
    version: WORKSPACE_SESSION_VERSION,
  };
  // A snapshot read back with no folder is restored into a window arriving at
  // the welcome screen, whatever its sidebar said when it was written. One
  // that still names its folder keeps the reader's answer for a reload, and
  // `setSessionActiveFolder(null)` collapses it if the landing turns out to be
  // the welcome screen after all.
  return normalized.activeFolderPath === null ? arriveAtWelcome(normalized) : normalized;
}

export function restoreFolderSession(
  snapshot: WorkspaceSessionSnapshot,
  folderPath: string,
): FolderSessionState | null {
  return snapshot.folders.find((folder) => folder.folderPath === folderPath) ?? null;
}

export function setSessionActiveFolder(
  snapshot: WorkspaceSessionSnapshot,
  folderPath: string | null,
): WorkspaceSessionSnapshot {
  if (snapshot.activeFolderPath === folderPath) return snapshot;
  if (folderPath === null) return arriveAtWelcome(snapshot);
  const folders = !snapshot.folders.some((folder) => folder.folderPath === folderPath)
    ? [
        ...snapshot.folders.slice(-(MAX_SESSION_FOLDERS - 1)),
        {
          activeTabId: null,
          expandedPaths: [],
          folderPath,
          mathMode: false,
          selectedPath: null,
          tabs: [],
        },
      ]
    : snapshot.folders;
  // A window's first folder brings the sidebar with it, the pair to
  // `arriveAtWelcome`: the collapsed rail belongs to the welcome screen, and
  // the folder's tree is the reason the rail exists. A switch between folders
  // keeps whatever the reader chose while working.
  const shell =
    snapshot.activeFolderPath === null && !snapshot.shell.sidebarOpen
      ? { ...snapshot.shell, sidebarOpen: true }
      : snapshot.shell;
  return { ...snapshot, activeFolderPath: folderPath, folders, shell };
}

export function reconcileSessionMembership(
  snapshot: WorkspaceSessionSnapshot,
  memberPaths: readonly string[],
): WorkspaceSessionSnapshot {
  const projects = new Set(memberPaths);
  const folders = snapshot.folders.filter((folder) => projects.has(folder.folderPath));
  const activeKept = snapshot.activeFolderPath === null || projects.has(snapshot.activeFolderPath);
  if (activeKept && folders.length === snapshot.folders.length) return snapshot;
  const pruned = { ...snapshot, folders };
  // The active folder leaving the project puts this window on the welcome
  // screen, so it arrives there the way every other route does.
  return activeKept ? pruned : arriveAtWelcome(pruned);
}

export function recordFolderSession(
  snapshot: WorkspaceSessionSnapshot,
  workspace: WorkspaceState,
  documents?: WorkspaceDocumentSession,
): WorkspaceSessionSnapshot {
  const folderPath = workspace.scope.folder.path;
  const previous = snapshot.folders.find((candidate) => candidate.folderPath === folderPath);
  const documentSession = documents ?? previous ?? { activeTabId: null, tabs: [] };
  const folder: FolderSessionState = {
    activeTabId: documentSession.activeTabId,
    expandedPaths: Object.keys(workspace.expanded)
      .filter((path) => workspace.expanded[path] === true)
      .slice(-MAX_SESSION_EXPANDED_PATHS),
    folderPath,
    mathMode: previous?.mathMode ?? false,
    selectedPath: workspace.selectedPath,
    tabs: documentSession.tabs
      .slice(-MAX_SESSION_TABS)
      .map((tab) => ({ id: tab.id, path: tab.path })),
  };
  folder.activeTabId = folder.tabs.some((tab) => tab.id === documentSession.activeTabId)
    ? documentSession.activeTabId
    : null;
  // Tree and tab stores change far more often than this projection; an equal
  // projection keeps the snapshot so the session neither re-renders nor saves.
  if (previous && sameFolderSession(previous, folder)) return snapshot;
  const index = snapshot.folders.findIndex((candidate) => candidate.folderPath === folderPath);
  const folders = [...snapshot.folders];
  if (index === -1) {
    if (folders.length >= MAX_SESSION_FOLDERS) folders.shift();
    folders.push(folder);
  } else folders[index] = folder;
  return { ...snapshot, folders };
}

function sameFolderSession(a: FolderSessionState, b: FolderSessionState): boolean {
  return (
    a.activeTabId === b.activeTabId &&
    a.mathMode === b.mathMode &&
    a.selectedPath === b.selectedPath &&
    a.expandedPaths.length === b.expandedPaths.length &&
    a.expandedPaths.every((path, index) => path === b.expandedPaths[index]) &&
    a.tabs.length === b.tabs.length &&
    a.tabs.every((tab, index) => tab.id === b.tabs[index]?.id && tab.path === b.tabs[index]?.path)
  );
}

export function setSessionMathMode(
  snapshot: WorkspaceSessionSnapshot,
  folderPath: string,
  mathMode: boolean,
): WorkspaceSessionSnapshot {
  const index = snapshot.folders.findIndex((folder) => folder.folderPath === folderPath);
  if (index === -1 || snapshot.folders[index]?.mathMode === mathMode) return snapshot;
  const folders = [...snapshot.folders];
  const folder = folders[index];
  if (!folder) return snapshot;
  folders[index] = { ...folder, mathMode };
  return { ...snapshot, folders };
}

export function setSessionSidebarOpen(
  snapshot: WorkspaceSessionSnapshot,
  sidebarOpen: boolean,
): WorkspaceSessionSnapshot {
  return snapshot.shell.sidebarOpen === sidebarOpen
    ? snapshot
    : { ...snapshot, shell: { ...snapshot.shell, sidebarOpen } };
}

function clampAgentPaneWidth(width: number): number {
  return clamp(Math.round(width), AGENT_PANE_WIDTH.min, AGENT_PANE_WIDTH.max);
}

export function setSessionAgentPaneWidth(
  snapshot: WorkspaceSessionSnapshot,
  agentPaneWidth: number,
): WorkspaceSessionSnapshot {
  const clamped = clampAgentPaneWidth(agentPaneWidth);
  return snapshot.shell.agentPaneWidth === clamped
    ? snapshot
    : { ...snapshot, shell: { ...snapshot.shell, agentPaneWidth: clamped } };
}

export function setSessionSidebarWidth(
  snapshot: WorkspaceSessionSnapshot,
  sidebarWidth: number,
): WorkspaceSessionSnapshot {
  const clamped = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, Math.round(sidebarWidth)),
  );
  return snapshot.shell.sidebarWidth === clamped
    ? snapshot
    : { ...snapshot, shell: { ...snapshot.shell, sidebarWidth: clamped } };
}
