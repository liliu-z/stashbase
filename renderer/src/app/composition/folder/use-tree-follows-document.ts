/**
 * Keeps the file tree's selection on the document in front of the reader.
 *
 * The tree selects the row a reader points at, and that is where the window's
 * creates land; the open set decides which document is actually on screen, and
 * it moves for reasons the tree never sees — a tab activated in the strip, a
 * preview reused by the next browse, document history, a tab closed. Without
 * this the highlighted row is only ever the last row that was clicked, so it
 * outlives the document it named.
 *
 * The rule: a document coming in front selects its own row, opening the
 * folders above it and bringing the row into view so the reader sees where it
 * lives, and when the last one goes the selection it put there leaves with it.
 * A row the reader pointed at themselves — a folder they expanded, a file
 * whose tab they have since closed — is not theirs to clear, so only the row
 * this hook last followed is dropped. A folder the reader folds stays folded
 * until a document from inside it comes in front again.
 */
import { useEffect } from 'react';

import type { DocumentTabsRuntime } from '@/features/documents/public';
import type { WorkspaceRuntime } from '@/features/workspace/public';

export function useTreeFollowsDocument(
  workspace: WorkspaceRuntime | null,
  documents: DocumentTabsRuntime | null,
): void {
  useEffect(() => {
    if (!workspace || !documents) return;
    const folderPath = workspace.scope.folder.path;
    /** The row the active document names, or null when nothing in front of
     *  the reader belongs to this tree: no document at all, or one opened
     *  read-only from another folder. */
    const activeTreePath = () => {
      const source = documents.activeSource();
      return source?.folderPath === folderPath ? source.path : null;
    };
    // The first look is the arrangement as restored, which already agrees
    // with the selection saved beside it. Only a later move is ours to answer.
    let followed = activeTreePath();
    return documents.subscribe(() => {
      const path = activeTreePath();
      if (path === followed) return;
      const left = followed;
      followed = path;
      if (path !== null) workspace.revealPath(path);
      else if (workspace.store.getState().selectedPath === left) workspace.selectPath(null);
    });
  }, [documents, workspace]);
}
