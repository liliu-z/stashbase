/**
 * Indexer abstraction — the only surface the rest of the server is
 * allowed to import. Concrete impl currently `MfsIndexer` (sidecar
 * Python over stdio). Switching to a native TS MFS package (when
 * upstream ships one) means writing a new class behind this interface
 * and changing one import line in `index.ts`.
 *
 * Paths on every method are absolute POSIX paths. Server modules that
 * operate in Folder-relative terms translate at the route/files boundary;
 * the daemon converts them to MFS namespace-relative DocumentIds.
 */
import type { KeywordHitFile, SearchHit } from '../shared/search-results.ts';
import type { EmbedderProvider } from '../shared/embedding.ts';

export type { SearchHit } from '../shared/search-results.ts';

export interface EmbedderRuntimeConfig {
  /** Supported embedding endpoints. OpenRouter and Requesty are used only as
   *  OpenAI-compatible embeddings endpoints for the fixed 1536d model. */
  provider: EmbedderProvider;
  /** Provider API key. */
  apiKey?: string;
  /** Optional model override. Defaults are provider-specific. */
  model?: string;
  /** Optional dimension override (default 1536). */
  dimension?: number;
  /** Optional OpenAI-compatible base URL. Used by OpenRouter and Requesty. */
  baseUrl?: string;
}

export interface IndexUpsertResult {
  /** MFS owns projection content identity and reports whether this accepted
   * body created, replaced, or matched the current document revision. */
  outcome: 'added' | 'updated' | 'unchanged' | 'removed';
}

export interface ExactSearchOptions {
  caseStrict: boolean;
  wholeWord: boolean;
  pathPrefix?: string;
  extensions?: string[];
}

export interface ExactSearchResult {
  files: KeywordHitFile[];
  totalMatches: number;
  truncated: boolean;
}

export interface Indexer {
  /** Register a Folder with the indexer and open its Internal namespace.
   *  Idempotent — safe to call on every
   *  server start for every known folder, and after a daemon respawn. */
  bindFolder(folder: string, cfg: EmbedderRuntimeConfig): Promise<void>;

  /** Stop routing new files for the folder. Existing rows stay
   *  searchable until explicit delete. */
  unbindFolder(folder: string): Promise<void>;

  /** Insert / replace one complete text projection. Empty / unchunkable
   *  content is valid: the document disappears from the index and no error
   *  is raised. By default await indexing; source saves pass waitForIndex=false
   *  to acknowledge revision acceptance without waiting for embeddings. */
  upsertFile(path: string, content: string, options?: { waitForIndex?: boolean }): Promise<IndexUpsertResult>;

  /** Insert/replace chunks for a **converted source** (PDF/image/DOCX) whose
   *  searchable text comes from a separately-stored derived text file
   *  (app data, never in the user's folder). Indexes `derivedContent` UNDER the
   *  source's own path so folder-scoped retrieval returns the visible source
   *  identity. Returns after revision acceptance; semantic builds run separately.
   * MFS owns the projection content hash and unchanged decision. */
  upsertConvertedFile(sourceAbs: string, derivedContent: string, derivedExt?: string): Promise<IndexUpsertResult>;

  /** Drop all chunks for one file. Safe to call on a never-indexed file. */
  deleteFile(path: string): Promise<void>;

  /** Drop all chunks for every file whose path starts with `prefix/`.
   *  Used by recursive folder-delete to clear the index in one shot. */
  deletePathPrefix(prefix: string): Promise<void>;

  /** Move a file in the index by removing the old DocumentId and upserting
   *  the unchanged body under the new DocumentId. */
  renameFile(oldPath: string, newPath: string, content: string): Promise<void>;

  /** Move every file under `oldPrefix` to `newPrefix`. `files` carries
   *  the bodies under the old paths. */
  renamePathPrefix(
    oldPrefix: string,
    newPrefix: string,
    files: Array<{ path: string; content: string }>,
  ): Promise<void>;

  /** Hybrid search. `folder` scopes to one absolute Folder root.
   *  `pathPrefix?` further narrows
   *  to chunks whose `source` starts with that prefix — useful when an
   *  agent wants to ask "only inside cs183b/transcripts/".
   *  `extensions?` restricts hits to sources with one of the given
   *  lowercase dot-prefixed extensions; the daemon applies it before
   *  final top-k selection. Returns at most `topK` hits ordered by
   *  descending score, with `fileName` absolute. */
  search(query: string, topK: number, folder: string, pathPrefix?: string, extensions?: string[]): Promise<SearchHit[]>;

  /** Exact literal search over MFS's accepted text projections. It remains
   * available when vector indexing is off and requires one Folder namespace. */
  grep(query: string, folder: string, options: ExactSearchOptions): Promise<ExactSearchResult>;

  /** Lightweight progress check. With a Folder it reports that namespace;
   *  omission aggregates status for non-search maintenance surfaces. */
  status(folder?: string): Promise<IndexerStatus>;

  /** Absolute source identities currently accepted by MFS. Omission
   *  aggregates the bound namespaces for non-search maintenance surfaces. */
  listDocuments(folder?: string): Promise<string[]>;

  /** Release MFS resources so the server can retire or replace the store.
   *  The next operation reopens lazily via `bindFolder`. */
  closeStore(): Promise<void>;

  /** Shut down underlying resources. Currently called only on process exit. */
  close(): Promise<void>;
}

/** The indexer's own view of a folder. Narrower than, and not the same type
 *  as, the `/api/index-status` HTTP response (`IndexStatus` in
 *  `shared/index-status.ts`), which layers embedding availability,
 *  conversion, and preparation state on top of this. */
export interface IndexerStatus {
  /** Documents accepted by MFS for the selected namespace(s). */
  total: number;
  /** Accepted documents whose current revision is indexed. */
  indexed: number;
  /** How many files are still waiting to be indexed. */
  pendingCount: number;
  /** Full list of absolute paths waiting to be indexed. */
  pending: string[];
  /** Kept for the public status shape. Internal MFS namespaces do not observe
   *  the filesystem, so reconcile removes absent projections directly. */
  orphanedCount: number;
  /** Full list of orphaned absolute paths. */
  orphaned: string[];
  /** True iff pending = 0 and orphaned = 0. Computed over the unfiltered
   *  lists above, so it can disagree with the visible pending count the
   *  HTTP layer reports beside it. */
  upToDate: boolean;
  /** False until the folder has received at least one daemon status response. */
  indexReady: boolean;
}

/*
 * Semantic availability, its disabled reason, and conversion progress are
 * deliberately absent. They are HTTP-layer concerns that `buildIndexStatus`
 * computes and puts on the response; no indexer knows them. They used to sit
 * here unset, where the response's `...status` spread could have carried a
 * stale `semanticDisabledReason` past the guard that only sets one when
 * semantic is actually unavailable — a payload claiming both at once.
 */
