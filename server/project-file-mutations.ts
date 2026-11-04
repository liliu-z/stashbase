import fs from 'node:fs';
import path from 'node:path';
import { queueConvertibleSource } from './conversion-dispatch.ts';
import { clearRecord } from './conversion-status.ts';
import { deleteDerivedForSource } from './derived-store.ts';
import { prepareFileOperation } from './file-operation-guard.ts';
import { saveTextFileContent } from './file-save.ts';
import {
  deleteFileAsync,
  pathExistsAsync,
  readTextAsync,
  renameOnDiskAsync,
} from './active-file-operations.ts';
import { filesystemPath } from './filesystem-path.ts';
import { isSameExistingPathAsync, resolveSafe, resolveSafeAsync } from './file-paths.ts';
import { runWithFolderRoot } from './folder.ts';
import { detectFormat, detectViewerFormat, isConvertibleSource } from './format.ts';
import { contentSizeError, isRetrievalEligiblePath, shouldIndexFilePath } from './indexable.ts';
import {
  normalizeProjectFilePath,
  routeError,
  validateProjectTextMutation,
  validateProjectWritableFolderRel,
} from './project-file-access.ts';
import { readProjectFile } from './project-file-reader.ts';
import { applyRenamePlanAsync, planRenameLinksAsync, type RenameEntry } from './links.ts';
import { errorCode, errorMessage, logger } from './log.ts';
import { bundleRenameEntryAsync } from './rename-helpers.ts';
import { indexer } from './state.ts';
import { noteTreeChanged } from './watcher.ts';
import { isWriteDiagnosticActive, writeDiagnosticEvidence, writeDiagnosticStep } from './write-diagnostic-context.ts';
import { writeDiagnosticTextMetrics } from './write-diagnostic-text.ts';

const log = logger('project-file-mutations');

export async function writeProjectFile(
  rawPath: unknown,
  content: string,
  opts: { baseVersion?: string } = {},
): Promise<{ path: string; version?: string; indexWarning?: string; changed: boolean }> {
  const target = await normalizeProjectFilePath(rawPath);
  writeDiagnosticStep('validation', 'validate_write_target_and_text', () => {
    validateProjectWritableFolderRel(target.folderRel);
    validateProjectTextMutation(content);
  }, { content: writeDiagnosticTextMetrics(content) });
  return runWithFolderRoot(target.folderRoot, async () => {
    const result = await saveTextFileContent(target.folderRel, content, opts);
    return { path: target.abs, version: result.version, indexWarning: result.indexWarning, changed: result.changed };
  });
}

export async function editProjectFile(
  rawPath: unknown,
  oldText: string,
  newText: string,
  opts: { replaceAll?: boolean; baseVersion?: string } = {},
): Promise<{ path: string; replacements: number; version?: string; indexWarning?: string; changed: boolean }> {
  const current = await readProjectFile(rawPath);
  const { next, replacements } = writeDiagnosticStep('edit_match', 'match_edit_text', () => {
    if (current.derived) {
      throw routeError('edit_file cannot edit derived PDF, DOCX or XLSX text; create or edit a UTF-8 text source file instead', 415, 'UNSUPPORTED_FORMAT');
    }
    const count = oldText ? countOccurrences(current.content, oldText) : Number(current.content === '');
    // These comparisons explain a refused literal edit; they never authorize a
    // replacement or retain either string in the diagnostic attachment.
    let normalizedCounts: Record<string, number> | null = null;
    if (count === 0 && oldText && isWriteDiagnosticActive()) {
      const normalizeLines = (text: string) => text.replace(/\r\n?/g, '\n');
      const sourceNfc = current.content.normalize('NFC');
      const needleNfc = oldText.normalize('NFC');
      normalizedCounts = {
        nfc: countOccurrences(sourceNfc, needleNfc),
        line_endings: countOccurrences(normalizeLines(current.content), normalizeLines(oldText)),
        nfc_and_line_endings: countOccurrences(normalizeLines(sourceNfc), normalizeLines(needleNfc)),
      };
    }
    writeDiagnosticEvidence('edit_match_result', {
      match_count: count,
      replace_all: opts.replaceAll === true,
      comparison: 'literal_utf16',
      normalization_applied: 'none',
      diagnostic_normalized_match_counts: normalizedCounts,
      source: writeDiagnosticTextMetrics(current.content),
      old_text: writeDiagnosticTextMetrics(oldText),
      new_text: writeDiagnosticTextMetrics(newText),
      read_version: current.version ?? null,
      request_version: opts.baseVersion ?? null,
    });
    if (!oldText) {
      if (count === 0) throw routeError('empty old_text only matches an empty file', 409, 'EDIT_MISMATCH');
      return { next: newText, replacements: 1 };
    }
    if (count === 0) throw routeError('old_text not found', 409, 'EDIT_MISMATCH');
    if (!opts.replaceAll && count > 1) {
      throw routeError('old_text matched multiple times; set replace_all=true or provide a more specific old_text', 409, 'EDIT_AMBIGUOUS');
    }
    return {
      next: opts.replaceAll ? current.content.split(oldText).join(newText) : current.content.replace(oldText, () => newText),
      replacements: opts.replaceAll ? count : 1,
    };
  });
  const written = await writeProjectFile(rawPath, next, { baseVersion: opts.baseVersion ?? current.version });
  return { ...written, replacements };
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(needle, offset);
    if (index < 0) return count;
    count++;
    offset = index + needle.length;
  }
}

export async function moveProjectFile(
  rawPath: unknown,
  rawNewPath: unknown,
  opts: { cascade?: boolean; allowOpaque?: boolean } = {},
): Promise<{ path: string; oldPath: string; linksUpdated: number; indexWarning?: string }> {
  const [oldTarget, newTarget] = await Promise.all([
    normalizeProjectFilePath(rawPath),
    normalizeProjectFilePath(rawNewPath),
  ]);
  if (!(await filesystemPath.equalAsync(oldTarget.folderRoot, newTarget.folderRoot))) {
    throw routeError('move_file currently supports moves within the same folder only', 400);
  }
  validateProjectWritableFolderRel(oldTarget.folderRel);
  validateProjectWritableFolderRel(newTarget.folderRel);
  return runWithFolderRoot(oldTarget.folderRoot, async () => {
    const oldFormat = detectViewerFormat(oldTarget.folderRel);
    const opaque = oldFormat == null;
    if (opaque && !opts.allowOpaque) throw routeError('unsupported format', 415, 'UNSUPPORTED_FORMAT');
    if (opaque && !isRegularFileNoFollow(oldTarget.folderRel)) {
      throw routeError('source is not a regular file', 415, 'UNSUPPORTED_FORMAT');
    }
    const oldStructuredFormat = detectFormat(oldTarget.folderRel);
    const newFormat = oldStructuredFormat ? detectFormat(newTarget.folderRel) : detectViewerFormat(newTarget.folderRel);
    if (!opaque && newFormat !== oldFormat) {
      throw routeError(`new_path must keep a ${oldFormat} extension`, 400);
    }
    // A workbench-only file has no format to validate against, so its
    // extension is the only identity a move must preserve.
    if (opaque && path.extname(newTarget.folderRel).toLocaleLowerCase() !== path.extname(oldTarget.folderRel).toLocaleLowerCase()) {
      throw routeError('new_path must keep the original extension', 400);
    }
    const viewerOnly = !opaque && !oldStructuredFormat && isConvertibleSource(oldTarget.folderRel);
    if (!(await pathExistsAsync(oldTarget.folderRel))) throw routeError('not found', 404);
    if ((await pathExistsAsync(newTarget.folderRel)) && !(await isSameExistingPathAsync(oldTarget.folderRel, newTarget.folderRel))) {
      throw routeError('target exists', 409);
    }
    await prepareFileOperation(oldTarget.folderRel);

    const renames: RenameEntry[] = [{ kind: 'file', old: oldTarget.folderRel, new: newTarget.folderRel }];
    const bundleEntry = await bundleRenameEntryAsync(oldTarget.folderRel, newTarget.folderRel, 'pre');
    if (bundleEntry) renames.push(bundleEntry);
    const cascadeOn = oldStructuredFormat !== 'json' && opts.cascade !== false;
    const linkPlan = cascadeOn ? await planRenameLinksAsync(renames) : [];
    await renameOnDiskAsync(oldTarget.folderRel, newTarget.folderRel);
    const applied = cascadeOn ? await applyRenamePlanAsync(linkPlan) : null;
    if (applied?.failed.length) {
      await applied.rollback();
      await renameOnDiskAsync(newTarget.folderRel, oldTarget.folderRel);
      throw routeError(`failed to update links in ${applied.failed.map((failure) => failure.name).join(', ')}`, 500);
    }
    noteTreeChanged();

    let indexWarning: string | undefined;
    try {
      const newPathIsRetrievalEligible = isRetrievalEligiblePath(newTarget.folderRel);
      if (opaque) {
        await indexer.deleteFile(oldTarget.abs).catch((err) => {
          log.warn(`project move: failed to remove opaque source index row ${oldTarget.abs}:`, err);
        });
        await indexer.deleteFile(newTarget.abs).catch((err) => {
          log.warn(`project move: failed to remove opaque target index row ${newTarget.abs}:`, err);
        });
      } else if (viewerOnly) {
        clearRecord(oldTarget.abs);
        clearRecord(newTarget.abs);
        try { deleteDerivedForSource(oldTarget.abs); } catch (err: unknown) {
          log.warn(`project move: old derived cleanup failed for ${oldTarget.abs}:`, err);
        }
        try { deleteDerivedForSource(newTarget.abs); } catch (err: unknown) {
          log.warn(`project move: stale target derived cleanup failed for ${newTarget.abs}:`, err);
        }
        await indexer.deleteFile(oldTarget.abs).catch((err) => {
          log.warn(`project move: failed to remove old source index row ${oldTarget.abs}:`, err);
        });
        if (newPathIsRetrievalEligible) {
          try {
            if (!queueConvertibleSource(newTarget.abs, newTarget.folderRel)) {
              throw new Error(`no conversion owner for ${oldFormat} source`);
            }
          } catch (err: unknown) {
            log.warn(`project move: conversion kickoff failed for ${newTarget.abs}:`, err);
          }
          indexWarning = 'Searchable text is being regenerated in the background.';
        }
      } else if (!newPathIsRetrievalEligible) {
        await indexer.deleteFile(oldTarget.abs).catch((err) => {
          log.warn(`project move: failed to remove hidden source index row ${oldTarget.abs}:`, err);
        });
        await indexer.deleteFile(newTarget.abs).catch((err) => {
          log.warn(`project move: failed to remove hidden target index row ${newTarget.abs}:`, err);
        });
      } else {
        const movedContent = (await readTextAsync(newTarget.folderRel)) ?? '';
        const tooLarge = contentSizeError(movedContent);
        if (tooLarge) {
          await indexer.deleteFile(oldTarget.abs).catch((err) => {
            log.warn(`project move: failed to remove old index row ${oldTarget.abs}:`, err);
          });
          indexWarning = `${tooLarge}. The file moved, but it won't be searchable until you split or reduce it and run sync.`;
        } else {
          await indexer.renameFile(oldTarget.abs, newTarget.abs, movedContent);
        }
      }
      for (const updated of applied?.updated ?? []) {
        if (updated.name === newTarget.folderRel) continue;
        if (!shouldIndexFilePath(updated.name)) {
          await indexer.deleteFile(filesystemPath.join(oldTarget.folderRoot, updated.name));
          continue;
        }
        const body = await readTextAsync(updated.name);
        if (body != null) await indexer.upsertFile(filesystemPath.join(oldTarget.folderRoot, updated.name), body);
      }
    } catch (err) {
      // The disk move is already valid. Report search-projection lag instead of
      // rolling it back after link rewrites have completed.
      await indexer.deleteFile(oldTarget.abs).catch((cleanupErr) => {
        log.warn(`project move: stale-source cleanup failed for ${oldTarget.abs}:`, cleanupErr);
      });
      indexWarning = `Moved, but the file couldn't be updated for search: ${errorMessage(err)}`;
    }
    return {
      oldPath: oldTarget.abs,
      path: newTarget.abs,
      linksUpdated: linkPlan.reduce((total, plan) => total + plan.changes, 0),
      indexWarning,
    };
  });
}

export async function deleteProjectFile(
  rawPath: unknown,
): Promise<{ path: string; alreadyGone: boolean; indexWarning?: string }> {
  const target = await normalizeProjectFilePath(rawPath);
  validateProjectWritableFolderRel(target.folderRel);
  return runWithFolderRoot(target.folderRoot, async () => {
    // Deletion owns a source path, not its preview or text format. Validate
    // containment even for missing files before cancelling work or cleaning up.
    const sourcePath = await resolveSafeAsync(target.folderRel, 'creatable', 'file');
    let stat: fs.Stats | undefined;
    try { stat = await fs.promises.lstat(sourcePath); }
    catch (err: unknown) {
      if (errorCode(err) !== 'ENOENT') throw err;
    }
    if (stat && !stat.isFile()) {
      throw routeError('source is not a regular file', 415, 'UNSUPPORTED_FORMAT');
    }
    if (stat) {
      const [physicalRoot, physicalSource] = await Promise.all([
        fs.promises.realpath(target.folderRoot),
        fs.promises.realpath(sourcePath),
      ]);
      const physicalRel = await filesystemPath.relativeAsync(physicalRoot, physicalSource);
      if (!physicalRel) throw routeError('file escapes folder through symlink', 403);
      // A directory alias must not hide a protected segment such as .git.
      validateProjectWritableFolderRel(physicalRel);
    }
    await prepareFileOperation(target.folderRel);
    const removed = await deleteFileAsync(target.folderRel);
    try { deleteDerivedForSource(target.abs); }
    catch (err: unknown) { log.warn(`project delete: derived cleanup failed for ${target.abs}:`, err); }
    try { clearRecord(target.abs); }
    catch (err: unknown) { log.warn(`project delete: preparation status cleanup failed for ${target.abs}:`, err); }
    if (removed) {
      noteTreeChanged();
    }
    let indexWarning: string | undefined;
    try { await indexer.deleteFile(target.abs); }
    catch (err: unknown) {
      log.warn(`project delete: index cleanup failed for ${target.abs}:`, err);
      indexWarning = 'Deleted, but search-data cleanup failed. Run sync to reconcile.';
    }
    return {
      path: target.abs,
      alreadyGone: !removed,
      ...(indexWarning ? { indexWarning } : {}),
    };
  });
}

function isRegularFileNoFollow(folderRel: string): boolean {
  try {
    return fs.lstatSync(resolveSafe(folderRel)).isFile();
  } catch {
    return false;
  }
}
