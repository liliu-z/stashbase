/**
 * The Agent beside the open document.
 *
 * Both panes are bound to their ports here — the Agent to its catalog and
 * scope outline, the document to every viewer transport and to preparation —
 * so the split row itself only owns the seam between them.
 */
import { useMemo } from 'react';

import type {
  SettingsCommand,
  SidebarMode,
} from '@/app/composition/commands/use-workspace-commands';
import { useDependencies } from '@/app/composition/dependency-context';
import type { DocumentSources } from '@/app/composition/folder/use-document-sources';
import { AgentWorkspace, type AgentWorkspaceRuntime } from '@/features/agent/public';
import {
  DocumentWorkspace,
  NewTabPage,
  type DocumentSelection,
  type DocumentTabsRuntime,
  type NewTab,
  type OpenRevision,
} from '@/features/documents/public';
import { SourcePreparationStatus, type FolderIndexStatus } from '@/features/preparation/public';
import { LocalComponentRecovery, useAccountView } from '@/features/settings/public';
import type { WorkspaceSessionController } from '@/features/workspace/public';
import type { SourceReference } from '@/shared/domain/source-reference';

import { AgentDocumentWorkspace } from './agent-document-workspace';

export interface WorkspacePanesProps {
  chatPaneOpen: boolean;
  agent: { runtime: AgentWorkspaceRuntime };
  documents: DocumentTabsRuntime | null;
  /** The sidebar mode. In Chats the Agent has the whole card and no name
   *  row of its own; in Documents it docks beside the open document. */
  mode: SidebarMode;
  /** The strip's New tab; its page covers the document slot while it is
   *  selected. */
  newTab: NewTab;
  /** Binds a document selection to the chat beside it. */
  onAskAgent(selection: DocumentSelection): void;
  /** What the New tab's page starts: a draft beside the tree's selection. */
  onCreateDraft(): void;
  onPrepare(source: SourceReference): void;
  onReprocess(source: SourceReference): void;
  onShowDocuments(): void;
  /** The reviews open across this folder's documents, by folder-relative path.
   *  The one cross-feature hop in the revision card, and it goes through here:
   *  the Agent panel never reaches into Documents for a count. */
  revisions: ReadonlyMap<string, OpenRevision>;
  session: WorkspaceSessionController;
  settings: SettingsCommand;
  sources: DocumentSources;
  status: FolderIndexStatus | null;
}

export function WorkspacePanes({
  agent,
  chatPaneOpen,
  documents,
  mode,
  newTab,
  onAskAgent,
  onCreateDraft,
  onPrepare,
  onReprocess,
  onShowDocuments,
  revisions,
  session,
  settings,
  sources,
  status,
}: WorkspacePanesProps) {
  const dependencies = useDependencies();
  const account = useAccountView();
  // The panel's transcript is memoized, so this keeps its identity until a
  // review's count actually moves rather than on every status poll above.
  const revisionFor = useMemo(
    () => (path: string, id: string) => {
      const revision = revisions.get(path);
      return revision?.id === id ? revision : null;
    },
    [revisions],
  );
  return (
    <AgentDocumentWorkspace
      chatPaneOpen={chatPaneOpen}
      documentsShown={mode === 'documents'}
      newTabOpen={newTab.open}
      agent={
        <AgentWorkspace
          catalog={dependencies.agent.catalog}
          accountSignedIn={account.account?.signedIn ?? false}
          header={mode === 'documents'}
          persona={dependencies.agent.persona}
          onOpenAgentSettings={() => settings.openSettings('agents')}
          onOpenExternal={(href) => void dependencies.documents.openExternal(href)}
          onOpenSource={(source, phrase) => {
            if (phrase) void sources.locatePassage(source, phrase);
            else sources.open(source);
            onShowDocuments();
          }}
          onReprocess={onReprocess}
          // The bundled runtime's only gate is the account, so the picker's
          // row starts the same browser sign-in the sidebar's footer row does.
          onSignIn={(signal) => (signal ? account.signInAndWait(signal) : account.signIn())}
          revisionFor={revisionFor}
          runtime={agent.runtime}
        />
      }
      onPaneWidthChange={session.runtime.setAgentPaneWidth}
      paneWidth={session.shell.agentPaneWidth}
      runtime={documents}
      document={
        documents ? (
          // The New tab's page lies over the document rather than replacing
          // it, so the editors underneath keep their state for its close.
          <div className="relative h-full">
            <div aria-hidden={newTab.open} className="h-full" inert={newTab.open}>
              <DocumentWorkspace
                assetApi={dependencies.documents.adapters.asset}
                docxPreviewApi={dependencies.documents.adapters.docxPreview}
                genericPreviewApi={dependencies.documents.adapters.genericPreview}
                onAskAgent={onAskAgent}
                onNavigate={sources.navigate}
                onOpenExternal={dependencies.documents.openExternal}
                onOpenPrepared={onPrepare}
                onReveal={(source, signal) =>
                  dependencies.workspace.adapters.files.reveal(
                    source.folderPath,
                    source.path,
                    signal,
                  )
                }
                renderPreparation={(source, format) => (
                  <>
                    {(format === 'pdf' || format === 'image') &&
                      status?.folderPath === source.folderPath &&
                      status.pendingConversions.includes(source.path) && (
                        <LocalComponentRecovery port={dependencies.settings.localComponentApi} />
                      )}
                    <SourcePreparationStatus
                      controlApi={dependencies.preparation.controlApi}
                      format={format}
                      source={source}
                      status={status}
                    />
                  </>
                )}
                revealLabel={dependencies.workspace.revealLabel}
                runtime={documents}
                humanizeApi={dependencies.documents.adapters.humanize}
                sourceApi={dependencies.documents.adapters.source}
              />
            </div>
            {newTab.open && (
              <NewTabPage
                className="absolute inset-0"
                onClose={newTab.close}
                onCreateDraft={onCreateDraft}
              />
            )}
          </div>
        ) : null
      }
    />
  );
}
