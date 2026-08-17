/**
 * Library MCP server factory shared by both transports.
 *
 * `mcp/server.ts` (stdio, spawned per client) and `server/routes/mcp-http.ts`
 * (Streamable HTTP on the app server) build their `Server` instances here, so
 * the tool definitions and handlers exist exactly once. Callers provide either
 * the in-process Library Operations adapter (HTTP MCP) or the HTTP adapter
 * used by the separately spawned stdio host.
 *
 * This module must stay transport-free: no stdio-guard (the app server needs
 * its console), no Express, no process-level state. Callers pass the adapter
 * and optional window id instead of reading argv/env here.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { LibraryOperations } from '../server/library-operations/index.ts';
import { createHttpLibraryOperations } from './library-operations-http.ts';
import {
  parseSearchMode,
  parseSearchTypes,
  SEARCH_MODE_VALIDATION_ERROR,
  SEARCH_MODES,
  SEARCH_TYPE_CATEGORIES,
  SEARCH_TYPES_VALIDATION_ERROR,
} from '../shared/search-types.ts';

export interface LibraryMcpServerOptions {
  /** App server base URL, e.g. `http://127.0.0.1:8090`. */
  webBase: string;
  /** Optional window id forwarded as `x-stashbase-window-id`. */
  windowId?: string;
  /** Optional per-session attribution id forwarded as
   * `x-stashbase-agent-session-id` (built-in panel sessions only). */
  agentSessionId?: string;
  /** Direct in-process adapter used by the app's HTTP MCP transport. */
  operations?: LibraryOperations;
}

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 25;

export function createLibraryMcpServer(opts: LibraryMcpServerOptions): Server {
  const { webBase, windowId, agentSessionId } = opts;
  const operations = withMcpErrors(opts.operations ?? createHttpLibraryOperations(webBase, windowId, agentSessionId));

  function filePathArg(args: Record<string, unknown>): unknown {
    return typeof args.path === 'string' && args.path.trim()
      ? args.path
      : args.file_path;
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
        'AI Index when an API key is configured. Call `reindex` after bulk ' +
        'external changes or whenever a tool returns an index warning. When constructing Markdown or LaTeX ' +
        'inside JavaScript, use `String.raw` or escape every backslash, then use `read_file` to verify generated math.\n\n' +
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
      const info = await operations.info();
      return {
        content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
      };
    }

    if (req.params.name === 'search_library') {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) throw new Error('`query` is required');
      const pathPrefix = typeof args.path_prefix === 'string' && args.path_prefix.trim()
        ? args.path_prefix.trim() : undefined;
      const parsedTypes = parseSearchTypes(args.types);
      if (parsedTypes == null) {
        return {
          content: [{ type: 'text', text: SEARCH_TYPES_VALIDATION_ERROR }],
          isError: true,
        };
      }
      const types = args.types == null ? undefined : parsedTypes;
      const mode = parseSearchMode(args.mode);
      if (mode == null) {
        return {
          content: [{ type: 'text', text: SEARCH_MODE_VALIDATION_ERROR }],
          isError: true,
        };
      }
      const caseStrict = args.case_strict === true;
      const wholeWord = args.whole_word === true;
      const k = Math.max(
        1,
        Math.min(MAX_TOP_K, Math.floor(typeof args.top_k === 'number' ? args.top_k : DEFAULT_TOP_K)),
      );
      const searchResult = await operations.search({ query, topK: k, folder, pathPrefix, types, mode, caseStrict, wholeWord });
      const hits = annotateSearchHitsForMcp(searchResult.hits);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query,
            mode,
            folder: folder ?? null,
            path_prefix: pathPrefix ?? null,
            types: types ?? null,
            top_k: k,
            ...(searchResult.truncated ? { truncated: true } : {}),
            hits,
          }, null, 2),
        }],
      };
    }

    if (req.params.name === 'list_directory') {
      const result = await operations.listDirectory(args.path);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (req.params.name === 'read_file') {
      const result = await operations.read(filePathArg(args));
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (req.params.name === 'write_file') {
      const result = await operations.write({ path: args.path, content: args.content, baseVersion: typeof args.baseVersion === 'string' ? args.baseVersion : undefined });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (req.params.name === 'edit_file') {
      const result = await operations.edit({ path: args.path, oldText: args.old_text, newText: args.new_text, replaceAll: args.replace_all === true, baseVersion: typeof args.baseVersion === 'string' ? args.baseVersion : undefined });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (req.params.name === 'move_file') {
      const result = await operations.move({ path: args.path, newPath: args.new_path, cascade: args.cascade !== false });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (req.params.name === 'delete_file') {
      const result = await operations.delete(args.path);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (req.params.name === 'reindex') {
      const result = await operations.reindex({ folder });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (req.params.name === 'create_project') {
      // Attribution comes from the transport (env → header), never from the
      // model-controlled arguments.
      const result = await operations.createProject({
        name: args.name,
        location: args.location,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    throw new Error(`unknown tool: ${req.params.name}`);
  });

  return server;
}

function withMcpErrors(operations: LibraryOperations): LibraryOperations {
  return new Proxy(operations, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        try {
          return await value.apply(target, args);
        } catch (error: unknown) {
          const code = typeof (error as { code?: unknown })?.code === 'string'
            ? (error as { code: string }).code
            : undefined;
          throw new Error(code ? `${code}: ${error instanceof Error ? error.message : String(error)}` : error instanceof Error ? error.message : String(error));
        }
      };
    },
  }) as LibraryOperations;
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
        'live anywhere on disk. Folder purpose and durable working instructions belong ' +
        'in the visible `AGENTS.md`, which you can read with the file tools when needed. ' +
        'Use StashBase file tools for these paths; sandboxed shells may not be able to ' +
        'see those host files.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'list_directory',
      description:
        'List visible files and folders in the StashBase library. `path` is optional; omit ' +
        'or pass "" to list your folders, or pass an absolute folder/subfolder path to ' +
        'list its immediate contents. Paths are absolute POSIX paths. Hidden ' +
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
        '`list_directory` and searchable through OCR evidence, but are not returned as bytes. ' +
        'One response is limited to 8 MiB; split oversized text before reading it through this tool.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path under one of your folders.' },
          file_path: { type: 'string', description: 'Alias for path; accepted for Claude Read-style calls.' },
        },
      },
    },
    {
      name: 'write_file',
      description:
        'Create or overwrite a Markdown/HTML text file. Creates parent folders as ' +
        'needed, writes atomically, and updates AI Index when an API key is configured.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path under one of your folders.' },
          content: { type: 'string', description: 'Full literal file content. In JavaScript wrappers, use String.raw or escape every Markdown/LaTeX backslash.' },
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
          new_text: { type: 'string', description: 'Literal replacement text. In JavaScript wrappers, use String.raw or escape every Markdown/LaTeX backslash.' },
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
        'and updates AI Index when possible.',
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
        'PDF/image derived artifacts owned by that file, and cleans AI Index asynchronously.',
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
        'Search opened local folders. Two modes: `semantic` (default) is hybrid ' +
        '(vector + full-text) meaning-based search and needs AI Index; `keyword` is ' +
        'exact literal search (ripgrep) for identifiers, error codes, config keys, or quoted ' +
        'phrases that semantic search blurs, and it works before AI Index is set up. ' +
        'Searches the **whole library** by default — every member folder from ' +
        '`library_info` — and scopes to one folder when `folder` is its absolute root (e.g. ' +
        '"/Users/me/notes"). For finer control, `path_prefix` restricts hits to sources ' +
        'starting with that prefix (e.g. "/Users/me/notes/transcripts/"). Keyword mode requires ' +
        'a folder scope (`folder` or `path_prefix`). Each hit returns the absolute file path, ' +
        'the matching content, optional heading and source line range, and (semantic) a fused ' +
        'relevance score. PDF hits include a `read_hint`; use `read_file` on the PDF path to get ' +
        'extracted Markdown. Read full text documents with `read_file`.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language query (semantic) or literal text (keyword).' },
          mode: {
            type: 'string',
            enum: [...SEARCH_MODES],
            description:
              'Search mode. "semantic" (default) is meaning-based and needs AI Index. ' +
              '"keyword" is exact literal matching that works before AI Index setup but requires a folder scope.',
          },
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
          types: {
            type: 'array',
            description:
              'Optional source file categories. Omit for all types; combine categories to ' +
              'search notes, PDFs, images, DOCX files, or audio/video transcripts.',
            items: { type: 'string', enum: [...SEARCH_TYPE_CATEGORIES] },
            uniqueItems: true,
          },
          case_strict: {
            type: 'boolean',
            description: 'Keyword mode only: match case exactly. Default is smart-case.',
          },
          whole_word: {
            type: 'boolean',
            description: 'Keyword mode only: match whole words, so "agent" does not match "agents".',
          },
          top_k: {
            type: 'integer',
            description: `Maximum number of search hits to return (1-${MAX_TOP_K}). Default ${DEFAULT_TOP_K}.`,
            minimum: 1,
            maximum: MAX_TOP_K,
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'create_project',
      description:
        'Create a NEW project folder and register it into the StashBase library so it ' +
        'appears in "Your Folders" immediately. Use this when the user wants a fresh ' +
        'working context (a new project/topic). `name` is a single folder name (no ' +
        'slashes). By default the project is created under `folder_home`; pass ' +
        '`location` only when the user names an existing directory inside the folder ' +
        'home or inside a library folder. When the CALLING chat is a library-scoped ' +
        'StashBase panel chat, that chat is automatically rebound to the new project ' +
        '(its scope pill and history move there); a chat already bound to a folder ' +
        'stays bound — the result reports which happened. Write project files with the ' +
        'StashBase file tools under the returned absolute `path`.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'New project folder name — one path segment, cross-platform safe.',
          },
          location: {
            type: 'string',
            description:
              'Optional absolute path of an existing directory to create the project in. ' +
              'Must be the folder home, inside it, or inside a library folder. Omit for ' +
              'the default folder home.',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'reindex',
      description:
        'Reconcile AI Index with the files currently on disk, then report ' +
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
