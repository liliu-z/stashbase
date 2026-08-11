/**
 * Typed endpoint facade for the renderer's local `/api/*` surface.
 * Protocol contracts live in `apiTypes.ts`; request/error behavior lives in
 * `apiTransport.ts`. Existing callers keep one stable import path.
 */
import type {
  AgentContextFile,
  AgentsResponse,
  AppearancePreferences,
  ApiKeySaveResult,
  EmbedderState,
  EmbedderProvider,
  HostedAccountState,
  HostedOAuthProvider,
  HostedOAuthStart,
  HostedOAuthStatus,
  FileBody,
  FilesPayload,
  FolderState,
  IndexStatus,
  KeywordSearchResult,
  LibraryKeywordSearchResult,
  McpHttpStatus,
  PdfStatusEntry,
  SearchHit,
  SessionBlock,
  SessionReplay,
  SessionInfo,
  SyncResult,
  TranscriptionModelId,
  TranscriptionModelState,
  TranscriptionSettings,
  AudioTranscriptState,
  AudioPreviewStatus,
  UploadResult,
  OnboardingPreferences,
} from './apiTypes';
import {
  ApiError,
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
  /** Star / unstar a library folder. Metadata only — never touches the
   *  folder on disk. */
  setFolderFavorite: (path: string, favorite: boolean) =>
    send<Record<string, never>>('POST', '/api/folders/favorite', { path, favorite }),
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
  // `folder` (optional) lists an explicit library-member folder instead of
  // the window's current one — used by cross-folder chat tabs for mention
  // and attachment scoping.
  listFiles: (folder?: string) => getJson<FilesPayload>(
    folder ? `/api/files?folder=${encodeURIComponent(folder)}` : '/api/files',
  ),
  // `folder` (optional, also on getFile below) reads from an explicit member
  // folder — out-of-folder tabs view files without switching the window.
  statFile: (name: string, opts?: { folder?: string }) =>
    head('/api/files/' + encodePath(name) + folderQuery(opts?.folder)),

  getOnboarding: () => getJson<OnboardingPreferences>('/api/onboarding'),
  putOnboarding: (patch: Partial<OnboardingPreferences>) =>
    send<OnboardingPreferences>('PUT', '/api/onboarding', patch),

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
  getFile: (name: string, opts?: { folder?: string }) =>
    getJson<FileBody>('/api/files/' + encodePath(name) + folderQuery(opts?.folder)),
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
  search: (query: string, top_k = 8, opts?: { folder?: string; pathPrefix?: string }) =>
    send<{ hits: SearchHit[] }>('POST', '/api/search', {
      query,
      top_k,
      folder: opts?.folder,
      path_prefix: opts?.pathPrefix,
    }),
  keywordSearch: (query: string, opts?: { caseStrict?: boolean; wholeWord?: boolean; folder?: string; pathPrefix?: string }) => {
    const qs = new URLSearchParams({ q: query });
    if (opts?.caseStrict) qs.set('case_strict', '1');
    if (opts?.wholeWord) qs.set('whole_word', '1');
    // Pass the active window's folder explicitly so multi-window
    // sessions don't fall back to the server's single `currentFolder`
    // singleton and search the wrong folder's tree.
    if (opts?.folder) qs.set('folder', opts.folder);
    if (opts?.pathPrefix) qs.set('path_prefix', opts.pathPrefix);
    return getJson<KeywordSearchResult>(`/api/keyword-search?${qs.toString()}`);
  },
  // Library-wide search (the in-app search popup). Both routes live outside
  // the per-window folder gate, so they answer even before a folder is open.
  // `fileName`s come back as absolute paths; `folder`/`path_prefix` narrow
  // to one member folder (`path_prefix` is that folder's absolute subpath).
  librarySearch: (query: string, top_k = 8, opts?: { folder?: string; pathPrefix?: string }) =>
    send<{ hits: SearchHit[] }>('POST', '/api/library/search', {
      query,
      top_k,
      ...(opts?.folder ? { folder: opts.folder } : {}),
      ...(opts?.pathPrefix ? { path_prefix: opts.pathPrefix } : {}),
    }),
  libraryKeywordSearch: (query: string, opts?: { caseStrict?: boolean; wholeWord?: boolean; folder?: string; pathPrefix?: string }) =>
    send<LibraryKeywordSearchResult>('POST', '/api/library/keyword-search', {
      query,
      case_strict: opts?.caseStrict === true,
      whole_word: opts?.wholeWord === true,
      ...(opts?.folder ? { folder: opts.folder } : {}),
      ...(opts?.pathPrefix ? { path_prefix: opts.pathPrefix } : {}),
    }),
  indexStatus: (folder?: string) =>
    getJson<IndexStatus>(folder ? `/api/index-status?folder=${encodeURIComponent(folder)}` : '/api/index-status'),
  dismissIndexWarning: (folder?: string) =>
    send<{ ok: boolean }>('POST', '/api/index-warning/dismiss', { folder }),
  semanticIndexingDecision: (decision: 'start' | 'defer', folder?: string) =>
    send<{ ok: boolean }>('POST', '/api/semantic-indexing/decision', { decision, folder }),

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
  prepareAudioPreview: async (path: string, opts: { signal?: AbortSignal; folder?: string } = {}) => {
    const r = await fetch('/api/audio/preview/prepare', {
      method: 'POST',
      headers: { ...requestHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ path, ...(opts.folder ? { folder: opts.folder } : {}) }),
      signal: opts.signal,
    });
    return parseJsonOrThrow<{ ok: boolean }>(r);
  },
  audioPreviewStatus: (path: string, opts?: { folder?: string }) =>
    getJson<AudioPreviewStatus>(`/api/audio/preview/status?path=${encodeURIComponent(path)}${opts?.folder ? `&folder=${encodeURIComponent(opts.folder)}` : ''}`),
  audioTranscript: (path: string, opts?: { folder?: string }) =>
    getJson<AudioTranscriptState>(`/api/audio/transcript?path=${encodeURIComponent(path)}${opts?.folder ? `&folder=${encodeURIComponent(opts.folder)}` : ''}`),
  transcriptionSettings: () =>
    getJson<TranscriptionSettings>('/api/transcription/settings'),
  appearance: () => getJson<AppearancePreferences>('/api/appearance'),
  setAppearance: (preferences: Partial<AppearancePreferences>) =>
    send<AppearancePreferences>('PUT', '/api/appearance', preferences),
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
  useApiKeySource: (provider: EmbedderProvider) =>
    send<EmbedderState>('PUT', '/api/embedder/source', { provider }),
  getAccount: (refresh = false) => getJson<HostedAccountState>(`/api/account${refresh ? '?refresh=1' : ''}`),
  startAccountOAuth: (provider: HostedOAuthProvider = 'google') =>
    send<HostedOAuthStart>('POST', '/api/account/oauth/start', { provider }),
  getAccountOAuthStatus: (flowId: string) =>
    getJson<HostedOAuthStatus>(`/api/account/oauth/status?flow=${encodeURIComponent(flowId)}`),
  useAccountAllowance: () => send<HostedAccountState>('PUT', '/api/account/source'),
  signOutAccount: () => send<HostedAccountState>('DELETE', '/api/account'),

  // Agents (chat-panel CLIs) -----------------------------------
  // Server routes stay under `/api/terminal/*` for historical reasons;
  // the renderer just calls them "agents". `listAgents` populates the
  // launcher registry / installed-state.
  listAgents: () => getJson<AgentsResponse>('/api/terminal/clis'),
  bootstrapAgent: (agent: 'claude' | 'codex') =>
    send<AgentsResponse>('POST', `/api/terminal/clis/${encodeURIComponent(agent)}/bootstrap`),
  setAgentRuntimeDebug: (patch: Partial<{
    discoveryPolicy: 'auto' | 'managed-only' | 'system-only';
    nextFailure: 'none' | 'installation' | 'mcp';
  }>) => send<AgentsResponse>('PUT', '/api/terminal/debug', patch),
  resetManagedAgent: (agent: 'claude' | 'codex') =>
    send<AgentsResponse>('DELETE', `/api/terminal/clis/${encodeURIComponent(agent)}/managed`),
  mcpStatus: () =>
    getJson<{
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
  /** Set or rotate the active embedding provider key. */
  changeApiKey: (key: string, provider?: EmbedderProvider) =>
    send<ApiKeySaveResult>('PUT', '/api/embedder/key', { key, provider }),
  /** Clear the active embedding key. Embedding and semantic retrieval stay
   *  disabled until a key is added back; keyword search is unaffected. */
  removeApiKey: () =>
    send<{ hasKey: false; provider: EmbedderProvider; model: string }>('DELETE', '/api/embedder/key'),

  // Agent sessions (chat-panel History dropdown) ----------------
  /** Local agent sessions for the given scope (a library folder, or the
   *  reserved library scope; defaults to the window's current folder),
   *  newest first. */
  listSessions: (agent: 'claude' | 'codex' = 'claude', scope?: SessionScopeParams) =>
    getJson<SessionInfo[]>(agentSessionBase(agent) + sessionScopeQuery(scope)),
  /** A session's transcript as renderable blocks (for resume replay). */
  getSessionMessages: (id: string, agent: 'claude' | 'codex' = 'claude', scope?: SessionScopeParams) =>
    getJson<SessionBlock[]>(agentSessionBase(agent) + '/' + encodeURIComponent(id) + '/messages' + sessionScopeQuery(scope)),
  /** Prefer protocol-v2 metadata, but tolerate a protocol-v1 server retained
   * across an application restart/update. */
  getSessionReplay: async (id: string, agent: 'claude' | 'codex' = 'claude', scope?: SessionScopeParams): Promise<SessionReplay> => {
    const base = agentSessionBase(agent) + '/' + encodeURIComponent(id);
    const query = sessionScopeQuery(scope);
    try {
      const replay = await getJson<SessionReplay>(base + '/replay' + query);
      if (replay?.protocol === 2 && Array.isArray(replay.messages)) return replay;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
      // Protocol-v1 server: fall through to the stable endpoint.
    }
    return { protocol: 2, messages: await getJson<SessionBlock[]>(base + '/messages' + query), effort: null };
  },
  renameSession: (id: string, title: string, agent: 'claude' | 'codex' = 'claude', scope?: SessionScopeParams) =>
    send<SessionInfo>('PATCH', agentSessionBase(agent) + '/' + encodeURIComponent(id) + sessionScopeQuery(scope), { title }),
  deleteSession: (id: string, agent: 'claude' | 'codex' = 'claude', scope?: SessionScopeParams) =>
    send<Record<string, never>>('DELETE', agentSessionBase(agent) + '/' + encodeURIComponent(id) + sessionScopeQuery(scope)),
  getExternalFileText: (grantId: string): Promise<{ content: string }> =>
    getJson<{ content: string }>(`/api/grant/${encodeURIComponent(grantId)}/text`),
};

function agentSessionBase(agent: 'claude' | 'codex'): string {
  return `/api/agents/${encodeURIComponent(agent)}/sessions`;
}

/** Explicit session scope for history routes: a library folder, or the
 *  library-wide scope. Absent → the server falls back to the window's
 *  current folder (else the library). */
export interface SessionScopeParams {
  folder?: string;
  /** `all` is a LIST-only mode: every member folder plus the library
   *  bucket, rows tagged with their member `folder`. */
  scope?: 'library' | 'all';
}

function sessionScopeQuery(params?: SessionScopeParams): string {
  if (params?.folder) return `?folder=${encodeURIComponent(params.folder)}`;
  if (params?.scope) return `?scope=${encodeURIComponent(params.scope)}`;
  return '';
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
export function assetUrl(name: string, folder?: string): string {
  return assetScopePrefix('/asset/', folder) + encodePath(name);
}

export function versionedAssetUrl(name: string, version: string, folder?: string, grantId?: string): string {
  if (grantId) {
    return `/asset-preview-grant/${encodeURIComponent(grantId)}?v=${encodeURIComponent(version)}`;
  }
  const url = assetUrl(name, folder);
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${encodeURIComponent(version)}`;
}

export function derivedAssetUrl(name: string, folder?: string): string {
  return assetScopePrefix('/asset-derived/', folder) + encodePath(name);
}

export function audioPreviewAssetUrl(name: string, version = '', folder?: string): string {
  const url = assetScopePrefix('/asset-audio-preview/', folder) + encodePath(name);
  return version ? `${url}?v=${encodeURIComponent(version)}` : url;
}

export function versionedDerivedAssetUrl(name: string, version: string, folder?: string): string {
  const url = derivedAssetUrl(name, folder);
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
export function assetBaseUrl(name: string, folder?: string): string {
  const parts = name.split('/');
  parts.pop();
  const dir = parts.join('/');
  return assetScopePrefix('/asset/', folder) + (dir ? encodePath(dir) + '/' : '');
}

/** `?folder=` suffix for the explicit-member-folder read variants of the
 *  JSON file routes. */
function folderQuery(folder?: string): string {
  return folder ? `?folder=${encodeURIComponent(folder)}` : '';
}

function assetWindowPrefix(base = '/asset/'): string {
  return base + '__window/' + encodeURIComponent(getWindowId()) + '/';
}

/** `folder` (absolute member root) rides the PATH as a second reserved
 *  token, for the same reason the window id does — `<base href>` and
 *  relative sub-asset URLs only inherit path segments. Double-encoded so
 *  the server's single route-level decode leaves the segment slash-free. */
function assetScopePrefix(base: string, folder?: string): string {
  const prefix = assetWindowPrefix(base);
  if (!folder) return prefix;
  return prefix + '__folder/' + encodeURIComponent(encodeURIComponent(folder)) + '/';
}
