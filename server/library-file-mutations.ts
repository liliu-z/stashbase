import { getApiKey } from './app-config.ts';
import { queueConvertibleSource } from './conversion-dispatch.ts';
import { clearRecord } from './conversion-status.ts';
import { deleteDerivedForSource } from './derived-store.ts';
import { prepareFileOperation } from './file-operation-guard.ts';
import { saveFileContent } from './file-save.ts';
import {
  deleteFile,
  derivedArtifactsForSource,
  isSameExistingPath,
  pathExists,
  readText,
  renameOnDisk,
} from './files.ts';
import { filesystemPath } from './filesystem-path.ts';
import { runWithFolderRoot } from './folder.ts';
import { detectFormat, detectViewerFormat, isConvertibleSource } from './format.ts';
import { contentSizeError } from './indexable.ts';
import {
  normalizeLibraryFilePath,
  routeError,
  validateLibraryWritableFolderRel,
} from './library-file-access.ts';
import { readLibraryFile } from './library-file-reader.ts';
import { applyRenamePlan, planRenameLinks, type RenameEntry } from './links.ts';
import { errorMessage, logger } from './log.ts';
import { indexer } from './state.ts';

const log = logger('library-file-mutations');

export async function writeLibraryFile(
  rawPath: unknown,
  content: string,
  opts: { baseVersion?: string } = {},
): Promise<{ path: string; version?: string; indexWarning?: string }> {
  const target = normalizeLibraryFilePath(rawPath);
  validateLibraryWritableFolderRel(target.folderRel);
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
    throw routeError('edit_file cannot edit derived PDF/DOCX/audio text; create or edit a Markdown/HTML source file instead', 415, 'UNSUPPORTED_FORMAT');
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
  opts: { cascade?: boolean } = {},
): Promise<{ path: string; oldPath: string; linksUpdated: number; indexWarning?: string }> {
  const oldTarget = normalizeLibraryFilePath(rawPath);
  const newTarget = normalizeLibraryFilePath(rawNewPath);
  if (!filesystemPath.equal(oldTarget.folderRoot, newTarget.folderRoot)) {
    throw routeError('move_file currently supports moves within the same folder only', 400);
  }
  validateLibraryWritableFolderRel(newTarget.folderRel);
  return runWithFolderRoot(oldTarget.folderRoot, async () => {
    const oldFormat = detectViewerFormat(oldTarget.folderRel);
    if (!oldFormat) throw routeError('unsupported format', 415, 'UNSUPPORTED_FORMAT');
    const oldStructuredFormat = detectFormat(oldTarget.folderRel);
    const newFormat = oldStructuredFormat ? detectFormat(newTarget.folderRel) : detectViewerFormat(newTarget.folderRel);
    if (newFormat !== oldFormat) {
      throw routeError(`new_path must keep a ${oldFormat} extension`, 400);
    }
    const viewerOnly = !oldStructuredFormat && isConvertibleSource(oldTarget.folderRel);
    const content = viewerOnly ? null : readText(oldTarget.folderRel);
    if (!viewerOnly && content == null) throw routeError('not found', 404);
    if (viewerOnly && !pathExists(oldTarget.folderRel)) throw routeError('not found', 404);
    if (pathExists(newTarget.folderRel) && !isSameExistingPath(oldTarget.folderRel, newTarget.folderRel)) {
      throw routeError('target exists', 409);
    }
    await prepareFileOperation(oldTarget.folderRel);

    const oldDerivedArtifacts = derivedArtifactsForSource(oldTarget.folderRel);
    const renames: RenameEntry[] = [{ kind: 'file', old: oldTarget.folderRel, new: newTarget.folderRel }];
    const linkPlan = opts.cascade === false ? [] : planRenameLinks(renames);
    renameOnDisk(oldTarget.folderRel, newTarget.folderRel);
    const applied = opts.cascade === false ? null : applyRenamePlan(linkPlan);
    if (applied?.failed.length) {
      applied.rollback();
      renameOnDisk(newTarget.folderRel, oldTarget.folderRel);
      throw routeError(`failed to update links in ${applied.failed.map((failure) => failure.name).join(', ')}`, 500);
    }

    let indexWarning: string | undefined;
    try {
      if (viewerOnly) {
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
      } else if (!getApiKey()) {
        indexWarning = 'Semantic index was not updated because no OpenAI API key is configured.';
      } else {
        const movedContent = readText(newTarget.folderRel) ?? content ?? '';
        const tooLarge = contentSizeError(movedContent);
        if (tooLarge) {
          await indexer.deleteFile(oldTarget.abs).catch((err) => {
            log.warn(`library move: failed to remove old index row ${oldTarget.abs}: ${errorMessage(err)}`);
          });
          indexWarning = `${tooLarge}. The file moved, but semantic search will skip it until you split or reduce it and run sync.`;
        } else {
          await indexer.renameFile(oldTarget.abs, newTarget.abs, movedContent);
        }
      }
      for (const updated of applied?.updated ?? []) {
        if (!getApiKey()) break;
        if (updated.name === newTarget.folderRel) continue;
        const body = readText(updated.name);
        if (body != null) await indexer.upsertFile(filesystemPath.join(oldTarget.folderRoot, updated.name), body);
      }
    } catch (err) {
      // The disk move is already valid. Report semantic-index lag instead of
      // rolling it back after link rewrites have completed.
      indexWarning = `Moved, but semantic index update failed: ${errorMessage(err)}`;
    }
    return {
      oldPath: oldTarget.abs,
      path: newTarget.abs,
      linksUpdated: linkPlan.reduce((total, plan) => total + plan.changes, 0),
      indexWarning,
    };
  });
}

export async function deleteLibraryFile(rawPath: unknown): Promise<{ path: string; alreadyGone: boolean }> {
  const target = normalizeLibraryFilePath(rawPath);
  return runWithFolderRoot(target.folderRoot, async () => {
    await prepareFileOperation(target.folderRel);
    const derivedArtifacts = derivedArtifactsForSource(target.folderRel);
    const removed = deleteFile(target.folderRel);
    try { deleteDerivedForSource(target.abs); }
    catch (err: unknown) { log.warn(`library delete: derived cleanup failed for ${target.abs}: ${errorMessage(err)}`); }
    try { clearRecord(target.abs); }
    catch (err: unknown) { log.warn(`library delete: preparation status cleanup failed for ${target.abs}: ${errorMessage(err)}`); }
    if (removed && getApiKey()) {
      for (const rel of [target.folderRel, ...derivedArtifacts.notes]) {
        const sourcePath = filesystemPath.join(target.folderRoot, rel);
        indexer.deleteFile(sourcePath).catch((err) => {
          log.warn(`library delete: index cleanup failed for ${sourcePath}: ${errorMessage(err)}`);
        });
      }
    }
    return { path: target.abs, alreadyGone: !removed };
  });
}
