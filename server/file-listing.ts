import { isRetrievableViewerFormat } from '../shared/file-formats.ts';
import { SCHEDULE_FILE_NAME } from '../shared/protocols/http/scheduled-tasks.ts';
import fs from 'node:fs';
import path from 'node:path';
import {
  LEGACY_DERIVED_SOURCE_EXTENSION_ALTERNATION,
} from '../shared/file-formats.ts';
import {
  detectFormat,
  detectViewerFormat,
  isDerivedNoteName,
  isNoteName,
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
import { folderRoot, resolveSafeAsync } from './file-paths.ts';
import type {
  WorkspaceEntryAvailability,
  WorkspaceFileKind,
} from '../shared/project-files.ts';
import { decodeDirectTextBytes } from './text-decoding.ts';

const LEGACY_DERIVED_SOURCE_RE = new RegExp(`^(.+)\\.(${LEGACY_DERIVED_SOURCE_EXTENSION_ALTERNATION})$`, 'i');
const LEGACY_DERIVED_STEM_RE = new RegExp(`\\.(${LEGACY_DERIVED_SOURCE_EXTENSION_ALTERNATION})$`, 'i');

export interface FileEntry {
  /** Folder-relative POSIX path (e.g. `topic/note.md`). */
  name: string;
  /** Workbench dispatch. `generic` is tree-visible but excluded from retrieval. */
  format: ViewerFormat;
  /** Raw file size on disk. Zero-byte notes are intentionally not indexed. */
  size: number;
  entryKind?: WorkspaceFileKind;
  availability?: WorkspaceEntryAvailability;
}

interface FolderEntry {
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

/** User-maintained project configuration belongs in the ordinary file tree. */
const VISIBLE_PROJECT_CONFIG_DIRS = new Set([
  '.agents',
  '.claude',
  '.codex',
  '.github',
  '.vscode',
]);

/** Product-owned hidden state is never a Workbench browsing surface, even
 * when ordinary user dot-directories are visible. This classification lives
 * beside traversal so renderers and tool callers cannot widen it. */
function isProtectedHiddenDirName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === '.git'
    || normalized === '.hg'
    || normalized === '.svn'
    || normalized === '.stashbase'
    || normalized.startsWith('.stashbase-');
}

/** Workspace visibility is intentionally wider than index visibility.
 * Protected hidden directories never surface even when hidden files are
 * shown. This is distinct from `INDEX_EXCLUDED_DIRS`, whose other hidden
 * members surface as bounded excluded rows when the option is enabled. Hidden
 * product-derived artifacts remain infrastructure. Recognized project configuration
 * is visible by default, as are ordinary dot-files and unknown source formats. */
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
      if (isProtectedHiddenDirName(entry.name)) return false;
      if (!opts.showHidden && !VISIBLE_PROJECT_CONFIG_DIRS.has(entry.name)) return false;
    }
    if (entry.isFile() && isOsJunkFile(entry.name)) return false;
    if (entry.isDirectory() && isOsSystemDir(entry.name)) return false;
    // The task list is the reader's view of this file; it joins the tree
    // only with the other hidden files.
    if (entry.isFile() && entry.name === SCHEDULE_FILE_NAME && !opts.showHidden) return false;
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
    ...(entryKind === 'regular' ? {} : { entryKind }),
    availability: 'unreadable',
  };
}

/** A row comes from the entry's metadata alone. Listing never opens a
 * source: a cloud-only file (iCloud's Optimize Mac Storage, a streamed
 * Google Drive) downloads on its first read, so reading ahead would make the
 * tree wait on the network for every such file in the project. */
async function scanWorkspaceFileAsync(entry: fs.Dirent, rel: string, full: string): Promise<FileEntry> {
  let st: fs.Stats;
  try { st = await fs.promises.lstat(full); }
  catch { return unreadableFileEntry(entry, rel); }
  const entryKind = workspaceEntryKind(entry);
  return {
    name: rel,
    format: entryKind === 'regular' ? (detectViewerFormat(entry.name) ?? 'generic') : 'generic',
    size: st.size,
    ...(entryKind === 'regular' ? {} : { entryKind }),
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

export async function listFilesAndFoldersAsync(opts: FolderListingOptions = {}): Promise<FolderListing> {
  const scanResult = await scanDirectoryAsync(folderRoot(), '', { entriesSinceYield: 0 }, opts);
  scanResult.files.sort((a, b) => (a.name < b.name ? -1 : 1));
  scanResult.folders.sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    files: scanResult.files,
    folders: scanResult.folders,
  };
}

export async function listFilesAsync(): Promise<FileEntry[]> {
  return (await listFilesAndFoldersAsync()).files;
}

/** Directory-tool listing seam. It inspects only the requested directory and
 * directory names beneath immediate children; it never reads file contents or
 * scans unrelated branches of the member root. */
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
    if (!format || !isRetrievableViewerFormat(format)) continue;
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

/** Markdown sources a person can open from the tree under the absolute `root`.
 *  Dot-notes stay out the way the workspace listing keeps them out, so a
 *  hidden derived note is never reported as something the reader can review. */
export async function walkMarkdownSourcesAsync(
  root: string,
  fn: (rel: string, full: string) => Promise<void>,
): Promise<void> {
  await walkAsync(root, '', async (rel, full, entry) => {
    if (!entry.isFile() || entry.name.startsWith('.') || detectFormat(rel) !== 'md') return;
    await fn(rel, full);
  });
}

/** Junk OS files hidden from the workspace, matching Finder and Explorer.
 *  `Icon\r` stores a macOS custom folder icon (Google Drive sets one on every
 *  synced folder). `desktop.ini` and `Thumbs.db` hold Explorer folder settings
 *  and thumbnail caches, and `~$` files are Office's lock for an open document.
 *  Windows names compare case-insensitively. Workspace directory visibility
 *  belongs to `workspaceDirectoryEntries`; retrieval walks skip dot-directories. */
const HIDDEN_OS_FILES = new Set<string>([
  '.DS_Store',
  'Icon\r',
]);
const HIDDEN_WINDOWS_FILES = new Set<string>(['desktop.ini', 'thumbs.db', 'ehthumbs.db']);
// The prefix alone is a valid ordinary filename, including Markdown drafts.
const OFFICE_LOCK_FILE = /^~\$.*\.(?:doc[xm]?|dot[xm]?|xls[xmb]?|xlt[xm]?|ppt[xm]?|pps[xm]?|pot[xm]?)$/i;

function isOsJunkFile(name: string): boolean {
  return HIDDEN_OS_FILES.has(name) || HIDDEN_WINDOWS_FILES.has(name.toLowerCase()) || OFFICE_LOCK_FILE.test(name);
}

/** A Windows drive root holds the recycle bin and restore data; neither is
 *  project content, and the recycle bin would surface deleted documents. */
const WINDOWS_SYSTEM_DIRS = new Set<string>(['$recycle.bin', 'system volume information']);

function isOsSystemDir(name: string): boolean {
  return WINDOWS_SYSTEM_DIRS.has(name.toLowerCase());
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
    if (entry.isFile() && isOsJunkFile(entry.name)) continue;
    if (entry.isDirectory() && isOsSystemDir(entry.name)) continue;
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
