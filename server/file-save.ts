import { normalizeFolderRelativePath } from './folder-relative-path.ts';
import { toSourcePath } from './folder.ts';
import { detectFormat, isDerivedNoteName } from './format.ts';
import { fileChanged, readTextSnapshotAsync, replaceTextSnapshotAsync, withTextFileTransaction } from './text-file-transaction.ts';
import { contentSizeError, shouldIndexFilePath } from './indexable.ts';
import { errorMessage, logger } from './log.ts';
import { preserveTextSourceFormat } from './markdown-source-format.ts';
import { indexer } from './state.ts';
import { noteTreeChanged } from './watcher.ts';

const log = logger('file-save');

function fileWriteError(message: string, status = 400, code = 'INVALID_FILE_WRITE'): Error {
  const err = new Error(message);
  (err as any).status = status;
  (err as any).code = code;
  return err;
}

export function validateEditableFileWrite(name: string): void {
  let normalized: string;
  try {
    normalized = normalizeFolderRelativePath(name, { writable: true, allowQuotes: true });
  } catch (err: unknown) {
    throw fileWriteError(errorMessage(err));
  }
  if (isDerivedNoteName(normalized)) {
    throw fileWriteError('cannot edit app-maintained derived notes');
  }
  if (!detectFormat(normalized)) {
    throw fileWriteError('unsupported editable format', 415, 'UNSUPPORTED_FORMAT');
  }
}

export async function upsertSavedFile(name: string, content: string): Promise<string | undefined> {
  // Saves under hidden or excluded directories (reachable once hidden files
  // are shown in the Workbench) stay outside the index. Delete any row from a
  // formerly visible identity immediately; waiting for reconcile would leave
  // hidden content available to Search or Chat after an edit.
  try {
    if (!shouldIndexFilePath(name)) {
      await indexer.deleteFile(toSourcePath(name));
      log.info(`save: removed/skipped index update for ${name} because the path is not indexable`);
      return undefined;
    }
    if (!content.trim()) {
      await indexer.deleteFile(toSourcePath(name));
      return undefined;
    }
    const tooLarge = contentSizeError(content);
    if (tooLarge) {
      await indexer.deleteFile(toSourcePath(name));
      log.warn(`save: skipped index update for ${name}: ${tooLarge}`);
      return `${tooLarge}. This file won't be searchable until you split or reduce it and run sync.`;
    }
    await indexer.upsertFile(toSourcePath(name), content, { waitForIndex: false });
    return undefined;
  } catch (err: unknown) {
    const message = errorMessage(err);
    log.warn(`save: index update failed for ${name}: ${message}`);
    return `Saved, but the file couldn't be updated for search: ${message}`;
  }
}

export async function saveFileContent(
  name: string,
  content: string,
  opts: { baseVersion?: string } = {},
): Promise<{ content: string; indexWarning?: string; version?: string; changed: boolean }> {
  validateEditableFileWrite(name);
  return withTextFileTransaction(name, async () => {
    const previous = await readTextSnapshotAsync(name);
    const format = detectFormat(name);
    const savedContent = format === 'md' || format === 'json' || format === 'txt'
      ? preserveTextSourceFormat(previous?.content ?? '', content)
      : content;
    // A byte-identical retry succeeds even if its original baseline is stale.
    if (previous?.content === savedContent) {
      return { ...previous, changed: false, indexWarning: await upsertSavedFile(name, savedContent) };
    }
    if (opts.baseVersion !== undefined && previous?.version !== opts.baseVersion) {
      throw fileChanged(previous?.version ?? null);
    }
    const saved = await replaceTextSnapshotAsync(name, savedContent, previous?.version ?? null);
    noteTreeChanged();
    const indexWarning = await upsertSavedFile(name, saved.content);
    return { ...saved, changed: true, indexWarning };
  });
}
