import { getApiKey } from './app-config.ts';
import { normalizeFolderRelativePath } from './folder-relative-path.ts';
import { toSourcePath } from './folder.ts';
import { detectFormat, isDerivedNoteName } from './format.ts';
import { fileVersion, readText, saveText } from './files.ts';
import { contentSizeError } from './indexable.ts';
import { errorMessage, logger } from './log.ts';
import { preserveMarkdownSourceFormat } from './markdown-source-format.ts';
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
  if (!getApiKey()) {
    log.info(`save: skipped index update for ${name} because no OpenAI key is configured`);
    return undefined;
  }
  if (!content.trim()) {
    await indexer.deleteFile(toSourcePath(name)).catch((err) => {
      log.warn(`save: failed to remove empty file from index ${name}: ${errorMessage(err)}`);
    });
    return undefined;
  }
  const tooLarge = contentSizeError(content);
  if (tooLarge) {
    await indexer.deleteFile(toSourcePath(name)).catch((err) => {
      log.warn(`save: failed to remove oversized file from index ${name}: ${errorMessage(err)}`);
    });
    log.warn(`save: skipped index update for ${name}: ${tooLarge}`);
    return `${tooLarge}. Semantic search will skip it until you split or reduce it and run sync.`;
  }
  try {
    await indexer.upsertFile(toSourcePath(name), content);
    return undefined;
  } catch (err: unknown) {
    const message = errorMessage(err);
    log.warn(`save: index update failed for ${name}: ${message}`);
    return `Saved, but semantic index update failed: ${message}`;
  }
}

export async function saveFileContent(
  name: string,
  content: string,
  opts: { baseVersion?: string } = {},
): Promise<{ content: string; indexWarning?: string; version?: string }> {
  validateEditableFileWrite(name);
  const format = detectFormat(name);
  if (opts.baseVersion !== undefined) {
    const currentVersion = fileVersion(name);
    if (currentVersion !== opts.baseVersion) {
      const currentContent = readText(name);
      const serializedContent = format === 'md'
        ? preserveMarkdownSourceFormat(currentContent ?? '', content)
        : content;
      if (currentContent === serializedContent) {
        return { content: serializedContent, version: currentVersion ?? undefined };
      }
      const err = new Error('file changed on disk; reload before saving');
      (err as any).code = 'FILE_CHANGED';
      (err as any).currentVersion = currentVersion;
      throw err;
    }
  }
  // CodeMirror stores its document with LF line separators. Markdown source
  // still owns its byte-level presentation: retain a leading UTF-8 BOM and
  // serialize edits using the source's uniform (or dominant mixed) ending.
  const previousContent = format === 'md' ? readText(name) : null;
  const savedContent = format === 'md'
    ? preserveMarkdownSourceFormat(previousContent ?? '', content)
    : content;
  if (previousContent !== null && savedContent === previousContent) {
    return { content: savedContent, version: fileVersion(name) ?? undefined };
  }
  saveText(name, savedContent);
  const indexWarning = await upsertSavedFile(name, savedContent);
  noteTreeChanged();
  return { content: savedContent, indexWarning, version: fileVersion(name) ?? undefined };
}
