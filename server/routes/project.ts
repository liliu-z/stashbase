import { telemetry } from '../telemetry.ts';
/**
 * Project registration and removal, window folder bindings, and imports.
 *
 * These are the only data routes that work BEFORE a folder is open —
 * they live outside the `requireFolder` prefix gate. The `onSwitch`
 * listener wired in `server/state.ts` takes over once a folder is set
 * to bind the indexer and kick off the background sync.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { githubImportRequestSchema } from '../../shared/protocols/http/github-import.ts';
import { createProjectImportOperations } from '../project-import-operations.ts';
import {
  clearFolderPathAsync,
  beginProjectFolderRemovalAsync,
  clearCurrentFolder,
  configuredDescendantProjectRootsAsync,
  currentWindowId,
  exactConfiguredProjectRootAsync,
  getFolderHome,
  getProjectRegistrySnapshot,
  notifyFolderSwitch,
  removeRecentAsync,
  openProjectFolder,
  setRecentFavorite,
} from '../folder.ts';
import { filesystemPath } from '../filesystem-path.ts';
import { forgetFolderTurnChanges } from '../turn-changes.ts';
import { errorMessage, logger } from '../log.ts';
import { cancelFolderSyncsAndWait, deleteFolderRuntimeState, indexer } from '../state.ts';
import { clearRecordsUnder } from '../conversion-status.ts';
import { cancelConversionsUnderAndWait } from '../conversion.ts';
import { noteTreeChanged } from '../watcher.ts';
import { deleteDerivedForSource, deleteDerivedUnderFolder, type DerivedCleanupStats } from '../derived-store.ts';
import { stopAgentRuntimesForFolder } from '../agent-contract.ts';
import {
  projectOpenFolderRequestSchema,
  projectRemoveFolderRequestSchema,
} from '../../shared/protocols/http/project.ts';
import { GitHubImportError, importPublicGitHubRepository } from '../github-import.ts';

const log = logger('routes/folder');

function addDerivedCleanupStats(a: DerivedCleanupStats, b: DerivedCleanupStats): DerivedCleanupStats {
  return { sources: a.sources + b.sources, artifacts: a.artifacts + b.artifacts };
}

async function cleanupDerivedForFolder(folderAbs: string, retainedRoots: readonly string[]): Promise<DerivedCleanupStats> {
  let stats = deleteDerivedUnderFolder(folderAbs, retainedRoots);
  try {
    const indexed = await indexer.listDocuments(folderAbs);
    for (const sourcePath of indexed) {
      if (retainedRoots.some((root) => filesystemPath.contains(root, sourcePath))) continue;
      stats = addDerivedCleanupStats(stats, deleteDerivedForSource(sourcePath));
    }
  } catch (err: unknown) {
    log.warn(`derived cleanup: failed to list indexed files for ${folderAbs}: ${errorMessage(err)}`);
  }
  if (stats.artifacts > 0) {
    log.info(`derived cleanup: removed ${stats.artifacts} artifact(s) for ${stats.sources} source(s) under ${folderAbs}`);
  }
  return stats;
}

async function cleanupRemovedProjectFolder(abs: string): Promise<void> {
  const retainedRoots = await configuredDescendantProjectRootsAsync(abs);
  // Retire any in-flight MFS operation first so Remove cannot sit in a
  // half-cleared window state until the daemon's global watchdog fires.
  await cancelFolderSyncsAndWait(abs);
  const cancelled = await cancelConversionsUnderAndWait(abs, retainedRoots);
  if (cancelled.length) {
    log.info(`folder remove: cancelled ${cancelled.length} queued/running conversion(s) under ${abs}`);
  }
  try { clearRecordsUnder(abs, retainedRoots); }
  catch (err: unknown) { log.warn(`conversion-state cleanup failed for ${abs}: ${errorMessage(err)}`); }
  await cleanupDerivedForFolder(abs, retainedRoots);
  // Clear its index rows + unbind from the daemon. deletePathPrefix is
  // keyed by the absolute folder root.
  await indexer.deletePathPrefix(abs);
  try { await indexer.unbindFolder(abs); }
  catch (err: unknown) { log.warn(`unbind on remove failed for ${abs}: ${errorMessage(err)}`); }
  forgetFolderTurnChanges(abs, retainedRoots);
  // Best-effort secondary-cache cleanup (conversions / runtime warnings).
  try { await deleteFolderRuntimeState(abs); }
  catch (err: unknown) { log.warn(`runtime-state cleanup failed for ${abs}: ${errorMessage(err)}`); }
}

async function removeProjectFolder(rawPath: string): Promise<void> {
  const requested = filesystemPath.absolute(rawPath);
  const abs = await exactConfiguredProjectRootAsync(requested);
  if (!abs) {
    const err = new Error('folder is not in your folders');
    (err as { code?: string }).code = 'FOLDER_NOT_FOUND';
    (err as { status?: number }).status = 404;
    throw err;
  }
  const finishRemoval = await beginProjectFolderRemovalAsync(abs);
  try {
    // OpenQuill sessions are folder-pinned and survive window folder
    // switches, so removal must also end the sessions BOUND to this folder —
    // including ones in windows currently showing another folder. Do this
    // BEFORE releasing window folder contexts so the structured retirement
    // reason reaches the session first.
    stopAgentRuntimesForFolder(abs);
    await clearFolderPathAsync(abs);
    // Membership is the commit record. Keep it until every cleanup owner has
    // acknowledged completion; partial cleanup remains recoverable.
    await cleanupRemovedProjectFolder(abs);
    await removeRecentAsync(abs);
    noteTreeChanged();
  } finally {
    finishRemoval();
  }
}

export function mount(app: express.Express): void {
  app.get('/api/projects', async (_req, res) => {
    res.json(await getProjectRegistrySnapshot());
  });

  app.post('/api/projects/open', async (req, res) => {
    const request = projectOpenFolderRequestSchema.safeParse(req.body);
    if (!request.success) {
      res.status(400).json({ error: 'path required', code: 'INVALID_FOLDER' });
      return;
    }
    const controller = new AbortController();
    const closed = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', closed);
    try {
      const { changed, snapshot } = await openProjectFolder(request.data.path, controller.signal);
      const folderRoot = snapshot.current!.path;
      const windowId = currentWindowId();
      if (changed) {
        res.once('finish', () => notifyFolderSwitch(folderRoot, windowId));
      }
      telemetry.capture({ event: 'project_entry_result', outcome: 'success' });
      res.json(snapshot);
    } catch (err: unknown) {
      if (controller.signal.aborted || res.destroyed) return;
      telemetry.capture({ event: 'project_entry_result', outcome: 'failed' });
      if ((err as { code?: string })?.code === 'WINDOW_CLOSED') {
        res.status(410).json({ error: 'window is closed', code: 'WINDOW_CLOSED' });
        return;
      }
      sendFolderOperationError(res, err);
    } finally { res.removeListener('close', closed); }
  });

  app.post('/api/projects/remove', async (req, res) => {
    const request = projectRemoveFolderRequestSchema.safeParse(req.body);
    if (!request.success) {
      res.status(400).json({ error: 'path required', code: 'INVALID_FOLDER' });
      return;
    }
    try {
      await removeProjectFolder(request.data.path);
      res.json(await getProjectRegistrySnapshot());
    } catch (err: unknown) {
      sendFolderOperationError(res, err);
    }
  });

  // Close the current window's active folder. Idempotent: if this window
  // is already on Welcome, there is nothing to do. This keeps the
  // server-side window binding in lockstep with renderer goHome(), so
  // subsequent polls return NO_FOLDER instead of silently reviving the
  // previous folder.
  app.delete('/api/folder', (_req, res) => {
    try {
      clearCurrentFolder();
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  // Default folder home: where New Folder starts its native picker.
  // Read-only — there is no configurable folder home.
  app.get('/api/folder-home', async (_req, res) => {
    const root = getFolderHome();
    await fs.promises.mkdir(root, { recursive: true });
    res.json({ path: root });
  });

  // Receipts survive HTTP disconnection. Explicit cancellation, not losing a
  // response, owns cancellation for receipt-bearing clients.
  const imports = createProjectImportOperations<{ status: number; body: unknown }>();
  async function acquire(input: { url: string; folderName: string }, signal: AbortSignal) {
    try {
      return { status: 200, body: await importPublicGitHubRepository({ ...input, signal }) };
    } catch (err) {
      if (!(err instanceof GitHubImportError)) {
        return { status: 500, body: { code: 'LOCAL_IMPORT_FAILED', error: 'The local import failed.' } };
      }
      let destination;
      if (err.code === 'DESTINATION_EXISTS') {
        const target = path.join(getFolderHome(), input.folderName);
        const stat = await fs.promises.stat(target).catch(() => null);
        destination = stat ? { path: target, directory: stat.isDirectory() } : undefined;
      }
      return { status: err.status, body: {
        code: err.code, error: err.message,
        ...(destination ? { destination } : {}),
        ...(err.retainedPath ? { retainedPath: err.retainedPath } : {}),
      } };
    }
  }
  app.post('/api/github/import', async (req, res) => {
    const parsed = githubImportRequestSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ code: 'INVALID_GITHUB_URL', error: 'Invalid import request.' }); return; }
    const { operationId, ...input } = parsed.data;
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    if (!operationId) res.once('close', abort);
    try {
      const result = await (operationId
        ? imports.start(currentWindowId(), operationId, JSON.stringify(input), (signal) => acquire(input, signal))
        : acquire(input, controller.signal));
      if (!res.destroyed) res.status(result.status).json(result.body);
    } catch {
      if (!res.destroyed) res.status(409).json({ error: 'That receipt belongs to another import request.' });
    } finally { res.removeListener('close', abort); }
  });
  app.get('/api/github/import/:operationId', async (req, res) => {
    const receipt = imports.result(currentWindowId(), req.params.operationId);
    if (!receipt) { res.status(404).json({ code: 'OUTCOME_UNKNOWN', error: 'The import outcome is unknown.' }); return; }
    const result = await receipt;
    res.status(result.status).json(result.body);
  });
  app.delete('/api/github/import/:operationId', (req, res) => {
    imports.cancel(currentWindowId(), req.params.operationId, { status: 499, body: { code: 'IMPORT_CANCELLED', error: 'The import was cancelled.' } });
    res.json({ ok: true });
  });

  // Star / unstar a member folder. Pure project metadata — never touches
  // the folder on disk or its index. Powers the Welcome Favorites view.
  app.post('/api/folders/favorite', (req, res) => {
    try {
      const raw = typeof req.body?.path === 'string' ? req.body.path : '';
      if (!raw.trim()) return res.status(400).json({ error: 'path required' });
      if (typeof req.body?.favorite !== 'boolean') {
        return res.status(400).json({ error: 'favorite must be a boolean' });
      }
      const changed = setRecentFavorite(filesystemPath.absolute(raw), req.body.favorite);
      if (!changed) return res.status(404).json({ error: 'folder is not in your folders' });
      res.json({});
    } catch (err: unknown) {
      sendFolderOperationError(res, err);
    }
  });
}

function sendFolderOperationError(res: express.Response, err: unknown): void {
  const status = (err as { status?: unknown })?.status;
  const code = (err as { code?: unknown })?.code;
  if (typeof status === 'number' && status >= 400 && status <= 599) {
    res.status(status).json({
      error: errorMessage(err),
      ...(typeof code === 'string' ? { code } : {}),
    });
    return;
  }
  res.status(400).json({ error: errorMessage(err) });
}
