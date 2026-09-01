import fs from 'node:fs';
import path from 'node:path';
import { isEmbeddingAvailable } from './embedding-availability.ts';
import { queueConvertibleSource } from './conversion-dispatch.ts';
import { clearRecord } from './conversion-status.ts';
import { deleteDerivedForSource } from './derived-store.ts';
import { prepareFileOperation } from './file-operation-guard.ts';
import { saveFileContent } from './file-save.ts';
import {
  deleteFileAsync,
  derivedArtifactsForSource,
  isSameExistingPathAsync,
  pathExistsAsync,
  readTextAsync,
  renameOnDiskAsync,
} from './files.ts';
import { filesystemPath } from './filesystem-path.ts';
import { resolveSafe } from './file-paths.ts';
import { runWithFolderRoot } from './folder.ts';
import { detectFormat, detectViewerFormat, isConvertibleSource } from './format.ts';
import { contentSizeError } from './indexable.ts';
import { remapFileOrderPath, removeFileOrderPath } from './file-order.ts';
import {
  normalizeLibraryFilePath,
  routeError,
  validateLibraryWritableFolderRel,
} from './library-file-access.ts';
import { readLibraryFile } from './library-file-reader.ts';
import { applyRenamePlanAsync, planRenameLinksAsync, type RenameEntry } from './links.ts';
import { errorMessage, logger } from './log.ts';
import { bundleRenameEntryAsync } from './rename-helpers.ts';
import { indexer } from './state.ts';
import { noteTreeChanged } from './watcher.ts';

const log = logger('library-file-mutations');

/** Agent/file-tool writes are transport-independent text. C0 controls other
 * than normal text whitespace almost always mean a caller constructed Markdown
 * or LaTeX in an interpreted string literal (for example, `\frac` became form
 * feed + `rac`). Refuse the mutation instead of silently corrupting user data.
 */
function validateLibraryTextMutation(content: string): void {
  const match = content.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u);
  if (!match) return;
  const codePoint = match[0].codePointAt(0) ?? 0;
  const printable = `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
  throw routeError(
    `content contains unsupported control character ${printable}. ` +
    'This commonly happens when Markdown or LaTeX backslashes are interpreted by a JavaScript string. ' +
    'Construct the value with String.raw or escape each backslash; no file was changed.',
    400,
    'INVALID_TEXT_CONTENT',
  );
}

export async function writeLibraryFile(
  rawPath: unknown,
  content: string,
  opts: { baseVersion?: string } = {},
): Promise<{ path: string; version?: string; indexWarning?: string }> {
  const target = await normalizeLibraryFilePath(rawPath);
  validateLibraryWritableFolderRel(target.folderRel);
  validateLibraryTextMutation(content);
  return runWithFolderRoot(target.folderRoot, async () => {
    const result = await saveFileContent(target.folderRel, content, opts);
    return { path: target.abs, version: result.version, indexWarning: result.indexWarning };
  });
}

export async function editLibraryFile(
  rawPath: unknown,
  oldText: string,
  newText: string,
  opts: { replaceAll?: boolean; baseVersion?: string } = {},
): Promise<{ path: string; replacements: number; version?: string; indexWarning?: string }> {
  if (!oldText) throw routeError('old_text must not be empty', 400);
  const current = await readLibraryFile(rawPath);
  if (current.derived) {
    throw routeError('edit_file cannot edit derived PDF/DOCX/audio text; create or edit a Markdown, HTML, JSON, or UTF-8 plain-text source file instead', 415, 'UNSUPPORTED_FORMAT');
  }
  const count = countOccurrences(current.content, oldText);
  if (count === 0) throw routeError('old_text not found', 409, 'EDIT_MISMATCH');
  if (!opts.replaceAll && count > 1) {
    throw routeError('old_text matched multiple times; set replace_all=true or provide a more specific old_text', 409, 'EDIT_AMBIGUOUS');
  }
  const next = opts.replaceAll
    ? current.content.split(oldText).join(newText)
    : current.content.replace(oldText, newText);
  const written = await writeLibraryFile(rawPath, next, { baseVersion: opts.baseVersion ?? current.version });
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

export async function moveLibraryFile(
  rawPath: unknown,
  rawNewPath: unknown,
  opts: { cascade?: boolean; allowOpaque?: boolean } = {},
): Promise<{ path: string; oldPath: string; linksUpdated: number; indexWarning?: string }> {
  const [oldTarget, newTarget] = await Promise.all([
    normalizeLibraryFilePath(rawPath),
    normalizeLibraryFilePath(rawNewPath),
  ]);
  if (!(await filesystemPath.equalAsync(oldTarget.folderRoot, newTarget.folderRoot))) {
    throw routeError('move_file currently supports moves within the same folder only', 400);
  }
  validateLibraryWritableFolderRel(oldTarget.folderRel);
  validateLibraryWritableFolderRel(newTarget.folderRel);
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

    const oldDerivedArtifacts = derivedArtifactsForSource(oldTarget.folderRel);
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
    try { remapFileOrderPath(oldTarget.folderRel, newTarget.folderRel, 'file'); }
    catch (err: unknown) {
      log.warn(`library move: file-order remap failed for ${oldTarget.folderRel} -> ${newTarget.folderRel}: ${errorMessage(err)}`);
    }

    let indexWarning: string | undefined;
    try {
      if (opaque) {
        await indexer.deleteFile(oldTarget.abs).catch((err) => {
          log.warn(`library move: failed to remove opaque source index row ${oldTarget.abs}: ${errorMessage(err)}`);
        });
        await indexer.deleteFile(newTarget.abs).catch((err) => {
          log.warn(`library move: failed to remove opaque target index row ${newTarget.abs}: ${errorMessage(err)}`);
        });
      } else if (viewerOnly) {
        clearRecord(oldTarget.abs);
        clearRecord(newTarget.abs);
        try { deleteDerivedForSource(oldTarget.abs); } catch (err: unknown) {
          log.warn(`library move: old derived cleanup failed for ${oldTarget.abs}: ${errorMessage(err)}`);
        }
        try { deleteDerivedForSource(newTarget.abs); } catch (err: unknown) {
          log.warn(`library move: stale target derived cleanup failed for ${newTarget.abs}: ${errorMessage(err)}`);
        }
        await indexer.deleteFile(oldTarget.abs).catch((err) => {
          log.warn(`library move: failed to remove old source index row ${oldTarget.abs}: ${errorMessage(err)}`);
        });
        for (const rel of oldDerivedArtifacts.notes) {
          const sourcePath = filesystemPath.join(oldTarget.folderRoot, rel);
          await indexer.deleteFile(sourcePath).catch((err) => {
            log.warn(`library move: failed to remove legacy derived index row ${sourcePath}: ${errorMessage(err)}`);
          });
        }
        try {
          if (!queueConvertibleSource(newTarget.abs, newTarget.folderRel)) {
            throw new Error(`no conversion owner for ${oldFormat} source`);
          }
        } catch (err: unknown) {
          log.warn(`library move: conversion kickoff failed for ${newTarget.abs}: ${errorMessage(err)}`);
        }
        indexWarning = 'Searchable text is being regenerated in the background.';
      } else if (!isEmbeddingAvailable()) {
        await indexer.deleteFile(oldTarget.abs);
        indexWarning = "The file wasn't updated for Similarity Search because it isn't set up.";
      } else {
        const movedContent = (await readTextAsync(newTarget.folderRel)) ?? '';
        const tooLarge = contentSizeError(movedContent);
        if (tooLarge) {
          await indexer.deleteFile(oldTarget.abs).catch((err) => {
            log.warn(`library move: failed to remove old index row ${oldTarget.abs}: ${errorMessage(err)}`);
          });
          indexWarning = `${tooLarge}. The file moved, but it won't be available to Similarity Search until you split or reduce it and run sync.`;
        } else {
          await indexer.renameFile(oldTarget.abs, newTarget.abs, movedContent);
        }
      }
      for (const updated of applied?.updated ?? []) {
        if (!isEmbeddingAvailable()) break;
        if (updated.name === newTarget.folderRel) continue;
        const body = await readTextAsync(updated.name);
        if (body != null) await indexer.upsertFile(filesystemPath.join(oldTarget.folderRoot, updated.name), body);
      }
    } catch (err) {
      // The disk move is already valid. Report semantic-index lag instead of
      // rolling it back after link rewrites have completed.
      await indexer.deleteFile(oldTarget.abs).catch((cleanupErr) => {
        log.warn(`library move: stale-source cleanup failed for ${oldTarget.abs}: ${errorMessage(cleanupErr)}`);
      });
      indexWarning = `Moved, but the file couldn't be updated for Similarity Search: ${errorMessage(err)}`;
    }
    return {
      oldPath: oldTarget.abs,
      path: newTarget.abs,
      linksUpdated: linkPlan.reduce((total, plan) => total + plan.changes, 0),
      indexWarning,
    };
  });
}

export async function deleteLibraryFile(
  rawPath: unknown,
  opts: { allowOpaque?: boolean } = {},
): Promise<{ path: string; alreadyGone: boolean; indexWarning?: string }> {
  const target = await normalizeLibraryFilePath(rawPath);
  return runWithFolderRoot(target.folderRoot, async () => {
    if (!detectViewerFormat(target.folderRel) && !opts.allowOpaque) {
      throw routeError('unsupported format', 415, 'UNSUPPORTED_FORMAT');
    }
    if (pathEntryExistsNoFollow(target.folderRel) && !isRegularFileNoFollow(target.folderRel)) {
      throw routeError('source is not a regular file', 415, 'UNSUPPORTED_FORMAT');
    }
    await prepareFileOperation(target.folderRel);
    const derivedArtifacts = derivedArtifactsForSource(target.folderRel);
    const removed = await deleteFileAsync(target.folderRel);
    try { deleteDerivedForSource(target.abs); }
    catch (err: unknown) { log.warn(`library delete: derived cleanup failed for ${target.abs}: ${errorMessage(err)}`); }
    try { clearRecord(target.abs); }
    catch (err: unknown) { log.warn(`library delete: preparation status cleanup failed for ${target.abs}: ${errorMessage(err)}`); }
    if (removed) {
      noteTreeChanged();
      try { removeFileOrderPath(target.folderRel, 'file'); }
      catch (err: unknown) {
        log.warn(`library delete: file-order cleanup failed for ${target.folderRel}: ${errorMessage(err)}`);
      }
    }
    const failures: string[] = [];
    for (const rel of [target.folderRel, ...derivedArtifacts.notes]) {
      const sourcePath = filesystemPath.join(target.folderRoot, rel);
      try { await indexer.deleteFile(sourcePath); }
      catch (err: unknown) {
        failures.push(sourcePath);
        log.warn(`library delete: index cleanup failed for ${sourcePath}: ${errorMessage(err)}`);
      }
    }
    return {
      path: target.abs,
      alreadyGone: !removed,
      ...(failures.length ? { indexWarning: `Deleted, but Similarity Search cleanup failed for ${failures.length} path(s). Run sync to reconcile.` } : {}),
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
