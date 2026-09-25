import { useMemo } from 'react';

import type { AgentScope, AgentScopeEnvironment } from '@/features/agent/public';
import {
  useActiveDocumentSource,
  useOpenDocumentSources,
  type DocumentTabsRuntime,
} from '@/features/documents/public';
import { sourceReadiness } from '@/features/preparation/public';
import type { FolderIndexStatus } from '@/features/preparation/public';
import type { WorkspaceListing } from '@/features/workspace/public';

export interface AgentEnvironment {
  /** What the Agent may bind context against, or null while the folder's
   *  listing is unknown. */
  environment: AgentScopeEnvironment | null;
  /** What a new chat is scoped to: the selected project, or null on Welcome. */
  scope: AgentScope | null;
}

/**
 * The one snapshot of the open folder that the Agent feature is allowed to see.
 *
 * The Agent validates bound context against the folder in front of the user,
 * and it has to do that without importing workspace or preparation state. So
 * the shell publishes a projection instead: the listing, per-source readiness
 * for anything not already current, the conversion versions, the paths of
 * the documents open beside the chat, and the one in front of the reader while
 * the Agent docks beside it. Everything here is derived — the Agent
 * never gets a handle it could use to change what it is looking at.
 *
 * Both halves are memoised because the runtime is told about a new environment
 * by identity; an equal-but-fresh object would republish the same folder on
 * every render.
 */
export function useAgentEnvironment(
  listing: WorkspaceListing | undefined,
  status: FolderIndexStatus | null,
  documents: DocumentTabsRuntime | null,
  folderPath: string | null,
  selectedFolderPath: string | null,
  documentsShown: boolean,
): AgentEnvironment {
  const openSources = useOpenDocumentSources(documents);
  const activeSource = useActiveDocumentSource(documents);
  const shownSource =
    documentsShown && activeSource?.folderPath === folderPath ? activeSource : null;

  // The selected folder, not the mounted workspace: a chat is scoped the
  // moment the reader picks a folder, before its workspace has settled.
  const scope = useMemo<AgentScope | null>(
    () => (selectedFolderPath ? { kind: 'folder', path: selectedFolderPath } : null),
    [selectedFolderPath],
  );

  const environment = useMemo<AgentScopeEnvironment | null>(() => {
    if (!listing || !folderPath) return null;
    const readiness: Record<string, AgentScopeEnvironment['readiness'][string]> = {};
    if (status) {
      for (const file of listing.files) {
        const kind = sourceReadiness(status, file.path).kind;
        if (kind !== 'current') readiness[file.path] = kind;
      }
    }
    return {
      activeSource: shownSource,
      folderPath,
      listing: {
        files: listing.files.map((file) => ({ format: file.format, path: file.path })),
        folders: listing.folders
          .filter((folder) => folder.kind === 'normal')
          .map((folder) => folder.path),
      },
      openPaths: openSources
        .filter((source) => source.folderPath === folderPath)
        .map((source) => source.path),
      readiness,
      versions: status?.conversionVersions ?? {},
    };
  }, [folderPath, listing, openSources, shownSource, status]);

  return useMemo(() => ({ environment, scope }), [environment, scope]);
}
