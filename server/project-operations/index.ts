/**
 * Host-side operations over the user's authorized project.
 *
 * This is the semantic seam shared by the local HTTP routes and MCP. It owns
 * source identity, project membership, preparation readiness, and operation
 * errors; transports only parse and serialize requests.
 */
import {
  normalizeProjectSearchScope,
  routeError,
} from '../project-file-access.ts';
import { listProjectDirectory } from '../project-directory.ts';
import { readProjectFile, type ProjectFileLineRange } from '../project-file-reader.ts';
import {
  deleteProjectFile,
  editProjectFile,
  moveProjectFile,
  writeProjectFile,
} from '../project-file-mutations.ts';
import { getProjectInfo, type ProjectInfo } from '../project-info.ts';
import { createProjectFolder } from '../agent-projects.ts';
import { isEmbeddingConfigured } from '../app-config.ts';
import { errorMessage } from '../log.ts';
import { filesystemPath } from '../filesystem-path.ts';
import { indexer, syncFolderNow } from '../state.ts';
import {
  createRetrieval,
  keywordFilesFromEvidence,
  searchHitsFromEvidence,
  type Retrieval,
  type RetrievalMode,
} from '../retrieval/index.ts';
import { attributedRequestSession } from '../agent-session-registry.ts';
import type { IndexerStatus, SearchHit } from '../indexer.ts';
import type { KeywordHitFile } from '../search-display.ts';
import type { SyncResult } from '../sync.ts';
import { ProjectOperationError } from './errors.ts';
import type { SearchTypeCategory } from '../../shared/search-types.ts';
import type { ProjectKeywordFile } from '../../shared/search-results.ts';

export type { ProjectKeywordFile } from '../../shared/search-results.ts';

export { ProjectOperationError } from './errors.ts';

export interface ProjectOperations {
  info(): Promise<ProjectInfo>;
  search(input: {
    query: string;
    topK?: number;
    folder?: string;
    pathPrefix?: string;
    types?: readonly SearchTypeCategory[];
    /** Omission selects grep without a key, hybrid with a key. Explicit modes
     * are honored; hybrid failures never silently become grep. */
    mode?: RetrievalMode;
    caseStrict?: boolean;
    wholeWord?: boolean;
    /** Transport attribution, never model-controlled tool arguments. */
    agentSessionId?: string;
    windowId?: string;
  }): Promise<{ mode: RetrievalMode; folder: string; hits: SearchHit[]; truncated?: boolean }>;
  /** MFS exact search over one explicit or attributed Folder. */
  keywordSearch(input: {
    query: string;
    caseStrict?: boolean;
    wholeWord?: boolean;
    folder?: string;
    pathPrefix?: string;
  }): Promise<{ files: ProjectKeywordFile[]; totalMatches: number; truncated: boolean }>;
  reindex(input?: { folder?: string }): Promise<unknown>;
  /** Explicitly create and register a project without changing any conversation. */
  createProject(input: { name: unknown; location?: unknown }): Promise<unknown>;
  listDirectory(path?: unknown): Promise<unknown>;
  read(path: unknown, range?: ProjectFileLineRange): Promise<unknown>;
  write(input: { path: unknown; content: unknown; baseVersion?: string }): Promise<unknown>;
  edit(input: { path: unknown; oldText: unknown; newText: unknown; replaceAll?: boolean; baseVersion?: string }): Promise<unknown>;
  move(input: { path: unknown; newPath: unknown; cascade?: boolean }): Promise<unknown>;
  delete(path: unknown): Promise<unknown>;
}

export interface ProjectOperationsDependencies {
  getProjectInfo: () => ProjectInfo;
  normalizeSearchScope: typeof normalizeProjectSearchScope;
  retrieval: Retrieval;
  reindexFolder: (folder: string) => Promise<SyncResult>;
  indexStatus: (folderRoot: string) => Promise<IndexerStatus>;
  createProject: typeof createProjectFolder;
  listDirectory: typeof listProjectDirectory;
  read: typeof readProjectFile;
  write: typeof writeProjectFile;
  edit: typeof editProjectFile;
  move: typeof moveProjectFile;
  delete: typeof deleteProjectFile;
  hasEmbeddingKey: () => boolean;
}

const productionDependencies: ProjectOperationsDependencies = {
  getProjectInfo,
  normalizeSearchScope: normalizeProjectSearchScope,
  retrieval: createRetrieval(),
  reindexFolder: (folder) => syncFolderNow(folder, { reason: 'mcp reindex' }),
  indexStatus: (folderRoot) => indexer.status(folderRoot),
  createProject: createProjectFolder,
  listDirectory: listProjectDirectory,
  read: readProjectFile,
  write: writeProjectFile,
  edit: editProjectFile,
  move: moveProjectFile,
  delete: deleteProjectFile,
  hasEmbeddingKey: isEmbeddingConfigured,
};

/** Build the deep project module. Tests may replace only the dependencies they exercise. */
export function createProjectOperations(
  overrides: Partial<ProjectOperationsDependencies> = {},
): ProjectOperations {
  const deps = { ...productionDependencies, ...overrides };
  return {
    info: async () => deps.getProjectInfo(),

    async search({
      query,
      topK = 8,
      folder,
      pathPrefix,
      types,
      mode,
      caseStrict,
      wholeWord,
      agentSessionId,
      windowId,
    }) {
      const trimmedQuery = query.trim();
      if (!trimmedQuery) throw routeError('query required', 400);
      if (folder != null && typeof folder !== 'string') throw routeError('folder must be a string', 400);
      if (pathPrefix != null && typeof pathPrefix !== 'string') throw routeError('path_prefix must be a string', 400);
      folder = folder?.trim() ? folder : undefined;
      // Scope must come from caller identity, never the app-wide sole active
      // turn: an unrelated external MCP client may search concurrently.
      const session = attributedRequestSession(agentSessionId, windowId);
      if (!session && (agentSessionId != null || (windowId != null && !folder))) {
        throw routeError('search session is no longer available or is ambiguous', 409);
      }
      const defaultFolder = session?.boundFolder() ?? undefined;
      if (session && !defaultFolder) {
        throw routeError('Open a project before searching its files.', 400, 'FOLDER_REQUIRED');
      }
      const scope = await deps.normalizeSearchScope(folder || defaultFolder, pathPrefix);
      if (defaultFolder && !filesystemPath.equal(scope.folderRoot, defaultFolder)) {
        throw routeError('Search must stay in the conversation project.', 403, 'PROJECT_SCOPE_MISMATCH');
      }
      const effectiveMode = mode ?? (deps.hasEmbeddingKey() ? 'hybrid' : 'grep');
      const result = await deps.retrieval.search({
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
        throw routeError(
          'To search by meaning, set it up in StashBase Settings.',
          412,
          'EMBEDDER_KEY_REQUIRED',
        );
      }
      return {
        mode: effectiveMode,
        folder: scope.folderRoot,
        hits: searchHitsFromEvidence(result.evidence, [scope.folderRoot]),
        ...(result.truncated ? { truncated: true } : {}),
      };
    },

    async keywordSearch({ query, caseStrict, wholeWord, folder, pathPrefix }) {
      const trimmedQuery = query.trim();
      if (!trimmedQuery) throw routeError('query required', 400);
      const scope = await deps.normalizeSearchScope(folder, pathPrefix);
      const result = await deps.retrieval.search({
        mode: 'grep',
        query: trimmedQuery,
        folderRoot: scope.folderRoot,
        pathPrefix: scope.pathPrefix,
        caseStrict: caseStrict === true,
        wholeWord: wholeWord === true,
      });
      const files = keywordFilesFromEvidence(result.evidence, scope.folderRoot)
        .map((file) => ({ ...file, folder: scope.folderRoot }));
      return {
        files,
        totalMatches: files.reduce((total, file) => total + file.totalMatches, 0),
        truncated: result.truncated,
      };
    },

    async reindex({ folder } = {}) {
      const { folderRoot } = await deps.normalizeSearchScope(folder, undefined);
      const result = await deps.reindexFolder(folderRoot);
      const status = await deps.indexStatus(folderRoot);
      return { folders: [{ folder: folderRoot, ...result }], ...status };
    },

    createProject: (input) => asProjectOperation(() => deps.createProject(input)),

    listDirectory: (path) => asProjectOperation(() => deps.listDirectory(path)),
    read: (path, range) => asProjectOperation(() => deps.read(path, range)),
    write: ({ path, content, baseVersion }) => asProjectOperation(() => {
      if (typeof content !== 'string') throw routeError('content (string) required', 400);
      return deps.write(path, content, { baseVersion });
    }),
    edit: ({ path, oldText, newText, replaceAll, baseVersion }) => asProjectOperation(() => {
      if (typeof oldText !== 'string') throw routeError('old_text (string) required', 400);
      if (typeof newText !== 'string') throw routeError('new_text (string) required', 400);
      return deps.edit(path, oldText, newText, { replaceAll, baseVersion });
    }),
    move: ({ path, newPath, cascade }) => asProjectOperation(() => deps.move(path, newPath, { cascade })),
    delete: (path) => asProjectOperation(() => deps.delete(path)),
  };
}

async function asProjectOperation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    if (error instanceof ProjectOperationError) throw error;
    const code = typeof (error as { code?: unknown })?.code === 'string'
      ? (error as { code: string }).code
      : undefined;
    const status = typeof (error as { status?: unknown })?.status === 'number'
      ? (error as { status: number }).status
      : code === 'FILE_CHANGED' ? 409 : 500;
    throw new ProjectOperationError(errorMessage(error), status, code);
  }
}
