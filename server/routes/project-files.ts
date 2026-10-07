import { withAgentProjectScope } from '../project-request-scope.ts';
/**
 * Project routes. External agents talk in absolute source paths because
 * they may run in sandboxes that cannot read the user's local filesystem.
 * These routes are the host-side bridge for semantic retrieval, index status,
 * orientation, project rules, and file CRUD.
 */
import express from 'express';
import fs from 'node:fs';
import { errorMessage, logger } from '../log.ts';
import { indexer } from '../state.ts';
import { sendError } from '../http.ts';
import {
  requireProjectStatusFolder,
  routeError,
} from '../project-file-access.ts';
import { agentContextFile, parseProjectFileLineBound } from '../project-file-reader.ts';
import { AGENT_SESSION_ID_HEADER, attributedRequestSession } from '../agent-session-registry.ts';
import { createProjectOperations, type ProjectOperations } from '../project-operations/index.ts';
import {
  parseSearchMode,
  toRetrievalMode,
  toSearchMode,
  parseSearchTypes,
  SEARCH_MODE_VALIDATION_ERROR,
  SEARCH_TYPES_VALIDATION_ERROR,
} from '../../shared/search-types.ts';

export {
  normalizeProjectFilePath,
  normalizeProjectSearchScope,
  requireProjectStatusFolder,
  type AgentContextFile,
  type ProjectSearchScope,
} from '../project-file-access.ts';
export { agentContextFile, readProjectFile } from '../project-file-reader.ts';
export { listProjectDirectory } from '../project-directory.ts';
export {
  deleteProjectFile,
  editProjectFile,
  moveProjectFile,
  writeProjectFile,
} from '../project-file-mutations.ts';

const log = logger('routes/project-files');


export function mount(app: express.Express, operations: ProjectOperations = createProjectOperations()): void {
  // Creation validates authorized destinations independently of existing-file scope.
  app.post('/api/project/create-project', async (req, res) => {
    try {
      res.json(await operations.createProject({
        name: req.body?.name,
        location: req.body?.location,
      }));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.use('/api/project', (req, res, next) => {
    try {
      withAgentProjectScope(req.header(AGENT_SESSION_ID_HEADER), next);
    } catch (error) {
      sendError(res, error);
    }
  });

  // Unified source search over one explicit or attributed Folder (optional
  // `path_prefix` and source `types` filters). Powers MCP's
  // `search_project`; omitted mode uses the current embedding configuration.
  // Hidden derived text is searched but always
  // remapped to its visible source identity.
  app.post('/api/project/search', async (req, res) => {
    try {
      const query = typeof req.body?.query === 'string' ? req.body.query : '';
      const topK = Number.isFinite(req.body?.top_k) ? Number(req.body.top_k) : 8;
      const types = parseSearchTypes(req.body?.types);
      if (types == null) {
        return res.status(400).json({
          error: SEARCH_TYPES_VALIDATION_ERROR,
          code: 'INVALID_SEARCH_TYPES',
        });
      }
      const mode = parseSearchMode(req.body?.mode);
      if (mode === null) {
        return res.status(400).json({
          error: SEARCH_MODE_VALIDATION_ERROR,
          code: 'INVALID_SEARCH_MODE',
        });
      }
      const result = await operations.search({
        query,
        topK,
        folder: req.body?.folder,
        pathPrefix: req.body?.path_prefix,
        types,
        mode: toRetrievalMode(mode),
        caseStrict: req.body?.case_strict === true,
        wholeWord: req.body?.whole_word === true,
        // Session identity constrains project scope. Older native MCP hosts
        // may retain only the window id; the operation owns safe attribution.
        agentSessionId: req.header(AGENT_SESSION_ID_HEADER),
        windowId: req.header('x-stashbase-window-id'),
      });
      res.json({ ...result, mode: toSearchMode(result.mode) });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // MFS exact search over one `folder`, optionally narrowed to a
  // folder-relative `path_prefix`. Powers the in-app search popup's exact
  // mode. MFS stores prepared text under the visible source DocumentId.
  app.post('/api/project/keyword-search', async (req, res) => {
    try {
      const query = typeof req.body?.query === 'string' ? req.body.query : '';
      res.json(await operations.keywordSearch({
        query,
        caseStrict: req.body?.case_strict === true,
        wholeWord: req.body?.whole_word === true,
        folder: typeof req.body?.folder === 'string' ? req.body.folder : undefined,
        pathPrefix: typeof req.body?.path_prefix === 'string' ? req.body.path_prefix : undefined,
      }));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Index status for one required project.
  app.get('/api/project/index-status', async (req, res) => {
    try {
      const folderRoot = await requireProjectStatusFolder(req.query.folder);
      const status = await indexer.status(folderRoot);
      // Recently-indexed slice: intersect the indexed file set with
      // their on-disk mtime, return top N. Helps an agent answer "what
      // did I just embed?" without a state.db timestamp column. Paths are
      // absolute (members live anywhere).
      let recentlyIndexed: Array<{ path: string; mtimeMs: number }> = [];
      try {
        const indexed = await indexer.listDocuments(folderRoot);
        const enriched: Array<{ path: string; mtimeMs: number }> = [];
        for (const abs of indexed) {
          try {
            const st = await fs.promises.stat(abs);
            enriched.push({ path: abs, mtimeMs: st.mtimeMs });
          } catch { /* file vanished — drop from list */ }
        }
        enriched.sort((a, b) => b.mtimeMs - a.mtimeMs);
        recentlyIndexed = enriched.slice(0, 10);
      } catch (err) {
        log.warn(`recently_indexed enrichment failed: ${errorMessage(err)}`);
      }
      res.json({
        ...status,
        recentlyIndexed,
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Reconcile one required project. Powers MCP `reindex` while
  // keeping membership resolution inside the app server instead of the stdio
  // MCP host.
  app.post('/api/project/reindex', async (req, res) => {
    try {
      const folder = req.body?.folder ?? req.query.folder;
      res.json(await operations.reindex({ folder: typeof folder === 'string' ? folder : undefined }));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Project registry = folder_home + folders. Powers MCP's `list_projects` tool — the agent's
  // orientation card at the start of a session.
  app.get('/api/project/info', async (_req, res) => {
    try {
      res.json(await operations.info());
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Resolve the best file path to hand to an Agent Panel runtime for a visible
  // source file. PDF/DOCX use app-data extracted text for reading. HTML/images
  // keep the original source as the read path; their extracted text layers
  // are indexing inputs, not source replacements.
  app.get('/api/project/agent-context-file', async (req, res) => {
    try {
      res.json(await agentContextFile(req.query.path));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.get('/api/project/directory', async (req, res) => {
    try {
      res.json(await operations.listDirectory(req.query.path));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.get('/api/project/file', async (req, res) => {
    try {
      const offset = parseProjectFileLineBound(req.query.offset, 'offset');
      const limit = parseProjectFileLineBound(req.query.limit, 'limit');
      res.json(await operations.read(
        req.query.path,
        offset == null && limit == null ? undefined : { offset, limit },
      ));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.put('/api/project/file', async (req, res) => {
    try {
      const filePath = req.body?.path;
      const content = req.body?.content;
      const baseVersion = typeof req.body?.baseVersion === 'string' ? req.body.baseVersion : undefined;
      res.json(await operations.write({ path: filePath, content, baseVersion }));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.post('/api/project/file/edit', async (req, res) => {
    try {
      const filePath = req.body?.path;
      const oldText = req.body?.old_text;
      const newText = req.body?.new_text;
      const baseVersion = typeof req.body?.baseVersion === 'string' ? req.body.baseVersion : undefined;
      res.json(await operations.edit({ path: filePath, oldText, newText, replaceAll: req.body?.replace_all === true, baseVersion }));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.patch('/api/project/file/move', async (req, res) => {
    try {
      res.json(await operations.move({ path: req.body?.path, newPath: req.body?.new_path, cascade: req.body?.cascade !== false }));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.delete('/api/project/file', async (req, res) => {
    try {
      res.json(await operations.delete(req.query.path));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}
