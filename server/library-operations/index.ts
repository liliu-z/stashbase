/**
 * Host-side operations over the user's authorized library.
 *
 * This is the semantic seam shared by the local HTTP routes and MCP. It owns
 * source identity, library membership, preparation readiness, and operation
 * errors; transports only parse and serialize requests.
 */
import { memberFolderRootsAsync } from '../folder.ts';
import { filesystemPath } from '../filesystem-path.ts';
import {
  normalizeLibrarySearchScope,
  requireLibraryStatusFolder,
  routeError,
} from '../library-file-access.ts';
import { listLibraryDirectory } from '../library-directory.ts';
import { readLibraryFile } from '../library-file-reader.ts';
import {
  deleteLibraryFile,
  editLibraryFile,
  moveLibraryFile,
  writeLibraryFile,
} from '../library-file-mutations.ts';
import { getLibraryInfo, type LibraryInfo } from '../library-info.ts';
import { createProjectFolder } from '../agent-projects.ts';
import { errorMessage, logger } from '../log.ts';
import { indexer, syncFolderNow } from '../state.ts';
import {
  createRetrieval,
  keywordFilesFromEvidence,
  searchHitsFromEvidence,
  type Retrieval,
  type RetrievalMode,
  type SourceEvidence,
} from '../retrieval/index.ts';
import { attributedRequestSession } from '../agent-session-registry.ts';
import type { IndexerStatus, SearchHit } from '../indexer.ts';
import type { KeywordHitFile } from '../search-display.ts';
import type { SyncResult } from '../sync.ts';
import { LibraryOperationError } from './errors.ts';
import type { SearchTypeCategory } from '../../shared/search-types.ts';
import type { LibraryKeywordFile } from '../../shared/search-results.ts';

export type { LibraryKeywordFile } from '../../shared/search-results.ts';

export { LibraryOperationError } from './errors.ts';

const log = logger('library-operations');

export interface LibraryOperations {
  info(): Promise<LibraryInfo>;
  search(input: {
    query: string;
    topK?: number;
    folder?: string;
    pathPrefix?: string;
    types?: readonly SearchTypeCategory[];
    /** Requested retrieval mode. An attributed panel session with Similarity
     * Search off resolves every request to lexical retrieval. */
    mode?: RetrievalMode;
    caseStrict?: boolean;
    wholeWord?: boolean;
    /** Transport attribution, never model-controlled tool arguments. */
    agentSessionId?: string;
    windowId?: string;
  }): Promise<{ mode: RetrievalMode; hits: SearchHit[]; truncated?: boolean }>;
  /** Ripgrep keyword search over every member folder (or one `folder`).
   * File paths come back folder-relative next to their member folder root so
   * a caller can open results across folders without prefix guessing. */
  keywordSearch(input: {
    query: string;
    caseStrict?: boolean;
    wholeWord?: boolean;
    folder?: string;
    pathPrefix?: string;
  }): Promise<{ files: LibraryKeywordFile[]; totalMatches: number; truncated: boolean }>;
  reindex(input?: { folder?: string }): Promise<unknown>;
  /** Create a new project folder and register it into the library.
   * `agentSessionId` is request attribution (header-derived, never a tool
   * argument): a live library-scoped calling session is rebound to the new
   * project; folder-bound and unattributed callers only create + register. */
  createProject(input: { name: unknown; location?: unknown; agentSessionId?: string; windowId?: string }): Promise<unknown>;
  listDirectory(path?: unknown): Promise<unknown>;
  read(path: unknown): Promise<unknown>;
  write(input: { path: unknown; content: unknown; baseVersion?: string }): Promise<unknown>;
  edit(input: { path: unknown; oldText: unknown; newText: unknown; replaceAll?: boolean; baseVersion?: string }): Promise<unknown>;
  move(input: { path: unknown; newPath: unknown; cascade?: boolean }): Promise<unknown>;
  delete(path: unknown): Promise<unknown>;
}

export interface LibraryOperationsDependencies {
  getLibraryInfo: () => LibraryInfo;
  normalizeSearchScope: typeof normalizeLibrarySearchScope;
  retrieval: Retrieval;
  reindexFolder: (folder: string) => Promise<SyncResult>;
  indexStatus: (folderRoot?: string) => Promise<IndexerStatus>;
  memberFolderRoots: () => string[] | Promise<string[]>;
  createProject: typeof createProjectFolder;
  listDirectory: typeof listLibraryDirectory;
  read: typeof readLibraryFile;
  write: typeof writeLibraryFile;
  edit: typeof editLibraryFile;
  move: typeof moveLibraryFile;
  delete: typeof deleteLibraryFile;
  /** null means the request did not come from an attributable panel session. */
  similaritySearchEnabled: (agentSessionId?: string, windowId?: string) => boolean | null;
}

const productionDependencies: LibraryOperationsDependencies = {
  getLibraryInfo,
  normalizeSearchScope: normalizeLibrarySearchScope,
  retrieval: createRetrieval(),
  reindexFolder: (folder) => syncFolderNow(folder, { reason: 'mcp reindex' }),
  indexStatus: (folderRoot) => indexer.status(folderRoot),
  memberFolderRoots: memberFolderRootsAsync,
  createProject: createProjectFolder,
  listDirectory: listLibraryDirectory,
  read: readLibraryFile,
  write: writeLibraryFile,
  edit: editLibraryFile,
  move: moveLibraryFile,
  delete: deleteLibraryFile,
  similaritySearchEnabled: (agentSessionId, windowId) =>
    attributedRequestSession(agentSessionId, windowId)?.similaritySearchEnabled() ?? null,
};

/** Build the deep library module. Tests may replace only the dependencies they exercise. */
export function createLibraryOperations(
  overrides: Partial<LibraryOperationsDependencies> = {},
): LibraryOperations {
  const deps = { ...productionDependencies, ...overrides };
  return {
    info: async () => deps.getLibraryInfo(),

    async search({
      query,
      topK = 8,
      folder,
      pathPrefix,
      types,
      mode = 'semantic',
      caseStrict,
      wholeWord,
      agentSessionId,
      windowId,
    }) {
      const trimmedQuery = query.trim();
      if (!trimmedQuery) throw routeError('query required', 400);
      const scope = await deps.normalizeSearchScope(folder, pathPrefix);
      const similarityEnabled = deps.similaritySearchEnabled(agentSessionId, windowId);
      const effectiveMode: RetrievalMode = similarityEnabled === false ? 'keyword' : mode;
      const result = effectiveMode === 'keyword' && !scope.folderRoot
        ? await searchKeywordAcrossLibrary({
            query: trimmedQuery,
            topK,
            types,
            caseStrict,
            wholeWord,
          }, deps)
        : await deps.retrieval.search({
            mode: effectiveMode,
            query: trimmedQuery,
            topK,
            folderRoot: scope.folderRoot,
            pathPrefix: scope.pathPrefix,
            types,
            caseStrict,
            wholeWord,
          });
      if (result.availability.state === 'unavailable') {
        if (result.availability.reason === 'hosted-quota-exhausted') {
          throw routeError(
            'Your hosted Similarity Search allowance is exhausted. Exact Search is still available.',
            402,
            'HOSTED_QUOTA_EXHAUSTED',
          );
        }
        throw routeError(
          "Similarity Search isn't set up. Open StashBase Settings to set it up.",
          412,
          'EMBEDDER_KEY_REQUIRED',
        );
      }
      return {
        mode: effectiveMode,
        hits: searchHitsFromEvidence(result.evidence),
        ...(result.truncated ? { truncated: true } : {}),
      };
    },

    async keywordSearch({ query, caseStrict, wholeWord, folder, pathPrefix }) {
      const trimmedQuery = query.trim();
      if (!trimmedQuery) throw routeError('query required', 400);
      const scope = await deps.normalizeSearchScope(folder, pathPrefix);
      const roots = scope.folderRoot ? [scope.folderRoot] : await deps.memberFolderRoots();
      let lastError: unknown = null;
      const perFolder = await mapWithConcurrency(roots, KEYWORD_FOLDER_CONCURRENCY, async (root) => {
        try {
          const result = await deps.retrieval.search({
            mode: 'keyword',
            query: trimmedQuery,
            folderRoot: root,
            pathPrefix: scope.pathPrefix,
            caseStrict: caseStrict === true,
            wholeWord: wholeWord === true,
          });
          return { root, files: keywordFilesFromEvidence(result.evidence, root), truncated: result.truncated };
        } catch (err: unknown) {
          // A vanished or unreadable member folder must not sink the whole
          // library sweep; the remaining folders still answer.
          log.warn(`library keyword search skipped ${root}: ${errorMessage(err)}`);
          lastError = err;
          return null;
        }
      });
      // Every folder failing is a search failure, not an empty result —
      // a silent empty 200 would read as "no matches".
      if (roots.length > 0 && perFolder.every((outcome) => outcome === null)) {
        throw lastError ?? routeError('keyword search failed', 500);
      }
      const files: LibraryKeywordFile[] = [];
      let totalMatches = 0;
      let delivered = 0;
      let truncated = false;
      for (const outcome of perFolder) {
        if (!outcome) continue;
        truncated = truncated || outcome.truncated;
        for (const file of outcome.files) {
          // Nested member folders: the deeper member's own sweep answers for
          // its files — drop them from the ancestor's sweep so a hit never
          // appears twice under two folder identities.
          if (roots.length > 1 && !(await deepestOwnerIs(outcome.root, file.path, roots))) continue;
          // One shared cap on delivered matches across folders so a broad
          // query cannot multiply the single-folder payload bound by the
          // library size. `totalMatches` keeps counting every remaining
          // file's real match count (per-file `totalMatches` already
          // exceeds `matches` under per-file caps), so the reported total
          // stays the library-wide truth even after the cap fires.
          totalMatches += file.totalMatches;
          if (delivered >= LIBRARY_KEYWORD_TOTAL_CAP) {
            truncated = true;
            continue;
          }
          const room = LIBRARY_KEYWORD_TOTAL_CAP - delivered;
          const matches = file.matches.length > room ? file.matches.slice(0, room) : file.matches;
          if (matches.length < file.matches.length) truncated = true;
          files.push({ ...file, matches, folder: outcome.root });
          delivered += matches.length;
        }
      }
      return { files, totalMatches, truncated };
    },

    async reindex({ folder } = {}) {
      const folderRoot = await requireLibraryStatusFolder(folder);
      const folders: Array<Record<string, unknown>> = [];
      for (const target of folderRoot ? [folderRoot] : await deps.memberFolderRoots()) {
        try {
          folders.push({ folder: target, ...await deps.reindexFolder(target) });
        } catch (err: unknown) {
          folders.push({ folder: target, error: errorMessage(err) });
        }
      }
      let status: Partial<IndexerStatus> = {};
      try {
        status = await deps.indexStatus(folderRoot);
      } catch (err: unknown) {
        log.warn(`reindex status failed: ${errorMessage(err)}`);
      }
      return { folders, ...status };
    },

    createProject: (input) => asLibraryOperation(() => deps.createProject(input)),

    listDirectory: (path) => asLibraryOperation(() => deps.listDirectory(path)),
    read: (path) => asLibraryOperation(() => deps.read(path)),
    write: ({ path, content, baseVersion }) => asLibraryOperation(() => {
      if (typeof content !== 'string') throw routeError('content (string) required', 400);
      return deps.write(path, content, { baseVersion });
    }),
    edit: ({ path, oldText, newText, replaceAll, baseVersion }) => asLibraryOperation(() => {
      if (typeof oldText !== 'string') throw routeError('old_text (string) required', 400);
      if (typeof newText !== 'string') throw routeError('new_text (string) required', 400);
      return deps.edit(path, oldText, newText, { replaceAll, baseVersion });
    }),
    move: ({ path, newPath, cascade }) => asLibraryOperation(() => deps.move(path, newPath, { cascade })),
    delete: (path) => asLibraryOperation(() => deps.delete(path)),
  };
}

/** Library-wide lexical retrieval for `search_library`. The lower Retrieval
 * Interface intentionally owns one folder at a time because ripgrep and the
 * prepared-text walk are folder-rooted. This operation-level fan-out keeps
 * that implementation detail away from Agent callers while preserving one
 * visible-source evidence model across direct and prepared text. */
async function searchKeywordAcrossLibrary(
  input: {
    query: string;
    topK: number;
    types?: readonly SearchTypeCategory[];
    caseStrict?: boolean;
    wholeWord?: boolean;
  },
  deps: Pick<LibraryOperationsDependencies, 'memberFolderRoots' | 'retrieval'>,
): Promise<{
  evidence: SourceEvidence[];
  availability: { state: 'ready' } | { state: 'partial'; reason: 'truncated' };
  truncated: boolean;
}> {
  const roots = await deps.memberFolderRoots();
  let lastError: unknown = null;
  const outcomes = await mapWithConcurrency(roots, KEYWORD_FOLDER_CONCURRENCY, async (root) => {
    try {
      const result = await deps.retrieval.search({
        mode: 'keyword',
        query: input.query,
        folderRoot: root,
        types: input.types,
        caseStrict: input.caseStrict === true,
        wholeWord: input.wholeWord === true,
      });
      return { root, result };
    } catch (error: unknown) {
      log.warn(`library keyword search skipped ${root}: ${errorMessage(error)}`);
      lastError = error;
      return null;
    }
  });
  if (roots.length > 0 && outcomes.every((outcome) => outcome === null)) {
    throw lastError ?? routeError('keyword search failed', 500);
  }

  const all: SourceEvidence[] = [];
  let truncated = false;
  for (const outcome of outcomes) {
    if (!outcome) continue;
    truncated = truncated || outcome.result.truncated;
    for (const evidence of outcome.result.evidence) {
      const relative = filesystemPath.relative(outcome.root, evidence.sourcePath);
      if (relative == null || !(await deepestOwnerIs(outcome.root, relative, roots))) continue;
      all.push(evidence);
    }
  }
  const limit = Math.max(1, Math.floor(input.topK));
  const evidence = all.slice(0, limit);
  truncated = truncated || evidence.length < all.length;
  return {
    evidence,
    availability: truncated
      ? { state: 'partial', reason: 'truncated' }
      : { state: 'ready' },
    truncated,
  };
}

/** True when `sweepRoot` is the DEEPEST member root containing the file —
 * i.e. this sweep, not a nested member's own sweep, owns the hit. */
async function deepestOwnerIs(
  sweepRoot: string,
  relPath: string,
  roots: readonly string[],
): Promise<boolean> {
  const abs = filesystemPath.join(sweepRoot, relPath);
  let owner = sweepRoot;
  for (const candidate of roots) {
    if (candidate.length <= owner.length) continue;
    if (await filesystemPath.relativeAsync(candidate, abs) != null) owner = candidate;
  }
  return owner === sweepRoot;
}

/** Each folder is one ripgrep spawn plus a derived-text walk; a handful in
 * flight keeps a many-folder library responsive without a process storm. */
const KEYWORD_FOLDER_CONCURRENCY = 4;
/** Delivered-match bound across the whole sweep — the same order of payload
 * the single-folder route's per-call cap allows. */
const LIBRARY_KEYWORD_TOTAL_CAP = 500;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]);
      }
    }),
  );
  return results;
}

async function asLibraryOperation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    if (error instanceof LibraryOperationError) throw error;
    const code = typeof (error as { code?: unknown })?.code === 'string'
      ? (error as { code: string }).code
      : undefined;
    const status = typeof (error as { status?: unknown })?.status === 'number'
      ? (error as { status: number }).status
      : code === 'FILE_CHANGED' ? 409 : 500;
    throw new LibraryOperationError(errorMessage(error), status, code);
  }
}
