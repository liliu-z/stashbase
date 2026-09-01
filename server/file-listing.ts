import fs from 'node:fs';
import path from 'node:path';
import {
  LEGACY_DERIVED_SOURCE_EXTENSION_ALTERNATION,
} from '../shared/file-formats.ts';
import { decodeEntities } from './html.ts';
import { onSwitch } from './folder.ts';
import {
  detectFormat,
  detectViewerFormat,
  isDerivedNoteName,
  isNoteName,
  type FileFormat,
  type ViewerFormat,
} from './format.ts';
import {
  FILESYSTEM_SCAN_YIELD_EVERY,
  isCloudPlaceholderName,
  isHiddenDirName,
  isIndexExcludedDirName,
  MAX_INDEXABLE_BYTES,
  shouldIndexFilePath,
} from './indexable.ts';
import { normalizeFolderRelativePath } from './folder-relative-path.ts';
import { folderRoot, resolveSafe, resolveSafeAsync } from './file-paths.ts';
import type {
  WorkspaceEntryAvailability,
  WorkspaceFileKind,
} from '../shared/library-files.ts';
import { decodeDirectTextBytes, decodeDirectTextPreview } from './text-decoding.ts';

const LEGACY_DERIVED_SOURCE_RE = new RegExp(`^(.+)\\.(${LEGACY_DERIVED_SOURCE_EXTENSION_ALTERNATION})$`, 'i');
const LEGACY_DERIVED_STEM_RE = new RegExp(`\\.(${LEGACY_DERIVED_SOURCE_EXTENSION_ALTERNATION})$`, 'i');

export interface FileEntry {
  /** Folder-relative POSIX path (e.g. `topic/note.md`). */
  name: string;
  /** Workbench dispatch. `generic` is tree-visible but excluded from retrieval. */
  format: ViewerFormat;
  /** Raw file size on disk. Zero-byte notes are intentionally not indexed. */
  size: number;
  heading: string;
  snippet: string;
  imported_at: string;
  entryKind?: WorkspaceFileKind;
  availability?: WorkspaceEntryAvailability;
}

export interface FolderEntry {
  /** Folder-relative POSIX path (e.g. `topic/sub`). */
  path: string;
  kind?: 'normal' | 'excluded' | 'unreadable';
}

export interface FolderListing {
  files: FileEntry[];
  folders: FolderEntry[];
}

export type ImmediateDirectoryEntry =
  | { name: string; path: string; type: 'directory' }
  | { name: string; path: string; type: 'file'; format: ViewerFormat; size: number };

/** Per-file preview cache keyed by absolute path. Avoids re-reading
 *  every file on every `GET /api/files`. Invalidated by mtime. */
interface PreviewCacheEntry {
  mtimeMs: number;
  heading: string;
  snippet: string;
  imported_at: string;
}
const previewCache = new Map<string, PreviewCacheEntry>();
const TEXT_PREVIEW_BYTES = 4096;

onSwitch(() => previewCache.clear());

interface ScanResult {
  isKept: boolean;
  files: FileEntry[];
  folders: FolderEntry[];
}

/** Listing behavior the server-owned folder Interface accepts. `showHidden`
 *  widens WORKBENCH visibility only: eligible user-owned dot-directories join
 *  the tree, while VCS databases, StashBase-derived artifacts, and excluded
 *  caches keep their protections, and index/Search/Agent visibility is
 *  untouched. */
export interface FolderListingOptions {
  showHidden?: boolean;
}

/** Hidden directories that never surface in the workspace even when hidden
 *  files are shown: VCS databases are internal state, not browsable user
 *  content. Distinct from `INDEX_EXCLUDED_DIRS` (whose other hidden members
 *  surface as non-expandable excluded rows when hidden files are shown). */
const PROTECTED_HIDDEN_DIRS = new Set<string>(['.git', '.hg', '.svn']);

/** Workspace visibility is intentionally wider than index visibility. Hidden
 * product-derived artifacts and dot-directories remain infrastructure, while
 * ordinary dot-files and unknown source formats are real user content. */
function workspaceDirectoryEntries(entries: fs.Dirent[], opts: FolderListingOptions): fs.Dirent[] {
  const noteStems = new Set<string>();
  const legacyDerivedStems = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const note = entry.name.match(/^(.+)\.(md|markdown|html|htm|pdf)$/i);
    if (note) noteStems.add(note[1]);
    const source = entry.name.match(LEGACY_DERIVED_SOURCE_RE);
    if (source) legacyDerivedStems.add(source[1]);
  }

  return entries.filter((entry) => {
    if (entry.isDirectory() && isHiddenDirName(entry.name)) {
      if (!opts.showHidden) return false;
      if (PROTECTED_HIDDEN_DIRS.has(entry.name)) return false;
    }
    if (entry.isFile() && HIDDEN_DOT_FILES.has(entry.name)) return false;
    if (entry.isFile() && entry.name.startsWith('.')) {
      // Dot-notes are part of the established hidden-note namespace. Keep
      // them out even when they are user-owned; ordinary dotfiles such as
      // .env and .gitignore remain truthful workspace entries.
      if (isNoteName(entry.name)) return false;
      if (isDerivedScratchName(entry.name)) return false;
      if (isDerivedNoteName(entry.name)) return false;
      if (isLegacyDerivedNoteName(entry.name, legacyDerivedStems)) return false;
    }
    if (entry.isDirectory() && entry.name.endsWith('_files')) {
      const stem = entry.name.slice(0, -'_files'.length);
      if (noteStems.has(stem) || stem.startsWith('.')) return false;
    }
    return !(entry.isDirectory() && isDerivedScratchName(entry.name));
  });
}

function workspaceEntryKind(entry: fs.Dirent): WorkspaceFileKind {
  if (isCloudPlaceholderName(entry.name)) return 'cloud-placeholder';
  if (entry.isSymbolicLink()) return 'symlink';
  if (!entry.isFile()) return 'special';
  return 'regular';
}

function unreadableFileEntry(entry: fs.Dirent, rel: string): FileEntry {
  const entryKind = workspaceEntryKind(entry);
  return {
    name: rel,
    format: 'generic',
    size: 0,
    heading: '',
    snippet: '',
    imported_at: '',
    ...(entryKind === 'regular' ? {} : { entryKind }),
    availability: 'unreadable',
  };
}

function scanWorkspaceFileSync(entry: fs.Dirent, rel: string, full: string): FileEntry {
  let st: fs.Stats;
  try { st = fs.lstatSync(full); }
  catch { return unreadableFileEntry(entry, rel); }
  return finishWorkspaceFileEntry(entry, rel, full, st, (size, format) => readTextPrefix(full, size, format));
}

async function scanWorkspaceFileAsync(entry: fs.Dirent, rel: string, full: string): Promise<FileEntry> {
  let st: fs.Stats;
  try { st = await fs.promises.lstat(full); }
  catch { return unreadableFileEntry(entry, rel); }
  return finishWorkspaceFileEntryAsync(entry, rel, full, st);
}

function workspaceFileBase(entry: fs.Dirent, rel: string, st: fs.Stats): FileEntry {
  const entryKind = workspaceEntryKind(entry);
  const format = entryKind === 'regular' ? (detectViewerFormat(entry.name) ?? 'generic') : 'generic';
  return {
    name: rel,
    format,
    size: st.size,
    heading: '',
    snippet: '',
    imported_at: st.mtime.toISOString(),
    ...(entryKind === 'regular' ? {} : { entryKind }),
  };
}

function finishWorkspaceFileEntry(
  entry: fs.Dirent,
  rel: string,
  full: string,
  st: fs.Stats,
  readPrefix: (size: number, format: FileFormat) => string,
): FileEntry {
  const base = workspaceFileBase(entry, rel, st);
  if (base.format === 'generic') return base;
  if (base.format === 'pdf' || base.format === 'image' || base.format === 'docx' || base.format === 'audio') {
    previewCache.set(full, { mtimeMs: st.mtimeMs, heading: '', snippet: '', imported_at: base.imported_at });
    return base;
  }
  const cached = previewCache.get(full);
  if (cached && cached.mtimeMs === st.mtimeMs) {
    return { ...base, heading: cached.heading, snippet: cached.snippet, imported_at: cached.imported_at };
  }
  try {
    const { heading, snippet } = preview(readPrefix(st.size, base.format as FileFormat), base.format);
    previewCache.set(full, { mtimeMs: st.mtimeMs, heading, snippet, imported_at: base.imported_at });
    return { ...base, heading, snippet };
  } catch {
    return { ...base, format: 'generic', availability: 'unreadable' };
  }
}

async function finishWorkspaceFileEntryAsync(
  entry: fs.Dirent,
  rel: string,
  full: string,
  st: fs.Stats,
): Promise<FileEntry> {
  const base = workspaceFileBase(entry, rel, st);
  if (base.format === 'generic') return base;
  if (base.format === 'pdf' || base.format === 'image' || base.format === 'docx' || base.format === 'audio') {
    previewCache.set(full, { mtimeMs: st.mtimeMs, heading: '', snippet: '', imported_at: base.imported_at });
    return base;
  }
  const cached = previewCache.get(full);
  if (cached && cached.mtimeMs === st.mtimeMs) {
    return { ...base, heading: cached.heading, snippet: cached.snippet, imported_at: cached.imported_at };
  }
  try {
    const { heading, snippet } = preview(await readTextPrefixAsync(full, st.size, base.format as FileFormat), base.format);
    previewCache.set(full, { mtimeMs: st.mtimeMs, heading, snippet, imported_at: base.imported_at });
    return { ...base, heading, snippet };
  } catch {
    return { ...base, format: 'generic', availability: 'unreadable' };
  }
}

function scanDirectory(dir: string, prefix: string, opts: FolderListingOptions): ScanResult {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return {
      isKept: Boolean(prefix),
      files: [],
      folders: prefix ? [{ path: prefix, kind: 'unreadable' }] : [],
    };
  }

  const files: FileEntry[] = [];
  const folders: FolderEntry[] = [];

  for (const e of workspaceDirectoryEntries(entries, opts)) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const full = path.join(dir, e.name);

    if (e.isDirectory()) {
      if (isIndexExcludedDirName(e.name)) {
        folders.push({ path: rel, kind: 'excluded' });
        continue;
      }
      const subResult = scanDirectory(full, rel, opts);
      if (subResult.isKept) {
        files.push(...subResult.files);
        folders.push(...subResult.folders);
      }
      continue;
    }
    files.push(scanWorkspaceFileSync(e, rel, full));
  }

  if (prefix) folders.push({ path: prefix });

  return {
    isKept: true,
    files,
    folders,
  };
}

interface AsyncScanState {
  entriesSinceYield: number;
}

/** Async counterpart for request handling. It preserves the workspace tree's exact
 * classification while keeping recursive directory I/O and large flat-folder
 * classification off uninterrupted turns of the shared Node event loop. */
async function scanDirectoryAsync(
  dir: string,
  prefix: string,
  state: AsyncScanState,
  opts: FolderListingOptions,
): Promise<ScanResult> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return {
      isKept: Boolean(prefix),
      files: [],
      folders: prefix ? [{ path: prefix, kind: 'unreadable' }] : [],
    };
  }

  const files: FileEntry[] = [];
  const folders: FolderEntry[] = [];

  for (const e of workspaceDirectoryEntries(entries, opts)) {
    state.entriesSinceYield += 1;
    if (state.entriesSinceYield >= FILESYSTEM_SCAN_YIELD_EVERY) {
      state.entriesSinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const full = path.join(dir, e.name);

    if (e.isDirectory()) {
      if (isIndexExcludedDirName(e.name)) {
        folders.push({ path: rel, kind: 'excluded' });
        continue;
      }
      const subResult = await scanDirectoryAsync(full, rel, state, opts);
      if (subResult.isKept) {
        files.push(...subResult.files);
        folders.push(...subResult.folders);
      }
      continue;
    }
    files.push(await scanWorkspaceFileAsync(e, rel, full));
  }

  if (prefix) folders.push({ path: prefix });
  return { isKept: true, files, folders };
}

function finishFolderListing(root: string, scanResult: ScanResult): FolderListing {
  const seen = new Set<string>();
  for (const f of scanResult.files) seen.add(path.join(root, f.name));
  for (const key of previewCache.keys()) {
    if (!seen.has(key)) previewCache.delete(key);
  }

  scanResult.files.sort((a, b) => (a.name < b.name ? -1 : 1));
  scanResult.folders.sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    files: scanResult.files,
    folders: scanResult.folders,
  };
}

export function listFilesAndFolders(opts: FolderListingOptions = {}): FolderListing {
  const root = folderRoot();
  return finishFolderListing(root, scanDirectory(root, '', opts));
}

export async function listFilesAndFoldersAsync(opts: FolderListingOptions = {}): Promise<FolderListing> {
  const root = folderRoot();
  const scanResult = await scanDirectoryAsync(root, '', { entriesSinceYield: 0 }, opts);
  return finishFolderListing(root, scanResult);
}

export function listFiles(): FileEntry[] {
  return listFilesAndFolders().files;
}

export async function listFilesAsync(): Promise<FileEntry[]> {
  return (await listFilesAndFoldersAsync()).files;
}

export function listFolders(): FolderEntry[] {
  return listFilesAndFolders().folders;
}

/** Directory-tool listing seam. It inspects only the requested directory and
 * directory names beneath immediate children; it never reads file contents or
 * scans unrelated branches of the member root. */
export function listImmediateDirectory(relPrefix = ''): ImmediateDirectoryEntry[] {
  const prefix = relPrefix ? normalizeFolderRelativePath(relPrefix, { allowQuotes: true }) : '';
  const dir = prefix ? resolveSafe(prefix, 'existing', 'directory') : folderRoot();
  const st = fs.statSync(dir);
  if (!st.isDirectory()) throw new Error('directory not found');
  const entries = visibleDirectoryEntries(fs.readdirSync(dir, { withFileTypes: true }));
  const out: ImmediateDirectoryEntry[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (directoryTreeIsVisible(full)) out.push({ name: entry.name, path: rel, type: 'directory' });
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith('.tmp')) continue;
    const format = detectViewerFormat(entry.name);
    if (!format) continue;
    try {
      out.push({ name: entry.name, path: rel, type: 'file', format, size: fs.statSync(full).size });
    } catch { /* raced with an external filesystem mutation */ }
  }
  return out.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1,
  );
}

export async function listImmediateDirectoryAsync(relPrefix = ''): Promise<ImmediateDirectoryEntry[]> {
  const prefix = relPrefix ? normalizeFolderRelativePath(relPrefix, { allowQuotes: true }) : '';
  const dir = prefix ? await resolveSafeAsync(prefix, 'existing', 'directory') : folderRoot();
  const st = await fs.promises.stat(dir);
  if (!st.isDirectory()) throw new Error('directory not found');
  const entries = visibleDirectoryEntries(await fs.promises.readdir(dir, { withFileTypes: true }));
  const out: ImmediateDirectoryEntry[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await directoryTreeIsVisibleAsync(full)) out.push({ name: entry.name, path: rel, type: 'directory' });
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith('.tmp')) continue;
    const format = detectViewerFormat(entry.name);
    if (!format) continue;
    try {
      out.push({ name: entry.name, path: rel, type: 'file', format, size: (await fs.promises.stat(full)).size });
    } catch { /* raced with an external filesystem mutation */ }
  }
  return out.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1,
  );
}

function visibleDirectoryEntries(entries: fs.Dirent[]): fs.Dirent[] {
  const noteStems = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^(.+)\.(md|markdown|html|htm|pdf)$/i);
    if (match) noteStems.add(match[1]);
  }
  return entries.filter((entry) => {
    if (isCloudPlaceholderName(entry.name)) return false;
    if (entry.isDirectory() && (isHiddenDirName(entry.name) || isIndexExcludedDirName(entry.name))) return false;
    /* The Agent directory tool omits dotfiles and app-derived infrastructure. */
    if (entry.isFile() && entry.name.startsWith('.')) return false;
    if (entry.isDirectory() && entry.name.endsWith('_files')) {
      const stem = entry.name.slice(0, -'_files'.length);
      if (noteStems.has(stem) || stem.startsWith('.')) return false;
    }
    return !(entry.isDirectory() && isDerivedScratchName(entry.name));
  });
}

function directoryTreeIsVisible(dir: string): boolean {
  let entries: fs.Dirent[];
  try { entries = visibleDirectoryEntries(fs.readdirSync(dir, { withFileTypes: true })); }
  catch { return false; }
  if (entries.length === 0) return true;
  for (const entry of entries) {
    if (entry.isFile() && !entry.name.endsWith('.tmp') && detectViewerFormat(entry.name)) return true;
    if (entry.isDirectory() && directoryTreeIsVisible(path.join(dir, entry.name))) return true;
  }
  return false;
}

async function directoryTreeIsVisibleAsync(dir: string): Promise<boolean> {
  let entries: fs.Dirent[];
  try { entries = visibleDirectoryEntries(await fs.promises.readdir(dir, { withFileTypes: true })); }
  catch { return false; }
  if (entries.length === 0) return true;
  for (const entry of entries) {
    if (entry.isFile() && !entry.name.endsWith('.tmp') && detectViewerFormat(entry.name)) return true;
    if (entry.isDirectory() && await directoryTreeIsVisibleAsync(path.join(dir, entry.name))) return true;
  }
  return false;
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
      if (fs.statSync(full).size > MAX_INDEXABLE_BYTES) return;
      out.push({ name: rel, content: decodeDirectTextBytes(rel, fs.readFileSync(full)) });
    } catch { /* unreadable files are skipped; sync can surface them later */ }
  }, { includeDerivedNotes: true });
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

export async function listIndexableTextFilesUnderAsync(
  relPrefix: string,
): Promise<Array<{ name: string; content: string }>> {
  const safePrefix = normalizeFolderRelativePath(relPrefix, { allowQuotes: true });
  const start = await resolveSafeAsync(safePrefix, 'existing', 'folder');
  const out: Array<{ name: string; content: string }> = [];
  await walkAsync(start, safePrefix, async (rel, full, entry) => {
    if (!entry.isFile() || !detectFormat(entry.name) || !shouldIndexFilePath(rel)) return;
    try {
      if ((await fs.promises.stat(full)).size > MAX_INDEXABLE_BYTES) return;
      out.push({ name: rel, content: decodeDirectTextBytes(rel, await fs.promises.readFile(full)) });
    } catch { /* unreadable files are skipped; sync can surface them later */ }
  }, { includeDerivedNotes: true });
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

function readTextPrefix(full: string, size: number, format: FileFormat): string {
  const fd = fs.openSync(full, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(TEXT_PREVIEW_BYTES, size));
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead);
    return format === 'txt' ? decodeDirectTextPreview(full, prefix) : prefix.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

async function readTextPrefixAsync(full: string, size: number, format: FileFormat): Promise<string> {
  const handle = await fs.promises.open(full, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(TEXT_PREVIEW_BYTES, size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead);
    return format === 'txt' ? decodeDirectTextPreview(full, prefix) : prefix.toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Junk dot-FILES hidden from the workspace. Dot DIRECTORIES (.claude,
 *  .git, .stashbase, …) are hidden wholesale by `isHiddenDirName` unless
 *  the listing's explicit `showHidden` option opts eligible ones in. */
export const HIDDEN_DOT_FILES = new Set<string>([
  '.DS_Store',
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
    if (e.isDirectory() && isHiddenDirName(e.name)) continue;
    if (e.isFile() && HIDDEN_DOT_FILES.has(e.name)) continue;
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

async function walkAsync(
  dir: string,
  prefix: string,
  fn: (rel: string, full: string, ent: fs.Dirent) => Promise<void>,
  opts: { includeDerivedNotes?: boolean } = {},
): Promise<void> {
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  const noteStems = new Set<string>();
  const legacyDerivedStems = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^(.+)\.(md|markdown|html|htm|pdf)$/i);
    if (match) noteStems.add(match[1]);
    const source = entry.name.match(LEGACY_DERIVED_SOURCE_RE);
    if (source) legacyDerivedStems.add(source[1]);
  }
  for (const entry of entries) {
    if (isCloudPlaceholderName(entry.name)) continue;
    if (entry.isDirectory() && isHiddenDirName(entry.name)) continue;
    if (entry.isFile() && HIDDEN_DOT_FILES.has(entry.name)) continue;
    if (entry.isDirectory() && isIndexExcludedDirName(entry.name)) continue;
    if (entry.isFile() && entry.name.startsWith('.')) {
      if (isDerivedScratchName(entry.name)) continue;
      if (!opts.includeDerivedNotes && isDerivedNoteName(entry.name)) continue;
      if (!opts.includeDerivedNotes && isLegacyDerivedNoteName(entry.name, legacyDerivedStems)) continue;
    }
    if (entry.isDirectory() && entry.name.endsWith('_files')) {
      const stem = entry.name.slice(0, -'_files'.length);
      if (noteStems.has(stem) || stem.startsWith('.')) continue;
    }
    if (entry.isDirectory() && isDerivedScratchName(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    await fn(rel, full, entry);
    if (entry.isDirectory()) await walkAsync(full, rel, fn, opts);
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
  if (format === 'md') return previewMarkdown(content);
  if (format === 'html') return previewHtml(content);
  return { heading: '', snippet: content.replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim().slice(0, 80) };
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
