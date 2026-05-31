import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSpaceName } from './space.ts';

export type ImportFolderMode = 'copy' | 'move';

export interface FolderImportPreview {
  source: string;
  name: string;
  destination: string;
  exists: boolean;
  entryCount: number;
  totalBytes: number;
  requiresConfirmation: boolean;
  warnings: string[];
  hasSnapshot: boolean;
}

export interface ImportFolderOptions {
  source: string;
  kbRoot: string;
  name?: string;
  mode?: ImportFolderMode;
  confirmExisting?: boolean;
}

export interface ImportFolderResult {
  path: string;
  name: string;
  mode: ImportFolderMode;
}

const STASHBASE_PER_MACHINE_ENTRIES = ['config.json', 'mfs', 'cache'];
const CONFIRM_ENTRY_LIMIT = 0;

export function previewFolderImport(
  opts: Pick<ImportFolderOptions, 'source' | 'kbRoot' | 'name'>,
): FolderImportPreview {
  const source = normalizeSource(opts.source);
  const kbRoot = path.resolve(opts.kbRoot);
  assertImportableSource(source, kbRoot);

  const name = (opts.name?.trim() || path.basename(source)).trim();
  const badName = validateSpaceName(name);
  if (badName) throw new Error(badName);

  const destination = path.join(kbRoot, name);
  const stats = scanFolder(source);
  const warnings = buildWarnings(source, kbRoot, name, stats.entryCount);

  return {
    source,
    name,
    destination,
    exists: stats.entryCount > 0,
    entryCount: stats.entryCount,
    totalBytes: stats.totalBytes,
    requiresConfirmation: stats.entryCount > CONFIRM_ENTRY_LIMIT,
    warnings,
    hasSnapshot: fileExists(path.join(source, '.stashbase', 'snapshot.parquet')),
  };
}

export function importFolderAsSpace(opts: ImportFolderOptions): ImportFolderResult {
  const mode = opts.mode ?? 'copy';
  if (mode !== 'copy' && mode !== 'move') throw new Error('mode must be "copy" or "move"');
  const preview = previewFolderImport(opts);
  if (preview.requiresConfirmation && opts.confirmExisting !== true) {
    const err = new Error('confirmation required before importing this folder');
    (err as any).code = 'CONFIRM_EXISTING';
    throw err;
  }

  fs.mkdirSync(path.dirname(preview.destination), { recursive: true });
  if (!dirExists(path.dirname(preview.destination))) throw new Error('library root is not a directory');
  if (fs.existsSync(preview.destination)) {
    const err = new Error(`space "${preview.name}" already exists`);
    (err as any).code = 'SPACE_EXISTS';
    throw err;
  }

  try {
    copyDirectoryDereferenced(preview.source, preview.destination);
    pruneImportedStashbase(path.join(preview.destination, '.stashbase'));
    if (mode === 'move') {
      fs.rmSync(preview.source, { recursive: true, force: false });
    }
    return { path: preview.destination, name: preview.name, mode };
  } catch (err) {
    try { fs.rmSync(preview.destination, { recursive: true, force: true }); } catch { /* best-effort rollback */ }
    throw err;
  }
}

function normalizeSource(raw: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('source required');
  let expanded = raw.trim();
  if (expanded === '~' || expanded.startsWith('~/')) expanded = path.join(os.homedir(), expanded.slice(1));
  const source = path.resolve(expanded);
  if (!dirExists(source)) throw new Error(fs.existsSync(source) ? 'source is not a directory' : 'source not found');
  return source;
}

function assertImportableSource(source: string, kbRoot: string): void {
  const home = os.homedir();
  if (source === home || source === path.parse(source).root) {
    throw new Error('refusing to import home or filesystem root');
  }
  const relFromRoot = path.relative(kbRoot, source);
  const isInsideKb = source === kbRoot
    || (relFromRoot !== '' && !relFromRoot.startsWith('..') && !path.isAbsolute(relFromRoot));
  if (isInsideKb) {
    throw new Error('source is already inside the library; use Open space');
  }
  const relRootFromSource = path.relative(source, kbRoot);
  const containsKbRoot = relRootFromSource !== ''
    && !relRootFromSource.startsWith('..')
    && !path.isAbsolute(relRootFromSource);
  if (containsKbRoot) {
    throw new Error('source contains the library root; choose a more specific folder');
  }
}

function scanFolder(source: string): { entryCount: number; totalBytes: number } {
  let entryCount = 0;
  let totalBytes = 0;
  const seenDirectories = new Set<string>();
  try { seenDirectories.add(fs.realpathSync(source)); } catch { /* source was already stat-checked */ }
  const stack = [source];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      entryCount += 1;
      const full = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile()) totalBytes += stat.size;
        if (stat.isDirectory()) {
          const real = fs.realpathSync(full);
          if (!seenDirectories.has(real)) {
            seenDirectories.add(real);
            stack.push(full);
          }
        }
      } catch {
        /* Unreadable entries are surfaced by copy during import. */
      }
    }
  }
  return { entryCount, totalBytes };
}

function copyDirectoryDereferenced(source: string, destination: string): void {
  if (fs.existsSync(destination)) throw new Error(`destination already exists: ${destination}`);
  fs.mkdirSync(destination, { recursive: false });
  const seen = new Set([fs.realpathSync(source)]);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dest = path.join(destination, entry.name);
    copyEntryDereferenced(src, dest, seen);
  }
}

function copyEntryDereferenced(source: string, destination: string, seenDirectories: Set<string>): void {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    const real = fs.realpathSync(source);
    if (seenDirectories.has(real)) throw new Error(`cyclic symlink detected: ${source}`);
    seenDirectories.add(real);
    fs.mkdirSync(destination, { mode: stat.mode });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyEntryDereferenced(path.join(source, entry.name), path.join(destination, entry.name), seenDirectories);
    }
    seenDirectories.delete(real);
    return;
  }
  if (stat.isFile()) {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, stat.mode);
    return;
  }
  throw new Error(`unsupported filesystem entry: ${source}`);
}

function buildWarnings(source: string, kbRoot: string, name: string, entryCount: number): string[] {
  const warnings: string[] = [];
  const home = os.homedir();
  const sensitiveNames = new Set(['Desktop', 'Documents', 'Downloads']);
  if (path.dirname(source) === home && sensitiveNames.has(path.basename(source))) {
    warnings.push(`This looks like your ${path.basename(source)} folder.`);
  }
  if (entryCount > 0) {
    warnings.push('Importing copies this existing folder into your StashBase library.');
  }
  warnings.push(`Destination will be ${path.join(kbRoot, name)}.`);
  return warnings;
}

function pruneImportedStashbase(stashbaseDir: string): void {
  if (!fs.existsSync(stashbaseDir)) return;
  for (const entry of STASHBASE_PER_MACHINE_ENTRIES) {
    fs.rmSync(path.join(stashbaseDir, entry), { recursive: true, force: true });
  }
}

function dirExists(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function fileExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
