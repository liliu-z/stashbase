/**
 * Stable renderer-state facade: data types, the action union, initial state,
 * and compatibility exports for the pure reducer and transition helpers.
 *
 * No React or side effects live in this module graph. Action-only interface
 * types remain in `actionTypes.ts` so the dependency direction stays
 * one-way.
 */
import type {
  FileBody,
  FileMeta,
  FolderMeta,
  KeywordSearchResult,
  PreparationFailure,
  ConversionProgress,
  IndexWarning,
  SearchHit,
  Agent,
} from '../api';
import type { SearchTypeCategory } from '../../../shared/search-types.ts';

export {
  CHAT_MAX_WIDTH,
  CHAT_MIN_WIDTH,
  SIDEBAR_COLLAPSE_AT,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampChatWidth,
  getActiveTab,
  makeChatTab,
  makeTab,
  optimisticKeyBackfillPaths,
  patchActiveTab,
  renamedFilePath,
} from './stateHelpers';
export { reducer } from './stateReducer';

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
  /** Display name in the tab strip. Default: `"Untitled"` (plus a
   *  `" N"` suffix on duplicates). */
  title: string;
}

export interface OpenFile {
  name: string;
  format: 'md' | 'html' | 'pdf' | 'image' | 'docx' | 'audio';
  /** Last on-disk content — diff target for the autosave path. Empty
   *  string for binary files (PDF / image / DOCX / audio; the viewer loads them
   *  directly from `/asset/*`). */
  content: string;
  /** Opaque server-side file version used to reject stale autosaves
   *  when another window or external editor changed the same file. */
  version?: string;
}

export interface CtxMenu {
  x: number;
  y: number;
  target: string;
  kind: 'file' | 'folder';
}

/** One open tab. Everything that varies per-document lives here so
 *  switching tabs is just a pointer swap. `file === null` is a blank
 *  tab created by the `+` button — empty pane until the user clicks
 *  a sidebar entry to fill it.
 *
 *  `preview` mirrors VS Code's "preview tab" mode — a tab opened by
 *  single-click from the sidebar is preview, rendered italic, and the
 *  next single-click on a different file REPLACES its content
 *  ("kicks" the preview out) instead of spawning a new tab. Promoted
 *  to a regular pinned tab by: double-clicking the file in the tree,
 *  double-clicking the tab title, or entering edit mode. */
export interface Tab {
  id: string;
  file: OpenFile | null;
  editMode: boolean;
  /** True only after the user changes the live editor buffer. */
  dirty: boolean;
  /** Increments when this tab is assigned a different document. */
  editorSessionVersion: number;
  preview: boolean;
  pendingAnchor: string | null;
  /** Set when a viewer should highlight a specific chunk on next
   *  render — typically after a click on a SearchHitRow. The viewer
   *  reads it, scrolls to the range, paints a fading overlay, and
   *  dispatches PENDING_HIGHLIGHT_CLEAR. Cleared automatically when
   *  the user navigates to a different file. */
  pendingHighlight: PendingHighlight | null;
  saveStatus: SaveStatus;
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
}

/** A toast notification: lightweight non-blocking feedback the user
 *  can dismiss or just wait out. Use this for "operation succeeded /
 *  failed" feedback where the user can keep working — reserve
 *  `actions.alert` for content that genuinely needs the user to
 *  stop and read. */
export interface Toast {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  /** Optional inline action (e.g. "Retry", "Undo"). The handler runs
   *  in addition to dismissing the toast — the toast tracker takes
   *  care of removing the toast from the stack afterwards. */
  action?: { label: string; onClick: () => void };
  /** Milliseconds before auto-dismiss. `null` = persistent (must be
   *  clicked away). Defaults: info / success 3000, warning 5000,
   *  error null. */
  ttl: number | null;
  /** How many identical (same level + message) toasts have collapsed
   *  into this one. Absent / 1 = a single occurrence; rendered as a
   *  "×N" badge when >1 so rapid-fire duplicates don't flood the
   *  stack. Maintained by the `TOAST_ADD` reducer. */
  count?: number;
}

export interface State {
  welcomeVisible: boolean;
  welcomeError: string | null;

  /** Human-facing active folder label. Use `folderPath` for API scope /
   *  identity; this value is for titles, sidebar headings, and empty-state
   *  copy. */
  folder: string;
  /** Absolute POSIX path of the active folder. This is the stable identity
   *  for search, sync, conversion retry, uploads, and agent context. */
  folderPath: string;
  recent: { path: string; openedAt: string }[];
  /** OS home directory — used by the Welcome screen to render
   *  `~/foo` instead of the full `/Users/<name>/foo`. */
  homeDir: string;
  /** Library-level search-readiness state keyed by absolute folder path. Unlike
   *  active-folder `pendingSemanticNames` / `pendingConversions`, this survives leaving an
   *  active folder so Welcome can surface failures without showing
   *  background preparation as a browsing status. */
  libraryFolderStatuses: Record<string, LibraryFolderStatus>;

  files: FileMeta[];
  folders: FolderMeta[];

  /** Manual sidebar ordering — map of `parentPath` → ordered list of
   *  child basenames. Empty map = use default (folders-first +
   *  alphabetical) for every folder. Mutated by drag-to-reorder in the
   *  tree; reset / refetched on folder switch. */
  fileOrder: Record<string, string[]>;

  /** Ordered open tabs. The tab strip renders this array left-to-right.
   *  Empty array = no document open (initial state or after closing the
   *  last tab). The active tab is whichever has `id === activeTabId`. */
  tabs: Tab[];
  activeTabId: string | null;

  expanded: Set<string>;
  activeFolder: string;
  /** The single "focused row" in the sidebar — at most one row (file or
   *  folder) is visually selected at a time. Tracks the open file by
   *  default; explicit clicks (tree row, breadcrumb segment, folder
   *  toggle) override it. `''` = FOLDER root is the focused row. */
  selectedPath: string;
  folderCollapsed: boolean;
  /** True hides the resizable side panel, leaving only the 44px activity
   *  rail visible (VSCode-style — the rail itself never collapses). */
  sidebarCollapsed: boolean;
  /** Width (px) of the resizable side panel — the part right of the
   *  44px activity rail. User-resizable via the drag handle on the
   *  sidebar's right edge; clamped to [SIDEBAR_MIN_WIDTH, MAX]. */
  sidebarWidth: number;
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
   *  tab that an agent icon selects when reopening that agent. */
  chatTabRecencyByAgent: Record<string, string[]>;

  /** User-visible paths whose semantic-search content is still being
   *  embedded/indexed. Keyword search ignores this state and can search
   *  converted/source text without embeddings. */
  pendingSemanticNames: Set<string>;
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

  /** Which sidebar view is active. `'files'` shows the file tree +
   *  banners; `'search'` shows the search input + result list (input
   *  visible only in this view). Not persisted — every launch starts on
   *  `'files'`. */
  activeSidebarView: 'files' | 'search';
  /** Sidebar search input. Empty = blank search panel; non-empty =
   *  run search in whichever mode `searchMode` selects. */
  filterQuery: string;
  /** `'semantic'` runs vector + BM25 hybrid via the daemon (`/api/search`).
   *  `'keyword'` runs ripgrep against the active folder dir
   *  (`/api/keyword-search`) — no daemon, no embeddings. The toggle
   *  switches without clearing the input so the user can compare. */
  searchMode: 'semantic' | 'keyword';
  /** Only meaningful in keyword mode. `false` = ripgrep `--smart-case`
   *  (case-insensitive unless the query has uppercase chars); `true` =
   *  `--case-sensitive` regardless. Semantic search ignores case via
   *  embeddings, so this knob is hidden when `searchMode === 'semantic'`. */
  caseStrict: boolean;
  /** Only meaningful in keyword mode. `true` = `--word-regexp` so
   *  "agent" doesn't match "agents". Hidden in semantic mode. */
  wholeWord: boolean;
  /** Folder-relative subfolder the next search is scoped to; null =
   *  whole folder. Reset when the active folder changes. */
  searchScope: string | null;
  /** File-type categories the next search includes; empty = every
   *  category. Applies to both modes and composes with `searchScope`. */
  searchTypes: SearchTypeCategory[];
  /** `null` = not in search mode (query empty or cleared). `[]` = ran
   *  and got nothing. Non-empty array = ranked hits from `/api/search`.
   *  Populated only when `searchMode === 'semantic'`. */
  searchHits: SearchHit[] | null;
  /** Same null / empty / populated convention as `searchHits`, but for
   *  the keyword path. Holds the file-grouped result so the sidebar can
   *  render each file's matches as a collapsible group. */
  keywordResult: KeywordSearchResult | null;
  searching: boolean;
  /** Non-null when the last search failed for a real reason (server /
   *  daemon error, not just "no matches"). Kept separate so the panel
   *  shows the error instead of a misleading empty "No matches". */
  searchError: string | null;
  /** Global OpenAI key availability. `null` = not checked yet. Semantic
   *  search is disabled when this is explicitly false. */
  embedderHasKey: boolean | null;

  /** Non-null when the active folder's background indexing failed.
   *  Cleared by user dismissal or the server reporting a later success. */
  indexWarning: IndexWarning | null;
  /** Folder-relative paths whose most recent preparation failed, carried
   *  in from `/api/index-status`. Drives lightweight failure markers,
   *  rich viewer banners where available, and the context-menu
   *  "Reprocess" entry. Empty when no failures. */
  preparationFailures: PreparationFailure[];

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
  /** Active toast notifications, rendered as a stack in the bottom-
   *  right corner. Each entry self-dismisses after its ttl; the
   *  Provider trims this list on every `TOAST_DISMISS`. */
  toasts: Toast[];
  /** True while the user is typing a new folder name. The input
   *  renders inside the FileTree at the row matching
   *  `state.activeFolder` so the new folder appears under the
   *  parent the user actually selected (mirrors new-note inline
   *  rename placement). */
  newFolderInputOpen: boolean;

  /** Chrome-style in-document keyword find. Global (not per-tab) to
   *  mirror the browser: opening Cmd+F overlays one bar over whichever
   *  view (editor / md preview / html preview iframe) is active, and
   *  switching tabs carries the bar over. `current` is 1-indexed for
   *  display; 0 means no match selected (empty query or nothing matched). */
  find: {
    open: boolean;
    query: string;
    caseSensitive: boolean;
    wholeWord: boolean;
    current: number;
    total: number;
  };
}

export const initialState: State = {
  welcomeVisible: true,
  welcomeError: null,
  folder: '',
  folderPath: '',
  recent: [],
  homeDir: '',
  libraryFolderStatuses: {},
  files: [],
  folders: [],
  fileOrder: {},
  tabs: [],
  activeTabId: null,
  expanded: new Set(),
  activeFolder: '',
  selectedPath: '',
  folderCollapsed: false,
  sidebarCollapsed: false,
  sidebarWidth: 280,
  chatOpen: false,
  chatWidth: 480,
  agents: [],
  chatTabs: [],
  activeChatTabId: null,
  chatTabRecencyByAgent: {},
  pendingSemanticNames: new Set(),
  pendingConversions: [],
  blockedConversions: [],
  conversionProgress: {},
  conversionRevision: 0,
  conversionVersions: {},
  syncRunning: false,
  activeSidebarView: 'files',
  filterQuery: '',
  searchMode: 'semantic',
  caseStrict: false,
  wholeWord: false,
  searchScope: null,
  searchTypes: [],
  searchHits: null,
  keywordResult: null,
  searching: false,
  searchError: null,
  embedderHasKey: null,
  indexWarning: null,
  preparationFailures: [],
  ctxMenu: null,
  renaming: null,
  cascadePrompt: null,
  modal: null,
  toasts: [],
  newFolderInputOpen: false,
  find: { open: false, query: '', caseSensitive: false, wholeWord: false, current: 0, total: 0 },
};

export type Action =
  | { type: 'WELCOME_HIDE' }
  | { type: 'WELCOME_SHOW'; recent: State['recent']; homeDir?: string; error?: string | null }
  | { type: 'RECENT_LOADED'; recent: State['recent']; homeDir?: string }
  | { type: 'WELCOME_ERROR'; error: string }
  | { type: 'LIBRARY_FOLDER_STATUS'; path: string; status: LibraryFolderStatus }
  | { type: 'LIBRARY_FOLDER_STATUS_REMOVE'; path: string }
  | { type: 'FOLDER_CONTEXT'; folder: string; folderPath: string }
  | { type: 'FILES_LOADED'; files: FileMeta[]; folders: FolderMeta[]; folder: string; folderPath?: string }
  | { type: 'FILE_ORDER_LOADED'; order: Record<string, string[]> }
  /** Replace one folder's ordered list (optimistic update before the
   *  PUT lands). Names list may include entries that no longer exist
   *  on disk — the tree renderer filters those out. */
  | { type: 'FILE_ORDER_SET'; parentPath: string; names: string[] }
  /** Load a file body into the active tab. `newTab: true` first pushes
   *  a fresh blank tab and switches to it, so the file lands in a new
   *  tab instead of replacing the current one. `preview` overrides the
   *  target tab's preview status: when creating a new tab it sets the
   *  initial value; when replacing an active tab it can flip an
   *  existing pinned tab back to preview (used by the blank-tab reuse
   *  path) or vice versa. Omit to preserve the tab's existing flag —
   *  back/forward and in-place anchor nav rely on that. */
  | { type: 'FILE_OPEN'; body: FileBody; newTab?: boolean; preview?: boolean }
  | { type: 'FILE_PATCH'; patch: Partial<OpenFile>; invalidateEditorSession?: boolean }
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
  | { type: 'AGENTS_LOADED'; agents: State['agents'] }
  /** Select or toggle an agent from a chrome icon. `tab` is supplied only
   *  when that agent has no open tabs. */
  | { type: 'CHAT_AGENT_TOGGLE'; agent: string; tab?: ChatTab }
  | { type: 'CHAT_TAB_NEW'; tab: ChatTab }
  | { type: 'CHAT_TAB_CLOSE'; id: string }
  | { type: 'CHAT_TAB_ACTIVATE'; id: string }
  | { type: 'CHAT_TAB_RENAME'; id: string; title: string }
  | { type: 'CHAT_TABS_RESET' }
  | { type: 'ACTIVE_FOLDER'; path: string }
  /** Move the sidebar's single focus to `path`. Pure visual highlight
   *  — does not touch expand state, activeFolder, or the open file. */
  | { type: 'SELECT_PATH'; path: string }
  | { type: 'PENDING_SEMANTIC_NAMES'; names: Set<string> }
  | { type: 'PENDING_CONVERSIONS'; paths: string[] }
  | { type: 'BLOCKED_CONVERSIONS'; paths: string[] }
  | { type: 'CONVERSION_PROGRESS'; progress: Record<string, ConversionProgress> }
  | { type: 'CONVERSION_SCHEDULER_STATE'; revision: number; versions: Record<string, number> }
  | { type: 'SAVE_STATUS'; status: SaveStatus }
  | { type: 'SYNC_RUNNING'; running: boolean }
  | { type: 'FILTER'; q: string }
  | { type: 'SEARCH_START' }
  | { type: 'SEARCH_HITS'; hits: SearchHit[] }
  | { type: 'SEARCH_KEYWORD'; result: KeywordSearchResult }
  | { type: 'SEARCH_ERROR'; error: string }
  | { type: 'SEARCH_CLEAR' }
  | { type: 'SEARCH_MODE'; mode: 'semantic' | 'keyword' }
  | { type: 'EMBEDDER_KEY_STATE'; hasKey: boolean }
  | { type: 'SIDEBAR_VIEW'; view: 'files' | 'search' }
  | { type: 'SEARCH_CASE_STRICT'; strict: boolean }
  | { type: 'SEARCH_WHOLE_WORD'; on: boolean }
  | { type: 'SEARCH_SCOPE'; scope: string | null }
  | { type: 'SEARCH_TYPES'; types: SearchTypeCategory[] }
  | { type: 'INDEX_WARNING'; warning: IndexWarning | null }
  | { type: 'PREPARATION_FAILURES'; failures: PreparationFailure[] }
  | { type: 'CTX_MENU'; menu: CtxMenu | null }
  | { type: 'RENAMING'; renaming: State['renaming'] }
  /** Arm the active tab's pending scroll-to-anchor (cross-file links /
   *  search hits); the viewer consumes it on next render. */
  | { type: 'PENDING_SCROLL'; anchor: string | null }
  | { type: 'PENDING_HIGHLIGHT'; highlight: PendingHighlight | null }
  | { type: 'CASCADE_PROMPT'; prompt: CascadePrompt | null }
  | { type: 'MODAL_OPEN'; request: ModalRequest }
  | { type: 'MODAL_CLOSE' }
  | { type: 'TOAST_ADD'; toast: Toast }
  | { type: 'TOAST_DISMISS'; id: string }
  | { type: 'TOAST_CLEAR' }
  /** Promote a preview tab to a pinned one (sets `preview = false`).
   *  Triggered by double-click on a sidebar file, double-click on the
   *  tab title, or entering edit mode on the tab. */
  | { type: 'PROMOTE_TAB'; id: string }
  /** Move tab `id` to immediately before tab `beforeId` (drag-reorder).
   *  `beforeId === null` appends to the end. No-op when the relative
   *  position wouldn't change — keeps the reducer idempotent so a
   *  hover-and-snap-back drag doesn't churn the React keys. */
  | { type: 'TABS_REORDER'; id: string; beforeId: string | null }
  | { type: 'NEW_FOLDER_INPUT'; open: boolean }
  | { type: 'FIND_OPEN' }
  | { type: 'FIND_CLOSE' }
  | { type: 'FIND_SET'; patch: Partial<State['find']> };
