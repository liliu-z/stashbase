/**
 * Library MCP server factory shared by both transports.
 *
 * `mcp/server.ts` (stdio, spawned per client) and `server/routes/mcp-http.ts`
 * (Streamable HTTP on the app server) build their `Server` instances here, so
 * the tool definitions and handlers exist exactly once. Every handler forwards
 * over HTTP to the StashBase app server (`/api/library/*` endpoints, absolute
 * member paths) — the single execution path both transports share.
 *
 * This module must stay transport-free: no stdio-guard (the app server needs
 * its console), no Express, no process-level state. Callers pass the web base
 * URL and the optional window id instead of reading argv/env here.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { type LibraryInfo } from '../server/library-info.ts';

export interface LibraryMcpServerOptions {
  /** App server base URL, e.g. `http://127.0.0.1:8090`. */
  webBase: string;
  /** Optional window id forwarded as `x-stashbase-window-id`. */
  windowId?: string;
}

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 25;

export function createLibraryMcpServer(opts: LibraryMcpServerOptions): Server {
  const { webBase, windowId } = opts;

  function webHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...(extra ?? {}) };
    if (windowId) headers['x-stashbase-window-id'] = windowId;
    return headers;
  }

  /** Run a web call through the already-running StashBase desktop app. */
  async function viaWeb<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: unknown) {
      if (!(err instanceof TypeError)) throw err;
      throw new Error(
        `StashBase app is not reachable for ${label}. Open the StashBase desktop app and try again.`,
      );
    }
  }

  async function searchViaWeb(
    query: string,
    topK: number,
    folder: string | undefined,
    pathPrefix?: string,
  ): Promise<unknown[]> {
    const body: Record<string, unknown> = { query, top_k: topK };
    if (folder) body.folder = folder;
    if (pathPrefix) body.path_prefix = pathPrefix;
    const r = await fetch(`${webBase}/api/library/search`, {
      method: 'POST',
      headers: webHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`web /api/library/search failed: ${r.status}`);
    const j = await r.json() as { hits: unknown[] };
    return j.hits;
  }

  async function libraryInfoViaWeb(): Promise<LibraryInfo> {
    const r = await fetch(`${webBase}/api/library/info`);
    if (!r.ok) throw new Error(`web /api/library/info failed: ${r.status}`);
    return r.json() as Promise<LibraryInfo>;
  }

  async function reindexViaWeb(folder: string | undefined): Promise<unknown> {
    const body = folder ? { folder } : {};
    const r = await fetch(`${webBase}/api/library/reindex`, {
      method: 'POST',
      headers: webHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`web POST /api/library/reindex failed: ${r.status}`);
    return r.json();
  }

  async function webJson<T>(url: string, init?: RequestInit): Promise<T> {
    const r = await fetch(url, init);
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new Error(`web ${init?.method ?? 'GET'} ${url.replace(webBase, '')} failed: ${r.status}${detail ? ` ${detail.slice(0, 500)}` : ''}`);
    }
    return r.json() as Promise<T>;
  }

  function pathQuery(pathValue: unknown): string {
    const pathParam = typeof pathValue === 'string' ? pathValue : '';
    return `path=${encodeURIComponent(pathParam)}`;
  }

  async function listDirectoryViaWeb(pathValue: unknown): Promise<unknown> {
    return webJson(`${webBase}/api/library/directory?${pathQuery(pathValue)}`, { headers: webHeaders() });
  }

  async function readFileViaWeb(pathValue: unknown): Promise<unknown> {
    return webJson(`${webBase}/api/library/file?${pathQuery(pathValue)}`, { headers: webHeaders() });
  }

  async function writeFileViaWeb(args: Record<string, unknown>): Promise<unknown> {
    return webJson(`${webBase}/api/library/file`, {
      method: 'PUT',
      headers: webHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        path: args.path,
        content: args.content,
        ...(typeof args.baseVersion === 'string' ? { baseVersion: args.baseVersion } : {}),
      }),
    });
  }

  async function editFileViaWeb(args: Record<string, unknown>): Promise<unknown> {
    return webJson(`${webBase}/api/library/file/edit`, {
      method: 'POST',
      headers: webHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        path: args.path,
        old_text: args.old_text,
        new_text: args.new_text,
        replace_all: args.replace_all === true,
        ...(typeof args.baseVersion === 'string' ? { baseVersion: args.baseVersion } : {}),
      }),
    });
  }

  async function moveFileViaWeb(args: Record<string, unknown>): Promise<unknown> {
    return webJson(`${webBase}/api/library/file/move`, {
      method: 'PATCH',
      headers: webHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        path: args.path,
        new_path: args.new_path,
        cascade: args.cascade !== false,
      }),
    });
  }

  async function deleteFileViaWeb(pathValue: unknown): Promise<unknown> {
    return webJson(`${webBase}/api/library/file?${pathQuery(pathValue)}`, {
      method: 'DELETE',
      headers: webHeaders(),
    });
  }

  const server = new Server(
    { name: 'stashbase', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'StashBase exposes local files through host-side ' +
        'MCP tools. External agent shells may be sandboxed and unable to read the ' +
        'user\'s absolute filesystem paths, so DO NOT use shell/cat or generic ' +
        'filesystem tools for StashBase paths. Use `list_directory`, `read_file`, ' +
        '`write_file`, `edit_file`, `move_file`, and `delete_file` instead.\n\n' +
        'At the start of a session, call `library_info`. It returns `folder_home` (the default ' +
        'new-folder location) and `folders` — "Your Folders", each an ABSOLUTE path. ' +
        'Folders can live anywhere on disk, not just under folder_home.\n\n' +
        'All file tools take ABSOLUTE POSIX paths that live under one of those folders ' +
        '(e.g. `/Users/me/notes/topic/note.md`); `search_library` returns paths in the same ' +
        'form. When a returned path is a PDF, call `read_file` on that PDF path; StashBase ' +
        'returns extracted Markdown when conversion has completed. `write_file`, `edit_file`, `move_file`, and `delete_file` update the ' +
        'semantic index when an API key is configured. Call `reindex` after bulk ' +
        'external changes or whenever a tool returns an index warning.\n\n' +
        'When you CREATE a new generated note (e.g. a summary or report), add ' +
        '`generated_by: stashbase-agent` to its Markdown YAML front-matter (or an HTML ' +
        '`<meta name="generated_by" content="stashbase-agent">`) so the user can later ' +
        'bulk-identify agent-generated output. Never put credentials in files.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: BUILTIN_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const folder = typeof args.folder === 'string' && args.folder.trim() ? args.folder.trim() : undefined;

    if (req.params.name === 'library_info') {
      const info = await viaWeb('library_info', () => libraryInfoViaWeb());
      return {
        content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
      };
    }

    if (req.params.name === 'search_library') {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) throw new Error('`query` is required');
      const pathPrefix = typeof args.path_prefix === 'string' && args.path_prefix.trim()
        ? args.path_prefix.trim() : undefined;
      const k = Math.max(
        1,
        Math.min(MAX_TOP_K, Math.floor(typeof args.top_k === 'number' ? args.top_k : DEFAULT_TOP_K)),
      );
      const hits = annotateSearchHitsForMcp(await viaWeb('search', () => searchViaWeb(query, k, folder, pathPrefix)));
      return {
        content: [{ type: 'text', text: JSON.stringify({ query, folder: folder ?? null, path_prefix: pathPrefix ?? null, top_k: k, hits }, null, 2) }],
      };
    }

    if (req.params.name === 'list_directory') {
      const result = await viaWeb('list_directory', () => listDirectoryViaWeb(args.path));
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (req.params.name === 'read_file') {
      const result = await viaWeb('read_file', () => readFileViaWeb(args.path));
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (req.params.name === 'write_file') {
      const result = await viaWeb('write_file', () => writeFileViaWeb(args));
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (req.params.name === 'edit_file') {
      const result = await viaWeb('edit_file', () => editFileViaWeb(args));
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (req.params.name === 'move_file') {
      const result = await viaWeb('move_file', () => moveFileViaWeb(args));
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (req.params.name === 'delete_file') {
      const result = await viaWeb('delete_file', () => deleteFileViaWeb(args.path));
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (req.params.name === 'reindex') {
      const result = await viaWeb('reindex', () => reindexViaWeb(folder));
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    throw new Error(`unknown tool: ${req.params.name}`);
  });

  return server;
}

function annotateSearchHitsForMcp(hits: unknown[]): unknown[] {
  return hits.map((hit) => {
    if (!hit || typeof hit !== 'object' || Array.isArray(hit)) return hit;
    const obj = hit as Record<string, unknown>;
    const fileName = typeof obj.fileName === 'string' ? obj.fileName : '';
    if (!/\.pdf$/i.test(fileName)) return hit;
    return {
      ...obj,
      read_hint: 'Use read_file on this PDF path; StashBase returns extracted Markdown when conversion has completed.',
    };
  });
}

const BUILTIN_TOOLS = [
    {
      name: 'library_info',
      description:
        'Orient yourself in the StashBase library. **Call this first** in a ' +
        'new conversation. Returns `{folder_home, folders}` where `folder_home` is the ' +
        'default new-folder location and `folders` lists "Your ' +
        'Folders", each with an ABSOLUTE `path` (the identity the file tools and ' +
        'search_library use), a display `name`, and the embedder provider. Folders can ' +
        'live anywhere on disk. Use StashBase file tools for these paths; sandboxed ' +
        'shells may not be able to see those host files.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'list_directory',
      description:
        'List visible files and folders in the StashBase library. `path` is optional; omit ' +
        'or pass "" to list your folders, or pass an absolute folder/subfolder path to ' +
        'list its contents. Paths are absolute POSIX paths. Hidden ' +
        'app-maintained derived notes and bundle folders are not surfaced.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional absolute directory path under one of your folders.' },
        },
      },
    },
    {
      name: 'read_file',
      description:
        'Read a file from StashBase by absolute path ' +
        '(for example `/Users/me/notes/topic/note.md`). Markdown and HTML return source text. ' +
        'PDFs return extracted Markdown when conversion has completed. Images are visible in ' +
        '`list_directory` and searchable through OCR evidence, but are not returned as bytes.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path under one of your folders.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description:
        'Create or overwrite a Markdown/HTML text file. Creates parent folders as ' +
        'needed, writes atomically, and updates the semantic index when an API key is configured.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path under one of your folders.' },
          content: { type: 'string', description: 'Full file content to write.' },
          baseVersion: { type: 'string', description: 'Optional version from read_file for optimistic conflict checks.' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'edit_file',
      description:
        'Patch a Markdown/HTML text file by exact string replacement. By default ' +
        '`old_text` must match exactly once; set `replace_all` for global replacement.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path under one of your folders.' },
          old_text: { type: 'string', description: 'Exact text to replace.' },
          new_text: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a single match.' },
          baseVersion: { type: 'string', description: 'Optional version from read_file for optimistic conflict checks.' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
    {
      name: 'move_file',
      description:
        'Rename or move a file within the same folder. Keeps note attachment bundles together, ' +
        'regenerates PDF/image searchable text when needed, optionally cascades Markdown/HTML links, ' +
        'and updates the semantic index when possible.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Existing absolute file path under one of your folders.' },
          new_path: { type: 'string', description: 'New absolute file path in the same folder.' },
          cascade: { type: 'boolean', description: 'Update links that point at the moved file. Defaults true.' },
        },
        required: ['path', 'new_path'],
      },
    },
    {
      name: 'delete_file',
      description:
        'Delete a visible file by absolute path. Also removes note bundles or ' +
        'PDF/image derived artifacts owned by that file, and cleans the semantic index asynchronously.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path under one of your folders.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'search_library',
      description:
        'Hybrid (vector + full-text) search over opened local folders. ' +
        'Searches the **whole library** by default — every member folder from ' +
        '`library_info` — and scopes to one folder when `folder` is its absolute root (e.g. ' +
        '"/Users/me/notes"). For finer control, `path_prefix` restricts hits to chunks ' +
        'whose absolute source starts with that prefix (e.g. "/Users/me/notes/transcripts/"). ' +
        'Each hit returns the absolute file path, the chunk content, ' +
        'optional heading and source line range, and a fused relevance score. PDF hits include a ' +
        '`read_hint`; use `read_file` on the PDF path to get extracted Markdown. Use this when ' +
        'the user asks something the notes might answer; read full text documents with `read_file`.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language query.' },
          folder: {
            type: 'string',
            description:
              'Optional absolute folder root from library_info (e.g. "/Users/me/notes"). ' +
              'Omit to search the whole library.',
          },
          path_prefix: {
            type: 'string',
            description:
              'Optional absolute path prefix (e.g. "/Users/me/notes/transcripts/"). Overrides ' +
              '`folder` when present — pass either, not both. Matches any chunk whose source ' +
              'starts with the prefix.',
          },
          top_k: {
            type: 'integer',
            description: `Number of chunks to return (1-${MAX_TOP_K}). Default ${DEFAULT_TOP_K}.`,
            minimum: 1,
            maximum: MAX_TOP_K,
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'reindex',
      description:
        'Reconcile the semantic index with the files currently on disk, then report ' +
        'index health. StashBase file tools update the index themselves when possible; ' +
        'call this after bulk external changes or when a file tool returns an index warning. ' +
        'You do NOT need to ' +
        'say what changed: the sweep diffs disk against the index and discovers added / ' +
        'modified / removed / renamed files itself. Defaults to the **whole library**; ' +
        'pass `folder` (an absolute folder root) to limit the disk walk to one ' +
        'folder. Re-embedding cost is ' +
        'proportional to the diff (only changed files are re-embedded), not the library size. ' +
        'Returns `{folders: [{folder, added, modified, removed, renamed, failed}], ' +
        'total, indexed, pendingCount, pending, upToDate}` — the totals come from a ' +
        'whole-library index-status check run after the sweep.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description: 'Absolute folder root from library_info to reconcile. Omit to reconcile every folder in the library.',
          },
        },
      },
    },
  ];
