/**
 * Library-wide routes. External agents talk in absolute source paths because
 * they may run in sandboxes that cannot read the user's local filesystem.
 * These routes are the host-side bridge for semantic search, index status,
 * orientation, library rules, and file CRUD.
 */
import express from 'express';
import fs from 'node:fs';
import { errorMessage, logger } from '../log.ts';
import {
  getFolderHome,
  memberFolderRoots,
} from '../folder.ts';
import { filesystemPath } from '../filesystem-path.ts';
import { indexer, syncFolderNow } from '../state.ts';
import { remapSearchHitsForDisplay } from '../search-display.ts';
import { getLibraryInfo } from '../library-info.ts';
import { sendError } from '../http.ts';
import { getApiKey } from '../app-config.ts';
import { isConversionTextUnavailable } from '../conversion.ts';
import { isAudioTranscriptTextUnavailable } from '../audio-transcription.ts';
import {
  normalizeLibrarySearchScope,
  requireLibraryStatusFolder,
  routeError,
} from '../library-file-access.ts';
import { listLibraryDirectory } from '../library-directory.ts';
import { agentContextFile, readLibraryFile } from '../library-file-reader.ts';
import {
  deleteLibraryFile,
  editLibraryFile,
  moveLibraryFile,
  writeLibraryFile,
} from '../library-file-mutations.ts';

export {
  normalizeLibraryFilePath,
  normalizeLibrarySearchScope,
  requireLibraryStatusFolder,
  type AgentContextFile,
  type LibrarySearchScope,
} from '../library-file-access.ts';
export { agentContextFile, readLibraryFile } from '../library-file-reader.ts';
export { listLibraryDirectory } from '../library-directory.ts';
export {
  deleteLibraryFile,
  editLibraryFile,
  moveLibraryFile,
  writeLibraryFile,
} from '../library-file-mutations.ts';

const log = logger('routes/library-files');


export function mount(app: express.Express): void {
  // Hybrid search over the whole library (optional `folder` / `path_prefix`
  // filter). Powers MCP's `search_library`. Hidden `.md` files are remapped or
  // dropped (same rule as /api/search) so an external client never sees
  // an internal path.
  app.post('/api/library/search', async (req, res) => {
    try {
      const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
      const topK = Number.isFinite(req.body?.top_k) ? Number(req.body.top_k) : 8;
      const { folderRoot, pathPrefix } = normalizeLibrarySearchScope(req.body?.folder, req.body?.path_prefix);
      if (!query) return res.status(400).json({ error: 'query required' });
      if (!getApiKey()) {
        return res.status(412).json({
          error: 'semantic search is disabled until you add an OpenAI API key',
          code: 'EMBEDDER_KEY_REQUIRED',
        });
      }
      // Members live anywhere, so hits carry their ABSOLUTE source path —
      // the unambiguous MCP identity the file tools accept. The base only
      // drives PDF page-marker resolution; absolute hits resolve regardless.
      const rawHits = await indexer.search(query, topK, folderRoot, pathPrefix);
      const hits = remapSearchHitsForDisplay(
        rawHits.filter((hit) => !isConversionTextUnavailable(hit.fileName) && !isAudioTranscriptTextUnavailable(hit.fileName)),
        filesystemPath.absolute(getFolderHome()),
      );
      res.json({ hits });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Index status for the whole library (or one `folder`). Powers the totals
  // MCP's `reindex` reports after a sweep.
  app.get('/api/library/index-status', async (req, res) => {
    try {
      const folderRoot = requireLibraryStatusFolder(req.query.folder);
      const status = await indexer.status(folderRoot);
      // Recently-indexed slice: intersect the indexed file set with
      // their on-disk mtime, return top N. Helps an agent answer "what
      // did I just embed?" without a state.db timestamp column. Paths are
      // absolute (members live anywhere).
      let recentlyIndexed: Array<{ path: string; mtimeMs: number }> = [];
      try {
        const indexed = await indexer.listFiles(folderRoot);
        const enriched: Array<{ path: string; mtimeMs: number }> = [];
        for (const abs of Object.keys(indexed)) {
          try {
            const st = fs.statSync(abs);
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

  // Reconcile one folder or the whole library. Powers MCP `reindex` while
  // keeping membership resolution inside the app server instead of the stdio
  // MCP host.
  app.post('/api/library/reindex', async (req, res) => {
    try {
      const folderRoot = requireLibraryStatusFolder(req.body?.folder ?? req.query.folder);
      const targets = folderRoot ? [folderRoot] : memberFolderRoots();
      const folders: Array<{ folder: string; added?: unknown; modified?: unknown; removed?: unknown; renamed?: unknown; failed?: unknown; error?: string }> = [];
      for (const target of targets) {
        try {
          const result = await syncFolderNow(target, { reason: 'mcp reindex' });
          folders.push({ folder: target, ...result });
        } catch (err: unknown) {
          folders.push({ folder: target, error: errorMessage(err) });
        }
      }
      let status: object = {};
      try {
        status = await indexer.status(folderRoot);
      } catch (err: unknown) {
        log.warn(`reindex status failed: ${errorMessage(err)}`);
      }
      res.json({ folders, ...status });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Library info = folder_home + folders. Powers MCP's `library_info` tool — the agent's
  // orientation card at the start of a session.
  app.get('/api/library/info', (_req, res) => {
    try {
      res.json(getLibraryInfo());
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Resolve the best file path to hand to a built-in agent for a visible
  // source file. PDF/DOCX use app-data extracted text for reading. HTML/images
  // keep the original source as the read path; their extracted text layers
  // are indexing inputs, not source replacements.
  app.get('/api/library/agent-context-file', async (req, res) => {
    try {
      res.json(await agentContextFile(req.query.path));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.get('/api/library/directory', async (req, res) => {
    try {
      res.json(await listLibraryDirectory(req.query.path));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.get('/api/library/file', async (req, res) => {
    try {
      res.json(await readLibraryFile(req.query.path));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.put('/api/library/file', async (req, res) => {
    try {
      const filePath = req.body?.path;
      const content = req.body?.content;
      if (typeof content !== 'string') throw routeError('content (string) required', 400);
      const baseVersion = typeof req.body?.baseVersion === 'string' ? req.body.baseVersion : undefined;
      res.json(await writeLibraryFile(filePath, content, { baseVersion }));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.post('/api/library/file/edit', async (req, res) => {
    try {
      const filePath = req.body?.path;
      const oldText = req.body?.old_text;
      const newText = req.body?.new_text;
      if (typeof oldText !== 'string') throw routeError('old_text (string) required', 400);
      if (typeof newText !== 'string') throw routeError('new_text (string) required', 400);
      const baseVersion = typeof req.body?.baseVersion === 'string' ? req.body.baseVersion : undefined;
      res.json(await editLibraryFile(filePath, oldText, newText, {
        replaceAll: req.body?.replace_all === true,
        baseVersion,
      }));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.patch('/api/library/file/move', async (req, res) => {
    try {
      res.json(await moveLibraryFile(req.body?.path, req.body?.new_path, {
        cascade: req.body?.cascade !== false,
      }));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.delete('/api/library/file', async (req, res) => {
    try {
      res.json(await deleteLibraryFile(req.query.path));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}
