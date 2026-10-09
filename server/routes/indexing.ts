/**
 * Indexing-related routes: hybrid search, manual full sync, and the
 * lightweight status poll the UI uses to grey out pending files.
 */
import express from 'express';
import fs from 'node:fs';
import { logger } from '../log.ts';
import {
  getCurrentFolder,
  exactRegisteredFolderRootAsync,
  resolveFolderRootAsync,
} from '../folder.ts';
import {
  cancelConversionAndWait,
  isConversionPending,
  isConversionTextUnavailable,
  promoteConversion,
} from '../conversion.ts';
import { detectFormat, isConvertibleSource } from '../format.ts';
import { clearRecord, markCancelled, readAll as readConversionStatus } from '../conversion-status.ts';
import {
  prepareConvertibleSource,
  reprocessConvertibleSource,
} from '../conversion-dispatch.ts';
import {
  clearIndexWarning,
  syncFolderNow,
} from '../state.ts';
import { noteTreeChanged } from '../watcher.ts';
import { sendError } from '../http.ts';
import { filesystemPath } from '../filesystem-path.ts';
import { isRetrievalEligibleDirectoryPath, isRetrievalEligiblePath } from '../indexable.ts';
import {
  parseSearchTypes,
  SEARCH_TYPES_VALIDATION_ERROR,
} from '../../shared/search-types.ts';
import { buildIndexStatus } from '../index-status.ts';
import { createRetrieval, keywordFilesFromEvidence, searchHitsFromEvidence } from '../retrieval/index.ts';

const log = logger('routes/indexing');
const retrieval = createRetrieval();

function parseFolderParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

async function requireMemberFolderRoot(ref: string): Promise<string> {
  const root = await resolveFolderRootAsync(ref);
  const memberRoot = await exactRegisteredFolderRootAsync(root);
  if (!memberRoot) {
    const err = new Error('folder is not in your folders');
    (err as any).status = 404;
    (err as any).code = 'FOLDER_NOT_FOUND';
    throw err;
  }
  return memberRoot;
}

async function requireRequestFolder(explicit?: string): Promise<{ folderRoot: string }> {
  if (explicit) {
    const root = await requireMemberFolderRoot(explicit);
    return { folderRoot: root };
  }
  const folderRoot = getCurrentFolder();
  if (!folderRoot) {
    const err = new Error('no folder open');
    (err as any).status = 412;
    (err as any).code = 'NO_FOLDER';
    throw err;
  }
  return { folderRoot: filesystemPath.absolute(folderRoot) };
}

function sourcePathForAbs(absPath: string): string {
  return filesystemPath.absolute(absPath);
}

/** Resolve an explicit-folder request without allowing a symlink inside the
 * project folder to redirect preparation/extraction outside that folder.
 *
 * Uses the promise-based resolver so canonicalization, realpath, existence,
 * and type checks can move off the single Node request-handling event loop. */
async function requireExistingFileInFolderAsync(folderRoot: string, rel: string): Promise<string> {
  let abs: string;
  try {
    abs = await filesystemPath.resolveUnderAsync(folderRoot, rel);
  } catch (cause) {
    const err = new Error('path escapes folder', { cause });
    (err as any).status = 400;
    throw err;
  }
  const exists = await fs.promises.access(abs).then(() => true, () => false);
  if (!exists) {
    clearRecord(sourcePathForAbs(abs));
    const err = new Error('file not found');
    (err as any).status = 404;
    throw err;
  }

  try {
    abs = await filesystemPath.resolveUnderAsync(folderRoot, rel, { access: 'existing' });
  } catch (cause) {
    const err = new Error('path escapes folder through symlink', { cause });
    (err as any).status = 400;
    throw err;
  }
  const stat = await fs.promises.stat(abs);
  if (!stat.isFile()) {
    const err = new Error('file not found');
    (err as any).status = 404;
    throw err;
  }
  return abs;
}

export async function reprocessFileInFolder(
  relPath: string,
  folderName?: string,
): Promise<'conversion' | 'index'> {
  const rel = typeof relPath === 'string' ? relPath : '';
  if (!rel) {
    const err = new Error('path required');
    (err as any).status = 400;
    throw err;
  }
  if (!isRetrievalEligiblePath(rel)) {
    const err = new Error('hidden and excluded paths are not eligible for Preparation');
    (err as any).status = 400;
    (err as any).code = 'PATH_NOT_PREPARABLE';
    throw err;
  }

  const { folderRoot } = await requireRequestFolder(folderName || undefined);

  const abs = await requireExistingFileInFolderAsync(folderRoot, rel);
  if (!isConvertibleSource(rel) && !detectFormat(rel)) {
    const err = new Error('this file format cannot be prepared');
    (err as any).status = 415;
    throw err;
  }
  const sourcePath = sourcePathForAbs(abs);
  if (isConversionPending(sourcePath)) {
    // A manual retry promotes queued work; running work is non-preemptive.
    promoteConversion(sourcePath, 'interactive');
    return isConvertibleSource(rel) ? 'conversion' : 'index';
  }

  const reprocess = reprocessConvertibleSource(abs, rel);
  if (reprocess.status === 'queued') {
    return 'conversion';
  }

  clearRecord(sourcePath);
  void syncFolderNow(folderRoot, { reason: `manual reprocess ${rel}` })
    .then((result) => {
      if (!result.cancelled) noteTreeChanged();
    })
    .catch((err: unknown) => {
      log.warn(`manual reprocess sync failed for ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`);
    });
  return 'index';
}

async function cancelFilePreparationInFolder(relPath: string, folderName?: string): Promise<boolean> {
  const rel = typeof relPath === 'string' ? relPath : '';
  if (!rel) {
    const err = new Error('path required');
    (err as any).status = 400;
    throw err;
  }
  const { folderRoot } = await requireRequestFolder(folderName || undefined);
  const abs = await requireExistingFileInFolderAsync(folderRoot, rel);
  const sourcePath = sourcePathForAbs(abs);
  const cancelled = await cancelConversionAndWait(sourcePath, 'user-request');
  if (cancelled) markCancelled(sourcePath);
  return cancelled;
}

async function prepareConvertibleInFolder(relPath: string, folderName?: string): Promise<void> {
  const rel = typeof relPath === 'string' ? relPath : '';
  if (!rel) {
    const err = new Error('path required');
    (err as any).status = 400;
    throw err;
  }
  if (!isRetrievalEligiblePath(rel)) {
    const err = new Error('hidden and excluded paths are not eligible for Preparation');
    (err as any).status = 400;
    (err as any).code = 'PATH_NOT_PREPARABLE';
    throw err;
  }
  const { folderRoot } = await requireRequestFolder(folderName || undefined);
  const abs = await requireExistingFileInFolderAsync(folderRoot, rel);
  if (!prepareConvertibleSource(abs, rel)) {
    const err = new Error('only DOCX files require interactive preparation');
    (err as any).status = 415;
    throw err;
  }
}

export function mount(app: express.Express): void {
  // Opening a DOCX is an explicit user gesture. Queue it in the light lane
  // at interactive priority (or promote the existing queued task).
  app.post('/api/files/prepare', async (req, res) => {
    try {
      await prepareConvertibleInFolder(req.body?.path, parseFolderParam(req.body?.folder));
      res.json({ ok: true });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Trigger a folder sync manually — useful after external edits / file
  // moves. Returns the diff (added / removed / failed). Defaults to the
  // active folder; accepts `?folder=<name>` to sync any known folder
  // (powers MCP `reindex` so external agents can refresh an
  // unopened folder's index without the user opening it first).
  app.post('/api/sync', async (req, res) => {
    try {
      const explicit = parseFolderParam(req.query.folder);
      const { folderRoot } = await requireRequestFolder(explicit);
      const result = await syncFolderNow(folderRoot, { reason: 'manual sync' });
      // `/api/sync` is also the explicit "something outside the app may
      // have changed" reconcile hook. Bump even when the semantic diff is
      // empty: no-key mode, non-indexable assets, empty dirs, and fast
      // no-op syncs still need the renderer to refresh its visible tree
      // and active read-only tab from disk.
      if (!result.cancelled) noteTreeChanged();
      res.json(result);
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Hybrid (vector + BM25) search, scoped to one Folder (explicit `folder`
  // or the window's current one). MCP uses the same one-Folder contract.
  // Optional narrowing: `path_prefix` (folder-relative subfolder, resolved
  // escape-safe) and `types` (file-type categories mapped to source
  // extensions, applied daemon-side before the final top-k cut).
  app.post('/api/search', async (req, res) => {
    try {
      const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
      const topK = Number.isFinite(req.body?.top_k) ? Number(req.body.top_k) : 8;
      if (!query) return res.status(400).json({ error: 'query required' });
      const explicit = parseFolderParam(req.body?.folder);
      const { folderRoot } = await requireRequestFolder(explicit);
      const types = parseSearchTypes(req.body?.types);
      if (types == null) return res.status(400).json({ error: SEARCH_TYPES_VALIDATION_ERROR });
      const prefixAbs = await resolveScopePrefix(folderRoot, req.body?.path_prefix);
      if (prefixAbs === false) return res.status(400).json({ error: 'path_prefix must be a folder-relative subfolder' });
      const result = await retrieval.search({
        mode: 'hybrid', query, topK, folderRoot, pathPrefix: prefixAbs, types,
      });
      if (result.availability.state === 'unavailable') {
        return res.status(412).json({
          error: 'To search by meaning, set it up in StashBase Settings.',
          code: 'EMBEDDER_KEY_REQUIRED',
        });
      }
      const out = (await Promise.all(searchHitsFromEvidence(result.evidence).map(async (hit) => {
        const rel = await filesystemPath.relativeAsync(folderRoot, hit.fileName);
        return rel == null ? null : { ...hit, fileName: rel };
      }))).filter((hit): hit is NonNullable<typeof hit> => hit != null);
      res.json({ hits: out });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Exact literal search via MFS grep, scoped to the active Folder namespace.
  // It works while vector indexing is off and is useful
  // for finding specific tokens (function names, exact phrases) that
  // meaning-based retrieval blurs out. Defaults to smart-case, restricts to
  // every admitted direct or prepared text projection and caps total work so
  // a generic query cannot exhaust the renderer or daemon.
  app.get('/api/keyword-search', async (req, res) => {
    try {
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (!query) return res.status(400).json({ error: 'q required' });
      const explicit = parseFolderParam(req.query.folder);
      const { folderRoot: folderDir } = await requireRequestFolder(explicit);
      const caseStrict = req.query.case_strict === '1' || req.query.case_strict === 'true';
      const wholeWord = req.query.whole_word === '1' || req.query.whole_word === 'true';
      const types = parseSearchTypes(
        typeof req.query.types === 'string' && req.query.types
          ? req.query.types.split(',')
          : undefined,
      );
      if (types == null) return res.status(400).json({ error: SEARCH_TYPES_VALIDATION_ERROR });
      const rawPrefix = typeof req.query.path_prefix === 'string' ? req.query.path_prefix : undefined;
      const prefixAbs = await resolveScopePrefix(folderDir, rawPrefix);
      if (prefixAbs === false) return res.status(400).json({ error: 'path_prefix must be a folder-relative subfolder' });
      const result = await retrieval.search({
        mode: 'grep', query, folderRoot: folderDir, pathPrefix: prefixAbs,
        caseStrict, wholeWord, types,
      });
      // Keep the same visible-source remap as semantic retrieval. Internal
      // MFS documents already use source identities, while this also drops
      // any legacy derived identity that survives a migration window.
      const files = keywordFilesFromEvidence(result.evidence, folderDir);
      const totalMatches = files.reduce((sum, file) => sum + file.totalMatches, 0);
      res.json({ query, folder: folderDir, files, totalMatches, truncated: result.truncated });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Lightweight status — full `pending` list (not a sample) so the
  // sidebar can grey out the right rows. Scoped to the current folder.
  // `treeVersion` signals app writes and completed reconciles. External
  // filesystem changes are reconciled on window focus; the renderer also
  // refreshes its listing immediately. Also surfaces in-flight PDF conversions
  // for the conversion indicator.
  app.get('/api/index-status', async (req, res) => {
    try {
      const { folderRoot } = await requireRequestFolder(parseFolderParam(req.query.folder));
      res.json(await buildIndexStatus(folderRoot));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.post('/api/index-warning/dismiss', async (req, res) => {
    try {
      const explicit = parseFolderParam(req.body?.folder);
      const { folderRoot } = await requireRequestFolder(explicit);
      clearIndexWarning(folderRoot);
      res.json({ ok: true });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // File preparation status: full map across registered projects. Used by rich
  // viewers to render per-file failure banners (cheaper than polling
  // folder-scoped /api/index-status when the viewer just needs one
  // file's status).
  app.get('/api/pdf/status', (_req, res) => {
    try {
      res.json({ entries: readConversionStatus() });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // File reprocess: take a folder-relative path and clear its durable
  // failure row. PDF/image/DOCX sources also clear stale final derived
  // artifacts and re-run extraction; directly readable files schedule a
  // reconcile so the index is rebuilt from source.
  app.post('/api/files/reprocess', async (req, res) => {
    try {
      const rel = typeof req.body?.path === 'string' ? req.body.path : '';
      const targetFolder = typeof req.body?.folder === 'string' && req.body.folder.trim()
        ? req.body.folder
        : undefined;
      const mode = await reprocessFileInFolder(rel, targetFolder);
      res.json({ ok: true, mode });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.post('/api/files/cancel-preparation', async (req, res) => {
    try {
      const rel = typeof req.body?.path === 'string' ? req.body.path : '';
      const targetFolder = typeof req.body?.folder === 'string' && req.body.folder.trim()
        ? req.body.folder
        : undefined;
      const cancelled = await cancelFilePreparationInFolder(rel, targetFolder);
      res.json({ ok: true, cancelled });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}

/** Resolves a folder-relative subfolder scope to an absolute directory
 *  inside `folderRoot`. Absent/empty → undefined (folder-wide search);
 *  escaping, missing, or non-directory values → false (caller 400s). */
async function resolveScopePrefix(folderRoot: string, raw: unknown): Promise<string | undefined | false> {
  if (raw == null) return undefined;
  if (typeof raw !== 'string') return false;
  const rel = raw.replace(/^\/+|\/+$/g, '');
  if (!rel) return undefined;
  if (!isRetrievalEligibleDirectoryPath(rel)) return false;
  try {
    const abs = await filesystemPath.resolveUnderAsync(folderRoot, rel, { access: 'existing' });
    return (await fs.promises.stat(abs)).isDirectory() ? abs : false;
  } catch {
    return false;
  }
}
// ---------- recent-files walk ----------
