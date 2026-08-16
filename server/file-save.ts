import { isEmbeddingAvailable } from './embedding-availability.ts';
import { normalizeFolderRelativePath } from './folder-relative-path.ts';
import { toSourcePath } from './folder.ts';
import { detectFormat, isDerivedNoteName } from './format.ts';
import { fileVersion, readText, saveText } from './files.ts';
import { contentSizeError } from './indexable.ts';
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
  if (!isEmbeddingAvailable()) {
    log.info(`save: skipped index update for ${name} because semantic embedding is unavailable`);
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
    return `${tooLarge}. AI Index will skip it until you split or reduce it and run sync.`;
  }
  try {
    await indexer.upsertFile(toSourcePath(name), content);
    return undefined;
  } catch (err: unknown) {
    const message = errorMessage(err);
    log.warn(`save: index update failed for ${name}: ${message}`);
    return `Saved, but AI Index update failed: ${friendlyIndexError(err)}`;
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
      const serializedContent = format === 'md' || format === 'json' || format === 'csv'
        ? preserveTextSourceFormat(currentContent ?? '', content)
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
  // CodeMirror stores its document with LF line separators. Editable raw text
  // still owns its byte-level presentation: retain a leading UTF-8 BOM and
  // serialize edits using the source's uniform (or dominant mixed) ending.
  const preservesSourceFormat = format === 'md' || format === 'json' || format === 'csv';
  const previousContent = preservesSourceFormat ? readText(name) : null;
  const savedContent = preservesSourceFormat
    ? preserveTextSourceFormat(previousContent ?? '', content)
    : content;
  if (previousContent !== null && savedContent === previousContent) {
    return { content: savedContent, version: fileVersion(name) ?? undefined };
  }
  saveText(name, savedContent);
  const indexWarning = await upsertSavedFile(name, savedContent);
  noteTreeChanged();
  return { content: savedContent, indexWarning, version: fileVersion(name) ?? undefined };
}

/** Translate raw indexing / embedding API errors into user-facing guidance.
 *  The server log retains the raw detail; the toast shows only this string. */
export function friendlyIndexError(err: unknown): string {
  const status = extractHttpStatus(err);
  if (status === 401 || status === 403) {
    return 'Your API key is invalid or expired. Check Settings → AI / Index.';
  }
  if (status === 429) {
    return 'Rate limit reached — the index will catch up on the next sync.';
  }
  const msg = errorMessage(err);
  // Strip the verbose `Error code: 4xx - {…}` wrapper the OpenAI SDK produces.
  if (/^Error code: \d/i.test(msg)) {
    const inner = msg.replace(/^Error code: \d+ - /i, '').trim();
    // Try to extract a readable `message` from the JSON payload.
    try {
      const parsed = JSON.parse(inner.replace(/'/g, '"'));
      if (parsed?.error?.message) return String(parsed.error.message);
    } catch { /* fall through */ }
  }
  return msg;
}

function extractHttpStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const status = (err as Record<string, unknown>).status ?? (err as Record<string, unknown>).statusCode;
    if (typeof status === 'number') return status;
    // OpenAI SDK errors carry a top-level `.status` property.
    const msg = errorMessage(err);
    const match = /^Error code: (\d+)/i.exec(msg);
    if (match) return Number(match[1]);
  }
  return undefined;
}
