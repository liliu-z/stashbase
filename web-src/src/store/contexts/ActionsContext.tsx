/**
 * The renderer's single actions surface, plus raw `dispatch` for the many
 * call sites that fire a bare action directly (there is no per-action
 * wrapper for every branch of the reducer, e.g. `SIDEBAR_WIDTH`,
 * `TOGGLE_FOLDER`, `CTX_MENU`). Both are `useReducer`/`useMemo`-stable
 * across renders, so — unlike the three state-slice contexts — this one
 * needs no slice split: no field of it changes on a state change.
 *
 * The wrapper object still has to be memoized. `ActionsProvider` re-renders
 * on every dispatch (it sits under the reducer), and a fresh
 * `{ actions, dispatch }` literal is a new context value even when both
 * fields are identical — which re-renders all ~42 `useAppActions()`
 * consumers on every dispatch. Stable members do not make a stable value.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { AgentKind } from '@/common/lib/agentCatalog';
import type { Action, CascadeDecision, PendingHighlight, WorkspaceSlice } from '@/store/state/state';
import type { EditorHandle, FindController } from '@/store/state/editorTypes';

export interface AppActions {
  bootstrap: () => Promise<void>;
  openFolder: (path: string) => Promise<void>;
  /** Open/create a folder by name under the default folder home — a
   *  single path segment. `openFolder(path)` opens any folder in place. */
  openFolderByName: (
    name: string,
    opts?: { create?: boolean; exclusiveCreate?: boolean; optimisticPendingOnOpen?: boolean },
  ) => Promise<void>;

  loadFiles: (expectedFolderPath?: string) => Promise<WorkspaceSlice['files']>;
  /** Optimistically mark the current visible files as pending for search. Used
   *  after the first embedder key is added and immediately after a
   *  folder import opens the new folder, before daemon status can catch
   *  up. */
  markVisibleFilesPendingForSearch: (files?: WorkspaceSlice['files']) => Promise<void>;
  refreshIndexState: (folderPath?: string) => Promise<void>;
  runSync: () => Promise<void>;
  /** Clear the active folder's background-index warning. */
  dismissIndexWarning: () => Promise<void>;
  decideSemanticIndexing: (decision: 'start' | 'defer') => Promise<void>;
  /** Replace a folder's ordered child list (manual sidebar ordering).
   *  Optimistic — state updates immediately, then a PUT is fired.
   *  Failure of the PUT rolls the renderer back to whatever the server
   *  has next time we reload. */
  setFolderOrder: (parentPath: string, names: string[]) => Promise<void>;

  selectFile: (name: string) => Promise<void>;
  /** Same as `selectFile` but additionally arms the viewer to highlight
   *  a specific chunk on next render (typically from a search hit
   *  click). HTML / MD / Code viewers use `startLine` / `endLine` for
   *  line-range overlay; PdfPreview uses `chunkText` to find the
   *  passage via pdfjs's find controller. */
  selectFileWithHighlight: (name: string, hit: PendingHighlight) => Promise<void>;
  /** Open a search hit by (member folder, rel path). Same-folder targets go
   *  through normal selection; anything else opens a read-only
   *  out-of-folder tab WITHOUT switching the window's folder. */
  openLibraryFile: (folder: string, name: string, opts?: { hit?: PendingHighlight; anchor?: string }) => Promise<void>;
  /** Open a file in a new tab (double-click in sidebar / drag-out
   *  semantics). Always creates a new tab even if the file is already
   *  open in another tab — VS Code does the same with the explicit
   *  "Open in New Tab" command. */
  openInNewTab: (name: string) => Promise<void>;
  newTab: () => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  /** Close whichever tab is currently active. Convenience for keyboard
   *  shortcuts (`⌘W`) and UI buttons that don't have a tab id handy. */
  closeActiveTab: () => Promise<void>;
  activateTab: (id: string) => Promise<void>;
  /** Cross-file link nav: open `name` (with optional anchor) and push a
   *  new entry into the back/forward stack. Used by preview iframes
   *  forwarding `<a>` clicks. */
  navigateTo: (name: string, anchor?: string) => Promise<void>;
  /** Called by the preview iframe after it has consumed the pending
   *  anchor / scrollY so a follow-up keystroke / re-render won't
   *  re-scroll. */
  consumePendingScroll: () => void;
  /** Called by the viewer after it has applied a pending-highlight
   *  (rendered the chunk overlay / kicked off the PDF text search)
   *  so a re-render doesn't re-trigger the effect. */
  consumePendingHighlight: () => void;
  /** Update the last viewed PDF page for tabId to page. */
  updateTabPdfPage: (tabId: string, page: number) => void;
  /** Settle the pending cascade dialog with the user's choice. The
   *  rename action awaits this. */
  resolveCascadePrompt: (decision: CascadeDecision) => void;
  /** Show a modal alert and resolve once dismissed. Replaces
   *  `window.alert`. */
  alert: (message: string) => Promise<void>;
  /** Show a modal confirm and resolve to true (OK) / false (Cancel).
   *  Replaces `window.confirm`. Options title the dialog and restyle the
   *  action button; omitted, it renders the generic 'Confirm action'. */
  confirm: (
    message: string,
    opts?: { title?: string; confirmLabel?: string; destructive?: boolean },
  ) => Promise<boolean>;
  /** Settle the pending alert/confirm modal with the user's choice.
   *  Called by the rendered modal's buttons. */
  resolveModal: (value: boolean) => void;
  /** Push a toast — lightweight non-blocking feedback. Use this for
   *  "operation succeeded / failed" messages instead of `alert` when
   *  the user can just keep working. Returns the new toast's id so
   *  the caller can dismiss it programmatically (e.g. when a long-
   *  running operation finally settles).
   *
   *  Default ttl: info / success 3000ms, warning 5000ms, error null
   *  (persistent — error toasts only go away when the user dismisses them). */
  toast: (
    message: string,
    opts?: {
      level?: 'info' | 'success' | 'warning' | 'error';
      ttl?: number | null;
      action?: { label: string; onClick: () => void };
    },
  ) => string;
  toggleEditMode: () => Promise<void>;
  /** Reveal an existing Agent Panel session or create its first tab. This only
   * changes renderer layout; permissions and Agent context remain unchanged. */
  openAgent: (agent: AgentKind) => void;
  /** Open or reuse a chat tab without starting runtime installation — the
   *  New Chat / resume-as-agent entry point. Reuses the one completely
   *  blank tab (switching its agent if needed) instead of `openAgent`'s
   *  reveal-or-create-per-agent semantics. A missing runtime is owned by
   *  AgentView's explicit "Install and continue" gate; tab activation
   *  alone is never consent to download another Agent. */
  activateChatTab: (agent: AgentKind) => void;
  /** The sidebar's Gallery row: raise the Gallery overlay over the
   *  workspace. The inline band under a bare window's blank chat needs
   *  no action — it derives from window state. */
  openGallery: () => void;

  newNote: () => Promise<void>;
  newFolder: (path: string) => Promise<void>;
  deleteFile: (name: string) => Promise<void>;
  deleteFolder: (path: string) => Promise<void>;
  renameFile: (oldName: string, newBaseName: string) => Promise<void>;
  renameFolder: (oldPath: string, newName: string) => Promise<void>;
  moveFile: (oldPath: string, targetDir: string) => Promise<boolean>;
  /** Rebuild a file's searchable version. `folder` defaults to the open one. */
  reprocessFile: (name: string, folder?: string) => Promise<void>;
  /** Show the file in the OS file manager. */
  revealFile: (name: string) => void;
  /** Persist the application-level hidden-files visibility and reload the
   *  active listing. Other windows converge through the tree-version poll. */
  toggleShowHiddenFiles: () => Promise<void>;
  /** Copy a pasteable Markdown link to the file at `targetPath` to the
   *  clipboard. Relative to the active Markdown note when one is open, else
   *  falls back to `targetPath`'s own workspace-relative form. */
  copyFileLink: (targetPath: string) => void;
  upload: (items: { file: File; relPath: string }[], dir: string) => Promise<boolean>;

  scheduleSave: () => void;
  flushSave: () => Promise<boolean>;

  /** Resolve a save-conflict by overwriting the disk file with the editor's current content. */
  resolveConflictOverwrite: (tabId: string) => Promise<void>;
  /** Resolve a save-conflict by reloading the disk version, discarding unsaved edits. */
  resolveConflictReload: (tabId: string) => Promise<void>;
  /** Resolve a save-conflict by inserting inline conflict markers and returning to the editor. */
  resolveConflictMerge: (tabId: string) => Promise<void>;

  registerEditor: (h: EditorHandle | null) => void;

  /** A view registers its find driver on mount; `null` on unmount.
   *  Switching tabs / toggling edit mode replaces it. */
  registerFindController: (c: FindController | null) => void;
  /** Open the in-document find bar (Cmd+F). No-op if already open;
   *  the bar's own effect re-focuses the input on re-open. */
  openFind: () => void;
  /** Close the find bar + tear down whatever the active controller
   *  highlighted. Also called implicitly on folder switch / tab close. */
  closeFind: () => void;
  setFindQuery: (q: string) => void;
  toggleFindCaseSensitive: () => void;
  toggleFindWholeWord: () => void;
  findNext: () => void;
  findPrev: () => void;
}

export interface AppActionsValue {
  actions: AppActions;
  dispatch: (a: Action) => void;
}

export const ActionsContext = createContext<AppActionsValue | null>(null);

export function ActionsProvider({ actions, dispatch, children }: AppActionsValue & { children: ReactNode }) {
  const value = useMemo(() => ({ actions, dispatch }), [actions, dispatch]);
  return (
    <ActionsContext.Provider value={value}>
      {children}
    </ActionsContext.Provider>
  );
}

export function useAppActions(): AppActionsValue {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error('useAppActions must be used inside <ActionsProvider>');
  return ctx;
}
