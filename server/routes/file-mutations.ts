import express from 'express';
import { getApiKey } from '../app-config.ts';
import { queueConvertibleSource } from '../conversion-dispatch.ts';
import { clearRecord } from '../conversion-status.ts';
import { deleteDerivedForSource } from '../derived-store.ts';
import { prepareFileOperation } from '../file-operation-guard.ts';
import { remapFileOrderPath, removeFileOrderPath } from '../file-order.ts';
import {
  deleteFile,
  derivedArtifactsForSource,
  detectFormat,
  isSameExistingPath,
  pathExists,
  readText,
  renameOnDisk,
  sanitizeFilename,
} from '../files.ts';
import { getCurrentFolder, runWithFolderRoot, toSourcePath } from '../folder.ts';
import { detectViewerFormat, isConvertibleSource } from '../format.ts';
import { sendError } from '../http.ts';
import { contentSizeError } from '../indexable.ts';
import { applyRenamePlan, planRenameLinks, type RenameEntry } from '../links.ts';
import { errorMessage, logger } from '../log.ts';
import { bundleRenameEntry, renameWithRollback } from '../rename-helpers.ts';
import { indexer } from '../state.ts';
import { noteTreeChanged } from '../watcher.ts';

const log = logger('routes/file-mutations');

export function mountFileMutationRoutes(app: express.Express): void {
  // Disk rename, link cascade, and index updates share one rollback ladder.
  // `async_index` responds after the disk move and pins background work to the
  // folder that owned the request.
  app.patch('/api/files/*', async (req, res) => {
    const oldName = (req.params as any)[0] as string;
    const requested = typeof req.body?.new_name === 'string' ? req.body.new_name.trim() : '';
    if (!requested) return res.status(400).json({ error: 'new_name required' });
    const oldFormat = detectViewerFormat(oldName);
    if (!oldFormat) return res.status(415).json({ error: 'unsupported format' });
    const requestFolderRoot = getCurrentFolder();
    if (!requestFolderRoot) return res.status(412).json({ error: 'no folder open', code: 'NO_FOLDER' });
    const oldStructuredFormat = detectFormat(oldName);
    const viewerOnly = !oldStructuredFormat && isConvertibleSource(oldName);
    let newName = requested;
    const requestedHasCompatibleExt = oldStructuredFormat
      ? detectFormat(newName) !== null
      : detectViewerFormat(newName) === oldFormat;
    if (!requestedHasCompatibleExt) {
      const oldExt = oldName.match(/\.[^./]+$/)?.[0] ?? '.md';
      newName += oldExt;
    }
    newName = renameTargetPath(oldName, newName);
    if (newName === oldName) return res.json({ name: oldName, linksUpdated: 0 });
    const oldViewerSourceAbs = viewerOnly ? toSourcePath(oldName) : null;
    const newViewerSourceAbs = viewerOnly ? toSourcePath(newName) : null;
    const content = viewerOnly ? null : readText(oldName);
    if (!viewerOnly && content == null) return res.status(404).json({ error: 'not found' });
    if (viewerOnly && !pathExists(oldName)) return res.status(404).json({ error: 'not found' });
    if (pathExists(newName) && !isSameExistingPath(oldName, newName)) {
      return res.status(409).json({ error: 'target exists' });
    }
    // Validate the mutation before cancelling expensive work. A typo or target
    // collision must not discard a transcription the user did not move.
    await prepareFileOperation(oldName);
    const oldDerivedArtifacts = derivedArtifactsForSource(oldName);
    const cascadeOn = req.body?.cascade !== false;
    const asyncIndex = req.body?.async_index === true;
    const renames: RenameEntry[] = [{ kind: 'file', old: oldName, new: newName }];
    const bundleEntry = bundleRenameEntry(oldName, newName, 'pre');
    if (bundleEntry) renames.push(bundleEntry);
    const linkPlan = cascadeOn ? planRenameLinks(renames) : [];
    let linksUpdated = 0;

    const updateLinksAndIndex = async (opts: { rollbackLinksOnFailure: boolean }): Promise<string | undefined> => {
      const applied = cascadeOn ? applyRenamePlan(linkPlan) : null;
      linksUpdated = applied?.updated.length ?? 0;
      try {
        if (applied?.failed.length) {
          throw new Error(`failed to update links in ${applied.failed.map((failure) => failure.name).join(', ')}`);
        }
        const reindexUpdatedLinks = async () => {
          for (const updated of applied?.updated ?? []) {
            if (updated.name === newName) continue;
            const body = readText(updated.name);
            if (body == null) continue;
            await indexer.upsertFile(toSourcePath(updated.name), body);
          }
        };
        if (viewerOnly) {
          const oldSourceAbs = oldViewerSourceAbs!;
          const newSourceAbs = newViewerSourceAbs!;
          clearRecord(oldSourceAbs);
          clearRecord(newSourceAbs);
          try { deleteDerivedForSource(oldSourceAbs); } catch (err: unknown) {
            log.warn(`rename: old derived cleanup failed for ${oldName}: ${errorMessage(err)}`);
          }
          try { deleteDerivedForSource(newSourceAbs); } catch (err: unknown) {
            log.warn(`rename: stale target derived cleanup failed for ${newName}: ${errorMessage(err)}`);
          }
          await indexer.deleteFile(oldSourceAbs).catch((err) => {
            log.warn(`rename: failed to remove old source index row ${oldName}: ${errorMessage(err)}`);
          });
          for (const rel of oldDerivedArtifacts.notes) {
            await indexer.deleteFile(toSourcePath(rel)).catch((err) => {
              log.warn(`rename: failed to remove legacy derived index row ${rel}: ${errorMessage(err)}`);
            });
          }
          if (getApiKey()) await reindexUpdatedLinks();
          return 'Searchable text is being regenerated in the background.';
        }
        if (!getApiKey()) {
          log.info(`rename: skipped index update for ${oldName} -> ${newName} because no OpenAI key is configured`);
          return 'Semantic index was not updated because no OpenAI API key is configured.';
        }
        const tooLarge = contentSizeError(content ?? '');
        if (tooLarge) {
          await indexer.deleteFile(toSourcePath(oldName)).catch((err) => {
            log.warn(`rename: failed to remove old index row for oversized file ${oldName}: ${errorMessage(err)}`);
          });
          log.warn(`rename: skipped index update for ${newName}: ${tooLarge}`);
          return `${tooLarge}. The file moved, but semantic search will skip it until you split or reduce it and run sync.`;
        }
        if (applied?.updated.length) await reindexUpdatedLinks();
        await indexer.renameFile(toSourcePath(oldName), toSourcePath(newName), content ?? '');
        return undefined;
      } catch (err) {
        if (opts.rollbackLinksOnFailure) applied?.rollback();
        throw err;
      }
    };

    if (asyncIndex) {
      try {
        renameOnDisk(oldName, newName);
      } catch (err: unknown) {
        sendError(res, err);
        return;
      }
      noteTreeChanged();
      try { remapFileOrderPath(oldName, newName, 'file'); }
      catch (err: unknown) { log.warn(`file-order remap failed for ${oldName} -> ${newName}: ${errorMessage(err)}`); }
      const warning = viewerOnly ? null : contentSizeError(content ?? '');
      const noKey = !getApiKey();
      res.json({
        name: newName,
        linksUpdated: linkPlan.length,
        indexDeferred: !warning && !noKey,
        indexWarning: warning
          ? `${warning}. The file moved, but semantic search will skip it until you split or reduce it and run sync.`
          : undefined,
      });
      void runWithFolderRoot(requestFolderRoot, () => updateLinksAndIndex({ rollbackLinksOnFailure: false }))
        .catch((err: unknown) => {
          log.warn(`rename: background index update failed for ${oldName} -> ${newName}: ${errorMessage(err)}`);
        })
        .finally(() => {
          if (newViewerSourceAbs) queueViewerConversion(oldFormat, newName, newViewerSourceAbs);
        });
      return;
    }

    let indexWarning: string | undefined;
    await renameWithRollback({
      kind: 'file',
      from: oldName,
      to: newName,
      res,
      doDisk: () => renameOnDisk(oldName, newName),
      undoDisk: () => {
        renameOnDisk(newName, oldName);
        if (oldViewerSourceAbs) {
          queueViewerConversion(oldFormat, oldName, oldViewerSourceAbs, 'rename rollback');
        }
      },
      doIndex: async () => {
        indexWarning = await updateLinksAndIndex({ rollbackLinksOnFailure: true });
      },
      okResponse: () => {
        if (newViewerSourceAbs) queueViewerConversion(oldFormat, newName, newViewerSourceAbs);
        noteTreeChanged();
        try { remapFileOrderPath(oldName, newName, 'file'); }
        catch (err: unknown) { log.warn(`file-order remap failed for ${oldName} -> ${newName}: ${errorMessage(err)}`); }
        return { name: newName, linksUpdated, indexWarning };
      },
    });
  });

  app.delete('/api/files/*', async (req, res) => {
    const name = (req.params as any)[0] as string;
    try {
      await prepareFileOperation(name);
      const sourceAbs = toSourcePath(name);
      const derivedArtifacts = derivedArtifactsForSource(name);
      const removed = deleteFile(name);
      try { deleteDerivedForSource(sourceAbs); }
      catch (err: unknown) { log.warn(`delete: derived cleanup failed for ${name}: ${errorMessage(err)}`); }
      if (removed) {
        noteTreeChanged();
        try { removeFileOrderPath(name, 'file'); }
        catch (err: unknown) { log.warn(`file-order cleanup failed for ${name}: ${errorMessage(err)}`); }
      }
      try { clearRecord(sourceAbs); }
      catch (err: unknown) { log.warn(`delete: preparation status cleanup failed for ${name}: ${errorMessage(err)}`); }
      res.json({ alreadyGone: !removed });
      for (const rel of [name, ...derivedArtifacts.notes]) {
        indexer.deleteFile(toSourcePath(rel)).catch((err) => {
          log.warn(`delete: index cleanup failed for ${rel}: ${errorMessage(err)}`);
        });
      }
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.post('/api/rename-preview', (req, res) => {
    const kind = req.body?.kind === 'folder' ? 'folder' : 'file';
    const oldPath = typeof req.body?.old === 'string' ? req.body.old.trim() : '';
    const newPath = typeof req.body?.new === 'string' ? req.body.new.trim() : '';
    if (!oldPath || !newPath) {
      return res.status(400).json({ error: 'old and new required' });
    }
    if (oldPath === newPath) {
      return res.json({ files: 0, links: 0 });
    }
    const renames: RenameEntry[] = [{ kind, old: oldPath, new: newPath }];
    if (kind === 'file') {
      const bundle = bundleRenameEntry(oldPath, newPath, 'pre');
      if (bundle) renames.push(bundle);
    }
    try {
      const plan = planRenameLinks(renames);
      res.json({
        files: plan.length,
        links: plan.reduce((total, entry) => total + entry.changes, 0),
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}

function renameTargetPath(oldName: string, requested: string): string {
  const normalizedRequest = requested.replace(/\\/g, '/');
  if (normalizedRequest.includes('/')) return sanitizeFilename(normalizedRequest);
  const lastSlash = oldName.lastIndexOf('/');
  const parent = lastSlash >= 0 ? oldName.slice(0, lastSlash + 1) : '';
  return sanitizeFilename(parent + normalizedRequest);
}

function queueViewerConversion(
  format: ReturnType<typeof detectViewerFormat>,
  name: string,
  sourceAbs: string,
  logContext = 'rename',
): void {
  try {
    if (!queueConvertibleSource(sourceAbs, name)) {
      log.warn(`${logContext}: no conversion owner for ${format ?? 'unknown'} source ${name}`);
    }
  } catch (err: unknown) {
    log.warn(`${logContext}: conversion kickoff failed for ${name}: ${errorMessage(err)}`);
  }
}
