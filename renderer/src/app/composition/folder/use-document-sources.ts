import { useCallback } from 'react';

import { mutateDocuments } from '@/app/workflows/mutate-documents';
import { openDocument } from '@/app/workflows/open-document';
import {
  passageSearchTarget,
  type DocumentNavigationTarget,
  type DocumentTabsRuntime,
} from '@/features/documents/public';
import type { SearchNavigationIntent } from '@/features/retrieval/public';
import {
  useProjectLifecycle,
  type WorkspaceAdapters,
  type WorkspaceEntry,
  type WorkspaceRuntime,
  type WorkspaceScope,
} from '@/features/workspace/public';
import type { SourceReference } from '@/shared/domain/source-reference';

export interface DocumentSources {
  /** The host's refusal to follow this window's folder, or null while it
   *  agrees. A window the host disagrees with cannot reconcile anything, so
   *  the shell says so rather than failing quietly. */
  hostFailure: string | null;
  /** Follows a link inside a document, landing on its anchor when it has one. */
  navigate(target: DocumentNavigationTarget): void;
  /** Opens the document behind a search hit and lands on the match. Answers
   *  whether the document opened. */
  navigateToMatch(intent: SearchNavigationIntent): Promise<boolean>;
  /** Opens the document a reply cited and lands on the quoted phrase. Answers
   *  whether the document opened; a phrase it no longer holds is said there. */
  locatePassage(source: SourceReference, phrase: string): Promise<boolean>;
  /** Opens a source. Browsing is the default and opens a preview, the one
   *  tab the next browse reuses; `keep` asks for a tab that stays. */
  open(source: SourceReference, options?: { keep?: boolean }): void;
  /** Reconciles a scope this window lost with the project the host reports. */
  recoverLostScope(scope: WorkspaceScope): void;
  /** Settles the open documents under an entry before it is renamed or
   *  deleted. */
  mutate(entry: WorkspaceEntry, operation: () => Promise<string | null>): Promise<boolean>;
  /** Flushes the open folder's unsaved documents; true when it is safe to
   *  leave the folder. */
  saveOpenFolder(): Promise<boolean>;
}

/**
 * The document workflows, bound to the workspace and tabs runtimes that are
 * live right now.
 *
 * Each workflow needs both runtimes and refuses to act without them, so the
 * binding is done once here instead of at every call site. The save barrier is
 * the reason this is not just a bag of callbacks: the project lifecycle has to
 * be able to stop a folder change until the folder's own documents have been
 * flushed, and only the folder that owns a document may answer for it.
 *
 * Every route in here is a reader browsing — a tree row, a link, a search
 * hit — so each opens a preview unless the caller says the tab should stay.
 */
export function useDocumentSources(
  adapters: WorkspaceAdapters,
  workspace: WorkspaceRuntime | null,
  documents: DocumentTabsRuntime | null,
): DocumentSources {
  const saveDocumentsForFolder = useCallback(
    (folderPath: string) =>
      documents?.scope.folderPath === folderPath ? documents.flush() : Promise.resolve(true),
    [documents],
  );

  const projectLifecycle = useProjectLifecycle(
    adapters.project,
    adapters.lifecycle,
    workspace,
    saveDocumentsForFolder,
  );

  const open = useCallback(
    (source: SourceReference, options: { keep?: boolean } = {}) => {
      if (!workspace || !documents) return;
      void openDocument(workspace, documents, source, { preview: options.keep !== true });
    },
    [documents, workspace],
  );

  const navigate = useCallback(
    (target: DocumentNavigationTarget) => {
      if (!workspace || !documents) return;
      void openDocument(workspace, documents, target.source, {
        preview: true,
        ...(target.anchor === undefined ? {} : { anchor: target.anchor }),
      });
    },
    [documents, workspace],
  );

  const navigateToMatch = useCallback(
    async (intent: SearchNavigationIntent) => {
      if (!workspace || !documents) return false;
      const opened = await openDocument(workspace, documents, intent.source, {
        preview: true,
        search: intent.target,
      });
      return opened !== null;
    },
    [documents, workspace],
  );

  const locatePassage = useCallback(
    async (source: SourceReference, phrase: string) => {
      if (!workspace || !documents) return false;
      const opened = await openDocument(workspace, documents, source, {
        preview: true,
        search: passageSearchTarget(phrase),
      });
      return opened !== null;
    },
    [documents, workspace],
  );

  const mutate = useCallback(
    (entry: WorkspaceEntry, operation: () => Promise<string | null>) =>
      workspace && documents
        ? mutateDocuments(workspace, documents, entry, operation)
        : Promise.resolve(false),
    [documents, workspace],
  );

  const saveOpenFolder = useCallback(
    () => (workspace ? saveDocumentsForFolder(workspace.scope.folder.path) : Promise.resolve(true)),
    [saveDocumentsForFolder, workspace],
  );

  return {
    hostFailure: projectLifecycle.failure,
    locatePassage,
    navigate,
    navigateToMatch,
    open,
    recoverLostScope: projectLifecycle.recoverLostScope,
    mutate,
    saveOpenFolder,
  };
}
