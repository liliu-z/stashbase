/** Opens a requested turn review on a kept document tab. Requests share one
 * queue so competing clicks cannot replace a review on the same document. */
import { useCallback, useEffect, useRef, useState } from 'react';

import { openDocument } from '@/app/workflows/open-document';
import {
  openTurnChangeReview,
  turnChangeReviewMessage,
  type DocumentAdapters,
  type DocumentTabsRuntime,
} from '@/features/documents/public';
import type { WorkspaceRuntime } from '@/features/workspace/public';
import type { SourceReference } from '@/shared/domain/source-reference';
import { basePathName } from '@/shared/utils/file-path';

export interface TurnReview {
  readonly failures: readonly string[];
  dismiss(message: string): void;
  reviewTurnChange(request: { source: SourceReference; turnId: string }): void;
}

async function reviewTurn(
  workspace: WorkspaceRuntime,
  documents: DocumentTabsRuntime,
  request: { source: SourceReference; turnId: string },
  ports: Pick<DocumentAdapters, 'source' | 'turnChanges'>,
) {
  if (request.source.folderPath !== documents.scope.folderPath) return 'outside-folder' as const;
  try {
    const document = await openDocument(workspace, documents, request.source, { preview: false });
    if (!document) return 'not-opened' as const;
    return await openTurnChangeReview(document, request.turnId, ports);
  } catch {
    return 'not-opened' as const;
  }
}

export function useTurnReview({
  documents,
  sourceApi,
  turnChangesApi,
  workspace,
}: {
  documents: DocumentTabsRuntime | null;
  sourceApi: DocumentAdapters['source'];
  turnChangesApi: DocumentAdapters['turnChanges'];
  workspace: WorkspaceRuntime | null;
}): TurnReview {
  const [failures, setFailures] = useState<readonly string[]>([]);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setFailures((current) => (current.length === 0 ? current : []));
    return () => {
      generation.current += 1;
    };
  }, [documents, workspace]);

  const queue = useRef<Promise<void>>(Promise.resolve());
  const reviewTurnChange = useCallback(
    (request: { source: SourceReference; turnId: string }) => {
      if (!workspace || !documents) return;
      const current = generation.current;
      queue.current = queue.current.then(async () => {
        if (current !== generation.current) return;
        const failure = await reviewTurn(workspace, documents, request, {
          source: sourceApi,
          turnChanges: turnChangesApi,
        });
        if (failure === null || current !== generation.current) return;
        const message = turnChangeReviewMessage(failure, basePathName(request.source.path));
        setFailures((entries) => (entries.includes(message) ? entries : [...entries, message]));
      });
    },
    [documents, sourceApi, turnChangesApi, workspace],
  );
  const dismiss = useCallback((message: string) => {
    setFailures((current) => current.filter((entry) => entry !== message));
  }, []);
  return { dismiss, failures, reviewTurnChange };
}
