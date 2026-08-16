import {
  AUDIO_SOURCE_EXTENSIONS, CSV_DATA_EXTENSIONS, DOCX_EXTENSIONS, HTML_NOTE_EXTENSIONS,
  IMAGE_SOURCE_EXTENSIONS, PDF_EXTENSIONS, STRUCTURED_DATA_EXTENSIONS,
} from '../../../../shared/file-formats.ts';
import type { FileGlyphFormat } from '../FileTree';
import type { Attachment } from './types';

/** The muted type glyph + short label for a file, keyed off the filename
 *  extension. Reuses the file tree's format vocabulary so a PDF reads the
 *  same glyph in the composer, the transcript, library search hits, and the
 *  tree — and stays de-coloured (`FileTypeIcon` renders in `currentColor`),
 *  the same restraint that keeps a column of files quiet. Unknown types fall
 *  back to the generic document glyph and the bare uppercased extension. */
export function fileGlyphFormat(name: string): { format: FileGlyphFormat; label: string } {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const label = ext ? ext.toUpperCase() : 'File';
  if (PDF_EXTENSIONS.includes(ext as never)) return { format: 'pdf', label };
  if (DOCX_EXTENSIONS.includes(ext as never)) return { format: 'docx', label };
  if (HTML_NOTE_EXTENSIONS.includes(ext as never)) return { format: 'html', label };
  if (CSV_DATA_EXTENSIONS.includes(ext as never)) return { format: 'csv', label };
  if (STRUCTURED_DATA_EXTENSIONS.includes(ext as never)) return { format: 'json', label };
  if (IMAGE_SOURCE_EXTENSIONS.includes(ext as never)) return { format: 'image', label };
  if (AUDIO_SOURCE_EXTENSIONS.includes(ext as never)) return { format: 'audio', label };
  return { format: 'md', label };
}

/** Append new attachments, skipping any whose path is already present
 *  (re-dropping the same file is a no-op). */
export function mergeAttachments(cur: Attachment[], add: Attachment[]): Attachment[] {
  const have = new Set(cur.map((a) => a.path));
  const fresh = add.filter((a) => !have.has(a.path));
  return fresh.length ? [...cur, ...fresh] : cur;
}

/** Read an image File's natural pixel dimensions for the chip label
 *  (e.g. `2162×4000`). Resolves undefined if it isn't a decodable image. */
export function readImageDims(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(`${img.naturalWidth}×${img.naturalHeight}`); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve(undefined); URL.revokeObjectURL(url); };
    img.src = url;
  });
}
