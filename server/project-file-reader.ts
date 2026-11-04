import { readTextSnapshotAsync } from './text-file-transaction.ts';
import path from 'node:path';
import { derivedNoteFor, sourceForDerivedText } from './derived-store.ts';
import { runWithFolderRoot } from './folder.ts';
import { detectFormat, detectViewerFormat, isKnownBinaryFile } from './format.ts';
import {
  fileStatVersionAsync,
  pathExistsAsync,
  readFileBytesBoundedAsync,
  readUtf8FileBoundedAsync,
} from './active-file-operations.ts';
import { currentPreparedTextPathAsync } from './conversion-dispatch.ts';
import { derivedHtmlPathForDocx } from './docx.ts';
import { isSpreadsheetFile, spreadsheetAgentText, spreadsheetFilePreview } from './spreadsheet-preview.ts';
import {
  normalizeProjectFilePath,
  resolveProjectAbs,
  routeError,
  type AgentContextFile,
} from './project-file-access.ts';
import { writeDiagnosticStep } from './write-diagnostic-context.ts';

export interface ProjectFileRead {
  path: string;
  format: string;
  content: string;
  version?: string;
  sourceFormat?: string;
  readPath?: string;
  derived?: boolean;
  /** Present only when `content` is a line window rather than the whole file. */
  partial?: true;
  totalLines?: number;
  /** Offset to pass back for the next window; absent once the window ends the file. */
  nextOffset?: number;
}

/** A 1-based line window over an already-read file. */
export interface ProjectFileLineRange {
  offset?: number;
  limit?: number;
}

/** Parse one optional public read-window bound. HTTP query parameters arrive
 * as strings while MCP arguments arrive as numbers; both transports must
 * reject malformed supplied values instead of silently widening to a whole
 * file read. */
export function parseProjectFileLineBound(raw: unknown, name: 'offset' | 'limit'): number | undefined {
  if (raw === undefined) return undefined;
  if ((typeof raw !== 'string' && typeof raw !== 'number') || (typeof raw === 'string' && !raw.trim())) {
    throw routeError(`${name} must be a positive integer`, 400);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw routeError(`${name} must be a positive integer`, 400);
  }
  return value;
}

export async function agentContextFile(rawPath: unknown): Promise<AgentContextFile> {
  const target = await normalizeProjectFilePath(rawPath);
  const folderName = path.basename(target.folderRoot);
  return runWithFolderRoot(target.folderRoot, async () => {
    const sourceFormat = detectViewerFormat(target.folderRel) ?? 'generic';
    if (sourceFormat === 'audio') throw routeError('unsupported format', 415, 'UNSUPPORTED_FORMAT');
    if (!(await pathExistsAsync(target.folderRel))) throw routeError('not found', 404, 'FILE_NOT_FOUND');

    if (sourceFormat !== 'pdf' && sourceFormat !== 'docx') {
      return {
        path: target.abs,
        folder: folderName,
        sourcePath: target.folderRel,
        readPath: target.folderRel,
        kind: 'direct',
        sourceFormat,
        available: true,
        reason: sourceFormat === 'image'
          ? 'Images are read as the source image; OCR text is used for search indexing.'
          : sourceFormat === 'generic'
            ? 'The runtime reads this source using its available tools.'
            : 'Structured text files are the readable source.',
      };
    }

    const derivedAbs = await currentPreparedTextPathAsync(target.abs);
    if (!derivedAbs) {
      return {
        path: target.abs,
        folder: folderName,
        sourcePath: target.folderRel,
        readPath: target.folderRel,
        kind: 'direct',
        sourceFormat,
        available: false,
        reason: 'Current prepared text is unavailable; retry after preparation completes or reprocess the source.',
      };
    }

    return {
      path: target.abs,
      folder: folderName,
      sourcePath: target.folderRel,
      readPath: derivedAbs,
      kind: 'derived',
      sourceFormat,
      available: true,
      reason: sourceFormat === 'docx'
        ? 'Read the extracted HTML file (an absolute app-data path) first for this DOCX; the original DOCX stays as the source identity.'
          : 'Read the extracted Markdown note (an absolute app-data path) first for this PDF; use the original only when raw visual or binary detail is needed.',
    };
  });
}

export async function readProjectFile(
  rawPath: unknown,
  range?: ProjectFileLineRange,
): Promise<ProjectFileRead> {
  return applyLineRange(await readWholeProjectFile(rawPath), range);
}

/** Narrow an already-read file to a 1-based line window. Reading stays whole-file
 * and bounded by MAX_TEXT_READ_BYTES; this only bounds what the caller receives.
 * Because the slice happens after that bounded read, a source above the ceiling
 * stays unreadable in every window. Serving those would mean streaming the window
 * off disk, which costs TXT its whole-file UTF-8 validation. */
export function applyLineRange(
  read: ProjectFileRead,
  range?: ProjectFileLineRange,
): ProjectFileRead {
  if (range == null) return read;
  const offset = Math.max(1, Math.trunc(range?.offset ?? 1));
  const limit = range?.limit == null ? null : Math.max(0, Math.trunc(range.limit));

  const lines = read.content.split('\n');
  const endsWithNewline = lines.length > 1 && lines[lines.length - 1] === '';
  if (endsWithNewline) lines.pop();
  const totalLines = lines.length;

  const start = Math.min(offset - 1, totalLines);
  const end = limit == null ? totalLines : Math.min(start + limit, totalLines);
  const window = lines.slice(start, end);
  const content = window.length === 0
    ? ''
    : window.join('\n') + (end < totalLines || endsWithNewline ? '\n' : '');

  // A window must never be mistaken for the whole file: without the version
  // token it cannot be laundered into an optimistic full-file overwrite.
  const { version: _version, ...rest } = read;
  return {
    ...rest,
    content,
    partial: true,
    totalLines,
    ...(end < totalLines ? { nextOffset: end + 1 } : {}),
  };
}

async function readWholeProjectFile(rawPath: unknown): Promise<ProjectFileRead> {
  // Legacy context may retain a manifest-known AppData path. Recover its
  // source, then apply the same membership, containment, and freshness checks.
  let sourcePath = rawPath;
  try { sourcePath = sourceForDerivedText(resolveProjectAbs(rawPath)) ?? rawPath; }
  catch { /* Normal path validation below owns malformed-input errors. */ }
  const target = await normalizeProjectFilePath(sourcePath);
  return runWithFolderRoot(target.folderRoot, () => writeDiagnosticStep('read', 'read_project_source', async () => {
    const format = detectFormat(target.folderRel);
    if (!format) {
      const viewerFormat = detectViewerFormat(target.folderRel);
      if (viewerFormat === 'pdf') {
        return readSourceDerivedFile(target.abs, target.folderRel, 'pdf');
      }
      if (viewerFormat === 'docx') {
        return readSourceDerivedFile(target.abs, target.folderRel, 'docx');
      }
      if (viewerFormat === 'image') {
        throw routeError('read_file cannot return image bytes; image OCR text is used for search evidence, while the image remains the source file', 415, 'UNSUPPORTED_FORMAT');
      }
      if (isSpreadsheetFile(target.folderRel)) return readSpreadsheetFile(target.abs, target.folderRel);
      if (isKnownBinaryFile(target.folderRel)) throw routeError('unsupported format: binary files cannot be read as text', 415, 'UNSUPPORTED_FORMAT');
    }
    const snapshot = await readTextSnapshotAsync(target.folderRel);
    if (snapshot == null) throw routeError('not found', 404, 'FILE_NOT_FOUND');
    return {
      path: target.abs,
      format: format ?? 'txt',
      ...snapshot,
    };
  }, { path: target.abs, purpose: 'existing_source' }));
}

/** The workbook through the same parse the preview uses, as Markdown with
 *  sheet names, column letters and row numbers. The source stays untouched. */
async function readSpreadsheetFile(sourceAbs: string, folderRel: string): Promise<ProjectFileRead> {
  if (!(await pathExistsAsync(folderRel))) throw routeError('not found', 404, 'FILE_NOT_FOUND');
  const preview = await spreadsheetFilePreview(await readFileBytesBoundedAsync(sourceAbs), folderRel);
  if (preview.kind !== 'spreadsheet') {
    throw routeError(preview.kind === 'invalid-spreadsheet' && preview.message ? preview.message : 'This workbook could not be read.', 422, 'UNSUPPORTED_FORMAT');
  }
  return {
    path: sourceAbs,
    format: 'xlsx-derived-md',
    sourceFormat: 'xlsx',
    derived: true,
    content: spreadsheetAgentText(path.basename(sourceAbs), preview.workbook),
    version: preview.version,
  };
}

async function readSourceDerivedFile(
  sourceAbs: string,
  folderRel: string,
  sourceFormat: 'pdf' | 'docx',
): Promise<ProjectFileRead> {
  const label = sourceFormat === 'docx' ? 'HTML' : 'Markdown';
  if (!(await pathExistsAsync(folderRel))) throw routeError('not found', 404, 'FILE_NOT_FOUND');
  const derivedAbs = sourceFormat === 'docx'
    ? derivedHtmlPathForDocx(sourceAbs)
    : derivedNoteFor(sourceAbs);
  let content: string;
  try {
    content = await readUtf8FileBoundedAsync(derivedAbs);
  } catch (err) {
    if ((err as { code?: unknown })?.code === 'FILE_TOO_LARGE') throw err;
    throw routeError(`extracted ${label} is not available for this ${sourceFormat.toUpperCase()} yet; retry conversion or run reindex first`, 409, 'CONVERSION_NOT_READY');
  }
  if (!await currentPreparedTextPathAsync(sourceAbs)) {
    throw routeError('Current prepared text is unavailable; retry after preparation completes or reprocess the source', 409, 'CONVERSION_NOT_READY');
  }
  return {
    path: sourceAbs,
    format: sourceFormat === 'docx' ? 'docx-derived-html' : 'pdf-derived-md',
    sourceFormat,
    readPath: derivedAbs,
    derived: true,
    content,
    version: (await fileStatVersionAsync(folderRel)) ?? undefined,
  };
}
