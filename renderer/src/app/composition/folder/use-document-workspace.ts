import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import {
  createDocumentQueryScope,
  prepareDocument,
  createDocumentTabsRuntime,
  type DocumentAdapters,
  type DocumentUsageEvent,
  type DocumentTabsRuntime,
} from '@/features/documents/public';
import type { WorkspaceRuntime, WorkspaceSessionController } from '@/features/workspace/public';
import { useScopedRuntime } from '@/shared/runtime/use-scoped-runtime';

export function useDocumentWorkspace(
  workspace: WorkspaceRuntime | null,
  session: Pick<WorkspaceSessionController, 'runtime' | 'status'>,
  sourceApi: DocumentAdapters['source'],
  createId: () => string,
  previewAdapters?: Pick<DocumentAdapters, 'asset' | 'genericPreview'>,
  recordUsage?: (event: DocumentUsageEvent) => void,
): DocumentTabsRuntime | null {
  const queryClient = useQueryClient();
  // Only a settled session names a folder to restore tabs from.
  const restoredRef = useRef(
    session.status.kind === 'ready' ? session.status.restoredFolder : null,
  );
  restoredRef.current = session.status.kind === 'ready' ? session.status.restoredFolder : null;
  const sessionRuntime = session.runtime;
  const folderPath = workspace?.scope.folder.path ?? null;
  const generation = workspace?.scope.generation ?? null;

  const create = useCallback(() => {
    // Only ever called for the scope the key below names, so both halves are
    // present; the fallbacks keep that promise typed rather than asserted.
    const path = folderPath ?? '';
    const restoredFolder = restoredRef.current?.folderPath === path ? restoredRef.current : null;
    return createDocumentTabsRuntime({
      api: sourceApi,
      recordUsage,
      ...(previewAdapters
        ? {
            prepare: (scope) =>
              prepareDocument(queryClient, { ...previewAdapters, source: sourceApi }, scope),
          }
        : {}),
      createId,
      createQueries: (scope) => createDocumentQueryScope(queryClient, scope),
      folderPath: path,
      generation: generation ?? 0,
      restored: restoredFolder
        ? {
            activeTabId: restoredFolder.activeTabId,
            tabs: restoredFolder.tabs.map((tab) => ({
              id: tab.id,
              source: { folderPath: path, path: tab.path },
            })),
          }
        : null,
    });
  }, [createId, folderPath, generation, previewAdapters, queryClient, recordUsage, sourceApi]);

  const runtime =
    useScopedRuntime(
      workspace && folderPath && generation ? `${folderPath}\u0000${generation}` : null,
      create,
      (tabs) => tabs.dispose(),
    ) ?? null;

  useEffect(() => {
    if (!workspace || !runtime) return;
    const record = () => sessionRuntime.recordWorkspace(workspace.toSession(), runtime.toSession());
    record();
    return runtime.subscribe(record);
  }, [runtime, sessionRuntime, workspace]);

  return runtime;
}
