/**
 * Folder CRUD: create / delete (recursive) / rename. Rename uses the
 * shared `renameWithRollback` ladder + a cross-reference link cascade
 * so anchors elsewhere in the folder still resolve after the move.
 */
import express from 'express';
import {
  createFolder,
  deleteFolder,
  listIndexableTextFilesUnder,
  listFiles,
  isSameExistingPath,
  pathExists,
  readText,
  renameFolder,
  sanitizeFilename,
} from '../files.ts';
import { applyRenamePlan, planRenameLinks } from '../links.ts';
import { toSourcePath } from '../folder.ts';
import { getApiKey } from '../app-config.ts';
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

const log = logger('routes/folders');

function scheduleConversionRediscovery(sourcePrefix: string, displayPath: string): void {
  setImmediate(() => {
    try {
      discoverConvertibleSources(sourcePrefix);
    } catch (err: unknown) {
      log.warn(`rename_folder: conversion rediscovery failed for ${displayPath}: ${errorMessage(err)}`);
    }
  });
}

export function mount(app: express.Express): void {
  app.post('/api/folders', (req, res) => {
    const requested = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    if (!requested) return res.status(400).json({ error: 'path required' });
    try {
      const folderPath = sanitizeFilename(requested);
      if (!createFolder(folderPath)) return res.status(409).json({ error: 'folder exists' });
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
      // wiped a populated folder". Index cleanup fires async so we
      // can respond fast (same fire-and-forget pattern as file delete).
      try { deleteDerivedUnderFolder(sourcePrefix); }
      catch (err: unknown) { log.warn(`delete_prefix: derived cleanup failed for ${p}: ${errorMessage(err)}`); }
      const removed = deleteFolder(p);
      if (removed) {
        noteTreeChanged();
        try { removeFileOrderPath(p, 'folder'); }
        catch (err: unknown) { log.warn(`file-order cleanup failed for ${p}: ${errorMessage(err)}`); }
      }
      try { clearRecordsUnder(toSourcePath(p)); }
      catch (err: unknown) { log.warn(`delete_prefix: preparation status cleanup failed for ${p}: ${errorMessage(err)}`); }
      res.json({ alreadyGone: !removed });
      indexer.deletePathPrefix(toSourcePath(p)).catch((err) => {
        log.warn(`delete_prefix: index cleanup failed for ${p}: ${errorMessage(err)}`);
      });
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
    if (!pathExists(oldPath)) return res.status(404).json({ error: 'source folder not found' });
    if (pathExists(newPath) && !isSameExistingPath(oldPath, newPath)) {
      return res.status(409).json({ error: 'target already exists' });
    }
    const oldSourcePrefix = toSourcePath(oldPath);
    const newSourcePrefix = toSourcePath(newPath);
    await cancelConversionsUnderAndWait(oldSourcePrefix);
    const cascadeOn = req.body?.cascade !== false;
    const linkPlan = cascadeOn ? planRenameLinks([{ kind: 'folder', old: oldPath, new: newPath }]) : [];

    await renameWithRollback({
      kind: 'folder',
      from: oldPath,
      to: newPath,
      res,
      doDisk: () => renameFolder(oldPath, newPath),
      undoDisk: () => {
        renameFolder(newPath, oldPath);
        // A queued task may have observed the source missing while the index
        // update was in progress and retired its old identity. Re-scan the
        // restored prefix so rollback restores background work as well as disk.
        scheduleConversionRediscovery(oldSourcePrefix, oldPath);
      },
      doIndex: async () => {
        const applied = cascadeOn ? applyRenamePlan(linkPlan) : null;
        try {
          if (applied?.failed.length) {
            throw new Error(`failed to update links in ${applied.failed.map((f) => f.name).join(', ')}`);
          }

          if (!getApiKey()) {
            log.info(`rename_folder: skipped index update for ${oldPath} -> ${newPath} because no OpenAI key is configured`);
            return;
          }
          // Cascade BEFORE the index call so files whose links we rewrite
          // are embedded with their fresh content — saves a second round of
          // embed for everything inside the renamed folder.
          // Re-collect bodies from the new locations (cascade may have
          // rewritten some). renamePathPrefix's contract takes OLD-keyed
          // entries, so we map new → old names.
          const filesUnder = listIndexableTextFilesUnder(newPath)
            .map((f) => ({
              // Indexer's renamePathPrefix takes OLD-keyed absolute paths.
              path: toSourcePath(oldPath + f.name.slice(newPath.length)),
              content: f.content,
            }));
          await indexer.renamePathPrefix(toSourcePath(oldPath), toSourcePath(newPath), filesUnder);

          // Files OUTSIDE the renamed folder that had links rewritten
          // need a separate upsert — the prefix rename only touches rows
          // under oldPath.
          for (const u of applied?.updated ?? []) {
            if (u.name === newPath || u.name.startsWith(newPath + '/')) continue;
            const body = readText(u.name);
            if (body == null) continue;
            await indexer.upsertFile(toSourcePath(u.name), body);
          }
        } catch (err) {
          applied?.rollback();
          throw err;
        }
      },
      okResponse: () => {
        try { deleteDerivedUnderFolder(oldSourcePrefix); }
        catch (err: unknown) { log.warn(`rename_folder: old derived cleanup failed for ${oldPath}: ${errorMessage(err)}`); }
        scheduleConversionRediscovery(newSourcePrefix, newPath);
        noteTreeChanged();
        try { remapFileOrderPath(oldPath, newPath, 'folder'); }
        catch (err: unknown) { log.warn(`file-order remap failed for ${oldPath} -> ${newPath}: ${errorMessage(err)}`); }
        return { path: newPath };
      },
    });
  });
}
