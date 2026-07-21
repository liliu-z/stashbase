import fs from 'node:fs';
import path from 'node:path';
import { derivedNoteFor, sourceForDerivedText } from './derived-store.ts';
import { memberRootForAbs, runWithFolderRoot } from './folder.ts';
import { filesystemPath } from './filesystem-path.ts';
import { detectFormat, detectViewerFormat } from './format.ts';
import { fileVersion, pathExists, readText } from './files.ts';
import { isConversionTextUnavailable } from './conversion.ts';
import { isAudioTranscriptTextUnavailable } from './audio-transcription.ts';
import { derivedHtmlPathForDocx } from './docx.ts';
import {
  normalizeLibraryFilePath,
  resolveLibraryAbs,
  routeError,
  type AgentContextFile,
} from './library-file-access.ts';

export interface LibraryFileRead {
  path: string;
  format: string;
  content: string;
  version?: string;
  sourceFormat?: string;
  readPath?: string;
  derived?: boolean;
}

export async function agentContextFile(rawPath: unknown): Promise<AgentContextFile> {
  const target = normalizeLibraryFilePath(rawPath);
  const folderName = path.basename(target.folderRoot);
  return runWithFolderRoot(target.folderRoot, async () => {
    const sourceFormat = detectViewerFormat(target.folderRel);
    if (!sourceFormat) throw routeError('unsupported format', 415, 'UNSUPPORTED_FORMAT');
    if (!pathExists(target.folderRel)) throw routeError('not found', 404);

    if (sourceFormat !== 'pdf' && sourceFormat !== 'docx' && sourceFormat !== 'audio') {
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
          : 'Structured text files are the readable source.',
      };
    }

    // Derived text lives in per-machine app data, so the built-in agent gets
    // an absolute read path while the visible source remains the identity.
    const derivedAbs = sourceFormat === 'docx'
      ? derivedHtmlPathForDocx(target.abs)
      : derivedNoteFor(target.abs);
    if (isConversionTextUnavailable(target.abs) || isAudioTranscriptTextUnavailable(target.abs)) {
      return {
        path: target.abs,
        folder: folderName,
        sourcePath: target.folderRel,
        readPath: target.folderRel,
        kind: 'direct',
        sourceFormat,
        available: false,
        reason: 'Searchable text is pending or preparation failed; retry after completion or reprocess the source.',
      };
    }
    if (!fs.existsSync(derivedAbs)) {
      return {
        path: target.abs,
        folder: folderName,
        sourcePath: target.folderRel,
        readPath: target.folderRel,
        kind: 'direct',
        sourceFormat,
        available: false,
        reason: sourceFormat === 'docx'
          ? 'No extracted HTML exists yet for this DOCX; retry after conversion if you need text context.'
          : sourceFormat === 'audio'
            ? 'No transcript exists yet for this audio file; install the selected local model or retry after transcription.'
            : 'No extracted Markdown exists yet for this PDF; retry after conversion if you need text context.',
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
        : sourceFormat === 'audio'
          ? 'Read the timestamped transcript Markdown (an absolute app-data path) first; the original audio stays as the source identity.'
          : 'Read the extracted Markdown note (an absolute app-data path) first for this PDF; use the original only when raw visual or binary detail is needed.',
    };
  });
}

export async function readLibraryFile(rawPath: unknown): Promise<LibraryFileRead> {
  const derived = normalizeDerivedReadPath(rawPath);
  if (derived) return derived;
  const target = normalizeLibraryFilePath(rawPath);
  return runWithFolderRoot(target.folderRoot, async () => {
    const format = detectFormat(target.folderRel);
    if (!format) {
      const viewerFormat = detectViewerFormat(target.folderRel);
      if (viewerFormat === 'pdf') {
        return readSourceDerivedFile(target.abs, target.folderRel, 'pdf');
      }
      if (viewerFormat === 'docx') {
        return readSourceDerivedFile(target.abs, target.folderRel, 'docx');
      }
      if (viewerFormat === 'audio') {
        return readSourceDerivedFile(target.abs, target.folderRel, 'audio');
      }
      if (viewerFormat === 'image') {
        throw routeError('read_file cannot return image bytes; image OCR text is used for search evidence, while the image remains the source file', 415, 'UNSUPPORTED_FORMAT');
      }
      throw routeError('unsupported format', 415, 'UNSUPPORTED_FORMAT');
    }
    const content = readText(target.folderRel);
    if (content == null) throw routeError('not found', 404);
    return {
      path: target.abs,
      format,
      content,
      version: fileVersion(target.folderRel) ?? undefined,
    };
  });
}

function readSourceDerivedFile(sourceAbs: string, folderRel: string, sourceFormat: 'pdf' | 'docx' | 'audio'): LibraryFileRead {
  const label = sourceFormat === 'docx' ? 'HTML' : 'Markdown';
  if (isConversionTextUnavailable(sourceAbs) || isAudioTranscriptTextUnavailable(sourceAbs)) {
    throw routeError(`extracted ${label} is pending or preparation failed; retry after completion or reprocess the ${sourceFormat.toUpperCase()}`, 409, 'CONVERSION_NOT_READY');
  }
  const derivedAbs = sourceFormat === 'docx'
    ? derivedHtmlPathForDocx(sourceAbs)
    : derivedNoteFor(sourceAbs);
  let content: string;
  try {
    content = fs.readFileSync(derivedAbs, 'utf8');
  } catch {
    throw routeError(`extracted ${label} is not available for this ${sourceFormat.toUpperCase()} yet; retry conversion or run reindex first`, 409, 'CONVERSION_NOT_READY');
  }
  return {
    path: sourceAbs,
    format: sourceFormat === 'docx' ? 'docx-derived-html' : sourceFormat === 'audio' ? 'audio-transcript-md' : 'pdf-derived-md',
    sourceFormat,
    readPath: derivedAbs,
    derived: true,
    content,
    version: fileVersion(folderRel) ?? undefined,
  };
}

function normalizeDerivedReadPath(rawPath: unknown): Promise<LibraryFileRead> | null {
  let abs: string;
  try {
    abs = resolveLibraryAbs(rawPath, { allowEmpty: false });
  } catch {
    return null;
  }
  const sourceAbs = sourceForDerivedText(abs);
  if (!sourceAbs) return null;
  const folderRoot = memberRootForAbs(sourceAbs);
  if (!folderRoot) {
    throw routeError('derived source is not in your folders (call library_info to list them)', 400);
  }
  return readDerivedLibraryFile(abs, sourceAbs, folderRoot);
}

function readDerivedLibraryFile(derivedAbs: string, sourceAbs: string, folderRoot: string): Promise<LibraryFileRead> {
  if (isConversionTextUnavailable(sourceAbs) || isAudioTranscriptTextUnavailable(sourceAbs)) {
    throw routeError('derived text is pending or preparation failed; retry after completion or reprocess the source', 409, 'CONVERSION_NOT_READY');
  }
  const folderRel = filesystemPath.relative(folderRoot, sourceAbs);
  if (folderRel == null || folderRel === '') {
    throw routeError('derived source path is invalid for its folder', 400);
  }
  const sourceFormat = detectViewerFormat(folderRel);
  if (sourceFormat !== 'pdf' && sourceFormat !== 'docx' && sourceFormat !== 'audio') {
    throw routeError('derived reads are only exposed for PDF/DOCX/audio text context', 403);
  }
  return runWithFolderRoot(folderRoot, async () => {
    return {
      path: sourceAbs,
      format: sourceFormat === 'docx' ? 'docx-derived-html' : sourceFormat === 'audio' ? 'audio-transcript-md' : 'pdf-derived-md',
      sourceFormat,
      readPath: derivedAbs,
      derived: true,
      content: readDerivedText(derivedAbs, sourceFormat),
      version: fileVersion(folderRel) ?? undefined,
    };
  });
}

function readDerivedText(derivedAbs: string, sourceFormat: 'pdf' | 'docx' | 'audio'): string {
  try {
    return fs.readFileSync(derivedAbs, 'utf8');
  } catch {
    throw routeError(sourceFormat === 'docx'
      ? 'extracted HTML is not available for this DOCX yet; retry conversion or run reindex first'
      : sourceFormat === 'audio'
        ? 'transcript Markdown is not available for this audio file yet; install a model or retry transcription first'
        : 'extracted Markdown is not available for this PDF yet; retry conversion or run reindex first', 409, 'CONVERSION_NOT_READY');
  }
}
