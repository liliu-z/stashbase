/**
 * Folder-management routes: open / create the active folder and list
 * recent folders.
 *
 * These are the only data routes that work BEFORE a folder is open —
 * they live outside the `requireFolder` prefix gate. The `onSwitch`
 * listener wired in `server/state.ts` takes over once a folder is set
 * to bind the indexer and kick off the background sync.
 */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCurrentFolderBasename } from '../files.ts';
import {
  clearFolderPathAsync,
  beginLibraryFolderRemovalAsync,
  clearCurrentFolder,
  currentWindowId,
  ensureFolderHome,
  getCurrentFolder,
  getCurrentFolderLabel,
  getFolderHome,
  getRecentFolders,
  exactMemberFolderRootAsync,
  notifyFolderSwitch,
  removeRecentAsync,
  setCurrentFolder,
  setRecentFavorite,
  validateFolderName,
} from '../folder.ts';
import { filesystemPath } from '../filesystem-path.ts';
import { errorMessage, logger } from '../log.ts';
import { cancelFolderSyncsAndWait, deleteFolderRuntimeState, indexer } from '../state.ts';
import { clearRecordsUnder } from '../conversion-status.ts';
import { cancelConversionsUnderAndWait } from '../conversion.ts';
import { noteTreeChanged } from '../watcher.ts';
import { deleteDerivedForSource, deleteDerivedUnderFolder, type DerivedCleanupStats } from '../derived-store.ts';
import { deleteFileOrderForRoot } from '../file-order.ts';
import { stopAgentRuntimeForFolder } from '../agent-contract.ts';

const log = logger('routes/folder');

function addDerivedCleanupStats(a: DerivedCleanupStats, b: DerivedCleanupStats): DerivedCleanupStats {
  return { sources: a.sources + b.sources, artifacts: a.artifacts + b.artifacts };
}

async function cleanupDerivedForFolder(folderAbs: string): Promise<DerivedCleanupStats> {
  let stats = deleteDerivedUnderFolder(folderAbs);
  try {
    const indexed = await indexer.listFiles(folderAbs);
    for (const sourcePath of Object.keys(indexed)) {
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

async function cleanupRemovedLibraryFolder(abs: string): Promise<void> {
  // A large semantic `scan_diff` runs inside the single-threaded Python
  // daemon and otherwise serializes every cleanup request behind it. Retire
  // that reconcile first so Remove cannot sit in a half-cleared window state
  // until the daemon's global ten-minute watchdog fires.
  await cancelFolderSyncsAndWait(abs);
  const cancelled = await cancelConversionsUnderAndWait(abs);
  if (cancelled.length) {
    log.info(`folder remove: cancelled ${cancelled.length} queued/running conversion(s) under ${abs}`);
  }
  try { clearRecordsUnder(abs); }
  catch (err: unknown) { log.warn(`conversion-state cleanup failed for ${abs}: ${errorMessage(err)}`); }
  try { deleteFileOrderForRoot(abs); }
  catch (err: unknown) { log.warn(`file-order cleanup failed for ${abs}: ${errorMessage(err)}`); }
  await cleanupDerivedForFolder(abs);
  // Clear its index rows + unbind from the daemon. deletePathPrefix is
  // keyed by the absolute folder root.
  await indexer.deletePathPrefix(abs);
  try { await indexer.unbindFolder(abs); }
  catch (err: unknown) { log.warn(`unbind on remove failed for ${abs}: ${errorMessage(err)}`); }
  // Best-effort secondary-cache cleanup (conversions / runtime warnings).
  try { await deleteFolderRuntimeState(abs); }
  catch (err: unknown) { log.warn(`runtime-state cleanup failed for ${abs}: ${errorMessage(err)}`); }
}

export function mount(app: express.Express): void {
  // List the open + recent folders. Powers the Welcome screen. Includes
  // homeDir so the renderer can shorten `/Users/<name>/foo` to `~/foo`
  // (less personal info in screenshots).
  app.get('/api/folder', (_req, res) => {
    const current = getCurrentFolder();
    res.json({
      current: current ? { path: filesystemPath.absolute(current), name: getCurrentFolderLabel() ?? path.basename(current) } : null,
      recent: getRecentFolders(),
      homeDir: os.homedir(),
    });
  });

  // Switch to a different folder. Accepts either `{ path }` (any local
  // folder) or `{ name }` (a direct child of the default StashBase home,
  // used by switch / rename flows). Returns immediately; the indexer
  // catches up in the background via `state.ts:onSwitch`.
  app.post('/api/folder', async (req, res) => {
    const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const rawPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    if (!rawName && !rawPath) return res.status(400).json({ error: 'name or path required' });
    // `create:true` is supported for compatibility, but the primary New
    // Folder UI uses the native OS dialog and then opens the selected path.
    const create = req.body?.create === true;
    const exclusiveCreate = req.body?.exclusiveCreate === true;
    let target = rawPath;
    if (rawName) {
      const bad = validateFolderName(rawName);
      if (bad) return res.status(400).json({ error: bad });
      target = path.join(getFolderHome(), rawName);
    }
    try {
      const changed = setCurrentFolder(target, { create, exclusiveCreate });
      const folderRoot = getCurrentFolder()!;
      const windowId = currentWindowId();
      if (changed) {
        res.once('finish', () => notifyFolderSwitch(folderRoot, windowId));
      }
      res.json({ current: { path: filesystemPath.absolute(folderRoot), name: getCurrentFolderLabel() ?? getCurrentFolderBasename() } });
    } catch (err: unknown) {
      if ((err as any)?.code === 'WINDOW_CLOSED') {
        return res.status(410).json({ error: 'window is closed', code: 'WINDOW_CLOSED' });
      }
      if ((err as any)?.code === 'FOLDER_EXISTS') {
        return res.status(409).json({ error: errorMessage(err), code: 'FOLDER_EXISTS' });
      }
      if ((err as any)?.code === 'FOLDER_REMOVING') {
        return res.status(409).json({ error: errorMessage(err), code: 'FOLDER_REMOVING' });
      }
      res.status(400).json({ error: errorMessage(err) });
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

  // Default folder home: where New Folder starts its native picker and
  // where the built-in manual is seeded. Read-only — there is no
  // configurable folder home.
  app.get('/api/folder-home', (_req, res) => {
    const root = getFolderHome();
    if (!fs.existsSync(root)) ensureFolderHome();
    res.json({ path: getFolderHome() });
  });

  // Star / unstar a member folder. Pure library metadata — never touches
  // the folder on disk or its index. Powers the Welcome Favorites view.
  app.post('/api/folders/favorite', (req, res) => {
    try {
      const raw = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      if (!raw) return res.status(400).json({ error: 'path required' });
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

  // Remove a folder from the library ("Your Folders"). UNLIKE
  // current-folder directory deletes, this NEVER touches the folder on disk
  // — it only forgets the folder: unbind it from the daemon, drop its semantic
  // index rows, clear runtime caches, and remove it from membership. The
  // user's files are left exactly as they are (folder-model integrity
  // constraint: opening/removing a folder must not mutate its contents).
  // The renderer confirms before calling.
  app.post('/api/folders/remove', async (req, res) => {
    try {
      const raw = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      if (!raw) return res.status(400).json({ error: 'path required' });
      const requested = filesystemPath.absolute(raw);
      const abs = await exactMemberFolderRootAsync(requested);
      if (!abs) {
        return res.status(404).json({ error: 'folder is not in your folders' });
      }
      const finishRemoval = await beginLibraryFolderRemovalAsync(abs);
      try {
        // Built-in Agent sessions are folder-pinned and survive window folder
        // switches, so removal must also end the sessions BOUND to this folder
        // — including ones in windows currently showing another folder. Do
        // this BEFORE releasing window folder contexts: that release invokes
        // the generic window-close teardown, whose raw socket close would
        // otherwise erase the structured scope-retirement reason.
        stopAgentRuntimeForFolder('claude', abs);
        stopAgentRuntimeForFolder('codex', abs);
        // Tear down every live window bound to the member after its affected
        // Agent sessions have received the precise retirement event.
        await clearFolderPathAsync(abs);
        // Membership is the commit record. Keep it until every cleanup owner
        // has acknowledged completion; a failure leaves the member recoverable
        // and the next reconcile can rebuild any partially-cleared cache.
        await cleanupRemovedLibraryFolder(abs);
        await removeRecentAsync(abs);
        noteTreeChanged();
        res.json({});
      } finally {
        finishRemoval();
      }
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
