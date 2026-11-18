/** What the document tab menu borrows from the host: showing a tab's file in
 *  the system file manager and copying its path. The tab strip owns closing;
 *  these reach adapters only the app may bind. A failure answers the reader's
 *  own choice, so it is kept here for the window's floating notices. */
import { useCallback, useMemo, useState } from 'react';

import type { AppDependencies } from '@/app/dependencies';
import type { DocumentTabMenuActions } from '@/features/documents/public';
import { systemEntryPath } from '@/features/workspace/public';
import { isExternalSource } from '@/shared/domain/external-source';
import type { FailureView } from '@/shared/domain/feature-error';
import { writeToClipboard } from '@/shared/ui/clipboard';

/** The same sentences the file tree and the file viewer use for these. */
const CLIPBOARD_FAILURE: FailureView = {
  message: 'StashBase could not reach the clipboard.',
  tone: 'capability',
};
const REVEAL_FAILURE: FailureView = {
  message: 'The file could not be shown in the system file manager.',
  tone: 'input',
};

export interface TabMenuActions {
  actions: DocumentTabMenuActions;
  dismissFailure(): void;
  /** The last copy or reveal that failed, until dismissed or a later one
   *  succeeds. */
  failure: FailureView | null;
}

export function useTabMenuActions({
  documents,
  workspace,
}: Pick<AppDependencies, 'documents' | 'workspace'>): TabMenuActions {
  const [failure, setFailure] = useState<FailureView | null>(null);
  const settle = useCallback(
    (work: Promise<unknown>, onFailure: FailureView) =>
      void work.then(
        () => setFailure(null),
        () => setFailure(onFailure),
      ),
    [],
  );
  const actions = useMemo<DocumentTabMenuActions>(
    () => ({
      revealLabel: workspace.revealLabel,
      onReveal(source) {
        // A menu choice has no view to cancel it from; the reveal finishes or
        // fails on its own, as a row's reveal in the file tree does.
        const { signal } = new AbortController();
        settle(
          isExternalSource(source)
            ? documents.adapters.externalFiles.reveal(source, signal)
            : workspace.adapters.files.reveal(source.folderPath, source.path, signal),
          REVEAL_FAILURE,
        );
      },
      onCopyPath(source, form) {
        const path = isExternalSource(source)
          ? source.path
          : systemEntryPath(source.folderPath, source.path, form);
        settle(writeToClipboard(path), CLIPBOARD_FAILURE);
      },
    }),
    [documents.adapters.externalFiles, settle, workspace.adapters.files, workspace.revealLabel],
  );
  const dismissFailure = useCallback(() => setFailure(null), []);
  return { actions, dismissFailure, failure };
}
