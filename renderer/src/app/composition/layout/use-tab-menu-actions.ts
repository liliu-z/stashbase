/** What the document tab menu borrows from the host: showing a tab's file in
 *  the system file manager and copying its path. The tab strip owns closing;
 *  these reach adapters only the app may bind. */
import { useMemo } from 'react';

import type { AppDependencies } from '@/app/dependencies';
import type { DocumentTabMenuActions } from '@/features/documents/public';
import { systemEntryPath } from '@/features/workspace/public';
import { isExternalSource } from '@/shared/domain/external-source';
import { writeToClipboard } from '@/shared/ui/clipboard';

export function useTabMenuActions({
  documents,
  workspace,
}: Pick<AppDependencies, 'documents' | 'workspace'>): DocumentTabMenuActions {
  return useMemo(
    () => ({
      revealLabel: workspace.revealLabel,
      onReveal(source) {
        // A menu choice has no view to cancel it from; the reveal finishes or
        // fails on its own, as a row's reveal in the file tree does.
        const { signal } = new AbortController();
        const revealing = isExternalSource(source)
          ? documents.adapters.externalFiles.reveal(source, signal)
          : workspace.adapters.files.reveal(source.folderPath, source.path, signal);
        void revealing.catch(() => undefined);
      },
      onCopyPath(source, form) {
        const path = isExternalSource(source)
          ? source.path
          : systemEntryPath(source.folderPath, source.path, form);
        void writeToClipboard(path).catch(() => undefined);
      },
    }),
    [documents.adapters.externalFiles, workspace.adapters.files, workspace.revealLabel],
  );
}
