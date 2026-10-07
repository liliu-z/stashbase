/** HTTP adapter for the separately spawned stdio MCP host. */
import { toSearchMode, toRetrievalMode, type SearchMode } from '../shared/search-types.ts';
import type { ProjectOperations } from '../server/project-operations/index.ts';
import { ProjectOperationError } from '../server/project-operations/errors.ts';
import { AGENT_SESSION_ID_HEADER } from '../server/agent-session-registry.ts';

export function createHttpProjectOperations(
  webBase: string,
  windowId?: string,
  agentSessionId?: string,
): ProjectOperations {
  const headers = (extra?: Record<string, string>): Record<string, string> => ({
    ...(extra ?? {}),
    ...(windowId != null ? { 'x-stashbase-window-id': windowId } : {}),
    // Per-session attribution for host-side policy and tools (search by
    // meaning and create_project). Comes from the spawning session's
    // environment, never from tool arguments.
    ...(agentSessionId != null ? { [AGENT_SESSION_ID_HEADER]: agentSessionId } : {}),
  });
  const json = async <T>(url: string, init?: RequestInit): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error: unknown) {
      if (error instanceof TypeError) {
        throw new Error('StashBase app is not reachable. Open the StashBase desktop app and try again.');
      }
      throw error;
    }
    if (response.ok) return response.json() as Promise<T>;
    const detail = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
    throw new ProjectOperationError(
      typeof detail.error === 'string' ? detail.error : `StashBase request failed: ${response.status}`,
      response.status,
      typeof detail.code === 'string' ? detail.code : undefined,
    );
  };
  const pathQuery = (path: unknown) => `path=${encodeURIComponent(typeof path === 'string' ? path : '')}`;
  return {
    info: () => json(`${webBase}/api/project/info`, { headers: headers() }),
    search: async ({ query, topK, folder, pathPrefix, types, mode, caseStrict, wholeWord }) => {
      const result = await json<Omit<Awaited<ReturnType<ProjectOperations['search']>>, 'mode'> & { mode: SearchMode }>(`${webBase}/api/project/search`, {
        method: 'POST', headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          query,
          top_k: topK,
          ...(folder ? { folder } : {}),
          ...(pathPrefix ? { path_prefix: pathPrefix } : {}),
          ...(types !== undefined ? { types } : {}),
          ...(mode ? { mode: toSearchMode(mode) } : {}),
          ...(caseStrict ? { case_strict: true } : {}),
          ...(wholeWord ? { whole_word: true } : {}),
        }),
      });
      return { ...result, mode: toRetrievalMode(result.mode) };
    },
    keywordSearch: ({ query, caseStrict, wholeWord, folder, pathPrefix }) => json(`${webBase}/api/project/keyword-search`, {
      method: 'POST', headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        query,
        case_strict: caseStrict === true,
        whole_word: wholeWord === true,
        ...(folder ? { folder } : {}),
        ...(pathPrefix ? { path_prefix: pathPrefix } : {}),
      }),
    }),
    reindex: ({ folder } = {}) => json(`${webBase}/api/project/reindex`, {
      method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify(folder ? { folder } : {}),
    }),
    createProject: ({ name, location }) => json(`${webBase}/api/project/create-project`, {
      method: 'POST', headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name, ...(location != null ? { location } : {}) }),
    }),
    listDirectory: (path) => json(`${webBase}/api/project/directory?${pathQuery(path)}`, { headers: headers() }),
    read: (path, range) => json(
      `${webBase}/api/project/file?${pathQuery(path)}`
        + (range?.offset != null ? `&offset=${range.offset}` : '')
        + (range?.limit != null ? `&limit=${range.limit}` : ''),
      { headers: headers() },
    ),
    write: ({ path, content, baseVersion }) => json(`${webBase}/api/project/file`, {
      method: 'PUT', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ path, content, ...(typeof baseVersion === 'string' ? { baseVersion } : {}) }),
    }),
    edit: ({ path, oldText, newText, replaceAll, baseVersion }) => json(`${webBase}/api/project/file/edit`, {
      method: 'POST', headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ path, old_text: oldText, new_text: newText, replace_all: replaceAll === true, ...(typeof baseVersion === 'string' ? { baseVersion } : {}) }),
    }),
    move: ({ path, newPath, cascade }) => json(`${webBase}/api/project/file/move`, {
      method: 'PATCH', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ path, new_path: newPath, cascade: cascade !== false }),
    }),
    delete: (path) => json(`${webBase}/api/project/file?${pathQuery(path)}`, { method: 'DELETE', headers: headers() }),
  };
}
