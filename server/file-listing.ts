import fs from 'node:fs';
import path from 'node:path';
import { LEGACY_DERIVED_SOURCE_EXTENSION_ALTERNATION } from '../shared/file-formats.ts';
import { decodeEntities } from './html.ts';
import { onSwitch } from './folder.ts';
import { detectFormat, detectViewerFormat, isDerivedNoteName, type FileFormat, type ViewerFormat } from './format.ts';
import { isCloudPlaceholderName, isIndexExcludedDirName, shouldIndexFilePath } from './indexable.ts';
import { normalizeFolderRelativePath } from './folder-relative-path.ts';
import { folderRoot, resolveSafe } from './file-paths.ts';

const LEGACY_DERIVED_SOURCE_RE = new RegExp(`^(.+)\\.(${LEGACY_DERIVED_SOURCE_EXTENSION_ALTERNATION})$`, 'i');
const LEGACY_DERIVED_STEM_RE = new RegExp(`\\.(${LEGACY_DERIVED_SOURCE_EXTENSION_ALTERNATION})$`, 'i');

export interface FileEntry {
  /** Folder-relative POSIX path (e.g. `topic/note.md`). */
  name: string;
  /** Widened to `ViewerFormat` to include viewable-only formats like
   *  `pdf` (which are surfaced in the sidebar but never indexed). */
  format: ViewerFormat;
  /** Raw file size on disk. Zero-byte notes are intentionally not indexed. */
  size: number;
  heading: string;
  snippet: string;
  imported_at: string;
}

export interface FolderEntry {
  /** Folder-relative POSIX path (e.g. `topic/sub`). */
  path: string;
}

export interface FolderListing {
  files: FileEntry[];
  folders: FolderEntry[];
}

/** Per-file preview cache keyed by absolute path. Avoids re-reading
 *  every file on every `GET /api/files`. Invalidated by mtime. */
interface PreviewCacheEntry {
  mtimeMs: number;
  heading: string;
  snippet: string;
  imported_at: string;
}
const previewCache = new Map<string, PreviewCacheEntry>();

onSwitch(() => previewCache.clear());

/** Recursive walk of the folder. Returns every visible subfolder plus every
 *  recognised note/viewer file. */
export function listFilesAndFolders(): FolderListing {
  const root = folderRoot();
  const files: FileEntry[] = [];
  const folders: FolderEntry[] = [];
  const seen = new Set<string>();
  walk(root, '', (rel, full, ent) => {
    if (ent.isDirectory()) {
      folders.push({ path: rel });
      return;
    }
    if (!ent.isFile()) return;
    if (ent.name.endsWith('.tmp')) return;
    const format = detectViewerFormat(ent.name);
    if (!format) return;
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { return; }
    seen.add(full);

    const cached = previewCache.get(full);
    let entry: Pick<FileEntry, 'heading' | 'snippet' | 'imported_at'>;
    if (cached && cached.mtimeMs === st.mtimeMs) {
      entry = { heading: cached.heading, snippet: cached.snippet, imported_at: cached.imported_at };
    } else if (format === 'pdf' || format === 'image' || format === 'docx' || format === 'audio') {
      const imported_at = st.mtime.toISOString();
      previewCache.set(full, { mtimeMs: st.mtimeMs, heading: '', snippet: '', imported_at });
      entry = { heading: '', snippet: '', imported_at };
    } else {
      let content: string;
      try { content = fs.readFileSync(full, 'utf8'); } catch { return; }
      const { heading, snippet } = preview(content, format);
      const imported_at = st.mtime.toISOString();
      previewCache.set(full, { mtimeMs: st.mtimeMs, heading, snippet, imported_at });
      entry = { heading, snippet, imported_at };
    }
    files.push({ name: rel, format, size: st.size, ...entry });
  });
  for (const key of previewCache.keys()) {
    if (!seen.has(key)) previewCache.delete(key);
  }
  files.sort((a, b) => (a.name < b.name ? -1 : 1));
  folders.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, folders };
}

export function listFiles(): FileEntry[] {
  return listFilesAndFolders().files;
}

export function listFolders(): FolderEntry[] {
  return listFilesAndFolders().folders;
}

/** Text files that should be carried through a folder-level index rename.
 *  Includes legacy hidden derived notes if they still exist on disk. */
export function listIndexableTextFilesUnder(relPrefix: string): Array<{ name: string; content: string }> {
  const safePrefix = normalizeFolderRelativePath(relPrefix, { allowQuotes: true });
  const start = resolveSafe(safePrefix, 'existing', 'folder');
  const out: Array<{ name: string; content: string }> = [];
  walk(start, safePrefix, (rel, full, ent) => {
    if (!ent.isFile()) return;
    if (!detectFormat(ent.name)) return;
    if (!shouldIndexFilePath(rel)) return;
    try {
      out.push({ name: rel, content: fs.readFileSync(full, 'utf8') });
    } catch { /* unreadable files are skipped; sync can surface them later */ }
  }, { includeDerivedNotes: true });
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

/** Dot-prefixed dir / file names we always hide from the sidebar. */
export const HIDDEN_DOT_DIRS = new Set<string>([
  '.stashbase',
  '.git',
  '.DS_Store',
  '.Trashes',
  '.Spotlight-V100',
  '.fseventsd',
  '.AppleDouble',
  '.TemporaryItems',
]);

function walk(
  dir: string,
  prefix: string,
  fn: (rel: string, full: string, ent: fs.Dirent) => void,
  opts: { includeDerivedNotes?: boolean } = {},
): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  const noteStems = new Set<string>();
  const legacyDerivedStems = new Set<string>();
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = e.name.match(/^(.+)\.(md|markdown|html|htm|pdf)$/i);
    if (m) noteStems.add(m[1]);
    const src = e.name.match(LEGACY_DERIVED_SOURCE_RE);
    if (src) legacyDerivedStems.add(src[1]);
  }
  for (const e of entries) {
    if (isCloudPlaceholderName(e.name)) continue;
    if (e.name.startsWith('.') && HIDDEN_DOT_DIRS.has(e.name)) continue;
    if (e.isDirectory() && isIndexExcludedDirName(e.name)) continue;
    if (e.isFile() && e.name.startsWith('.')) {
      if (isDerivedScratchName(e.name)) continue;
      if (!opts.includeDerivedNotes && isDerivedNoteName(e.name)) continue;
      if (!opts.includeDerivedNotes && isLegacyDerivedNoteName(e.name, legacyDerivedStems)) continue;
    }
    if (e.isDirectory() && e.name.endsWith('_files')) {
      const stem = e.name.slice(0, -'_files'.length);
      if (noteStems.has(stem)) continue;
      if (stem.startsWith('.')) continue;
    }
    if (e.isDirectory() && isDerivedScratchName(e.name)) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    fn(rel, full, e);
    if (e.isDirectory()) walk(full, rel, fn, opts);
  }
}

function isLegacyDerivedNoteName(name: string, sourceStems: Set<string>): boolean {
  const m = name.match(/^\.([^/]+)\.(md|markdown|html|htm)$/i);
  if (!m) return false;
  const stem = m[1];
  if (LEGACY_DERIVED_STEM_RE.test(stem)) return false;
  return sourceStems.has(stem);
}

function isDerivedScratchName(name: string): boolean {
  return /^\.\.?[^/]+_files\.(?:tmp|batch)-/i.test(name)
    || /^\.[^/]+\.pdf\.md\.tmp-/i.test(name)
    || /^\.[^/]+\.pdf\.md\.batches$/i.test(name);
}

function preview(
  content: string,
  format: FileFormat,
): { heading: string; snippet: string } {
  return format === 'md' ? previewMarkdown(content) : previewHtml(content);
}

function previewMarkdown(md: string): { heading: string; snippet: string } {
  let heading = '';
  let snippet = '';
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^#{1,6}\s+(.*)$/);
    if (m) {
      if (!heading) heading = m[1];
      continue;
    }
    if (!snippet) {
      snippet = t.slice(0, 80);
      if (heading) break;
    }
    if (heading && snippet) break;
  }
  return { heading, snippet };
}

/** Cheap HTML preview without spinning up linkedom — file listing fires
 *  this on every file in the folder, so the regex path is the right
 *  tradeoff (the chunker does the proper DOM walk later). */
function previewHtml(html: string): { heading: string; snippet: string } {
  let heading = '';
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (tm) heading = decodeEntities(stripTags(tm[1])).trim();
  if (!heading) {
    const hm = html.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
    if (hm) heading = decodeEntities(stripTags(hm[1])).trim();
  }

  const stripped = decodeEntities(
    stripTags(
      html
        .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
        .replace(/<(?:script|style|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript)>/gi, ''),
    ),
  );
  const snippet = stripped.replace(/\s+/g, ' ').trim().slice(0, 80);
  return { heading, snippet };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ');
}
