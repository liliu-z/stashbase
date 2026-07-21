/**
 * Indexer impl backed by the Python MFS sidecar. Each method translates
 * a logical op into one JSON request and reshapes the reply to match
 * the `Indexer` contract. The `Indexer` API speaks absolute POSIX-spelled
 * source paths; this module is the daemon boundary and sends Node-generated
 * comparison identities separately wherever Python needs routing keys. The
 * daemon keys one global collection by retained absolute source path and
 * scopes by an absolute folder root.
 *
 * HTML special-case: we feed MFS a markdown-shaped plaintext (see
 * `server/html.ts:analyzeHtml`) so its markdown chunker keeps respecting
 * heading boundaries even though it has no HTML parser. The on-disk
 * file extension stays `.html` — only what we send to the indexer is
 * rewritten.
 */
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import path from 'node:path';
import { analyzeHtml } from './html.ts';
import { detectFormat } from './format.ts';
import { contentSizeError, shouldIndexSourcePath } from './indexable.ts';
import { logger } from './log.ts';
import { getDaemon } from './mfs-daemon.ts';
import { filesystemPath } from './filesystem-path.ts';
import type { FilesystemPathModule } from './filesystem-path.ts';
import type {
  EmbedderRuntimeConfig,
  Indexer,
  IndexStatus,
  SearchHit,
  SyncDiff,
} from './indexer.ts';

const log = logger('index');

// The daemon keys its single global collection by **absolute POSIX path**
// and binds absolute folder roots. Under the Folder model every caller
// already passes absolute paths/roots (`state.ts` binds absolute roots) and accepts absolute paths
// back. This adapter normalizes every crossing so daemon calls never acquire
// a second separator or relative-path convention.
const normalizeDaemonPath = (p: string): string => filesystemPath.absolute(p);

/** Rebase one indexed source onto the retained spelling of its longest bound
 * member root. Identity is deliberately computed only by filesystemPath;
 * Python receives the resulting old/new pair and does no Unicode case map. */
export function retainedIndexedSource(
  root: string,
  source: string,
  boundRoots: readonly string[],
  paths: FilesystemPathModule = filesystemPath,
): string | null {
  const owner = boundRoots
    .filter((candidate) => paths.contains(candidate, source))
    .sort((a, b) => paths.identity(b).length - paths.identity(a).length)[0];
  if (!owner || !paths.equal(owner, root)) return null;
  const rel = paths.relative(root, source);
  if (!rel) return null;
  const retained = paths.join(root, rel);
  return retained === source ? null : retained;
}

/** Convert (path, raw content) into the (text, ext, fileHash) tuple
 *  the daemon expects. HTML gets pre-flattened to markdown-shaped
 *  plaintext so MFS's markdown chunker respects heading boundaries.
 *
 *  `fileHash` is **always BLAKE3 of the ORIGINAL on-disk content**, not
 *  the chunked text — it has to match the hash MFS Scanner computes
 *  during scan_diff (we patch the scanner to BLAKE3 too — see
 *  `python/stashbase_daemon.py:_patch_scanner_blake3`), otherwise an HTML
 *  file would forever look "modified" against the index. BLAKE3(content
 *  as UTF-8) here equals the daemon's BLAKE3 of the raw file bytes for
 *  any UTF-8 file — the same invariant SHA256 relied on. */
function prepareForIndex(filePath: string, content: string): {
  text: string;
  ext: string;
  fileHash: string;
} {
  const fileHash = bytesToHex(blake3(new TextEncoder().encode(content)));
  const format = detectFormat(filePath);
  if (format === 'html') {
    // HTML is structured (the .html file is the source of truth), but
    // MFS's chunker splits on markdown headings — so we run a cheap,
    // in-memory "targeted optimization" that turns <h1-6> into `#`
    // headings + flattened body. Done here at feed time (not materialized
    // to a hidden .md) because the transform is pure-regex / near-free and
    // the .html already covers viewing. Unstructured sources
    // (PDF/image/DOCX/audio),
    // by contrast, are extracted to a hidden `.md` on disk because their
    // conversion is expensive and worth caching.
    const { plaintext } = analyzeHtml(content);
    return { text: plaintext, ext: '.md', fileHash };
  }
  // Markdown (incl. the derived `.md` of an unstructured source): the
  // file already IS the structured single source of truth — index as-is.
  return {
    text: content,
    ext: path.extname(filePath).toLowerCase() || '.md',
    fileHash,
  };
}

interface DaemonHit {
  path: string;
  chunk_index: number;
  chunk_text: string;
  start_line?: number;
  end_line?: number;
  score: number;
  metadata?: Record<string, unknown>;
}

export class MfsIndexer implements Indexer {
  private loggedBindings = new Map<string, string>();
  /** Folders that have successfully received at least one daemon status
   *  response in this process. */
  private folderReady = new Set<string>();
  private legacySources: Map<string, string> | null = null;
  private legacySourceGeneration = -1;

  async bindFolder(folder: string, cfg: EmbedderRuntimeConfig): Promise<void> {
    const daemon = getDaemon();
    const source = normalizeDaemonPath(folder);
    const key = filesystemPath.identity(source);
    await daemon.bindFolder(source, {
      provider: cfg.provider,
      apiKey: cfg.apiKey,
      model: cfg.model,
      dimension: cfg.dimension,
    });
    if (cfg.apiKey) {
      try { await this.reconcileLegacySourceSpelling(source); }
      catch (err) {
        // Legacy spelling repair is auxiliary. A list/read failure must not
        // turn an otherwise valid daemon bind into an indexing outage.
        log.warn(`indexed source spelling inspection failed for ${source}: ${(err as Error).message}`);
      }
    }
    this.folderReady.delete(key);
    const bindingKey = `${cfg.provider}:${cfg.model ?? ''}:${cfg.dimension ?? ''}`;
    if (this.loggedBindings.get(key) === bindingKey) {
      log.debug(`bound ${source} → ${cfg.provider}`);
    } else {
      this.loggedBindings.set(key, bindingKey);
      log.info(`bound ${source} → ${cfg.provider}`);
    }
  }

  async unbindFolder(folder: string): Promise<void> {
    const source = normalizeDaemonPath(folder);
    const key = filesystemPath.identity(source);
    await getDaemon().unbindFolder(source);
    this.folderReady.delete(key);
    this.loggedBindings.delete(key);
  }

  async upsertFile(filePath: string, content: string): Promise<number> {
    if (!shouldIndexSourcePath(filePath)) {
      await getDaemon().call('delete', { path: normalizeDaemonPath(filePath) });
      log.info(`upsert ${filePath}: skipped by index rules`);
      return 0;
    }
    const tooLarge = contentSizeError(content);
    if (tooLarge) {
      await getDaemon().call('delete', { path: normalizeDaemonPath(filePath) });
      log.warn(`upsert ${filePath}: ${tooLarge}`);
      return 0;
    }
    const { text, ext, fileHash } = prepareForIndex(filePath, content);
    // Covers truly empty files AND files whose extractable text is empty
    // (bundler-format HTML that is one giant <script>, whitespace-only
    // notes) — embedding either would store 0 chunks, so skip the
    // round-trip. `/api/index-status` filters the same files out of
    // `pending` (see `hasNoExtractableText`) so they don't pulse forever.
    if (text.trim().length === 0) {
      await getDaemon().call('delete', { path: normalizeDaemonPath(filePath) });
      log.info(`upsert ${filePath}: no extractable text, skipped embedding`);
      return 0;
    }
    const t0 = Date.now();
    const res = await getDaemon().call<{ chunks: number; embed_ms: number; total_ms: number }>(
      'upsert', {
        path: normalizeDaemonPath(filePath),
        path_identity: filesystemPath.identity(filePath),
        content: text,
        ext,
        file_hash: fileHash,
        metadata: {},
      },
    );
    log.info(
      `upsert ${filePath}: ${res.chunks} chunks ` +
        `(embed ${fmtMs(res.embed_ms)}, total ${fmtMs(res.total_ms)}, wall ${fmtMs(Date.now() - t0)})`,
    );
    return res.chunks;
  }

  async upsertConvertedFile(sourceAbs: string, derivedContent: string, sourceHash: string, derivedExt = '.md'): Promise<number> {
    // Convertible sources: the searchable text is stored in AppData, but
    // indexed UNDER the source's own path so folder-scoped search finds it
    // and daemon source-file hash diff matches. HTML-derived DOCX content is
    // flattened with the same transform as source HTML before we feed MFS.
    const ext = derivedExt.toLowerCase();
    const content = ext === '.html' || ext === '.htm'
      ? analyzeHtml(derivedContent).plaintext
      : derivedContent;
    if (content.trim().length === 0) {
      await getDaemon().call('delete', { path: normalizeDaemonPath(sourceAbs) });
      return 0;
    }
    const res = await getDaemon().call<{ chunks: number; embed_ms: number; total_ms: number }>(
      'upsert', {
        path: normalizeDaemonPath(sourceAbs),
        path_identity: filesystemPath.identity(sourceAbs),
        content,
        ext: '.md',
        file_hash: sourceHash,
        metadata: {},
      },
    );
    log.info(`upsert(converted) ${sourceAbs}: ${res.chunks} chunks (embed ${fmtMs(res.embed_ms)})`);
    return res.chunks;
  }

  async deleteFile(filePath: string): Promise<void> {
    await getDaemon().call('delete', { path: normalizeDaemonPath(filePath) });
  }

  async deletePathPrefix(prefix: string): Promise<void> {
    const norm = normalizeDaemonPath(prefix);
    const res = await getDaemon().call<{ removed: number }>(
      'delete_prefix', { prefix: norm },
    );
    log.info(`delete_prefix ${prefix}: removed ${res.removed} chunk(s) from index`);
  }

  async renameFile(oldPath: string, newPath: string, content: string): Promise<number> {
    const { text, ext, fileHash } = prepareForIndex(newPath, content);
    const t0 = Date.now();
    const res = await getDaemon().call<{ chunks: number; embed_ms: number; fast_path?: boolean }>(
      'rename', {
        old: normalizeDaemonPath(oldPath),
        new: normalizeDaemonPath(newPath),
        new_identity: filesystemPath.identity(newPath),
        content: text,
        ext,
        file_hash: fileHash,
        metadata: {},
      },
    );
    // Fast path reuses the cached vectors (embed_ms == 0); only the
    // fallback actually re-embeds. Log which one ran so a slow rename
    // is distinguishable from a copied one.
    const how = res.fast_path ? 'copied' : 're-embedded';
    log.info(
      `rename ${oldPath} → ${newPath}: ${how} ${res.chunks} chunks ` +
        `(embed ${fmtMs(res.embed_ms)}, wall ${fmtMs(Date.now() - t0)})`,
    );
    return res.chunks;
  }

  async renamePathPrefix(
    oldPrefix: string,
    newPrefix: string,
    files: Array<{ path: string; content: string }>,
  ): Promise<void> {
    const oldRoot = normalizeDaemonPath(oldPrefix);
    const newRoot = normalizeDaemonPath(newPrefix);
    if (files.length === 0) {
      await getDaemon().call('rename_prefix', { old: oldRoot, new: newRoot, files: [] });
      return;
    }
    const payload = files.map((f) => {
      const rel = filesystemPath.relative(oldRoot, normalizeDaemonPath(f.path));
      if (rel == null || rel === '') {
        throw new Error(`rename source is outside prefix: ${f.path}`);
      }
      const newP = filesystemPath.join(newRoot, rel);
      const { text, ext, fileHash } = prepareForIndex(newP, f.content);
      return {
        path: normalizeDaemonPath(newP),
        path_identity: filesystemPath.identity(newP),
        content: text,
        ext,
        file_hash: fileHash,
      };
    });
    const t0 = Date.now();
    const res = await getDaemon().call<{ files: number; chunks: number; fast_path_files?: number }>(
      'rename_prefix', { old: oldRoot, new: newRoot, files: payload },
    );
    const fast = res.fast_path_files ?? 0;
    log.info(
      `rename_prefix ${oldPrefix} → ${newPrefix}: ` +
        `${res.files} files (${fast} copied, ${res.files - fast} re-embedded), ` +
        `${res.chunks} chunks (wall ${fmtMs(Date.now() - t0)})`,
    );
  }

  async syncDiff(folder?: string): Promise<SyncDiff> {
    const args: Record<string, unknown> = {};
    if (folder) args.folder = normalizeDaemonPath(folder);
    const res = await getDaemon().call<{
      added: string[];
      modified: string[];
      deleted: string[];
      renamed?: Array<{ old: string; new: string; file_hash: string }>;
      unchanged_count: number;
    }>('scan_diff', args);
    const renamed = (res.renamed ?? []).map((r) => ({ old: normalizeDaemonPath(r.old), new: normalizeDaemonPath(r.new), fileHash: r.file_hash }));
    return {
      added: res.added.map(normalizeDaemonPath),
      modified: res.modified.map(normalizeDaemonPath),
      deleted: res.deleted.map(normalizeDaemonPath),
      renamed,
    };
  }

  async search(query: string, topK: number, folder?: string, pathPrefix?: string, extensions?: string[]): Promise<SearchHit[]> {
    const args: Record<string, unknown> = { query, top_k: topK };
    if (folder) args.folder = normalizeDaemonPath(folder);
    if (pathPrefix) args.path_prefix = normalizeDaemonPath(pathPrefix);
    if (extensions && extensions.length > 0) args.extensions = extensions;
    const res = await getDaemon().call<{ hits: DaemonHit[] }>('search', args);
    return res.hits.map((h) => ({
      fileName: normalizeDaemonPath(h.path),
      chunkIndex: h.chunk_index,
      content: h.chunk_text,
      // MFS markdown chunker stuffs heading info into metadata; lift it
      // to a top-level `heading` field so the external SearchHit contract
      // stays format-agnostic.
      heading: typeof h.metadata?.heading_text === 'string'
        ? (h.metadata.heading_text as string)
        : '',
      startLine: h.start_line,
      endLine: h.end_line,
      score: h.score,
    }));
  }

  async status(folder?: string): Promise<IndexStatus> {
    // Per-folder status: ask the daemon directly. It owns both disk scan
    // and indexed-name truth, which keeps Node from maintaining a second
    // partial cache that can drift from the vector store.
    const args: Record<string, unknown> = {};
    if (folder) args.folder = normalizeDaemonPath(folder);
    const res = await getDaemon().call<{
      total: number;
      indexed: number;
      pending_count: number;
      pending: string[];
      orphaned_count: number;
      orphaned: string[];
      up_to_date: boolean;
    }>('status', args);
    if (folder) {
      this.folderReady.add(filesystemPath.identity(folder));
    }
    return {
      total: res.total,
      indexed: res.indexed,
      pendingCount: res.pending_count,
      pending: res.pending.map(normalizeDaemonPath),
      orphanedCount: res.orphaned_count,
      orphaned: res.orphaned.map(normalizeDaemonPath),
      upToDate: res.up_to_date,
      indexReady: !folder ? true : this.folderReady.has(filesystemPath.identity(folder)),
    };
  }

  async listFiles(folder?: string): Promise<Record<string, string>> {
    const args: Record<string, unknown> = {};
    if (folder) args.folder = normalizeDaemonPath(folder);
    const res = await getDaemon().call<{ files: Record<string, string> }>('list', args);
    const out: Record<string, string> = {};
    for (const [abs, hash] of Object.entries(res.files)) out[normalizeDaemonPath(abs)] = hash;
    return out;
  }

  async closeStore(): Promise<void> {
    const daemon = getDaemon();
    if (daemon.currentGeneration() === 0) return;
    try {
      await daemon.call('close_store', {});
    } finally {
      await daemon.close();
    }
    this.folderReady.clear();
    this.legacySources = null;
    this.legacySourceGeneration = -1;
  }

  async close(): Promise<void> {
    await getDaemon().close();
  }

  private async reconcileLegacySourceSpelling(root: string): Promise<void> {
    const daemon = getDaemon();
    const generation = daemon.currentGeneration();
    if (this.legacySources === null || this.legacySourceGeneration !== generation) {
      const listed = await daemon.call<{ files: Record<string, string> }>('list', {});
      this.legacySources = new Map(Object.entries(listed.files));
      this.legacySourceGeneration = generation;
    }

    const boundRoots = [...daemon.knownBindings().keys()];
    for (const [oldSource, fileHash] of [...this.legacySources.entries()]) {
      const retained = retainedIndexedSource(root, oldSource, boundRoots);
      if (!retained) continue;
      try {
        const result = await daemon.call<{ reused: boolean }>('reconcile_source', {
          old: oldSource,
          new: retained,
          file_hash: fileHash,
        });
        this.legacySources.delete(oldSource);
        if (result.reused) this.legacySources.set(retained, fileHash);
        log.info(`reconciled indexed source spelling ${oldSource} → ${retained}`);
      } catch (err) {
        log.warn(`indexed source spelling reconcile failed for ${oldSource}: ${(err as Error).message}`);
      }
    }
  }
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
