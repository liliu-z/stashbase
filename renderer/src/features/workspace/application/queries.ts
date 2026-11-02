import type { QueryClient } from '@tanstack/react-query';

import type { FilesPort, ProjectRegistryPort, WorkspaceQueryScope } from './ports';

export const workspaceQueryKeys = {
  all: ['workspace'] as const,
  files: (folderPath: string) => [...workspaceQueryKeys.folder(folderPath), 'files'] as const,
  folder: (folderPath: string) => ['workspace', 'folder', folderPath] as const,
  project: ['project', 'membership'] as const,
};

export function projectQuery(api: ProjectRegistryPort) {
  return {
    queryFn: ({ signal }: { signal: AbortSignal }) => api.load(signal),
    queryKey: workspaceQueryKeys.project,
    retry: false,
    staleTime: 10_000,
  } as const;
}

export function createWorkspaceQueryScope(
  queryClient: QueryClient,
  folderPath: string,
): WorkspaceQueryScope {
  const queryKey = workspaceQueryKeys.folder(folderPath);
  return {
    cancel: () => queryClient.cancelQueries({ queryKey }),
    remove: () => queryClient.removeQueries({ queryKey }),
  };
}

export async function retireWorkspaceQueries(
  queryClient: QueryClient,
  folderPath: string,
): Promise<void> {
  const queryKey = workspaceQueryKeys.folder(folderPath);
  await queryClient.cancelQueries({ queryKey });
  queryClient.removeQueries({ queryKey });
}

/** The one place the open folder's listing is invalidated. Every caller that
 *  wants the tree re-read goes through here, so a new reason to refresh adds
 *  a call site rather than another spelling of the same key. */
export function refreshFolderListing(
  queryClient: QueryClient,
  folderPath: string,
  options: { cancelRefetch?: boolean } = {},
): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.files(folderPath) }, options);
}

export function filesQuery(api: FilesPort, folderPath: string) {
  return {
    queryFn: ({ signal }: { signal: AbortSignal }) => api.load(folderPath, signal),
    queryKey: workspaceQueryKeys.files(folderPath),
    retry: false,
    staleTime: 5_000,
  } as const;
}
