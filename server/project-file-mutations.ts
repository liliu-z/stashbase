import fs from 'node:fs';
import path from 'node:path';
import { queueConvertibleSource } from './conversion-dispatch.ts';
import { clearRecord } from './conversion-status.ts';
import { deleteDerivedForSource } from './derived-store.ts';
import { prepareFileOperation } from './file-operation-guard.ts';
import { saveFileContent } from './file-save.ts';
import {
  deleteFileAsync,
  isSameExistingPathAsync,
  pathExistsAsync,
  readTextAsync,
  renameOnDiskAsync,
} from './files.ts';
import { filesystemPath } from './filesystem-path.ts';
import { resolveSafe } from './file-paths.ts';
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
import { errorMessage, logger } from './log.ts';
import { bundleRenameEntryAsync } from './rename-helpers.ts';
import { indexer } from './state.ts';
import { noteTreeChanged } from './watcher.ts';

const log = logger('project-file-mutations');

export async function writeProjectFile(
  rawPath: unknown,
  content: string,
  opts: { baseVersion?: string } = {},
): Promise<{ path: string; version?: string; indexWarning?: string }> {
  const target = await normalizeProjectFilePath(rawPath);
  validateProjectWritableFolderRel(target.folderRel);
  validateProjectTextMutation(content);
  return runWithFolderRoot(target.folderRoot, async () => {
    const result = await saveFileContent(target.folderRel, content, opts);
    return { path: target.abs, version: result.version, indexWarning: result.indexWarning };
  });
}

export async function editProjectFile(
  rawPath: unknown,
  oldText: string,
  newText: string,
  opts: { replaceAll?: boolean; baseVersion?: string } = {},
): Promise<{ path: string; replacements: number; version?: string; indexWarning?: string }> {
  const current = await readProjectFile(rawPath);
  if (current.derived) {
    throw routeError('edit_file cannot edit derived PDF/DOCX/audio text; create or edit a Markdown, HTML, JSON, or UTF-8 plain-text source file instead', 415, 'UNSUPPORTED_FORMAT');
  }
  if (!oldText) {
    if (current.content !== '') throw routeError('empty old_text only matches an empty file', 409, 'EDIT_MISMATCH');
    const written = await writeProjectFile(rawPath, newText, { baseVersion: opts.baseVersion ?? current.version });
    return { ...written, replacements: 1 };
  }
  const count = countOccurrences(current.content, oldText);
  if (count === 0) throw routeError('old_text not found', 409, 'EDIT_MISMATCH');
  if (!opts.replaceAll && count > 1) {
    throw routeError('old_text matched multiple times; set replace_all=true or provide a more specific old_text', 409, 'EDIT_AMBIGUOUS');
  }
  const next = opts.replaceAll
    ? current.content.split(oldText).join(newText)
    : current.content.replace(oldText, () => newText);
  const written = await writeProjectFile(rawPath, next, { baseVersion: opts.baseVersion ?? current.version });
  return { ...written, replacements: opts.replaceAll ? count : 1 };
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
          log.warn(`project move: failed to remove opaque source index row ${oldTarget.abs}: ${errorMessage(err)}`);
        });
        await indexer.deleteFile(newTarget.abs).catch((err) => {
          log.warn(`project move: failed to remove opaque target index row ${newTarget.abs}: ${errorMessage(err)}`);
        });
      } else if (viewerOnly) {
        clearRecord(oldTarget.abs);
        clearRecord(newTarget.abs);
        try { deleteDerivedForSource(oldTarget.abs); } catch (err: unknown) {
          log.warn(`project move: old derived cleanup failed for ${oldTarget.abs}: ${errorMessage(err)}`);
        }
        try { deleteDerivedForSource(newTarget.abs); } catch (err: unknown) {
          log.warn(`project move: stale target derived cleanup failed for ${newTarget.abs}: ${errorMessage(err)}`);
        }
        await indexer.deleteFile(oldTarget.abs).catch((err) => {
          log.warn(`project move: failed to remove old source index row ${oldTarget.abs}: ${errorMessage(err)}`);
        });
        if (newPathIsRetrievalEligible) {
          try {
            if (!queueConvertibleSource(newTarget.abs, newTarget.folderRel)) {
              throw new Error(`no conversion owner for ${oldFormat} source`);
            }
          } catch (err: unknown) {
            log.warn(`project move: conversion kickoff failed for ${newTarget.abs}: ${errorMessage(err)}`);
          }
          indexWarning = 'Searchable text is being regenerated in the background.';
        }
      } else if (!newPathIsRetrievalEligible) {
        await indexer.deleteFile(oldTarget.abs).catch((err) => {
          log.warn(`project move: failed to remove hidden source index row ${oldTarget.abs}: ${errorMessage(err)}`);
        });
        await indexer.deleteFile(newTarget.abs).catch((err) => {
          log.warn(`project move: failed to remove hidden target index row ${newTarget.abs}: ${errorMessage(err)}`);
        });
      } else {
        const movedContent = (await readTextAsync(newTarget.folderRel)) ?? '';
        const tooLarge = contentSizeError(movedContent);
        if (tooLarge) {
          await indexer.deleteFile(oldTarget.abs).catch((err) => {
            log.warn(`project move: failed to remove old index row ${oldTarget.abs}: ${errorMessage(err)}`);
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
        log.warn(`project move: stale-source cleanup failed for ${oldTarget.abs}: ${errorMessage(cleanupErr)}`);
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
  opts: { allowOpaque?: boolean } = {},
): Promise<{ path: string; alreadyGone: boolean; indexWarning?: string }> {
  const target = await normalizeProjectFilePath(rawPath);
  return runWithFolderRoot(target.folderRoot, async () => {
    if (!detectViewerFormat(target.folderRel) && !opts.allowOpaque) {
      throw routeError('unsupported format', 415, 'UNSUPPORTED_FORMAT');
    }
    if (pathEntryExistsNoFollow(target.folderRel) && !isRegularFileNoFollow(target.folderRel)) {
      throw routeError('source is not a regular file', 415, 'UNSUPPORTED_FORMAT');
    }
    await prepareFileOperation(target.folderRel);
    const removed = await deleteFileAsync(target.folderRel);
    try { deleteDerivedForSource(target.abs); }
    catch (err: unknown) { log.warn(`project delete: derived cleanup failed for ${target.abs}: ${errorMessage(err)}`); }
    try { clearRecord(target.abs); }
    catch (err: unknown) { log.warn(`project delete: preparation status cleanup failed for ${target.abs}: ${errorMessage(err)}`); }
    if (removed) {
      noteTreeChanged();
    }
    let indexWarning: string | undefined;
    try { await indexer.deleteFile(target.abs); }
    catch (err: unknown) {
      log.warn(`project delete: index cleanup failed for ${target.abs}: ${errorMessage(err)}`);
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

function pathEntryExistsNoFollow(folderRel: string): boolean {
  try {
    fs.lstatSync(resolveSafe(folderRel));
    return true;
  } catch {
    return false;
  }
}
