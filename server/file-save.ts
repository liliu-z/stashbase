import { normalizeFolderRelativePath } from './folder-relative-path.ts';
import { getCurrentFolder, toSourcePath } from './folder.ts';
import { detectEditableTextFormat, detectFormat, isDelimitedTextFile, isDerivedNoteName, isKnownBinaryFile } from './format.ts';
import { fileChanged, readTextSnapshotAsync, replaceTextSnapshotAsync, withTextFileTransaction } from './text-file-transaction.ts';
import { contentSizeError, shouldIndexFilePath } from './indexable.ts';
import { errorMessage, logger } from './log.ts';
import { preserveTextSourceFormat } from './markdown-source-format.ts';
import { indexer } from './state.ts';
import { noteTreeChanged } from './watcher.ts';
import { writeDiagnosticEvidence, writeDiagnosticStep } from './write-diagnostic-context.ts';
import { writeDiagnosticTextMetrics } from './write-diagnostic-text.ts';
import { diagnoseFileWrite } from './write-diagnostics.ts';

const log = logger('file-save');

function fileWriteError(message: string, status = 400, code = 'INVALID_FILE_WRITE'): Error {
  const err = new Error(message);
  (err as any).status = status;
  (err as any).code = code;
  return err;
}

export function validateEditableFileWrite(name: string): void {
  validateTextFileWrite(name);
  if (!detectEditableTextFormat(name)) {
    throw fileWriteError('unsupported editable format', 415, 'UNSUPPORTED_FORMAT');
  }
}

function validateTextFileWrite(name: string): void {
  let normalized: string;
  try {
    normalized = normalizeFolderRelativePath(name, { writable: true, allowQuotes: true });
  } catch (err: unknown) {
    throw fileWriteError(errorMessage(err));
  }
  if (isDerivedNoteName(normalized)) {
    throw fileWriteError('cannot edit app-maintained derived notes', 400, 'DERIVED_PATH_FORBIDDEN');
  }
  if (isKnownBinaryFile(normalized)) {
    throw fileWriteError('unsupported editable format: binary files cannot be written as text', 415, 'UNSUPPORTED_FORMAT');
  }
}

export async function upsertSavedFile(name: string, content: string): Promise<string | undefined> {
  // Explicit Agent text access does not make source code/configuration
  // retrievable or require an index daemon to save it.
  if (!detectFormat(name)) return undefined;
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
      log.info(`save: skipped index update for ${name}: ${tooLarge}`);
      return `${tooLarge}. This file won't be searchable until you split or reduce it and run sync.`;
    }
    await indexer.upsertFile(toSourcePath(name), content, { waitForIndex: false });
    return undefined;
  } catch (err: unknown) {
    const message = errorMessage(err);
    log.warn(`save: index update failed for ${name}:`, err);
    return `Saved, but the file couldn't be updated for search: ${message}`;
  }
}

export async function saveFileContent(
  name: string,
  content: string,
  opts: { baseVersion?: string } = {},
): Promise<{ content: string; indexWarning?: string; version?: string; changed: boolean }> {
  return diagnoseFileWrite({ operation: 'write', path: name, origin: 'http', session_root: getCurrentFolder() }, () => {
    writeDiagnosticStep('validation', 'validate_document_file_write', () => validateEditableFileWrite(name), { path: name });
    return saveTextFileContent(name, content, opts);
  });
}

/** Agent/MCP text writes share document transactions, not editor capabilities.
 * Keep the supplied path intact, including dotfiles and extensionless names. */
export async function saveTextFileContent(
  name: string,
  content: string,
  opts: { baseVersion?: string } = {},
): Promise<{ content: string; indexWarning?: string; version?: string; changed: boolean }> {
  writeDiagnosticStep('validation', 'validate_text_file_write', () => validateTextFileWrite(name), { path: name });
  return withTextFileTransaction(name, async () => {
    const previous = await readTextSnapshotAsync(name, 'write_previous');
    const format = detectFormat(name);
    const savedContent = format !== 'html'
      ? preserveTextSourceFormat(previous?.content ?? '', content, {
          keepUnchangedLineEndings: isDelimitedTextFile(name),
        })
      : content;
    writeDiagnosticEvidence('source_format_preservation', {
      format: format ?? 'generic',
      normalization_applied: format === 'html' ? 'none' : isDelimitedTextFile(name) ? 'preserve_unchanged_line_endings_and_bom' : 'preserve_dominant_line_ending_and_bom',
      input: writeDiagnosticTextMetrics(content),
      saved: writeDiagnosticTextMetrics(savedContent),
      content_transformed: savedContent !== content,
    });
    // A byte-identical retry succeeds even if its original baseline is stale.
    if (previous?.content === savedContent) {
      writeDiagnosticEvidence('unchanged_save', {
        request_version: opts.baseVersion ?? null, read_version: previous.version,
        version_check: 'not_required_identical_content', changed: false,
      });
      return { ...previous, changed: false, indexWarning: await upsertSavedFile(name, savedContent) };
    }
    writeDiagnosticStep('version_check', 'check_requested_version', () => {
      if (opts.baseVersion !== undefined && (previous?.version ?? 'absent') !== opts.baseVersion) {
        throw fileChanged(previous?.version ?? null);
      }
    }, {
      request_version: opts.baseVersion ?? null,
      read_version: previous?.version ?? null,
      comparison_version: previous?.version ?? 'absent',
      required: opts.baseVersion !== undefined,
    });
    const saved = await replaceTextSnapshotAsync(name, savedContent, previous?.version ?? null);
    // Rewriting an existing file leaves the visible tree unchanged; bumping it
    // here made every autosave refetch and rebuild the whole project listing.
    if (!previous) noteTreeChanged();
    const indexWarning = await upsertSavedFile(name, saved.content);
    return { ...saved, changed: true, indexWarning };
  });
}
