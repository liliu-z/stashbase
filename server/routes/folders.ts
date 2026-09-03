/**
 * Folder CRUD: create / delete (recursive) / rename. Rename uses the
 * shared `renameWithRollback` ladder + a cross-reference link cascade
 * so anchors elsewhere in the folder still resolve after the move.
 */
import express from 'express';
import {
  createFolderAsync,
  deleteFolderAsync,
  listIndexableTextFilesUnderAsync,
  isSameExistingPathAsync,
  pathExistsAsync,
  readTextAsync,
  renameFolderAsync,
  sanitizeFilename,
} from '../files.ts';
import { applyRenamePlanAsync, planRenameLinksAsync } from '../links.ts';
import { toSourcePath } from '../folder.ts';
import { isEmbeddingAvailable } from '../embedding-availability.ts';
import { errorMessage, logger } from '../log.ts';
import { indexer } from '../state.ts';
import { sendError } from '../http.ts';
import { renameWithRollback } from '../rename-helpers.ts';
import { noteTreeChanged } from '../watcher.ts';
import { remapFileOrderPath, removeFileOrderPath } from '../file-order.ts';
import { clearRecordsUnder } from '../conversion-status.ts';
import { cancelConversionsUnderAndWait } from '../conversion.ts';
import { discoverConvertibleSources } from '../conversion-dispatch.ts';
import { deleteDerivedUnderFolder } from '../derived-store.ts';
import {
  isRetrievalEligibleDirectoryPath,
  shouldIndexFilePath,
} from '../indexable.ts';

const log = logger('routes/folders');

function scheduleConversionRediscovery(sourcePrefix: string, displayPath: string): void {
  setImmediate(() => {
    void discoverConvertibleSources(sourcePrefix).catch((err: unknown) => {
      log.warn(`rename_folder: conversion rediscovery failed for ${displayPath}: ${errorMessage(err)}`);
    });
  });
}

export function mount(app: express.Express): void {
  app.post('/api/folders', async (req, res) => {
    const requested = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    if (!requested) return res.status(400).json({ error: 'path required' });
    try {
      const folderPath = sanitizeFilename(requested);
      if (!(await createFolderAsync(folderPath))) return res.status(409).json({ error: 'folder exists' });
      noteTreeChanged();
      res.json({ path: folderPath });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.delete('/api/folders/*', async (req, res) => {
    const p = (req.params as any)[0] as string;
    try {
      const sourcePrefix = toSourcePath(p);
      await cancelConversionsUnderAndWait(sourcePrefix);
      // Recursive delete on disk — the route layer trusts the UI's
      // confirm prompt to be the guardrail against "oops, I just
      // wiped a populated folder". Do not acknowledge completion until
      // the old semantic prefix has also been removed.
      try { deleteDerivedUnderFolder(sourcePrefix); }
      catch (err: unknown) { log.warn(`delete_prefix: derived cleanup failed for ${p}: ${errorMessage(err)}`); }
      const removed = await deleteFolderAsync(p);
      if (removed) {
        noteTreeChanged();
        try { removeFileOrderPath(p, 'folder'); }
        catch (err: unknown) { log.warn(`file-order cleanup failed for ${p}: ${errorMessage(err)}`); }
      }
      try { clearRecordsUnder(toSourcePath(p)); }
      catch (err: unknown) { log.warn(`delete_prefix: preparation status cleanup failed for ${p}: ${errorMessage(err)}`); }
      await indexer.deletePathPrefix(sourcePrefix);
      res.json({ alreadyGone: !removed });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Rename a folder. Body: { new_name }. `new_name` is the new basename
  // (kept in the same parent); cross-parent moves are out of scope. Disk
  // rename first, then bring the index along by re-embedding every file
  // under the old prefix at its new path (slow — see mfs.md §B3).
  // If the index step fails, roll back the disk rename.
  app.patch('/api/folders/*', async (req, res) => {
    const oldPath = (req.params as any)[0] as string;
    const requested = typeof req.body?.new_name === 'string' ? req.body.new_name.trim() : '';
    if (!requested) return res.status(400).json({ error: 'new_name required' });
    if (requested.includes('/')) {
      return res.status(400).json({ error: 'new_name must not contain "/"' });
    }
    const lastSlash = oldPath.lastIndexOf('/');
    const parent = lastSlash >= 0 ? oldPath.slice(0, lastSlash + 1) : '';
    const newPath = sanitizeFilename(parent + requested);
    if (newPath === oldPath) return res.json({ path: oldPath });
    if (!(await pathExistsAsync(oldPath))) return res.status(404).json({ error: 'source folder not found' });
    if ((await pathExistsAsync(newPath)) && !(await isSameExistingPathAsync(oldPath, newPath))) {
      return res.status(409).json({ error: 'target already exists' });
    }
    const oldSourcePrefix = toSourcePath(oldPath);
    const newSourcePrefix = toSourcePath(newPath);
    const oldPrefixIsRetrievalEligible = isRetrievalEligibleDirectoryPath(oldPath);
    const newPrefixIsRetrievalEligible = isRetrievalEligibleDirectoryPath(newPath);
    await cancelConversionsUnderAndWait(oldSourcePrefix);
    const cascadeOn = req.body?.cascade !== false;
    const linkPlan = cascadeOn
      ? await planRenameLinksAsync([{ kind: 'folder', old: oldPath, new: newPath }])
      : [];

    await renameWithRollback({
      kind: 'folder',
      from: oldPath,
      to: newPath,
      res,
      doDisk: () => renameFolderAsync(oldPath, newPath),
      undoDisk: async () => {
        await renameFolderAsync(newPath, oldPath);
        // A queued task may have observed the source missing while the index
        // update was in progress and retired its old identity. Re-scan the
        // restored prefix so rollback restores background work as well as disk.
        if (oldPrefixIsRetrievalEligible) scheduleConversionRediscovery(oldSourcePrefix, oldPath);
      },
      doIndex: async () => {
        const applied = cascadeOn ? await applyRenamePlanAsync(linkPlan) : null;
        try {
          if (applied?.failed.length) {
            throw new Error(`failed to update links in ${applied.failed.map((f) => f.name).join(', ')}`);
          }

          for (const updated of applied?.updated ?? []) {
            if (!shouldIndexFilePath(updated.name)) {
              await indexer.deleteFile(toSourcePath(updated.name));
            }
          }
          if (!isEmbeddingAvailable()) {
            if (!newPrefixIsRetrievalEligible) await indexer.deletePathPrefix(oldSourcePrefix);
            log.info(`rename_folder: skipped index update for ${oldPath} -> ${newPath} because no embedding key is configured`);
            return;
          }
          if (!newPrefixIsRetrievalEligible) {
            // The disk move is valid Workbench behavior, but the retrieval
            // owner must forget the old identity and must not traverse the
            // newly hidden subtree to build a replacement payload.
            await indexer.deletePathPrefix(oldSourcePrefix);
          } else {
            // Cascade BEFORE the index call so files whose links we rewrite
            // are embedded with their fresh content — saves a second round of
            // embed for everything inside the renamed folder.
            // Re-collect bodies from the new locations (cascade may have
            // rewritten some). renamePathPrefix's contract takes OLD-keyed
            // entries, so we map new → old names.
            const filesUnder = (await listIndexableTextFilesUnderAsync(newPath))
              .map((f) => ({
                // Indexer's renamePathPrefix takes OLD-keyed absolute paths.
                path: toSourcePath(oldPath + f.name.slice(newPath.length)),
                content: f.content,
              }));
            await indexer.renamePathPrefix(toSourcePath(oldPath), toSourcePath(newPath), filesUnder);
          }

          // Files OUTSIDE the renamed folder that had links rewritten
          // need a separate upsert — the prefix rename only touches rows
          // under oldPath.
          for (const u of applied?.updated ?? []) {
            if (u.name === newPath || u.name.startsWith(newPath + '/')) continue;
            if (!shouldIndexFilePath(u.name)) continue;
            const body = await readTextAsync(u.name);
            if (body == null) continue;
            await indexer.upsertFile(toSourcePath(u.name), body);
          }
        } catch (err) {
          await applied?.rollback();
          throw err;
        }
      },
      okResponse: () => {
        try { deleteDerivedUnderFolder(oldSourcePrefix); }
        catch (err: unknown) { log.warn(`rename_folder: old derived cleanup failed for ${oldPath}: ${errorMessage(err)}`); }
        if (newPrefixIsRetrievalEligible) scheduleConversionRediscovery(newSourcePrefix, newPath);
        noteTreeChanged();
        try { remapFileOrderPath(oldPath, newPath, 'folder'); }
        catch (err: unknown) { log.warn(`file-order remap failed for ${oldPath} -> ${newPath}: ${errorMessage(err)}`); }
        return { path: newPath };
      },
    });
  });
}
