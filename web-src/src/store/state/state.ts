/**
 * Stable renderer-state facade: data types, the action union, initial state,
 * and compatibility exports for the pure reducer and transition helpers.
 *
 * No React or side effects live in this module graph. Every action type lives
 * here, in the `Action` union below. The sibling `editorTypes.ts` holds the
 * imperative document handles the action hooks and contexts pass around
 * (`EditorHandle`, `FindController`, `FindOptions`, `MatchInfo`) — they are
 * registered by a rendered view rather than stored in `State`, so keeping them
 * out of this file is what keeps the dependency direction one-way.
 *
 * Slice map — `State` is exactly three nested slices, one per delivery
 * context (`WorkspaceSlice` → `WorkspaceContext`, `ChatSlice` →
 * `ChatContext`, `UiShellSlice` → `UiShellContext`). Membership is the type,
 * not a comment: adding a field to a slice interface is the whole
 * declaration, and the context that owns it publishes `state.<slice>`
 * verbatim. The reducer stays single from the caller's side — one
 * `useReducer` in `AppContext.tsx` — but composes three sub-reducers that
 * each rebuild only their own slice, so a dispatch touching one slice cannot
 * change another slice's object identity.
 *
 * `ctxMenu` and `renaming` are workspace/tree interactions in origin, but
 * they sit in ui-shell because that's how the app already treats them:
 * QuickOpen/LibrarySearch read `modal || cascadePrompt || ctxMenu ||
 * renaming` together as one "something is blocking" signal, and their only
 * renderers (`ContextMenu.tsx`, `RenameInput.tsx`) live in `common/`, not
 * `features/workspace/`. `newFolderInputOpen` stayed in workspace instead —
 * its only reader is `FileTree.tsx`, paired with the workspace-owned
 * `activeFolder` field, and nothing outside workspace treats it as a
 * blocking overlay the way it does `renaming`.
 */
import type { ViewerFormat } from '@shared/file-formats';
import type {
  FileBody,
  FileMeta,
  FolderMeta,
  GenericFilePreview,
  PreparationFailure,
  ConversionProgress,
  IndexWarning,
  IndexStatus,
  Agent,
} from '@/common/api/api';

export {
  CHAT_MAX_WIDTH,
  CHAT_MIN_WIDTH,
  SPLITTER_KEYBOARD_STEP,
  SIDEBAR_COLLAPSE_AT,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampChatWidth,
  hasName,
  isSplitterKey,
  resizeChatByKeyboard,
  resizeSidebarByKeyboard,
  getActiveTab,
  makeChatTab,
  makeTab,
  nameSetSize,
  optimisticKeyBackfillPaths,
  patchActiveTab,
  renamedFilePath,
  toNameSet,
} from './stateHelpers';
export { reducer } from './stateReducer';

/**
 * A membership-only set of path-like strings, stored as a plain keyed record
 * rather than a `Set`. Records keep `State` JSON-serializable and
 * structurally diffable (a `Set` survives neither), while membership stays
 * O(1) — which matters for `expanded`, consulted once per visible tree row.
 *
 * Always go through `toNameSet` / `hasName` / `nameSetSize` instead of
 * indexing directly: a path such as `constructor` or `__proto__` would
 * otherwise read as a member off `Object.prototype`.
 */
export type NameSet = Record<string, true>;

export interface SaveStatus {
  text: string;
  cls: '' | 'saved' | 'error';
}

export type LibraryFolderStatus = 'ready' | 'preparing' | 'failed' | 'unknown';

/** One chat tab in the right-side chat panel. The tab's `agent` is
 *  locked at creation time so starting a new tab with a different agent
 *  doesn't restart open conversations. */
export interface ChatTab {
  id: string;
  /** Agent id the tab runs (`claude` / `codex` / …). */
  agent: string;
  /** Display name in the tab strip. Default: `"New Chat"` (plus a
   *  `" N"` suffix on duplicates). */
  title: string;
  /** True while the tab is COMPLETELY blank: no transcript, no active
   *  turn, not resumed, no picked scope override, no draft text, and no
   *  attachments. Maintained by the tab's AgentView; a blank tab is the
   *  reusable welcome tab for New Chat and window-folder switches. */
  blank?: boolean;
  /** The folder the tab's CONNECTED session is bound to (`null` =
   *  library scope, undefined = not connected yet). Maintained by the
   *  tab's AgentView; lets the window-folder switch skip spawning a
   *  welcome tab when the active chat already targets the new folder
   *  (the create_project auto-select case). */
  boundFolder?: string | null;
}

/** A session-resume request raised by the sidebar's History menus. The
 *  sidebar records it here, ensures a suitable chat tab is active, and
 *  the target tab's AgentView consumes it (CHAT_RESUME_CONSUMED) by
 *  resuming the session within `folder`'s scope. `folder` uses the
 *  `boundFolder` convention: an absolute member-folder path, or `null`
 *  for the library scope. */
export interface PendingChatResume {
  /** Agent that owns the session (`claude` / `codex`). */
  agent: string;
  sessionId: string;
  folder: string | null;
}

export interface OpenFile {
  name: string;
  format: ViewerFormat;
  /** Last on-disk content — diff target for the autosave path. Empty
   *  string for binary files (PDF / image / DOCX / audio; the viewer loads them
   *  directly from `/asset/*`). */
  content: string;
  /** Opaque server-side file version used to reject stale autosaves
   *  when another window or external editor changed the same file. */
  version?: string;
  /** Selection-time result for a workbench-only generic file. Text is shown
   * read-only; every other state renders an explicit unavailable placeholder. */
  genericPreview?: GenericFilePreview;
  /** Decode failure on a first-class text format (TXT), which keeps its named
   * tab visible rather than substituting replacement characters. */
  error?: import('@shared/library-files').FileBody['error'];
  /** Absolute member-folder root when this file lives OUTSIDE the window's
   *  active folder (an "out-of-folder" tab, opened from a library-wide
   *  search hit). Such tabs are strictly read-only, never enter the tree's
   *  selection / recents / pruning flows, and every fetch they cause must
   *  carry this folder explicitly. Undefined for ordinary tabs. */
  folder?: string;
}

export interface CtxMenu {
  x: number;
  y: number;
  target: string;
  kind: 'file' | 'folder' | 'restricted';
}

export interface TabConflict {
  diskContent: string;
  diskVersion: string;
  editorContent: string;
  /** One explicit resolution owns the conflict until it settles. */
  resolving?: boolean;
}

/** One open tab. Everything that varies per-document lives here so
 *  switching tabs is just a pointer swap. `file === null` is a blank
 *  tab created by the `+` button — empty pane until the user clicks
 *  a sidebar entry to fill it.
 *
 *  Every open is a persistent tab: a single sidebar click opens the
 *  file in its own tab (or focuses it if already open). There is no
 *  VS Code-style "preview tab" mode — the single/double-click split it
 *  required cost more to learn than it saved. */
export interface Tab {
  id: string;
  file: OpenFile | null;
  editMode: boolean;
  /** True only after the user changes the live editor buffer. */
  dirty: boolean;
  pendingAnchor: string | null;
  /** Set when a viewer should highlight a specific chunk on next
   *  render — typically after a click on a SearchHitRow. The viewer
   *  reads it, scrolls to the range, paints a fading overlay, and
   *  dispatches PENDING_HIGHLIGHT_CLEAR. Cleared automatically when
   *  the user navigates to a different file. */
  pendingHighlight: PendingHighlight | null;
  saveStatus: SaveStatus;
  /** Last page viewed in this PDF tab for the renderer session. A different
   *  file or source version clears it before the viewer reloads. */
  pdfPage?: number;
  conflict?: TabConflict | null;
}

/** Search-hit-derived highlight signal: which lines (for HTML / MD /
 *  code viewers) plus the raw chunk text (for the PDF viewer to do
 *  text-layer search when line numbers don't apply). When
 *  `openFindBar` is true the viewer opens the FindBar pre-seeded with
 *  `chunkText` so the user can walk every in-file match with Cmd+G —
 *  set by the keyword-search hit click so a click on one match opens
 *  navigation across all of them. */
export interface PendingHighlight {
  startLine?: number;
  endLine?: number;
  chunkText: string;
  /** Exact timestamped transcript line for audio keyword hits. Other viewers
   *  keep using chunkText as the find-bar query. */
  audioSeekText?: string;
  /** Exact millisecond position supplied by an audio keyword hit. */
  audioSeekMs?: number;
  openFindBar?: boolean;
  pdfPage?: number;
}

/** Data for the rename-cascade confirmation dialog (VSCode "Update N
 *  references in M files?" prompt). `kind` + `oldPath` + `newPath`
 *  fully describe the intent; the action holds the resolver and
 *  blocks until the user picks. */
export interface CascadePrompt {
  kind: 'file' | 'folder';
  oldPath: string;
  newPath: string;
  files: number;
  links: number;
}

export type CascadeDecision = 'update' | 'skip' | 'cancel';

/** Pending alert/confirm payload. We render these inline via a styled
 *  `ModalShell` instead of `window.alert` / `window.confirm` — the
 *  native dialogs steal focus, block the renderer thread on Electron,
 *  and clash visually with the rest of the app's modal aesthetic. */
export interface ModalRequest {
  type: 'alert' | 'confirm';
  message: string;
  /** Confirm-only presentation. Omitted fields keep the generic
   *  'Confirm action' / 'Confirm' rendering so plain `confirm(message)`
   *  call sites are unchanged. */
  title?: string;
  confirmLabel?: string;
  /** Render the action button with the destructive Button variant. */
  destructive?: boolean;
}

/**
 * Folder identity, the file tree, document tabs, the sidebar, and
 * folder-level indexing/preparation state. Published as-is by
 * `WorkspaceContext` (plus the derived `activeTab`).
 */
export interface WorkspaceSlice {
  /** True once `bootstrap` has settled (initial library load plus any
   *  auto-open attempt). Lets the shell distinguish "still booting" from
   *  "booted with no folder" — e.g. before releasing a pending
   *  window-folder registration back to Electron. */
  booted: boolean;

  /** True only after the server has returned an initial or refreshed library
   *  membership. Bootstrap settlement alone is not evidence that an empty
   *  `recent` list is authoritative. */
  membershipLoaded: boolean;

  /** Human-facing active folder label. Use `folderPath` for API scope /
   *  identity; this value is for titles, sidebar headings, and empty-state
   *  copy. */
  folder: string;
  /** Absolute POSIX path of the active folder. This is the stable identity
   *  for search, sync, conversion retry, uploads, and agent context. */
  folderPath: string;
  /** Library membership, recents-ordered — feeds the sidebar library list. */
  recent: { path: string; openedAt: string; favorite?: boolean }[];
  /** OS home directory — used to render `~/foo` instead of the full
   *  `/Users/<name>/foo` wherever an absolute path shows up in copy. */
  homeDir: string;
  /** Library-level search-readiness state keyed by absolute folder path. Unlike
   *  active-folder `pendingSemanticNames` / `pendingConversions`, this survives leaving an
   *  active folder so the sidebar library list can surface failures without
   *  showing background preparation as a browsing status. */
  libraryFolderStatuses: Record<string, LibraryFolderStatus>;

  files: FileMeta[];
  folders: FolderMeta[];

  /** Server-owned application-level hidden-files visibility, as echoed by
   *  the most recent listing. Drives the Files-panel menu's checked state
   *  and the hidden-row presentation; the durable value lives in app
   *  config, never here. */
  showHiddenFiles: boolean;

  /** Manual sidebar ordering — map of `parentPath` → ordered list of
   *  child basenames. Empty map = use default (folders-first +
   *  alphabetical) for every folder. Mutated by drag-to-reorder in the
   *  tree; reset / refetched on folder switch. */
  fileOrder: Record<string, string[]>;

  /** Ordered open tabs. The tab strip renders this array left-to-right.
   *  Empty array = no document open (initial state or after closing the
   *  last tab). The active tab is whichever has `id === activeTabId`. */
  tabs: Tab[];
  /** Most recently activated source-file paths for the active folder.
   *  This is intentionally independent of tab-strip order. */
  recentFilePaths: string[];
  /** Editor History: most-recently-activated tab ids, current tab first.
   *  Independent of tab-strip order — the Ctrl+Tab navigator's ordering
   *  source. Entries are dropped when their tab closes; unlike
   *  `recentFilePaths` (which can outlive a closed tab for Quick Open's
   *  "recent editors" list) this never references a tab that isn't
   *  currently open. Reset with `tabs` on `TABS_RESET` / folder switch. */
  editorHistory: string[];
  activeTabId: string | null;

  /** Sidebar folder paths whose children are shown. See `NameSet` — this is
   *  the field whose membership test is hot (every visible tree row). */
  expanded: NameSet;
  activeFolder: string;
  /** The single "focused row" in the sidebar — at most one row (file or
   *  folder) is visually selected at a time. Tracks the open file by
   *  default; explicit clicks (tree row, breadcrumb segment, folder
   *  toggle) override it. `''` = FOLDER root is the focused row. */
  selectedPath: string;
  folderCollapsed: boolean;
  /** True hides the sidebar entirely; the titlebar toggle brings it
   *  back (there is no activity rail). */
  sidebarCollapsed: boolean;
  /** Width (px) of the sidebar. User-resizable via the drag handle on
   *  the sidebar's right edge; clamped to [SIDEBAR_MIN_WIDTH, MAX]. */
  sidebarWidth: number;

  /** User-visible paths whose AI Index content is still being
   *  embedded/indexed. Keyword search ignores this state and can search
   *  converted/source text without embeddings. */
  pendingSemanticNames: NameSet;
  semanticIndexing: NonNullable<IndexStatus['semanticIndexing']> | null;
  /** Folder-relative paths of PDF/image/DOCX conversions that are queued or
   *  running. Kept for search-readiness accounting and refresh timing. */
  pendingConversions: string[];
  /** Folder-relative convertible sources whose preparation cannot be queued
   *  until setup is resolved. Separate from pending so the UI never implies
   *  that these files will become searchable without user action. */
  blockedConversions: string[];
  /** Current per-file conversion state for the active folder, including
   *  queued lane position and running extractor progress. */
  conversionProgress: Record<string, ConversionProgress>;
  /** Scheduler notification state for precise derived-preview reloads. */
  conversionRevision: number;
  conversionVersions: Record<string, number>;

  syncRunning: boolean;

  /** Global embedding key availability. `null` = not checked yet. Semantic
   *  search is disabled when this is explicitly false. Search itself lives
   *  in the library search popup, whose state deliberately stays outside
   *  this reducer (see `librarySearch.ts`) so it survives folder switches. */
  embedderHasKey: boolean | null;

  /** Non-null when the active folder's background indexing failed.
   *  Cleared by user dismissal or the server reporting a later success. */
  indexWarning: IndexWarning | null;
  /** Folder-relative paths whose most recent preparation failed, carried
   *  in from `/api/index-status`. Drives lightweight failure markers,
   *  rich viewer banners where available, and the context-menu
   *  "Reprocess" entry. Empty when no failures. */
  preparationFailures: PreparationFailure[];

  /** True while the user is typing a new folder name. The input
   *  renders inside the FileTree at the row matching
   *  `state.activeFolder` so the new folder appears under the
   *  parent the user actually selected (mirrors new-note inline
   *  rename placement). */
  newFolderInputOpen: boolean;
}

/**
 * The right-side Agent Panel's tab bookkeeping. Published as-is by
 * `ChatContext`.
 */
export interface ChatSlice {
  /** True opens the right-side chat panel. */
  chatOpen: boolean;
  /** Chat panel width in pixels — user-resizable via drag handle. */
  chatWidth: number;
  /** Catalog of available agents from the server, populated on demand. */
  agents: Agent[];
  /** Active chat tabs. Each tab owns its own agent session so switching
   *  tabs preserves that conversation. The chrome agent icons select or
   *  toggle an agent's chat; the in-panel `+` creates new tabs. */
  chatTabs: ChatTab[];
  /** Id of the currently-visible tab. `null` only when `chatTabs`
   *  is empty (panel closed or just initialised). */
  activeChatTabId: string | null;
  /** Per-agent tab activation history, oldest first. The last id is the
   *  tab that an agent icon selects when reopening that agent.
   *
   *  Deliberately stored, not derived: `chatTabs` is strip order and never
   *  changes on activation, so nothing in it records that the user last
   *  looked at the SECOND claude tab. Only the single most-recent tab could
   *  be reconstructed (from `activeChatTabId`); the tail behind it — which
   *  is what an agent icon falls back to once that tab closes — has no
   *  other source. Every write goes through `updateChatTabRecency` so the
   *  five reducer cases that maintain it cannot drift apart. */
  chatTabRecencyByAgent: Record<string, string[]>;
  /** Un-consumed sidebar History resume request, if any. See
   *  `PendingChatResume`; a new request replaces an unconsumed one. */
  pendingResume: PendingChatResume | null;
}

/** Chrome-style in-document keyword find. Global (not per-tab) to mirror
 *  the browser: opening Cmd+F overlays one bar over whichever view (editor
 *  / md preview / html preview iframe) is active, and switching tabs
 *  carries the bar over. `current` is 1-indexed for display; 0 means no
 *  match selected (empty query or nothing matched). */
export interface FindState {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  current: number;
  total: number;
}

/**
 * The cross-cutting overlay/blocking states. Published as-is by
 * `UiShellContext`.
 */
export interface UiShellSlice {
  ctxMenu: CtxMenu | null;
  renaming: { path: string; kind: 'file' | 'folder' } | null;
  /** Active rename-cascade dialog payload. `null` means hidden. The
   *  caller awaits a separate `resolveCascadePrompt` action to settle
   *  the decision. */
  cascadePrompt: CascadePrompt | null;
  /** Pending in-app alert/confirm. `null` = nothing showing. The
   *  Provider's `actions.alert` / `actions.confirm` set this and resolve
   *  the returned Promise once the user dismisses. */
  modal: ModalRequest | null;
  find: FindState;
}

export interface State {
  workspace: WorkspaceSlice;
  chat: ChatSlice;
  uiShell: UiShellSlice;
}

const initialWorkspace: WorkspaceSlice = {
  booted: false,
  membershipLoaded: false,
  folder: '',
  folderPath: '',
  recent: [],
  homeDir: '',
  libraryFolderStatuses: {},
  files: [],
  folders: [],
  showHiddenFiles: false,
  fileOrder: {},
  tabs: [],
  recentFilePaths: [],
  editorHistory: [],
  activeTabId: null,
  expanded: {},
  activeFolder: '',
  selectedPath: '',
  folderCollapsed: false,
  sidebarCollapsed: false,
  sidebarWidth: 280,
  pendingSemanticNames: {},
  semanticIndexing: null,
  pendingConversions: [],
  blockedConversions: [],
  conversionProgress: {},
  conversionRevision: 0,
  conversionVersions: {},
  syncRunning: false,
  embedderHasKey: null,
  indexWarning: null,
  preparationFailures: [],
  newFolderInputOpen: false,
};

const initialChat: ChatSlice = {
  // The app boots into the library-scoped Chat workspace. Keep the shell open
  // from the first renderer frame; AppBody creates the initial blank tab once
  // bootstrap settles, but the panel must not flash or remain collapsed while
  // that asynchronous state arrives.
  chatOpen: true,
  chatWidth: 480,
  agents: [],
  chatTabs: [],
  activeChatTabId: null,
  chatTabRecencyByAgent: {},
  pendingResume: null,
};

const initialUiShell: UiShellSlice = {
  ctxMenu: null,
  renaming: null,
  cascadePrompt: null,
  modal: null,
  find: { open: false, query: '', caseSensitive: false, wholeWord: false, current: 0, total: 0 },
};

export const initialState: State = {
  workspace: initialWorkspace,
  chat: initialChat,
  uiShell: initialUiShell,
};

export type Action =
  | { type: 'BOOTED' }
  | { type: 'RECENT_LOADED'; recent: WorkspaceSlice['recent']; homeDir?: string }
  | { type: 'LIBRARY_FOLDER_STATUS'; path: string; status: LibraryFolderStatus }
  | { type: 'LIBRARY_FOLDER_STATUS_REMOVE'; path: string }
  | { type: 'FOLDER_CONTEXT'; folder: string; folderPath: string }
  | { type: 'FILES_LOADED'; files: FileMeta[]; folders: FolderMeta[]; folder: string; folderPath?: string; showHiddenFiles?: boolean }
  | { type: 'FILE_ORDER_LOADED'; order: Record<string, string[]> }
  /** Replace one folder's ordered list (optimistic update before the
   *  PUT lands). Names list may include entries that no longer exist
   *  on disk — the tree renderer filters those out. */
  | { type: 'FILE_ORDER_SET'; parentPath: string; names: string[] }
  /** Load a file body into the active tab. `newTab: true` activates the
   *  source's existing tab when present; otherwise it pushes a fresh tab and
   *  switches to it. Omitting `newTab` replaces the active tab in place
   *  (blank-tab reuse, back/forward, in-place anchor nav). */
  | { type: 'FILE_OPEN'; body: FileBody & { genericPreview?: GenericFilePreview }; newTab?: boolean; libraryFolder?: string }
  | { type: 'FILE_PATCH'; patch: Partial<OpenFile> }
  | { type: 'DOCUMENT_DIRTY'; dirty: boolean }
  | { type: 'PRUNE_MISSING_FILE_TABS'; names: string[] }
  | { type: 'REMAP_PATHS'; from: string; to: string; kind: 'file' | 'folder' }
  /** Push an empty tab and activate it (Obsidian-style `+`). The next
   *  single-click in the sidebar lands here. */
  | { type: 'NEW_TAB' }
  | { type: 'CLOSE_TAB'; id: string }
  | { type: 'ACTIVATE_TAB'; id: string }
  /** Close every open tab — used on folder switch / "go home". */
  | { type: 'TABS_RESET' }
  | { type: 'EDIT_MODE'; on: boolean }
  | { type: 'TOGGLE_FOLDER'; path: string }
  | { type: 'EXPAND_FOLDER'; path: string }
  | { type: 'COLLAPSE_ALL_FOLDERS' }
  | { type: 'EXPAND_ALL_FOLDERS'; paths: string[] }
  | { type: 'FOLDER_FOLD_TOGGLE' }
  | { type: 'SIDEBAR_SET_COLLAPSED'; collapsed: boolean }
  | { type: 'SIDEBAR_WIDTH'; width: number }
  | { type: 'CHAT_TOGGLE' }
  | { type: 'CHAT_WIDTH'; width: number }
  | { type: 'AGENTS_LOADED'; agents: ChatSlice['agents'] }
  /** Reveal an agent's most recent Agent Panel session (opening the panel
   *  when hidden) without toggling an already-visible panel. `tab` is
   *  supplied only when that agent has no open tabs. */
  | { type: 'CHAT_AGENT_OPEN'; agent: string; tab?: ChatTab }
  | { type: 'CHAT_TAB_NEW'; tab: ChatTab }
  | { type: 'CHAT_TAB_CLOSE'; id: string }
  | { type: 'CHAT_TAB_ACTIVATE'; id: string }
  | { type: 'CHAT_TAB_RENAME'; id: string; title: string }
  /** AgentView reports whether its tab is completely blank (reusable as a
   *  welcome tab). See `ChatTab.blank`. */
  | { type: 'CHAT_TAB_SET_BLANK'; id: string; blank: boolean }
  /** Switch a COMPLETELY BLANK tab's agent in place (the New Chat split
   *  button reusing a blank tab of the other agent). The reducer refuses
   *  the switch for any tab with `blank === false` — user work is never
   *  handed to another agent. */
  | { type: 'CHAT_TAB_SET_AGENT'; id: string; agent: string }
  | { type: 'CHAT_TAB_SET_SCOPE'; id: string; folder: string | null }
  /** Sidebar History picked a session: record the resume request for the
   *  target tab's AgentView to consume. Replaces any unconsumed request. */
  | { type: 'CHAT_RESUME_REQUEST'; resume: PendingChatResume }
  /** The target AgentView took ownership of the pending resume. */
  | { type: 'CHAT_RESUME_CONSUMED' }
  | { type: 'ACTIVE_FOLDER'; path: string }
  /** Move the sidebar's single focus to `path`. Pure visual highlight
   *  — does not touch expand state, activeFolder, or the open file. */
  | { type: 'SELECT_PATH'; path: string }
  | { type: 'PENDING_SEMANTIC_NAMES'; names: NameSet }
  | { type: 'SEMANTIC_INDEXING_STATE'; state: WorkspaceSlice['semanticIndexing'] }
  | { type: 'PENDING_CONVERSIONS'; paths: string[] }
  | { type: 'BLOCKED_CONVERSIONS'; paths: string[] }
  | { type: 'CONVERSION_PROGRESS'; progress: Record<string, ConversionProgress> }
  | { type: 'CONVERSION_SCHEDULER_STATE'; revision: number; versions: Record<string, number> }
  | { type: 'SAVE_STATUS'; status: SaveStatus }
  | { type: 'SYNC_RUNNING'; running: boolean }
  | { type: 'EMBEDDER_KEY_STATE'; hasKey: boolean }
  | { type: 'INDEX_WARNING'; warning: IndexWarning | null }
  | { type: 'PREPARATION_FAILURES'; failures: PreparationFailure[] }
  | { type: 'CTX_MENU'; menu: CtxMenu | null }
  | { type: 'RENAMING'; renaming: UiShellSlice['renaming'] }
  /** Arm the active tab's pending scroll-to-anchor (cross-file links /
   *  search hits); the viewer consumes it on next render. */
  | { type: 'PENDING_SCROLL'; anchor: string | null }
  | { type: 'PENDING_HIGHLIGHT'; highlight: PendingHighlight | null }
  | { type: 'CASCADE_PROMPT'; prompt: CascadePrompt | null }
  | { type: 'MODAL_OPEN'; request: ModalRequest }
  | { type: 'MODAL_CLOSE' }
  | { type: 'TAB_PDF_PAGE'; id: string; page: number }
  /** Move tab `id` to immediately before tab `beforeId` (drag-reorder).
   *  `beforeId === null` appends to the end. No-op when the relative
   *  position wouldn't change — keeps the reducer idempotent so a
   *  hover-and-snap-back drag doesn't churn the React keys. */
  | { type: 'TABS_REORDER'; id: string; beforeId: string | null }
  | { type: 'NEW_FOLDER_INPUT'; open: boolean }
  | { type: 'FIND_OPEN' }
  | { type: 'FIND_CLOSE' }
  | { type: 'FIND_SET'; patch: Partial<FindState> }
  | { type: 'SET_CONFLICT'; id: string; conflict: TabConflict | null }
  | { type: 'SET_CONFLICT_RESOLVING'; id: string; resolving: boolean }
  | { type: 'RESOLVE_CONFLICT_DISCARD'; id: string };
