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

export interface UnsupportedFileSummary {
  sourceCode: number;
  other: number;
  otherExtensions: Array<{
    extension: string;
    count: number;
  }>;
}

export interface FolderListing {
  files: FileEntry[];
  folders: FolderEntry[];
  unsupportedFiles: UnsupportedFileSummary;
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

const SOURCE_EXTENSIONS = new Set<string>([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.go', '.rs',
  '.java', '.kt', '.kts', '.scala',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp',
  '.cs',
  '.rb', '.php',
  '.swift', '.m', '.mm',
  '.dart',
  '.ex', '.exs',
  '.lua', '.r',
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.sql',
  '.vue', '.svelte',
  '.css', '.scss', '.less',
  '.ipynb',
]);

const SOURCE_BASENAMES = new Set<string>([
  'dockerfile',
  'makefile',
  'cmakelists.txt',
]);

function classifyUnsupportedFile(name: string): 'source' | 'other' {
  const base = name.toLowerCase();
  if (SOURCE_BASENAMES.has(base)) return 'source';

  const ext = path.extname(name).toLowerCase();
  if (SOURCE_EXTENSIONS.has(ext)) return 'source';

  return 'other';
}

function getNormalizedExtension(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return ext === '' ? 'no extension' : ext;
}

interface UnsupportedInfo {
  sourceCode: number;
  other: number;
  otherExtensions: Record<string, number>;
}

interface ScanResult {
  isKept: boolean;
  files: FileEntry[];
  folders: FolderEntry[];
  unsupportedFiles: UnsupportedInfo;
}

function scanDirectory(dir: string, prefix: string): ScanResult {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return {
      isKept: false,
      files: [],
      folders: [],
      unsupportedFiles: { sourceCode: 0, other: 0, otherExtensions: {} },
    };
  }

  const noteStems = new Set<string>();
  const legacyDerivedStems = new Set<string>();
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = e.name.match(/^(.+)\.(md|markdown|html|htm|pdf)$/i);
    if (m) noteStems.add(m[1]);
    const src = e.name.match(LEGACY_DERIVED_SOURCE_RE);
    if (src) legacyDerivedStems.add(src[1]);
  }

  const acceptedEntries: fs.Dirent[] = [];
  for (const e of entries) {
    if (isCloudPlaceholderName(e.name)) continue;
    if (e.name.startsWith('.') && HIDDEN_DOT_DIRS.has(e.name)) continue;
    if (e.isDirectory() && isIndexExcludedDirName(e.name)) continue;
    if (e.isFile() && e.name.startsWith('.')) {
      if (isDerivedScratchName(e.name)) continue;
      if (isDerivedNoteName(e.name)) continue;
      if (isLegacyDerivedNoteName(e.name, legacyDerivedStems)) continue;
    }
    if (e.isDirectory() && e.name.endsWith('_files')) {
      const stem = e.name.slice(0, -'_files'.length);
      if (noteStems.has(stem)) continue;
      if (stem.startsWith('.')) continue;
    }
    if (e.isDirectory() && isDerivedScratchName(e.name)) continue;

    acceptedEntries.push(e);
  }

  // Only an actually empty directory is retained as user-created structure.
  // A directory whose entries are all excluded/generated is not physically
  // empty and must not reappear as a misleading empty folder in the tree.
  if (entries.length === 0) {
    return {
      isKept: true,
      files: [],
      folders: prefix ? [{ path: prefix }] : [],
      unsupportedFiles: { sourceCode: 0, other: 0, otherExtensions: {} },
    };
  }
  if (acceptedEntries.length === 0) {
    return {
      isKept: false,
      files: [],
      folders: [],
      unsupportedFiles: { sourceCode: 0, other: 0, otherExtensions: {} },
    };
  }

  const files: FileEntry[] = [];
  const folders: FolderEntry[] = [];
  const unsupportedFiles: UnsupportedInfo = { sourceCode: 0, other: 0, otherExtensions: {} };
  let hasSupportedInSubtree = false;
  let hasKeptSubfolder = false;

  for (const e of acceptedEntries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const full = path.join(dir, e.name);

    if (e.isDirectory()) {
      const subResult = scanDirectory(full, rel);
      if (subResult.isKept) {
        hasKeptSubfolder = true;
        files.push(...subResult.files);
        folders.push(...subResult.folders);
      }
      unsupportedFiles.sourceCode += subResult.unsupportedFiles.sourceCode;
      unsupportedFiles.other += subResult.unsupportedFiles.other;
      for (const [ext, count] of Object.entries(subResult.unsupportedFiles.otherExtensions)) {
        unsupportedFiles.otherExtensions[ext] = (unsupportedFiles.otherExtensions[ext] ?? 0) + count;
      }
    } else if (e.isFile()) {
      if (e.name.endsWith('.tmp')) continue;

      const format = detectViewerFormat(e.name);
      if (format) {
        hasSupportedInSubtree = true;
        let st: fs.Stats;
        try { st = fs.statSync(full); } catch { continue; }

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
          try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
          const { heading, snippet } = preview(content, format);
          const imported_at = st.mtime.toISOString();
          previewCache.set(full, { mtimeMs: st.mtimeMs, heading, snippet, imported_at });
          entry = { heading, snippet, imported_at };
        }
        files.push({ name: rel, format, size: st.size, ...entry });
      } else {
        const classification = classifyUnsupportedFile(e.name);
        if (classification === 'source') {
          unsupportedFiles.sourceCode++;
        } else {
          unsupportedFiles.other++;
          const ext = getNormalizedExtension(e.name);
          unsupportedFiles.otherExtensions[ext] = (unsupportedFiles.otherExtensions[ext] ?? 0) + 1;
        }
      }
    }
  }

  const isKept = hasSupportedInSubtree || hasKeptSubfolder;
  if (isKept && prefix) {
    folders.push({ path: prefix });
  }

  return {
    isKept,
    files,
    folders,
    unsupportedFiles,
  };
}

export function listFilesAndFolders(): FolderListing {
  const root = folderRoot();
  const scanResult = scanDirectory(root, '');

  const otherExtensions = Object.entries(scanResult.unsupportedFiles.otherExtensions)
    .map(([extension, count]) => ({ extension, count }))
    .sort((a, b) => {
      if (a.count !== b.count) {
        return b.count - a.count;
      }
      return a.extension.localeCompare(b.extension);
    });

  const seen = new Set<string>();
  for (const f of scanResult.files) {
    seen.add(path.join(root, f.name));
  }
  for (const key of previewCache.keys()) {
    if (!seen.has(key)) previewCache.delete(key);
  }

  scanResult.files.sort((a, b) => (a.name < b.name ? -1 : 1));
  scanResult.folders.sort((a, b) => (a.path < b.path ? -1 : 1));

  return {
    files: scanResult.files,
    folders: scanResult.folders,
    unsupportedFiles: {
      sourceCode: scanResult.unsupportedFiles.sourceCode,
      other: scanResult.unsupportedFiles.other,
      otherExtensions,
    },
  };
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
