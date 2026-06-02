/**
 * Typed fetch wrappers for every `/api/*` endpoint the server exposes
 * (see `server/index.ts`). Throws `ApiError` on non-2xx so callers can
 * `try/catch` once at the action layer.
 *
 * Paths are always space-relative POSIX (`topic/note.md`). The server
 * url-encodes them for us inside route patterns; the client must do the
 * same for path segments embedded into the URL.
 */

/** Viewer format the renderer uses for tab routing. `md` / `html` are
 *  indexed note formats (text loaded from `/api/files/*`); `pdf` is a
 *  binary-only viewer (PDF.js renders the file straight from
 *  `/asset/*`). The server's `detectFormat()` still excludes `pdf`
 *  because PDFs aren't indexed — this type is wider than the server's
 *  on purpose. */
export type FileFormat = 'md' | 'html' | 'pdf';

export interface FileMeta {
  name: string;
  format: FileFormat;
  heading: string;
  snippet: string;
  imported_at?: string;
}

export interface FolderMeta {
  path: string;
}

export interface Heading {
  level: number;
  text: string;
  id: string;
}

export interface SpaceState {
  current: string | null;
  recent: { path: string; openedAt: string }[];
  homeDir?: string;
}

export interface SpaceConfig {
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  skillsDirs?: string[];
}

export type ImportFolderMode = 'copy' | 'move';

export interface FolderImportPreview {
  source: string;
  name: string;
  destination: string;
  exists: boolean;
  entryCount: number;
  totalBytes: number;
  requiresConfirmation: boolean;
  warnings: string[];
  hasSnapshot: boolean;
}

export interface FolderImportResult {
  path: string;
  name: string;
  mode: ImportFolderMode;
  /** Present only when a `move` import copied successfully but the
   *  original folder could not be fully deleted; the new space is intact
   *  and the original needs manual cleanup. */
  warning?: string;
}

export interface FilesPayload {
  files: FileMeta[];
  folders: FolderMeta[];
  space: string;
}

export interface FileBody {
  name: string;
  format: FileFormat;
  content: string;
  headings?: Heading[];
}

export interface IndexStatus {
  total: number;
  indexed: number;
  pendingCount: number;
  pending: string[];
  orphanedCount: number;
  orphaned: string[];
  upToDate: boolean;
  /** False while the server is still loading the index cache for a space. */
  indexReady?: boolean;
  /** Space-relative paths of PDFs the server is currently converting
   *  into a readable note + bundle. Empty when no conversions are in
   *  flight. Used by the sidebar to render a transient indicator. */
  pendingConversions?: string[];
  /** Persistent failure list — PDFs whose most recent conversion
   *  attempt errored. Survives app restart (read back from
   *  `<KB>/.stashbase/state.db`). Empty when no failures.
   *  Drives the failures-list UI and the per-file Retry banner in
   *  PdfPreview. */
  pdfFailures?: PdfFailure[];
  /** Monotonic counter the server bumps on every external fs event
   *  (after self-write filtering). Renderer compares against its
   *  last-seen value and triggers `/api/files` on any change — picks
   *  up writes from the terminal panel (Claude Code, `touch`, …) even
   *  for non-indexable files / empty dirs that don't move `pending`. */
  treeVersion?: number;
  /** Non-null when this space's most recent snapshot import skipped
   *  chunks because their provider key didn't match the library's
   *  current embedder. The renderer surfaces this as a dismissible
   *  banner with a link to switch embedders. */
  snapshotWarning?: SnapshotWarning | null;
}

export interface SnapshotWarning {
  skipped: number;
  details: { provider: string; chunks: number }[];
  at: string;
}

/** Persistent PDF conversion failure record (subset of the on-disk
 *  entry — we strip timestamps the UI doesn't need). */
export interface PdfFailure {
  path: string;
  lastError: string;
  attempts: number;
}

/** Full PDF status entries returned by `GET /api/pdf/status`. Keyed by
 *  KB-relative path. PdfPreview uses this to pick out the entry for
 *  the file it's rendering and decide whether to show the failure
 *  banner. */
export type PdfStatusKind = 'in-flight' | 'done' | 'failed' | 'cancelled';
export interface PdfStatusEntry {
  status: PdfStatusKind;
  attempts: number;
  lastError?: string;
  lastAttemptAt: string;
  doneAt?: string;
}

export interface SyncResult {
  added?: string[];
  modified?: string[];
  removed?: string[];
  /** Files the daemon detected as renames (hash match between a
   *  deleted and an added path). These bypass the embedding pipeline
   *  entirely — cached vectors get re-stamped under the new source. */
  renamed?: string[];
  error?: string;
}

export interface UploadResultEntry {
  file: string;
  error?: string;
}

export interface UploadResult {
  files: UploadResultEntry[];
}

export interface SearchHit {
  fileName: string;
  chunkIndex: number;
  content: string;
  heading: string;
  startLine?: number;
  endLine?: number;
  score: number;
}

export interface KeywordMatch {
  line: number;
  text: string;
  ranges: Array<[number, number]>;
}

export interface KeywordHitFile {
  path: string;
  matches: KeywordMatch[];
  totalMatches: number;
}

export interface KeywordSearchResult {
  query: string;
  space: string;
  files: KeywordHitFile[];
  totalMatches: number;
  truncated: boolean;
}

export type EmbedderProvider = 'onnx' | 'openai';

export interface EmbedderState {
  provider: EmbedderProvider;
  hasKey: boolean;
}

export interface EmbedderCostEstimate {
  provider: string;
  files: number;
  bytes: number;
  tokens: number;
  /** USD, computed at the server. May be 0 for non-API providers. */
  costUsd: number;
}


export interface TerminalCli {
  id: string;
  label: string;
  vendor: string;
  installHint: string;
  installed: boolean;
  /** Full shell command the panel feeds to the shell once it's ready
   *  (e.g. `claude --theme light`). Built by the server from the CLI
   *  registry so the renderer doesn't have to track per-CLI flags. */
  launchCommand: string;
}

export interface TerminalClisResponse {
  current: string;
  clis: TerminalCli[];
}

/** Extract a printable message from any thrown value. ApiError wins
 *  first because its `.message` already includes the HTTP context. Use
 *  in `catch (err: unknown)` blocks so the renderer doesn't have to
 *  fall back to `any`. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' };
const WINDOW_ID_KEY = 'stashbase.windowId';

export function getWindowId(): string {
  try {
    let id = window.sessionStorage.getItem(WINDOW_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      window.sessionStorage.setItem(WINDOW_ID_KEY, id);
    }
    return id;
  } catch {
    return 'web';
  }
}

function requestHeaders(extra?: HeadersInit): HeadersInit {
  return { ...(extra ?? {}), 'x-stashbase-window-id': getWindowId() };
}

/** GET wrapper. Throws `ApiError` for non-2xx; returns parsed JSON. */
async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: requestHeaders() });
  return parseJsonOrThrow<T>(r);
}

async function send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: requestHeaders() };
  if (body !== undefined) {
    init.headers = requestHeaders(JSON_HEADERS);
    init.body = JSON.stringify(body);
  }
  const r = await fetch(path, init);
  return parseJsonOrThrow<T>(r);
}

async function parseJsonOrThrow<T>(r: Response): Promise<T> {
  // Most error routes return `{ error: '…' }` so we surface that
  // message; raw status fallback covers the rest.
  let payload: unknown;
  try { payload = await r.json(); } catch { payload = null; }
  if (!r.ok) {
    const msg = (payload && typeof payload === 'object' && 'error' in payload && typeof (payload as any).error === 'string')
      ? (payload as any).error as string
      : `HTTP ${r.status}`;
    throw new ApiError(msg, r.status);
  }
  if (payload && typeof payload === 'object' && 'error' in payload && (payload as any).error) {
    throw new ApiError((payload as any).error as string, r.status);
  }
  return payload as T;
}

/** Encode each path segment but keep the `/` separators — what the
 *  server's `/api/files/*` and `/asset/*` routes expect. */
export function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

export const api = {
  // Space ---------------------------------------------------------
  getSpace: () => getJson<SpaceState>('/api/space'),
  openSpace: (path: string) => send<SpaceState>('POST', '/api/space', { path }),
  /** Open a space by name (single segment under the library root).
   *  Preferred over `openSpace(path)` for new flows now that spaces
   *  are flat. */
  openSpaceByName: (name: string) => send<SpaceState>('POST', '/api/space', { name }),
  /** Absolute path of the KB root. All spaces live under it as direct
   *  children; the renderer uses this to display the home-relative
   *  form (`~/Documents/StashBase`) in copy. */
  getKbRoot: () => getJson<{ path: string; needsPicker?: boolean }>('/api/kb-root'),
  setKbRoot: (path: string, confirmNonEmpty = false) =>
    send<{ path: string }>('PUT', '/api/kb-root', { path, confirmNonEmpty }),
  /** Direct-child directory names under kbRoot — every entry is a
   *  candidate the server will accept as a space name. Powers the
   *  "Open space" dropdown. */
  listAvailableSpaces: () => getJson<{ names: string[] }>('/api/spaces/available'),
  renameSpace: (name: string, nextName: string) =>
    send<{ name: string; path: string }>('PATCH', '/api/spaces/' + encodeURIComponent(name), { name: nextName }),
  deleteSpace: (name: string) =>
    send<Record<string, never>>('DELETE', '/api/spaces/' + encodeURIComponent(name)),
  getSpaceConfig: (name: string) =>
    getJson<{ path: string; local: SpaceConfig; resolved: Required<SpaceConfig> }>(
      '/api/spaces/' + encodeURIComponent(name) + '/config',
    ),
  putSpaceConfig: (name: string, config: SpaceConfig) =>
    send<{ path: string; local: SpaceConfig; resolved: Required<SpaceConfig> }>(
      'PUT',
      '/api/spaces/' + encodeURIComponent(name) + '/config',
      config,
    ),
  getSpaceRules: (name: string) =>
    getJson<{ name: string; content: string }>('/api/spaces/' + encodeURIComponent(name) + '/rules'),
  putSpaceRules: (name: string, content: string) =>
    send<{ ok: true }>('PUT', '/api/spaces/' + encodeURIComponent(name) + '/rules', { content }),
  getResolvedRules: () => getJson<{ space: string | null; content: string }>('/api/rules'),
  /** Read `<kbRoot>/STASHBASE.md` — the KB-level rules book. Powers
   *  the LibraryPanel's "open KB rules" row. */
  getKbRules: () => getJson<{ content: string }>('/api/library/rules'),
  /** Read `<kbRoot>/.stashbase/space-metadata.md` — the agent-maintained
   *  library 目录. Powers the LibraryPanel's overview row. */
  getLibraryOverview: () => getJson<{ content: string }>('/api/library/overview'),
  /** Run `git clone <url>` into `<kbRoot>/<name>`, returning the
   *  absolute path of the freshly-cloned working tree. `name`
   *  defaults to the inferred repo name. Caller follows up with
   *  `openSpaceByName(name)`. */
  gitClone: (url: string, name = '') =>
    send<{ path: string }>('POST', '/api/git/clone', { url, name }),
  /** Copy a local folder into kbRoot as a new space. `source` is an
   *  absolute path; the renderer obtains it from
   *  `window.electron.openFolderDialog` (Electron-only). `name`
   *  defaults to the basename of `source` server-side. */
  previewImportFolder: (source: string, name = '') =>
    send<FolderImportPreview>('POST', '/api/space/import-folder/preview', { source, name }),
  importFolder: (
    source: string,
    opts: { name?: string; mode?: ImportFolderMode; confirmExisting?: boolean } = {},
  ) =>
    send<FolderImportResult>('POST', '/api/space/import-folder', {
      source,
      name: opts.name ?? '',
      mode: opts.mode ?? 'copy',
      confirmExisting: opts.confirmExisting === true,
    }),
  /** Mirror this space's `skills/<name>/SKILL.md` into the active
   *  CLI's per-project prompt dir (`.claude/commands` / `.codex/prompts`).
   *  Renderer fires this on terminal panel open / CLI switch. */
  syncSkills: (cli: 'claude' | 'codex') =>
    send<{ synced: string[]; skipped: string[] }>(
      'POST',
      '/api/skills/sync',
      { cli },
    ),
  /** Manual sidebar ordering — full map of `parentPath → child basenames`. */
  getFileOrder: () => getJson<Record<string, string[]>>('/api/file-order'),
  /** Update one folder's ordered list. `parentPath` `""` = space root. */
  putFileOrder: (parentPath: string, names: string[]) =>
    send<Record<string, never>>('PUT', '/api/file-order', { parentPath, names }),

  // Files / folders listing --------------------------------------
  listFiles: () => getJson<FilesPayload>('/api/files'),

  // CRUD ---------------------------------------------------------
  createNote: (content: string, dir: string, format: FileFormat = 'md') =>
    send<{ name: string }>('POST', '/api/files', { content, dir, format }),
  createFolder: (path: string) =>
    send<{ path: string }>('POST', '/api/folders', { path }),
  deleteFile: (name: string) =>
    send<Record<string, never>>('DELETE', '/api/files/' + encodePath(name)),
  /** Ask the server to reveal the file in the host OS file manager
   *  (Finder / Explorer / xdg-open on the file's directory). */
  revealFile: (name: string) =>
    send<Record<string, never>>('POST', '/api/reveal/' + encodePath(name)),
  deleteFolder: (path: string) =>
    send<Record<string, never>>('DELETE', '/api/folders/' + encodePath(path)),
  renameFile: (name: string, newName: string, opts: { cascade?: boolean } = {}) =>
    send<{ name: string; linksUpdated?: number }>(
      'PATCH',
      '/api/files/' + encodePath(name),
      { new_name: newName, cascade: opts.cascade ?? true },
    ),
  renameFolder: (path: string, newName: string, opts: { cascade?: boolean } = {}) =>
    send<{ path: string }>(
      'PATCH',
      '/api/folders/' + encodePath(path),
      { new_name: newName, cascade: opts.cascade ?? true },
    ),
  /** Dry-run cross-reference count for an intended rename — powers
   *  the confirmation dialog. Returns `{ files, links }`; both 0 means
   *  the rename is safe to commit without prompting. */
  renamePreview: (kind: 'file' | 'folder', oldPath: string, newPath: string) =>
    send<{ files: number; links: number }>('POST', '/api/rename-preview', {
      kind,
      old: oldPath,
      new: newPath,
    }),

  // File body ----------------------------------------------------
  getFile: (name: string) => getJson<FileBody>('/api/files/' + encodePath(name)),
  putFile: (name: string, content: string) =>
    send<Record<string, never>>('PUT', '/api/files/' + encodePath(name), { content }),

  // Upload (FormData) -------------------------------------------
  upload: async (
    items: { file: File; relPath: string }[],
    dir = '',
  ): Promise<UploadResult> => {
    const fd = new FormData();
    for (const it of items) {
      fd.append('files', it.file);
      fd.append('paths', it.relPath);
    }
    if (dir) fd.append('dir', dir);
    const r = await fetch('/api/upload', { method: 'POST', body: fd, headers: requestHeaders() });
    return parseJsonOrThrow<UploadResult>(r);
  },

  // Sync / search / status --------------------------------------
  sync: () => send<SyncResult>('POST', '/api/sync'),
  search: (query: string, top_k = 8) =>
    send<{ hits: SearchHit[] }>('POST', '/api/search', { query, top_k }),
  keywordSearch: (query: string, opts?: { caseStrict?: boolean; wholeWord?: boolean; space?: string }) => {
    const qs = new URLSearchParams({ q: query });
    if (opts?.caseStrict) qs.set('case_strict', '1');
    if (opts?.wholeWord) qs.set('whole_word', '1');
    // Pass the active window's space explicitly so multi-window
    // sessions don't fall back to the server's single `currentSpace`
    // singleton and search the wrong space's tree.
    if (opts?.space) qs.set('space', opts.space);
    return getJson<KeywordSearchResult>(`/api/keyword-search?${qs.toString()}`);
  },
  indexStatus: () => getJson<IndexStatus>('/api/index-status'),
  dismissSnapshotWarning: () =>
    send<{ ok: boolean }>('POST', '/api/snapshot-warning/dismiss'),

  /** Full per-file PDF conversion status, KB-wide, keyed by KB-relative
   *  path. PdfPreview calls this when the active file is a PDF to
   *  decide whether to render the failure banner. */
  pdfStatus: () =>
    getJson<{ entries: Record<string, PdfStatusEntry> }>('/api/pdf/status'),
  /** Retry conversion of a specific PDF (space-relative path). Clears
   *  the existing status record, removes the stale derived note + bundle
   *  if present, then re-fires the converter in the background. Client
   *  observes the outcome via the next `/api/index-status` or
   *  `/api/pdf/status` poll. */
  retryPdf: (path: string) =>
    send<{ ok: boolean }>('POST', '/api/pdf/retry', { path }),

  // Embedder ----------------------------------------------------
  getEmbedder: () => getJson<EmbedderState>('/api/embedder'),
  setEmbedder: (provider: EmbedderProvider, openaiKey?: string) =>
    send<EmbedderState>('PUT', '/api/embedder', { provider, openaiKey }),
  /** Validate without saving. Used before storing a fresh OpenAI key
   *  so a bad key never lands in `~/.stashbase/config.json`. Throws
   *  `ApiError` on invalid; resolves on valid. */
  validateEmbedder: (provider: EmbedderProvider, openaiKey?: string) =>
    send<Record<string, never>>('POST', '/api/embedder/validate', { provider, openaiKey }),
  embedderCostEstimate: (provider: EmbedderProvider) =>
    getJson<EmbedderCostEstimate>('/api/embedder/cost-estimate?provider=' + encodeURIComponent(provider)),

  // Terminal CLIs ----------------------------------------------
  listClis: () => getJson<TerminalClisResponse>('/api/terminal/clis'),
  setCli: (id: string) =>
    send<{ current: string }>('PUT', '/api/terminal/cli', { id }),
  checkCli: (id: string) =>
    getJson<{ installed: boolean }>('/api/terminal/check/' + encodeURIComponent(id)),
  mcpStatus: () =>
    getJson<{ clients: Record<string, boolean> }>('/api/mcp/status'),
  listMcpTools: () =>
    getJson<{ tools: { server: string; name: string; fqName: string; description?: string; inputSchema: unknown }[] }>('/api/mcp/tools'),
  callMcpTool: (name: string, args: Record<string, unknown> = {}) =>
    send<{ result: unknown }>('POST', '/api/mcp/tools/call', { name, arguments: args }),
  configureMcp: (client: string) =>
    send<{
      ok: boolean;
      client?: string;
      file?: string;
      command?: string;
      manual?: unknown;
      mode?: 'file' | 'clipboard';
      error?: string;
    }>('POST', '/api/mcp/configure', { client }),
  disconnectMcp: (client: string) =>
    send<{
      ok: boolean;
      client?: string;
      file?: string;
      mode?: 'file' | 'clipboard';
      error?: string;
    }>('POST', '/api/mcp/disconnect', { client }),
  /** Rotate the global OpenAI key without touching the provider choice. */
  changeApiKey: (openaiKey: string) =>
    send<{ hasKey: true }>('PUT', '/api/embedder/key', { openaiKey }),
  /** Clear the global OpenAI key. If the library is on OpenAI, embed /
   *  search will fail until a key is added back or the provider is
   *  switched to Local. */
  removeApiKey: () =>
    send<{ hasKey: false }>('DELETE', '/api/embedder/key'),
};

/** Asset URL for HTML files (used by the preview iframe so relative
 *  references inside the page — `<img src="X_files/figure.png">` —
 *  resolve correctly). Caller passes a space-relative path.
 *
 *  The `?windowId=` query param mirrors the `x-stashbase-window-id`
 *  header that fetch-based calls carry — the browser can't add a
 *  custom header to `<img src>` or iframe loads, so the server's
 *  `withWindowContext` middleware also honours this query param.
 *  Without it, images would resolve against the process-wide default
 *  space in a multi-window session. */
export function assetUrl(name: string): string {
  return '/asset/' + encodePath(name) + '?windowId=' + encodeURIComponent(getWindowId());
}

/** Base URL for live HTML edit previews. The preview itself is a blob,
 *  but relative image/css/font URLs should still resolve next to the
 *  saved file in the current space.
 *
 *  KNOWN multi-window limitation: a `?windowId=` query on the `<base
 *  href>` does NOT propagate to relative `<img src="…">` URLs (per
 *  the URL spec, only the path of a base href is inherited), so we
 *  don't add one here. In multi-window sessions, images inside a
 *  markdown preview resolve against the process-wide default space.
 *  Fix requires either encoding windowId in the URL path or rewriting
 *  each relative URL during preview compilation. */
export function assetBaseUrl(name: string): string {
  const parts = name.split('/');
  parts.pop();
  const dir = parts.join('/');
  return '/asset/' + (dir ? encodePath(dir) + '/' : '');
}
