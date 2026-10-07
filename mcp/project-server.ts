/**
 * Project MCP server factory shared by both transports.
 *
 * `mcp/server.ts` (stdio, spawned per client) and `server/routes/mcp-http.ts`
 * (Streamable HTTP on the app server) build their `Server` instances here, so
 * the tool definitions and handlers exist exactly once. Callers provide either
 * the in-process Project Operations adapter (HTTP MCP) or the HTTP adapter
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
import type { ProjectOperations } from '../server/project-operations/index.ts';
import { parseProjectFileLineBound } from '../server/project-file-reader.ts';
import { createHttpProjectOperations } from './project-operations-http.ts';
import {
  parseSearchMode,
  toRetrievalMode,
  toSearchMode,
  parseSearchTypes,
  SEARCH_MODE_VALIDATION_ERROR,
  SEARCH_MODES,
  SEARCH_TYPE_CATEGORIES,
  SEARCH_TYPES_VALIDATION_ERROR,
} from '../shared/search-types.ts';

export interface ProjectMcpServerOptions {
  /** App server base URL, e.g. `http://127.0.0.1:8090`. */
  webBase: string;
  /** Optional window id forwarded as `x-stashbase-window-id`. */
  windowId?: string;
  /** Optional per-session attribution id forwarded as
   * `x-stashbase-agent-session-id` (built-in panel sessions only). */
  agentSessionId?: string;
  /** Direct in-process adapter used by the app's HTTP MCP transport. */
  operations?: ProjectOperations;
}

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 25;

export function createProjectMcpServer(opts: ProjectMcpServerOptions): Server {
  const { webBase, windowId, agentSessionId } = opts;
  const operations = withMcpErrors(opts.operations ?? createHttpProjectOperations(webBase, windowId, agentSessionId));

  function filePathArg(args: Record<string, unknown>): unknown {
    return typeof args.path === 'string' && args.path.trim()
      ? args.path
      : args.file_path;
  }

  const server = new Server(
    { name: 'stashbase', version: '0.1.0' },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: BUILTIN_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const folder = typeof args.folder === 'string' && args.folder.trim() ? args.folder : undefined;

    if (req.params.name === 'list_projects') {
      const info = await operations.info();
      return {
        content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
      };
    }

    if (req.params.name === 'search_project') {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) throw new Error('`query` is required');
      const pathPrefix = typeof args.path_prefix === 'string' && args.path_prefix.trim()
        ? args.path_prefix : undefined;
      const parsedTypes = parseSearchTypes(args.types);
      if (parsedTypes == null) {
        return {
          content: [{ type: 'text', text: SEARCH_TYPES_VALIDATION_ERROR }],
          isError: true,
        };
      }
      const types = args.types == null ? undefined : parsedTypes;
      const mode = parseSearchMode(args.mode);
      if (mode === null) {
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
      const searchResult = await operations.search({ query, topK: k, folder, pathPrefix, types, mode: toRetrievalMode(mode), caseStrict, wholeWord });
      const hits = annotateSearchHitsForMcp(searchResult.hits);
      const effectiveMode = toSearchMode(searchResult.mode);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query,
            mode: effectiveMode,
            folder: searchResult.folder,
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
      const offset = parseProjectFileLineBound(args.offset, 'offset');
      const limit = parseProjectFileLineBound(args.limit, 'limit');
      const result = await operations.read(
        filePathArg(args),
        offset == null && limit == null ? undefined : { offset, limit },
      );
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

function withMcpErrors(operations: ProjectOperations): ProjectOperations {
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
  }) as ProjectOperations;
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
      name: 'list_projects',
      description:
        'Return StashBase project locations as `{folder_home, folders}`, where `folder_home` is the ' +
        'default new-folder location and `folders` lists "Your ' +
        'Folders", each with an ABSOLUTE `path` (the identity the file tools and ' +
        'search_project use), a display `name`, and the embedder provider. Folders can ' +
        'live anywhere on disk. Sandboxed runtime filesystem tools may not be able to ' +
        'see these host paths; the StashBase file tools operate on them.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'list_directory',
      description:
        'List visible files and folders within one registered project. Pass an absolute folder/subfolder path to ' +
        'list its immediate contents. Paths are absolute POSIX paths. Hidden ' +
        'app-maintained derived notes and bundle folders are not surfaced.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Required absolute directory path inside one registered project.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'read_file',
      description:
        'Read a file from StashBase by absolute path ' +
        '(for example `/Users/me/notes/topic/note.md`). Markdown, HTML, JSON, and UTF-8 plain text return source text. ' +
        'PDFs and DOCX return current prepared text. Images are visible in ' +
        '`list_directory` and searchable through OCR evidence, but are not returned as bytes. ' +
        'Generic Workbench-only files are not listed or readable through MCP. ' +
        'Use `offset` and `limit` to read a long file one window at a time instead of ' +
        'spending your context on the whole file. A windowed response sets `partial: true`, ' +
        'reports `totalLines`, and returns `nextOffset` until the window reaches the end. ' +
        'It also omits `version`, so read the whole file before any `baseVersion` write. ' +
        'A source above the 8 MiB read ceiling is not served by this tool in any window.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path under one of your folders.' },
          file_path: { type: 'string', description: 'Alias for path; accepted for Claude Read-style calls.' },
          offset: { type: 'integer', minimum: 1, description: 'Optional 1-based line to start at. Defaults to the first line.' },
          limit: { type: 'integer', minimum: 1, description: 'Optional maximum number of lines to return. Defaults to the rest of the file.' },
        },
      },
    },
    {
      name: 'write_file',
      description:
        'Create or overwrite a Markdown, HTML, JSON, or UTF-8 plain-text file. Creates parent folders as ' +
        'needed, writes atomically, and updates the MFS search projection. Exact search works without an ' +
        'embedding provider; meaning-based indexing follows when one is configured.',
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
        'Patch a Markdown, HTML, JSON, or UTF-8 plain-text file by exact string replacement. By default ' +
        '`old_text` must match exactly once; set `replace_all` for global replacement. Empty `old_text` ' +
        'is allowed only for an existing empty file. Changes are saved directly; the reader can review ' +
        'a built-in Chat turn afterwards with Undo/Keep.',
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
        'and replaces the old MFS document identity. The new identity may be embedded again.',
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
        'PDF/image derived artifacts owned by that file, and removes its MFS search projection.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path under one of your folders.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'search_project',
      description:
        'Search one registered project, including current prepared text for PDFs, DOCX, and images. ' +
        'Omit `mode` to use hybrid retrieval when an embedding key is configured, or grep otherwise. ' +
        'Two explicit modes: `semantic` searches by meaning — hybrid ' +
        '(vector + full-text) retrieval that needs an embedding provider set up in StashBase; `keyword` is ' +
        'exact literal search through the local MFS text index for identifiers, error codes, config keys, or quoted ' +
        'phrases that meaning-based matching may blur, and it works without any setup. ' +
        'Explicit `semantic` requires a key and reports configuration or provider errors without silently changing strategy. ' +
        'The response `mode` reports the strategy used in the same wire vocabulary. ' +
        'Every request searches one Folder. A Folder Chat may omit `folder` to use its bound Folder; ' +
        'External clients must pass an absolute root from `list_projects` as `folder`. ' +
        'A bound Chat cannot override its project. Only external clients can select another registered project per request. ' +
        'The response `folder` reports the effective root. For finer control, `path_prefix` restricts hits to sources ' +
        'starting with that prefix (e.g. "/Users/me/notes/transcripts/"). Each hit returns the absolute file path, ' +
        'the matching content, optional heading and source line range, and (in `semantic` mode) a fused ' +
        'relevance score. PDF hits include a `read_hint`; use `read_file` on the PDF path to get ' +
        'extracted Markdown. Read full text documents with `read_file`.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language query for `semantic` mode (search by meaning) or literal text for `keyword` mode.' },
          mode: {
            type: 'string',
            enum: [...SEARCH_MODES],
            description:
              'Omit to select from current key configuration. "semantic" searches by meaning and needs an embedding provider set up in StashBase. ' +
              '"keyword" is exact literal matching over source and prepared text and works without setup.',
          },
          folder: {
            type: 'string',
            description:
              'Absolute folder root from list_projects (e.g. "/Users/me/notes"). ' +
              'Only a Folder Chat may omit it and use its bound Folder.',
          },
          path_prefix: {
            type: 'string',
            description:
              'Optional absolute path prefix (e.g. "/Users/me/notes/transcripts/"). Must remain inside ' +
              'the effective folder scope. Matches any chunk whose source ' +
              'starts with the prefix.',
          },
          types: {
            type: 'array',
            description:
              'Optional source file categories. Omit for all types; combine categories to ' +
              'search notes, PDFs, images, or DOCX files.',
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
        'Create a NEW project folder and register it in StashBase so it ' +
        'appears in Recent immediately. Use this when the user wants a fresh ' +
        'working context (a new project/topic). `name` is a single folder name (no ' +
        'slashes). By default the project is created under `folder_home`; pass ' +
        '`location` only when the user names an existing directory inside the folder ' +
        'home or inside a project folder. Creation does not move the current chat. ' +
        'Open the created project to start a chat there; external clients can select its returned `path`.',
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
              'Must be the folder home, inside it, or inside a project folder. Omit for ' +
              'the default folder home.',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'reindex',
      description:
        'Reconcile search data with the files currently on disk, then report ' +
        'index health. StashBase file tools update the index themselves when possible; ' +
        'call this after bulk external changes or when a file tool returns an index warning. ' +
        'You do NOT need to say what changed: the sweep offers every admitted text ' +
        'projection to MFS, which identifies unchanged content, and removes identities ' +
        'missing from disk. A rename is reported as an old removal plus a new add or update. ' +
        'Requires `folder`, the absolute root of one registered project. Only that folder is traversed. Unchanged content spends no embedding tokens; renamed documents may ' +
        'be embedded again under their new MFS identity. ' +
        'Returns `{folders: [{folder, added, modified, removed, failed}], ' +
        'total, indexed, pendingCount, pending, upToDate}` — the totals come from a ' +
        'same-project index-status check run after the sweep.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description: 'Absolute folder root from list_projects to reconcile. Required; only this project is reconciled.',
          },
        },
        required: ['folder'],
      },
    },
  ];
