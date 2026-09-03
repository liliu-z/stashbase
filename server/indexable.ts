import fs from 'node:fs';
import { detectFormat } from './format.ts';
import { analyzeHtml } from './html.ts';

/** Directories that are usually generated, dependency caches, VCS state,
 *  or source-project internals. If a user opens a code checkout, these
 *  skips keep indexing bounded and predictable. */
export const INDEX_EXCLUDED_DIRS = new Set<string>([
  '.cache',
  '.git',
  '.hg',
  '.next',
  '.nuxt',
  '.output',
  '.parcel-cache',
  '.pnpm-store',
  '.svelte-kit',
  '.turbo',
  '.venv',
  '.venv.nosync',
  '.vite',
  '.yarn',
  '__pycache__',
  'bower_components',
  'build',
  'coverage',
  'DerivedData',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
]);

/** Large recursive scans yield after this many entries so folder entry and
 * reconcile cannot monopolize the shared Node event loop on flat code trees. */
export const FILESYSTEM_SCAN_YIELD_EVERY = 2_048;

/** Hard ceiling for a single source text that we will send to the daemon.
 *  It must be large enough for book-length PDF/OCR derived markdown,
 *  while still catching accidental bundled app dumps or source trees. */
export const MAX_INDEXABLE_BYTES = 8 * 1024 * 1024;

export function isIndexExcludedDirName(name: string): boolean {
  return INDEX_EXCLUDED_DIRS.has(name);
}

/** Dot-prefixed DIRECTORIES are tool/config internals (.claude, .git,
 *  .obsidian), never knowledge: the index skips them wholesale, and the
 *  sidebar listing skips them unless its explicit show-hidden option opts
 *  eligible ones in (a Workbench visibility choice that never widens index
 *  visibility). Directory segments only — dot FILES keep their own
 *  semantics (derived notes are dot-files). Deliberately separate from
 *  isIndexExcludedDirName: that predicate also gates writable paths,
 *  and writes into .claude (agent config) must stay allowed. */
export function isHiddenDirName(name: string): boolean {
  return name.startsWith('.');
}

export function isCloudPlaceholderName(name: string): boolean {
  return name.toLowerCase().endsWith('.icloud');
}

export function pathHasCloudPlaceholder(relPath: string): boolean {
  return relPath
    .replace(/\\/g, '/')
    .split('/')
    .some((seg) => isCloudPlaceholderName(seg));
}

function dipsIntoIndexExcludedDir(relPath: string): boolean {
  const segments = relPath.replace(/\\/g, '/').split('/');
  return segments.some((seg, i) =>
    INDEX_EXCLUDED_DIRS.has(seg)
    || isGeneratedPdfBatchCacheDir(seg)
    // Hidden-dir rule applies to directory segments only — the basename
    // may be a dot-file (derived note) with its own handling.
    || (i < segments.length - 1 && isHiddenDirName(seg)));
}

/** Directory-scope form of the retrieval boundary. Unlike file paths, every
 * segment is a directory segment, so a hidden final basename is excluded too. */
export function isRetrievalEligibleDirectoryPath(relPath: string): boolean {
  if (pathHasCloudPlaceholder(relPath)) return false;
  const segments = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return !segments.some((seg) => INDEX_EXCLUDED_DIRS.has(seg)
    || isGeneratedPdfBatchCacheDir(seg)
    || isHiddenDirName(seg));
}

function isGeneratedPdfBatchCacheDir(seg: string): boolean {
  return /^\.[^/]+\.pdf\.md\.batches$/i.test(seg);
}

/** Legacy agent-maintained sidecar files. The metadata subsystem was
 *  removed, but existing libraries may still have these on disk;
 *  keep them out of the index so they don't surface as bogus hits. */
const EXCLUDED_BASENAMES = new Set<string>([
  'file-metadata.md',
  'folder-metadata.md',
]);

export function shouldIndexFilePath(relPath: string): boolean {
  if (!detectFormat(relPath)) return false;
  return isRetrievalEligiblePath(relPath);
}

/** Path-only eligibility shared by direct-text indexing and prepared formats.
 * Format dispatch remains the caller's responsibility. */
export function isRetrievalEligiblePath(relPath: string): boolean {
  if (pathHasCloudPlaceholder(relPath)) return false;
  const base = relPath.replace(/\\/g, '/').split('/').pop() ?? '';
  if (EXCLUDED_BASENAMES.has(base)) return false;
  return !dipsIntoIndexExcludedDir(relPath);
}

export function shouldIndexSourcePath(sourcePath: string): boolean {
  return shouldIndexFilePath(sourcePath);
}

export function indexableFileSizeError(absPath: string): string | null {
  let st: fs.Stats;
  try { st = fs.statSync(absPath); } catch { return 'file is not readable'; }
  if (!st.isFile()) return 'path is not a file';
  if (st.size === 0) return 'empty file';
  if (st.size > MAX_INDEXABLE_BYTES) {
    return `file is too large to index (${formatBytes(st.size)} > ${formatBytes(MAX_INDEXABLE_BYTES)})`;
  }
  return null;
}

export async function indexableFileSizeErrorAsync(absPath: string): Promise<string | null> {
  let st: fs.Stats;
  try { st = await fs.promises.stat(absPath); } catch { return 'file is not readable'; }
  if (!st.isFile()) return 'path is not a file';
  if (st.size === 0) return 'empty file';
  if (st.size > MAX_INDEXABLE_BYTES) {
    return `file is too large to index (${formatBytes(st.size)} > ${formatBytes(MAX_INDEXABLE_BYTES)})`;
  }
  return null;
}

/** True when the file's *extractable* text is empty even though the
 *  file itself is not — a bundler-format HTML that is one giant
 *  `<script>` with no prose, or a whitespace-only note. Such files can
 *  never produce chunks, so nothing is ever stored in Milvus for them
 *  and the daemon's name-only `status` reports them pending forever.
 *  Callers treat them like empty files: drop from the sidebar's pending
 *  pulse, skip the futile embed round-trip.
 *
 *  Cached by (size, mtime): the status poll runs every 1.5s while the
 *  sidebar pulses, and re-analyzing a large HTML on each tick would be
 *  wasted work. */
const noTextCache = new Map<string, { size: number; mtimeMs: number; noText: boolean }>();

export function hasNoExtractableText(absPath: string): boolean {
  const format = detectFormat(absPath);
  if (!format) return false;
  let st: fs.Stats;
  try { st = fs.statSync(absPath); } catch { return false; }
  const hit = noTextCache.get(absPath);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.noText;
  let noText = false;
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    noText = format === 'html'
      ? analyzeHtml(content).plaintext.length === 0
      : content.trim().length === 0;
  } catch { /* unreadable — let the indexing path surface the error */ }
  noTextCache.set(absPath, { size: st.size, mtimeMs: st.mtimeMs, noText });
  return noText;
}

export function contentSizeError(content: string): string | null {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes === 0) return null;
  if (bytes > MAX_INDEXABLE_BYTES) {
    return `file is too large to index (${formatBytes(bytes)} > ${formatBytes(MAX_INDEXABLE_BYTES)})`;
  }
  return null;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
