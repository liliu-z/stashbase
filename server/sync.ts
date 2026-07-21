/**
 * Folder sync: reconcile the index with whatever note files are
 * currently on disk in the folder.
 *
 * ONE flavour (2026-06 simplification): `syncIndex` — full content-hash
 * diff via the daemon's `scan_diff` op. Hashing a personal-library-sized tree
 * is milliseconds; embedding only happens for changed hashes, so a
 * cheaper name-only tier bought nothing but a second semantics. Called
 * on folder open/switch, window focus, agent turn end, the manual
 * `POST /api/sync` button, and MCP `reindex`.
 *
 * Scoped to ONE folder at a time and fully context-free: the target
 * folder arrives as an explicit **absolute root** argument and every path
 * (including the PDF/image conversion discovery below) is resolved against
 * that root — never against the ambient window context. Sync runs in
 * contexts that have no folder open at all (headless server,
 * `POST /api/sync?folder=X` from a window that has a different folder open).
 */
import fs from 'node:fs';
import path from 'node:path';
import { discoverConvertibleSources, indexFreshConvertibleSource } from './conversion-dispatch.ts';
import { getApiKey } from './app-config.ts';
import type { Indexer } from './indexer.ts';
import { logger, errorMessage } from './log.ts';
import { hasNoExtractableText, indexableFileSizeError, shouldIndexFilePath } from './indexable.ts';
import { isConvertibleSource } from './format.ts';
import { cancelConversion } from './conversion.ts';
import { clearRecord } from './conversion-status.ts';
import { deleteDerivedForSource, knownDerivedSourcesUnderFolder } from './derived-store.ts';
import { filesystemPath } from './filesystem-path.ts';

const log = logger('sync');

/** Strip the absolute folder root prefix from an absolute path, or null
 *  when the path lives outside that folder (a daemon cross-folder
 *  surprise). Deliberately NOT `fromSourcePath()` — that resolves the folder
 *  from the ambient window context, which the sync caller may not have. */
function folderRelOf(root: string, abs: string): string | null {
  const rel = filesystemPath.relative(root, abs);
  return rel === '' ? null : rel;
}

/** Runtime assertion for the Data Correctness "sync does not lie" review rule:
 *  a file this sync just claimed to have indexed must not still be in
 *  the daemon's name-only pending set. A violation is the
 *  write-black-hole fingerprint — upsert returned ok but the store has
 *  no rows for the file (observed when a second daemon fights over the
 *  Milvus Lite flock) — and is otherwise invisible until a user
 *  notices search misses days later. Best-effort: one extra status
 *  round-trip per non-empty sync; any error here is swallowed (the
 *  sync itself already succeeded from the caller's perspective). */
async function assertSyncConverged(
  indexer: Indexer,
  root: string,
  claimed: string[],
): Promise<void> {
  if (claimed.length === 0) return;
  let pending: Set<string>;
  try {
    pending = new Set((await indexer.status(root)).pending);
  } catch {
    return;
  }
  for (const abs of claimed) {
    if (!pending.has(abs)) continue;
    // Files that can never produce chunks (over-size, no extractable
    // text) are legitimately skipped by upsert yet keep showing in the
    // daemon's raw pending — not a lie, not a black hole.
    if (indexableFileSizeError(abs) !== null || hasNoExtractableText(abs)) continue;
    log.error(
      `sync claimed "${abs}" indexed but the daemon still reports it pending — ` +
        'write-black-hole fingerprint. Check for a second ' +
        'stashbase daemon fighting over the Milvus lock (ps aux | grep stashbase-daemon).',
    );
  }
}

/** Read a file by its absolute path, validated to live under `root`.
 *  Null on escape or read failure — same contract as `files.ts:readText`,
 *  minus the current-folder resolution. */
function readTextAt(root: string, abs: string): string | null {
  const rel = filesystemPath.relative(root, abs);
  if (rel == null || rel === '') return null;
  try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}

export interface SyncResult {
  added: string[];
  modified: string[];
  removed: string[];
  /** Files the daemon's scan_diff matched by content hash to a
   *  previously-indexed (now-deleted) path. Each entry is the NEW
   *  folder-relative path. Routed through `indexer.renameFile`, which the
   *  daemon fast-paths to reuse cached embeddings — no embedding tokens
   *  spent for these. */
  renamed: string[];
  failed: { name: string; error: string }[];
  /** True when the caller deliberately abandoned the sync because the
   *  target folder/window is no longer current. Any arrays are partial work
   *  completed before cancellation was observed. */
  cancelled?: boolean;
}

export interface SyncOptions {
  /** Cooperative cancellation hook. The Python daemon cannot abort an
   *  in-flight upsert, but checking between files stops stale imports from
   *  continuing through the rest of a large folder after a folder switch. */
  shouldContinue?: () => boolean;
}

function emptyResult(cancelled = false): SyncResult {
  return { added: [], modified: [], removed: [], renamed: [], failed: [], ...(cancelled ? { cancelled: true } : {}) };
}

function shouldStop(opts: SyncOptions | undefined): boolean {
  return opts?.shouldContinue ? !opts.shouldContinue() : false;
}

function toFolderRelList(root: string, paths: string[]): string[] {
  return paths.map((p) => folderRelOf(root, p) ?? p);
}

function toFolderRelFailures(
  root: string,
  failed: { name: string; error: string }[],
): { name: string; error: string }[] {
  return failed.map((f) => ({ ...f, name: folderRelOf(root, f.name) ?? f.name }));
}

function syncIndexCandidates(root: string, paths: string[]): string[] {
  return paths.filter((abs) => {
    const folderRel = folderRelOf(root, abs);
    return folderRel != null && shouldIndexFilePath(folderRel);
  });
}

function isLiveConvertedIndexRow(root: string, sourcePath: string): boolean {
  const folderRel = folderRelOf(root, sourcePath);
  return folderRel != null && isConvertibleSource(folderRel) && fs.existsSync(sourcePath);
}

async function deleteStaleRenameSource(
  indexer: Indexer,
  oldPath: string,
  failed: { name: string; error: string }[],
): Promise<void> {
  try {
    cleanupRemovedSource(oldPath);
    await indexer.deleteFile(oldPath);
  } catch (err: unknown) {
    failed.push({ name: oldPath, error: `stale rename cleanup failed: ${errorMessage(err)}` });
  }
}

function discoverConvertedSources(root: string): void {
  discoverConvertibleSources(root);
}

function cleanupRemovedSource(sourcePath: string): void {
  if (!isConvertibleSource(sourcePath)) return;
  try { cancelConversion(sourcePath); } catch { /* best-effort */ }
  try { clearRecord(sourcePath); } catch { /* best-effort */ }
  try { deleteDerivedForSource(sourcePath); } catch (err: unknown) {
    log.warn(`removed-source cleanup failed for ${sourcePath}: ${errorMessage(err)}`);
  }
}

function invalidateModifiedConvertedSource(sourcePath: string): void {
  if (!isConvertibleSource(sourcePath)) return;
  try { cancelConversion(sourcePath); } catch { /* best-effort */ }
  try { clearRecord(sourcePath); } catch { /* best-effort */ }
  try { deleteDerivedForSource(sourcePath); } catch (err: unknown) {
    log.warn(`modified-source invalidation failed for ${sourcePath}: ${errorMessage(err)}`);
  }
}

function cleanupMissingConvertedSources(root: string): void {
  for (const sourcePath of knownDerivedSourcesUnderFolder(root)) {
    if (fs.existsSync(sourcePath)) continue;
    cleanupRemovedSource(sourcePath);
  }
}

async function cleanupConvertedRename(
  indexer: Indexer,
  oldPath: string,
  newPath: string,
  failed: { name: string; error: string }[],
): Promise<void> {
  cleanupRemovedSource(oldPath);
  // A path can be reused by a different source between app runs. Clear the
  // target's stale app-owned state before discovery queues a fresh conversion.
  try { cancelConversion(newPath); } catch { /* best-effort */ }
  try { clearRecord(newPath); } catch { /* best-effort */ }
  try { deleteDerivedForSource(newPath); } catch (err: unknown) {
    log.warn(`rename-target cleanup failed for ${newPath}: ${errorMessage(err)}`);
  }
  try {
    await indexer.deleteFile(oldPath);
  } catch (err: unknown) {
    failed.push({ name: oldPath, error: `converted rename cleanup failed: ${errorMessage(err)}` });
  }
}

/** Full content-hash diff. `root` is the **absolute folder root**
 *  (e.g. `/Users/me/notes`) — any folder, not necessarily one open in a
 *  window. Returns folder-relative paths so the manual sync UI can show
 *  them straight. */
export async function syncIndex(indexer: Indexer, root: string, opts: SyncOptions = {}): Promise<SyncResult> {
  if (shouldStop(opts)) return emptyResult(true);

  // No OpenAI key → semantic indexing is disabled by design (§5.3): the
  // daemon has no embedder/store, so every upsert would throw "no bound
  // root … set an OpenAI API key" and a whole-folder import would flood
  // the log with one failure per file. Conversion discovery still
  // runs so PDFs/images can produce AppData derived text for keyword search
    // and future reindex.
  if (!getApiKey()) {
    cleanupMissingConvertedSources(root);
    discoverConvertedSources(root);
    log.info(`no OpenAI key — skipping semantic index for "${root}" (conversion + keyword search unaffected)`);
    return emptyResult();
  }

  if (shouldStop(opts)) return emptyResult(true);
  const diff = await indexer.syncDiff(root);
  const failed: { name: string; error: string }[] = [];
  const excludedRemoved = await removeExcludedIndexedFiles(indexer, root, failed);
  cleanupMissingConvertedSources(root);
  // scan_diff is content-hash based. Invalidate converted output for every
  // byte-level modification before freshness/discovery checks, even when a
  // sync tool preserved source size and mtime.
  for (const sourcePath of diff.modified) invalidateModifiedConvertedSource(sourcePath);

  const deletedCandidates = diff.deleted.filter((sourcePath) => !isLiveConvertedIndexRow(root, sourcePath));

  if (
    diff.added.length === 0 && diff.modified.length === 0 &&
    deletedCandidates.length === 0 && diff.renamed.length === 0 && excludedRemoved.length === 0
  ) {
    discoverConvertedSources(root);
    log.debug('index up to date');
    return emptyResult();
  }

  // Renames first — they consume rows the deletes would otherwise wipe
  // (we already filtered the paired deletes out of `diff.deleted` in
  // scan_diff, but doing renames before deletes keeps the daemon's
  // collection state monotonic).
  const renamedDone: string[] = [];
  if (diff.renamed.length) {
    log.info(`renaming ${diff.renamed.length} file(s) (hash match, no re-embed)`);
    for (const r of diff.renamed) {
      if (shouldStop(opts)) {
        return {
          added: [],
          modified: [],
          removed: [],
          renamed: toFolderRelList(root, renamedDone),
          failed: toFolderRelFailures(root, failed),
          cancelled: true,
        };
      }
      const folderRel = folderRelOf(root, r.new);
      if (folderRel == null) {
        failed.push({ name: r.new, error: `path not under synced folder ""` });
        continue;
      }
      if (isConvertibleSource(folderRel)) {
        await cleanupConvertedRename(indexer, r.old, r.new, failed);
        renamedDone.push(r.new);
        continue;
      }
      const tooLarge = indexableFileSizeError(r.new);
      if (tooLarge) {
        failed.push({ name: r.new, error: tooLarge });
        await deleteStaleRenameSource(indexer, r.old, failed);
        continue;
      }
      const content = readTextAt(root, r.new);
      if (content == null) {
        failed.push({ name: r.new, error: 'read returned null on rename target' });
        await deleteStaleRenameSource(indexer, r.old, failed);
        continue;
      }
      try {
        const chunks = await indexer.renameFile(r.old, r.new, content);
        if (chunks > 0) renamedDone.push(r.new);
      } catch (err: any) {
        failed.push({ name: r.new, error: errorMessage(err) });
        await deleteStaleRenameSource(indexer, r.old, failed);
      }
    }
  }

  const removedDone: string[] = [...excludedRemoved];
  if (deletedCandidates.length) {
    log.info(`removing ${deletedCandidates.length} stale file(s) from index`);
    for (const sourcePath of deletedCandidates) {
      if (shouldStop(opts)) {
        return {
          added: [],
          modified: [],
          removed: toFolderRelList(root, removedDone),
          renamed: toFolderRelList(root, renamedDone),
          failed: toFolderRelFailures(root, failed),
          cancelled: true,
        };
      }
      try {
        cleanupRemovedSource(sourcePath);
        await indexer.deleteFile(sourcePath);
        removedDone.push(sourcePath);
      }
      catch (err: any) { failed.push({ name: sourcePath, error: errorMessage(err) }); }
    }
  }

  // Surface untracked PDFs / images after stale delete/rename cleanup.
  // This ordering matters for external Finder/Git moves: a renamed
  // PDF/image must first clear the old source identity and any stale
  // target artifacts, then queue a fresh conversion for the new path.
  discoverConvertedSources(root);

  const convertedAddedDone = await indexFreshConvertedSources(indexer, root, diff.added, failed, opts);
  if (convertedAddedDone.cancelled) {
    return {
      added: toFolderRelList(root, convertedAddedDone.done),
      modified: [],
      removed: toFolderRelList(root, removedDone),
      renamed: toFolderRelList(root, renamedDone),
      failed: toFolderRelFailures(root, failed),
      cancelled: true,
    };
  }
  const convertedModifiedDone = await indexFreshConvertedSources(indexer, root, diff.modified, failed, opts);
  if (convertedModifiedDone.cancelled) {
    return {
      added: toFolderRelList(root, convertedAddedDone.done),
      modified: toFolderRelList(root, convertedModifiedDone.done),
      removed: toFolderRelList(root, removedDone),
      renamed: toFolderRelList(root, renamedDone),
      failed: toFolderRelFailures(root, failed),
      cancelled: true,
    };
  }

  const addedCandidates = syncIndexCandidates(root, diff.added);
  const modifiedCandidates = syncIndexCandidates(root, diff.modified);
  const toIndex = [...addedCandidates, ...modifiedCandidates];
  if (toIndex.length) {
    log.info(
      `indexing ${toIndex.length} file(s) ` +
        `(${addedCandidates.length} new, ${modifiedCandidates.length} drift-detected)`,
    );
  }
  const addedDone: string[] = [...convertedAddedDone.done];
  const modifiedDone: string[] = [...convertedModifiedDone.done];
  for (const sourcePath of addedCandidates) {
    if (shouldStop(opts)) {
      return {
        added: toFolderRelList(root, addedDone),
        modified: [],
        removed: toFolderRelList(root, removedDone),
        renamed: toFolderRelList(root, renamedDone),
        failed: toFolderRelFailures(root, failed),
        cancelled: true,
      };
    }
    const chunks = await indexOne(indexer, root, sourcePath, failed);
    if (chunks > 0) addedDone.push(sourcePath);
  }
  for (const sourcePath of modifiedCandidates) {
    if (shouldStop(opts)) {
      return {
        added: toFolderRelList(root, addedDone),
        modified: toFolderRelList(root, modifiedDone),
        removed: toFolderRelList(root, removedDone),
        renamed: toFolderRelList(root, renamedDone),
        failed: toFolderRelFailures(root, failed),
        cancelled: true,
      };
    }
    const chunks = await indexOne(indexer, root, sourcePath, failed);
    if (chunks > 0) modifiedDone.push(sourcePath);
  }

  log.info(
    `done. added=${addedDone.length}/${addedCandidates.length} ` +
      `modified=${modifiedDone.length}/${modifiedCandidates.length} ` +
      `renamed=${renamedDone.length}/${diff.renamed.length} ` +
      `removed=${removedDone.length}/${deletedCandidates.length + excludedRemoved.length} failed=${failed.length}`,
  );
  await assertSyncConverged(indexer, root, [...addedDone, ...modifiedDone, ...renamedDone]);
  return {
    added: toFolderRelList(root, addedDone),
    modified: toFolderRelList(root, modifiedDone),
    removed: toFolderRelList(root, removedDone),
    renamed: toFolderRelList(root, renamedDone),
    failed: toFolderRelFailures(root, failed),
  };
}

async function indexFreshConvertedSources(
  _indexer: Indexer,
  root: string,
  paths: string[],
  failed: { name: string; error: string }[],
  opts: SyncOptions,
): Promise<{ done: string[]; cancelled: boolean }> {
  const done: string[] = [];
  for (const sourcePath of paths) {
    if (shouldStop(opts)) return { done, cancelled: true };
    const folderRel = folderRelOf(root, sourcePath);
    if (folderRel == null || !isConvertibleSource(folderRel)) continue;
    try {
      const indexed = await indexFreshConvertibleSource(sourcePath, folderRel);
      if (indexed) done.push(sourcePath);
    } catch (err: unknown) {
      failed.push({ name: sourcePath, error: errorMessage(err) });
    }
  }
  return { done, cancelled: false };
}

/** Read the file at `sourcePath` (currently an absolute source path) and upsert
 *  it under that same path. Returns the stored chunk count on success, 0 when skipped or
 *  unchunkable, and pushes a failure record on real failure. */
async function indexOne(
  indexer: Indexer,
  root: string,
  sourcePath: string,
  failed: { name: string; error: string }[],
): Promise<number> {
  const folderRel = folderRelOf(root, sourcePath);
  if (folderRel == null) {
    // Daemon reported a path outside the folder this sync is scoped to —
    // shouldn't happen, but guard so a cross-folder surprise can't wedge
    // the loop.
    failed.push({ name: sourcePath, error: `path not under synced folder ""` });
    return 0;
  }
  if (!shouldIndexFilePath(folderRel)) {
    try { await indexer.deleteFile(sourcePath); } catch { /* best-effort stale cleanup */ }
    return 0;
  }
  const tooLarge = indexableFileSizeError(sourcePath);
  if (tooLarge) {
    try { await indexer.deleteFile(sourcePath); } catch { /* best-effort stale cleanup */ }
    failed.push({ name: sourcePath, error: tooLarge });
    log.warn(`skipped ${sourcePath}: ${tooLarge}`);
    return 0;
  }
  const content = readTextAt(root, sourcePath);
  if (content == null) {
    failed.push({ name: sourcePath, error: 'read returned null' });
    return 0;
  }
  try {
    return await indexer.upsertFile(sourcePath, content);
  } catch (err: any) {
    const msg = errorMessage(err);
    failed.push({ name: sourcePath, error: msg });
    log.warn(`failed ${sourcePath}: ${msg}`);
    return 0;
  }
}

async function removeExcludedIndexedFiles(
  indexer: Indexer,
  root: string,
  failed: { name: string; error: string }[],
): Promise<string[]> {
  let indexed: Record<string, string>;
  try {
    indexed = await indexer.listFiles(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const sourcePath of Object.keys(indexed)) {
    const folderRel = folderRelOf(root, sourcePath);
    if (folderRel == null || shouldIndexFilePath(folderRel)) continue;
    // A convertible source (PDF/image) is indexed under its own path with
    // the derived markdown as content; `shouldIndexFilePath` is false for it
    // (its raw bytes aren't index-readable), but as long as the source file
    // still exists the entry is legitimate — the conversion path owns it.
    if (isConvertibleSource(folderRel) && fs.existsSync(sourcePath)) continue;
    try {
      cleanupRemovedSource(sourcePath);
      await indexer.deleteFile(sourcePath);
      removed.push(sourcePath);
    } catch (err: unknown) {
      failed.push({ name: sourcePath, error: `excluded index cleanup failed: ${errorMessage(err)}` });
    }
  }
  if (removed.length) log.info(`removed ${removed.length} excluded file(s) from index`);
  return removed;
}
