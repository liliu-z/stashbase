import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useStore } from 'zustand';

import type { DocumentRuntime } from '@/features/documents/application/document-runtime';
import type { DocumentSourcePort } from '@/features/documents/application/ports';
import { documentSourceQuery } from '@/features/documents/application/queries';
import type { DocumentConflictResolution } from '@/features/documents/domain/document';

import { useDocumentRefresh } from './use-document-refresh';
import { usePreparedRead } from './use-prepared-read';

export function useDocumentSource(
  runtime: DocumentRuntime,
  api: DocumentSourcePort,
  active: boolean,
) {
  const access = useStore(runtime.store, (state) => state.access);
  const mutationPending = useStore(runtime.store, (state) => state.mutationPending);
  const editor = useStore(runtime.store, (state) => state.editor);
  const markdownMode = useStore(runtime.store, (state) => state.markdownMode);
  const revision = useStore(runtime.store, (state) => state.revision);
  const query = documentSourceQuery(api, runtime.scope);
  const prepared = usePreparedRead(query.queryKey);
  const source = useQuery({ ...query, refetchOnMount: !prepared });
  useDocumentRefresh(active, source.refetch, prepared);

  useEffect(() => {
    if (source.data) runtime.reconcile(source.data);
  }, [runtime, source.data]);

  return {
    access,
    change: runtime.change,
    editor,
    finishMerge: () => runtime.finishMerge(api),
    markdownMode,
    mutationPending,
    revision,
    resolveConflict: (resolution: DocumentConflictResolution) =>
      runtime.resolveConflict(api, resolution),
    restoreSource: () => runtime.restore(api),
    retrySave: () => runtime.save(api),
    source,
  };
}
