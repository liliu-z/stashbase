/**
 * Leaf module for file-format detection — and the home of the
 * structured-vs-unstructured model the whole ingestion pipeline rests on.
 *
 * The index unit is always markdown. Formats split two ways:
 *   - **Structured** (`FileFormat`: md, html): the source file is itself
 *     the single source of truth and is indexed directly — markdown
 *     as-is; HTML via a cheap in-memory "→ heading markdown" optimization
 *     at MFS-feed time (`analyzeHtml`), NOT materialized to disk.
 *   - **Convertible** (`UNSTRUCTURED_SOURCE_EXTS`: pdf, images, docx, audio): a
 *     converter extracts text into an AppData-derived representation. That
 *     text layer feeds search; PDFs/DOCX/audio also use it for Agent text
 *     reading, while images remain the read/view source.
 * So MFS only ever sees markdown; all format knowledge lives here / in
 * the converters, never in MFS.
 *
 * Lives separately from `files.ts` because `files.ts` imports from
 * `watcher.ts` (→ `state.ts`, which instantiates `MfsIndexer` at module
 * top level). The MCP bundle entry only needs `detectFormat`, so
 * isolating it here keeps `mcp/server.ts` → `indexer.mfs.ts` from
 * pulling watcher/state into the bundle and creating an init-order
 * cycle that the packaged bundle can't resolve correctly.
 */

import {
  AUDIO_SOURCE_EXTENSIONS,
  AUDIO_SOURCE_EXTENSION_ALTERNATION,
  CONVERTIBLE_SOURCE_EXTENSION_ALTERNATION,
  DOCX_EXTENSIONS,
  DOCX_EXTENSION_ALTERNATION,
  HTML_NOTE_EXTENSIONS,
  IMAGE_SOURCE_EXTENSIONS,
  IMAGE_SOURCE_EXTENSION_ALTERNATION,
  LEGACY_DERIVED_SOURCE_EXTENSIONS,
  MARKDOWN_NOTE_EXTENSIONS,
  PDF_EXTENSIONS,
  PDF_EXTENSION_ALTERNATION,
} from '../shared/file-formats.ts';
import { SEARCH_TYPE_CATEGORIES, type SearchTypeCategory } from '../shared/search-types.ts';

/** Structured note formats — indexed directly (the file is the source). */
export type FileFormat = 'md' | 'html';

/** Everything the renderer can open in the file tree: the structured
 *  note formats plus the convertible binaries (pdf, image) that are
 *  viewable but searched via AppData-derived text. Kept
 *  distinct from `FileFormat` so the indexing pipeline (chunker, daemon
 *  upsert, scan_diff) only ever sees structured `md` / `html`. */
export type ViewerFormat = FileFormat | 'pdf' | 'image' | 'docx' | 'audio';

/** Recognised note extensions and how the rest of the pipeline should
 *  treat them. Adding a format = one line here + a chunker + a viewer —
 *  every note / derived-note / bundle regex elsewhere derives from this
 *  list (via `NOTE_EXTS` and the `isNoteName` / `matchNoteStem` /
 *  `matchDerivedNote` helpers), so the extension set has a single home. */
const NOTE_FORMATS: Array<{ exts: readonly string[]; format: FileFormat }> = [
  { exts: MARKDOWN_NOTE_EXTENSIONS, format: 'md' },
  { exts: HTML_NOTE_EXTENSIONS, format: 'html' },
];

/** Every note extension (no leading dot), e.g. `['md','markdown','html','htm']`.
 *  Single source for the alternation baked into the regexes below. */
export const NOTE_EXTS: readonly string[] = NOTE_FORMATS.flatMap((f) => f.exts);

/** Only formats that actually emitted sibling derived notes participate in
 * compatibility hiding. Current converted output, including all audio
 * transcripts, lives in AppData. */
const LEGACY_DERIVED_SOURCE_EXTS = LEGACY_DERIVED_SOURCE_EXTENSIONS;

const NOTE_EXT_ALT = NOTE_EXTS.join('|');
const SRC_EXT_ALT = LEGACY_DERIVED_SOURCE_EXTS.join('|');
const NOTE_EXT_RE = new RegExp(`\\.(${NOTE_EXT_ALT})$`, 'i');
/** Legacy `<dir>/.<sourceBasename>.md` — an app-derived hidden note, where
 *  `sourceBasename` is the full source filename incl. extension. Capture
 *  1 = dir (trailing slash kept), capture 2 = the source basename. The
 *  required source extension is what keeps a user's own hidden `.foo.md`
 *  from being mistaken for a derived note. */
const DERIVED_NOTE_RE = new RegExp(`^(.*/)?\\.(.+\\.(?:${SRC_EXT_ALT}))\\.(?:${NOTE_EXT_ALT})$`, 'i');
/** `<dir>/<stem>.<noteExt>` — a visible note, captured for bundle naming. */
const NOTE_STEM_RE = new RegExp(`^(.*/)?([^/]+)\\.(${NOTE_EXT_ALT})$`, 'i');

/** True when `name` ends in a note extension (= the indexer would pick it
 *  up). Same set as `detectFormat(name) !== null`; use this for boolean
 *  "is it a note?" checks so the extension set isn't re-spelled. */
export function isNoteName(name: string): boolean {
  return NOTE_EXT_RE.test(name);
}


/** True when a path/basename has the legacy hidden-note shape
 *  (`.<sourceBasename>.md`, e.g. `.report.pdf.md`). Used for cleanup/remap
 *  so old on-disk derived notes do not leak. */
export function isDerivedNoteName(pathOrName: string): boolean {
  return DERIVED_NOTE_RE.test(pathOrName);
}

/** Split a derived-note relative path into `{ dir, source }` where
 *  `source` is the source file's relative path (dir + full basename, e.g.
 *  `sub/report.pdf`), or null if it isn't a derived note. The source is
 *  read straight from the name — no extension probing. */
export function matchDerivedNote(rel: string): { dir: string; source: string } | null {
  const m = rel.replace(/\\/g, '/').match(DERIVED_NOTE_RE);
  return m ? { dir: m[1] ?? '', source: `${m[1] ?? ''}${m[2]}` } : null;
}

/** Split a (visible) note relative path into `{ dir, stem }` for deriving
 *  the `<stem>_files/` bundle name, or null if it isn't a note. */
export function matchNoteStem(rel: string): { dir: string; stem: string } | null {
  const m = rel.replace(/\\/g, '/').match(NOTE_STEM_RE);
  return m ? { dir: m[1] ?? '', stem: m[2] } : null;
}

/** Image extensions we OCR + view. Deliberately narrow for V1
 *  (png / jpg / jpeg / webp) — the OCR pipeline and viewer are tested
 *  against these; widen here when we add gif / heic / etc. */
const PDF_PATTERN = new RegExp(`\\.(${PDF_EXTENSION_ALTERNATION})$`, 'i');
const IMAGE_PATTERN = new RegExp(`\\.(${IMAGE_SOURCE_EXTENSION_ALTERNATION})$`, 'i');
const DOCX_PATTERN = new RegExp(`\\.(${DOCX_EXTENSION_ALTERNATION})$`, 'i');
const AUDIO_PATTERN = new RegExp(`\\.(${AUDIO_SOURCE_EXTENSION_ALTERNATION})$`, 'i');
const CONVERTIBLE_SOURCE_PATTERN = new RegExp(`\\.(${CONVERTIBLE_SOURCE_EXTENSION_ALTERNATION})$`, 'i');

const VIEWER_ONLY_FORMATS: Array<{ pattern: RegExp; format: ViewerFormat }> = [
  { pattern: PDF_PATTERN, format: 'pdf' },
  { pattern: IMAGE_PATTERN, format: 'image' },
  { pattern: AUDIO_PATTERN, format: 'audio' },
];

/** True for the image extensions the OCR pipeline handles. Used by the
 *  upload route to decide whether to spawn `ocr_extract.py`, and by the
 *  derived-note remap to probe for an image original. */
export function isImageFile(name: string): boolean {
  return IMAGE_PATTERN.test(name);
}

export function isDocxFile(name: string): boolean {
  const base = pathBasename(name);
  return DOCX_PATTERN.test(base) && !base.startsWith('~$') && !base.startsWith('.~');
}

/** Audio sources accepted by the local transcription pipeline. Video
 *  containers are deliberately excluded even when they carry audio. */
export function isAudioFile(name: string): boolean {
  return AUDIO_PATTERN.test(pathBasename(name));
}

/** True for an unstructured **convertible source** — files
 *  whose searchable text comes from an app-data derived note and are
 *  indexed under their own path. They are NOT directly index-readable
 *  (raw bytes would be garbage), so reconcile must not treat them as plain
 *  notes; it lets the conversion path own their index entry. */
export function isConvertibleSource(name: string): boolean {
  const base = pathBasename(name);
  if (!CONVERTIBLE_SOURCE_PATTERN.test(base)) return false;
  // Office lock files share the `.docx` suffix but are never user documents.
  return !DOCX_PATTERN.test(base) || isDocxFile(base);
}

const SEARCH_TYPE_EXTENSIONS: Record<SearchTypeCategory, readonly string[]> = {
  notes: NOTE_EXTS,
  pdf: PDF_EXTENSIONS,
  image: IMAGE_SOURCE_EXTENSIONS,
  docx: DOCX_EXTENSIONS,
  audio: AUDIO_SOURCE_EXTENSIONS,
};

/** Lowercase dot-prefixed source extensions for a set of search
 *  categories. Returns null when the set is empty or covers every
 *  category — both mean "no extension filter". */
export function searchExtensionsForTypes(types: readonly SearchTypeCategory[]): string[] | null {
  const unique = [...new Set(types)];
  if (unique.length === 0 || unique.length === SEARCH_TYPE_CATEGORIES.length) return null;
  return unique.flatMap((t) => SEARCH_TYPE_EXTENSIONS[t].map((ext) => `.${ext}`));
}

/** True when `name`'s extension belongs to one of the given categories. */
export function matchesSearchTypes(name: string, types: readonly SearchTypeCategory[]): boolean {
  if (types.length === 0) return true;
  const exts = searchExtensionsForTypes(types);
  if (exts == null) return true;
  const lower = name.toLowerCase();
  return exts.some((ext) => lower.endsWith(ext));
}

function pathBasename(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop() ?? name;
}

const NOTE_FORMAT_RES: Array<{ re: RegExp; format: FileFormat }> = NOTE_FORMATS.map((f) => ({
  re: new RegExp(`\\.(${f.exts.join('|')})$`, 'i'),
  format: f.format,
}));

export function detectFormat(name: string): FileFormat | null {
  for (const { re, format } of NOTE_FORMAT_RES) {
    if (re.test(name)) return format;
  }
  return null;
}

/** Like `detectFormat` but also recognises viewer-only formats.
 *  Used by the sidebar / file tree which surfaces every viewable file
 *  to the user, even ones that don't go through indexing. */
export function detectViewerFormat(name: string): ViewerFormat | null {
  const note = detectFormat(name);
  if (note) return note;
  if (isDocxFile(name)) return 'docx';
  for (const { pattern, format } of VIEWER_ONLY_FORMATS) {
    if (pattern.test(name)) return format;
  }
  return null;
}
