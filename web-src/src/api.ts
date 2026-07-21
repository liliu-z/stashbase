/**
 * Typed endpoint facade for the renderer's local `/api/*` surface.
 * Protocol contracts live in `apiTypes.ts`; request/error behavior lives in
 * `apiTransport.ts`. Existing callers keep one stable import path.
 */
import type {
  AgentContextFile,
  AgentsResponse,
  ApiKeySaveResult,
  EmbedderState,
  FileBody,
  FilesPayload,
  FolderState,
  IndexStatus,
  KeywordSearchResult,
  McpHttpStatus,
  PdfStatusEntry,
  SearchHit,
  SessionBlock,
  SessionInfo,
  SyncResult,
  TranscriptionModelId,
  TranscriptionModelState,
  TranscriptionSettings,
  AudioTranscriptState,
  AudioPreviewStatus,
  UploadResult,
} from './apiTypes';
import type { SearchTypeCategory } from '../../shared/search-types.ts';
import {
  encodePath,
  getWindowId,
  getJson,
  head,
  parseJsonOrThrow,
  requestHeaders,
  send,
  sendWithNetworkRetry,
} from './apiTransport';

export * from './apiTypes';
export { ApiError, encodePath, errorMessage, getWindowId } from './apiTransport';

export const api = {
  // Folder ---------------------------------------------------------
  getFolder: () => getJson<FolderState>('/api/folder'),
  openFolder: (path: string) => sendWithNetworkRetry<FolderState>('POST', '/api/folder', { path }),
  /** Open a direct child of the default StashBase home by name. Kept for
   *  switch / rename flows that operate on known default-home folders. */
  openFolderByName: (name: string, opts?: { create?: boolean; exclusiveCreate?: boolean }) =>
    send<FolderState>('POST', '/api/folder', {
      name,
      create: opts?.create,
      exclusiveCreate: opts?.exclusiveCreate,
    }),
  closeFolder: () => send<{ ok: boolean }>('DELETE', '/api/folder'),
  /** Absolute path of the default folder home. New Folder opens the native
   *  picker here, but users can still open any folder on disk. */
  getFolderHome: () => getJson<{ path: string }>('/api/folder-home'),
  /** Remove a folder from the library ("Your Folders"): forgets it
   *  (unbind + clear index + drop from membership) WITHOUT touching the
   *  folder on disk. */
  removeFolder: (path: string) =>
    send<Record<string, never>>('POST', '/api/folders/remove', { path }),
  /** Manual sidebar ordering — full map of `parentPath → child basenames`. */
  getFileOrder: () => getJson<Record<string, string[]>>('/api/file-order'),
  /** Update one folder's ordered list. `parentPath` `""` = folder root. */
  putFileOrder: (parentPath: string, names: string[]) =>
    send<Record<string, never>>('PUT', '/api/file-order', { parentPath, names }),

  // Files / folders listing --------------------------------------
  listFiles: () => getJson<FilesPayload>('/api/files'),
  statFile: (name: string) => head('/api/files/' + encodePath(name)),

  // CRUD ---------------------------------------------------------
  createNote: (content: string, dir: string) =>
    send<{ name: string; content: string; version?: string; indexWarning?: string }>('POST', '/api/files', { content, dir }),
  createFolder: (path: string) =>
    send<{ path: string }>('POST', '/api/folders', { path }),
  deleteFile: (name: string) =>
    send<{ alreadyGone?: boolean }>('DELETE', '/api/files/' + encodePath(name)),
  /** Ask the server to reveal the file in the host OS file manager
   *  (Finder / Explorer / xdg-open on the file's directory). */
  revealFile: (name: string) =>
    send<Record<string, never>>('POST', '/api/reveal/' + encodePath(name)),
  deleteFolder: (path: string) =>
    send<{ alreadyGone?: boolean }>('DELETE', '/api/folders/' + encodePath(path)),
  renameFile: (name: string, newName: string, opts: { cascade?: boolean; asyncIndex?: boolean } = {}) =>
    send<{ name: string; linksUpdated?: number; indexDeferred?: boolean; indexWarning?: string }>(
      'PATCH',
      '/api/files/' + encodePath(name),
      { new_name: newName, cascade: opts.cascade ?? true, async_index: opts.asyncIndex === true },
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
  putFile: (name: string, content: string, baseVersion?: string) =>
    send<{ content: string; indexWarning?: string; version?: string }>(
      'PUT',
      '/api/files/' + encodePath(name),
      { content, ...(baseVersion !== undefined ? { baseVersion } : {}) },
    ),

  // Upload (FormData) -------------------------------------------
  upload: async (
    items: { file: File; relPath: string }[],
    dir = '',
    folder?: string,
  ): Promise<UploadResult> => {
    const fd = new FormData();
    for (const it of items) {
      fd.append('files', it.file);
      fd.append('paths', it.relPath);
    }
    if (dir) fd.append('dir', dir);
    if (folder) fd.append('folder', folder);
    const r = await fetch('/api/upload', { method: 'POST', body: fd, headers: requestHeaders() });
    return parseJsonOrThrow<UploadResult>(r);
  },

  /** Attach files as transient chat context — written to a throwaway OS
   *  temp dir (NOT the folder) and returned as absolute paths the agent
   *  reads. Used by the composer `+` and panel drag-drop. */
  attachFiles: async (
    files: File[],
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ files: { name: string; path?: string; error?: string }[] }> => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    const r = await fetch('/api/agent/attach', { method: 'POST', body: fd, headers: requestHeaders(), signal: opts.signal });
    return parseJsonOrThrow(r);
  },
  agentContextFile: (folder: string, path: string) =>
    getJson<AgentContextFile>(
      '/api/library/agent-context-file?path=' + encodeURIComponent(`${folder}/${path}`),
    ),

  // Sync / search / status --------------------------------------
  sync: (folder?: string) => send<SyncResult>(
    'POST',
    folder ? `/api/sync?folder=${encodeURIComponent(folder)}` : '/api/sync',
  ),
  search: (query: string, top_k = 8, opts?: { folder?: string; pathPrefix?: string; types?: readonly SearchTypeCategory[] }) =>
    send<{ hits: SearchHit[] }>('POST', '/api/search', {
      query,
      top_k,
      folder: opts?.folder,
      path_prefix: opts?.pathPrefix,
      types: opts?.types?.length ? opts.types : undefined,
    }),
  keywordSearch: (query: string, opts?: { caseStrict?: boolean; wholeWord?: boolean; folder?: string; pathPrefix?: string; types?: readonly SearchTypeCategory[] }) => {
    const qs = new URLSearchParams({ q: query });
    if (opts?.caseStrict) qs.set('case_strict', '1');
    if (opts?.wholeWord) qs.set('whole_word', '1');
    // Pass the active window's folder explicitly so multi-window
    // sessions don't fall back to the server's single `currentFolder`
    // singleton and search the wrong folder's tree.
    if (opts?.folder) qs.set('folder', opts.folder);
    if (opts?.pathPrefix) qs.set('path_prefix', opts.pathPrefix);
    if (opts?.types?.length) qs.set('types', opts.types.join(','));
    return getJson<KeywordSearchResult>(`/api/keyword-search?${qs.toString()}`);
  },
  indexStatus: (folder?: string) =>
    getJson<IndexStatus>(folder ? `/api/index-status?folder=${encodeURIComponent(folder)}` : '/api/index-status'),
  dismissIndexWarning: (folder?: string) =>
    send<{ ok: boolean }>('POST', '/api/index-warning/dismiss', { folder }),

  /** Full per-file preparation status, library-wide, keyed by absolute
   *  source path. */
  pdfStatus: () =>
    getJson<{ entries: Record<string, PdfStatusEntry> }>('/api/pdf/status'),
  /** Reprocess a specific source file (folder-relative path). PDF/image
   *  sources re-run extraction; directly readable files clear the
   *  failure row and trigger reconcile/index. */
  reprocessFile: (path: string, opts?: { folder?: string; language?: string }) =>
    send<{ ok: boolean; mode?: 'conversion' | 'index' }>('POST', '/api/files/reprocess', {
      path,
      folder: opts?.folder,
      language: opts?.language,
    }),
  cancelFilePreparation: (path: string, opts?: { folder?: string }) =>
    send<{ ok: boolean; cancelled: boolean }>('POST', '/api/files/cancel-preparation', {
      path,
      folder: opts?.folder,
    }),
  /** Prepare an opened DOCX's searchable/Agent-readable text at interactive
   *  scheduler priority. Visible preview does not wait for this request. */
  prepareDocx: (path: string, opts?: { folder?: string }) =>
    send<{ ok: boolean }>('POST', '/api/files/prepare', { path, folder: opts?.folder }),
  prepareAudio: (path: string, opts?: { folder?: string }) =>
    send<{ ok: boolean }>('POST', '/api/files/prepare', { path, folder: opts?.folder }),
  prepareAudioPreview: async (path: string, opts: { signal?: AbortSignal } = {}) => {
    const r = await fetch('/api/audio/preview/prepare', {
      method: 'POST',
      headers: { ...requestHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
      signal: opts.signal,
    });
    return parseJsonOrThrow<{ ok: boolean }>(r);
  },
  audioPreviewStatus: (path: string) =>
    getJson<AudioPreviewStatus>(`/api/audio/preview/status?path=${encodeURIComponent(path)}`),
  audioTranscript: (path: string) =>
    getJson<AudioTranscriptState>(`/api/audio/transcript?path=${encodeURIComponent(path)}`),
  transcriptionSettings: () =>
    getJson<TranscriptionSettings>('/api/transcription/settings'),
  setTranscriptionPreferences: (preferences: { providerId?: string; modelId?: string; language?: string }) =>
    send<{ providerId: string; modelId: string; language: string }>('PUT', '/api/transcription/preferences', preferences),
  downloadTranscriptionModel: (id: TranscriptionModelId) =>
    send<{ id: TranscriptionModelId; download: NonNullable<TranscriptionModelState['operation']> }>(
      'POST',
      `/api/transcription/models/${encodeURIComponent(id)}/download`,
    ),
  removeTranscriptionModel: (id: TranscriptionModelId) =>
    send<{ ok: true }>('DELETE', `/api/transcription/models/${encodeURIComponent(id)}`),
  // Embedder ----------------------------------------------------
  getEmbedder: () => getJson<EmbedderState>('/api/embedder'),

  // Agents (chat-panel CLIs) -----------------------------------
  // Server routes stay under `/api/terminal/*` for historical reasons;
  // the renderer just calls them "agents". `listAgents` populates the
  // launcher registry / installed-state.
  listAgents: () => getJson<AgentsResponse>('/api/terminal/clis'),
  mcpStatus: () =>
    getJson<{
      clients: Record<string, boolean | { configured?: boolean; cliInstalled?: boolean; restartRequired?: boolean }>;
      command: string;
      config: unknown;
      http: McpHttpStatus;
    }>('/api/mcp/status'),
  rotateMcpHttpToken: () =>
    send<{ ok: true; http: McpHttpStatus }>('POST', '/api/mcp/http/token'),
  setMcpDockerAccess: (enabled: boolean) =>
    send<{ ok: true; http: McpHttpStatus }>('PUT', '/api/mcp/http/docker-access', { enabled }),
  setMcpDockerPort: (port: number) =>
    send<{ ok: true; http: McpHttpStatus }>('PUT', '/api/mcp/http/docker-port', { port }),
  // `send` throws ApiError on any non-2xx, so a resolved value is always
  // the success shape — no `error` field, `ok` is always true.
  configureMcp: (client: string) =>
    send<{
      ok: true;
      client?: string;
      file?: string;
      command?: string;
      manual?: unknown;
      mode?: 'file' | 'clipboard';
    }>('POST', '/api/mcp/configure', { client }),
  disconnectMcp: (client: string) =>
    send<{
      ok: true;
      client?: string;
      file?: string;
      mode?: 'file' | 'clipboard';
    }>('POST', '/api/mcp/disconnect', { client }),
  /** Rotate the global OpenAI key without touching the provider choice. */
  changeApiKey: (openaiKey: string) =>
    send<ApiKeySaveResult>('PUT', '/api/embedder/key', { openaiKey }),
  /** Clear the global OpenAI key. Embedding and semantic search stay
   *  disabled until a key is added back; keyword search is unaffected. */
  removeApiKey: () =>
    send<{ hasKey: false }>('DELETE', '/api/embedder/key'),

  // Agent sessions (chat-panel History dropdown) ----------------
  /** All local agent sessions for the current folder, newest first. */
  listSessions: (agent: 'claude' | 'codex' = 'claude') =>
    getJson<SessionInfo[]>(agentSessionBase(agent)),
  /** A session's transcript as renderable blocks (for resume replay). */
  getSessionMessages: (id: string, agent: 'claude' | 'codex' = 'claude') =>
    getJson<SessionBlock[]>(agentSessionBase(agent) + '/' + encodeURIComponent(id) + '/messages'),
  renameSession: (id: string, title: string, agent: 'claude' | 'codex' = 'claude') =>
    send<SessionInfo>('PATCH', agentSessionBase(agent) + '/' + encodeURIComponent(id), { title }),
  deleteSession: (id: string, agent: 'claude' | 'codex' = 'claude') =>
    send<Record<string, never>>('DELETE', agentSessionBase(agent) + '/' + encodeURIComponent(id)),
};

function agentSessionBase(agent: 'claude' | 'codex'): string {
  return `/api/agents/${encodeURIComponent(agent)}/sessions`;
}

/** Asset URL for HTML files (used by the preview iframe so relative
 *  references inside the page — `<img src="X_files/figure.png">` —
 *  resolve correctly). Caller passes a folder-relative path.
 *
 *  The reserved `__window/<id>/` path prefix mirrors the
 *  `x-stashbase-window-id` header that fetch-based calls carry — the
 *  browser can't add a custom header to `<img src>` or iframe loads.
 *  Without it, images would resolve against the default window's folder
 *  in a multi-window session. */
export function assetUrl(name: string): string {
  return assetWindowPrefix() + encodePath(name);
}

export function versionedAssetUrl(name: string, version: string): string {
  const url = assetUrl(name);
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${encodeURIComponent(version)}`;
}

export function derivedAssetUrl(name: string): string {
  return assetWindowPrefix('/asset-derived/') + encodePath(name);
}

export function audioPreviewAssetUrl(name: string, version = ''): string {
  const url = assetWindowPrefix('/asset-audio-preview/') + encodePath(name);
  return version ? `${url}?v=${encodeURIComponent(version)}` : url;
}

export function versionedDerivedAssetUrl(name: string, version: string): string {
  const url = derivedAssetUrl(name);
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${encodeURIComponent(version)}`;
}

/** Base URL for live HTML edit previews. The preview itself is a blob,
 *  but relative image/css/font URLs should still resolve next to the
 *  saved file in the current folder.
 *
 *  The window id lives in the path instead of a query string because
 *  `<base href="?windowId=…">` does not propagate that query to relative
 *  `<img>`, CSS, or font URLs. The server strips the reserved prefix
 *  before resolving the actual folder-relative asset path. */
export function assetBaseUrl(name: string): string {
  const parts = name.split('/');
  parts.pop();
  const dir = parts.join('/');
  return assetWindowPrefix() + (dir ? encodePath(dir) + '/' : '');
}

function assetWindowPrefix(base = '/asset/'): string {
  return base + '__window/' + encodeURIComponent(getWindowId()) + '/';
}
