/**
 * The Agent beside the open document.
 *
 * Both panes are bound to their ports here — the Agent to its catalog and
 * scope outline, the document to every viewer transport and to preparation —
 * so the split row itself only owns the seam between them.
 */

import { useCallback } from 'react';

import type {
  SettingsCommand,
  SidebarMode,
} from '@/app/composition/commands/use-workspace-commands';
import { useDependencies } from '@/app/composition/dependency-context';
import type { DocumentSources } from '@/app/composition/folder/use-document-sources';
import { useExternalFiles } from '@/app/composition/folder/use-external-files';
import {
  AgentWorkspace,
  useReferencedPassages,
  type AgentWorkspaceRuntime,
} from '@/features/agent/public';
import {
  DocumentDropZone,
  DocumentWorkspace,
  NewTabPage,
  type DocumentSelection,
  type DocumentTabsRuntime,
  type NewTab,
} from '@/features/documents/public';
import { SourcePreparationStatus, type FolderIndexStatus } from '@/features/preparation/public';
import {
  LocalComponentRecovery,
  ReadingTextMenu,
  useAccountView,
} from '@/features/settings/public';
import type { WorkspaceRuntime, WorkspaceSessionController } from '@/features/workspace/public';
import { isExternalSource } from '@/shared/domain/external-source';
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
  /** Opens the Gallery at its personas, for the composer's picker. */
  onBrowsePersonas(): void;
  /** What the New tab's page starts: a draft beside the tree's selection. */
  onCreateDraft(): void;
  onCreateInteractiveNote(): void;
  onPrepare(source: SourceReference): void;
  onReprocess(source: SourceReference): void;
  /** Opens what an Agent turn changed in one file as a review inside it. */
  onReviewTurnChange(request: { source: SourceReference; turnId: string }): void;
  onShowDocuments(): void;
  session: WorkspaceSessionController;
  settings: SettingsCommand;
  sources: DocumentSources;
  status: FolderIndexStatus | null;
  workspace: WorkspaceRuntime | null;
}

export function WorkspacePanes({
  agent,
  chatPaneOpen,
  documents,
  mode,
  newTab,
  onAskAgent,
  onBrowsePersonas,
  onCreateDraft,
  onCreateInteractiveNote,
  onPrepare,
  onReprocess,
  onReviewTurnChange,
  onShowDocuments,
  session,
  settings,
  sources,
  status,
  workspace,
}: WorkspacePanesProps) {
  const referencedPassages = useReferencedPassages(agent.runtime);
  const dependencies = useDependencies();
  // Files dropped on the workspace open in place and go to the chat beside
  // them; Files keeps the copy.
  const externalFiles = useExternalFiles({
    agent: agent.runtime,
    documents,
    externalFiles: dependencies.documents.adapters.externalFiles,
    onOpened: onShowDocuments,
    workspace,
  });
  const account = useAccountView();
  // The transcript memoizes each message on these callbacks, so they change
  // only with what they close over, never with a streamed reply.
  const { locatePassage, open: openSource } = sources;
  const documentPorts = dependencies.documents;
  const openExternal = useCallback(
    (href: string) => void documentPorts.openExternal(href),
    [documentPorts],
  );
  const openAgentSource = useCallback(
    (source: SourceReference, phrase: string | null, quoteFormat?: 'markdown') => {
      if (phrase) void locatePassage(source, phrase, quoteFormat);
      else openSource(source);
      onShowDocuments();
    },
    [locatePassage, onShowDocuments, openSource],
  );
  const reviewTurnChange = useCallback(
    (request: { source: SourceReference; turnId: string }) => {
      onReviewTurnChange(request);
      onShowDocuments();
    },
    [onReviewTurnChange, onShowDocuments],
  );
  return (
    // The whole row opens a dropped desktop file, so it works before any
    // document is open; the message box inside keeps attaching.
    <DocumentDropZone
      notice={externalFiles.notice}
      onDropFiles={documents ? externalFiles.dropFiles : undefined}
    >
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
            scheduledTasks={dependencies.agent.scheduledTasks}
            tools={dependencies.agent.tools}
            onBrowsePersonas={onBrowsePersonas}
            onOpenAgentSettings={() => settings.openSettings('agents')}
            onOpenAppSettings={() => settings.openSettings('general')}
            onOpenExternal={openExternal}
            onOpenSource={openAgentSource}
            onReprocess={onReprocess}
            onReviewTurnChange={reviewTurnChange}
            // The bundled runtime's only gate is the account, so the picker's
            // row starts the same browser sign-in the sidebar's footer row does.
            onSignIn={(signal) => (signal ? account.signInAndWait(signal) : account.signIn())}
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
            // `isolate` keeps the document's own layers, such as a table row's
            // z-index, beneath the page instead of drawing through it.
            <div className="relative h-full">
              <div aria-hidden={newTab.open} className="isolate h-full" inert={newTab.open}>
                <DocumentWorkspace
                  active={mode === 'documents' && !newTab.open}
                  assetApi={dependencies.documents.adapters.asset}
                  docxPreviewApi={dependencies.documents.adapters.docxPreview}
                  genericPreviewApi={dependencies.documents.adapters.genericPreview}
                  recordUsage={dependencies.recordUsage}
                  onInputActivity={dependencies.onInputActivity}
                  onAskAgent={onAskAgent}
                  referencedPassages={referencedPassages}
                  onNavigate={sources.navigate}
                  onOpenExternal={dependencies.documents.openExternal}
                  onOpenPrepared={onPrepare}
                  onReveal={(source, signal) =>
                    isExternalSource(source)
                      ? dependencies.documents.adapters.externalFiles.reveal(source, signal)
                      : dependencies.workspace.adapters.files.reveal(
                          source.folderPath,
                          source.path,
                          signal,
                        )
                  }
                  // An external file is never prepared, so it has no status row.
                  renderPreparation={(source, format) =>
                    isExternalSource(source) ? null : (
                      <>
                        {format === 'pdf' &&
                          status?.folderPath === source.folderPath &&
                          status.pendingConversions.includes(source.path) && (
                            <LocalComponentRecovery
                              port={dependencies.settings.localComponentApi}
                            />
                          )}
                        <SourcePreparationStatus
                          controlApi={dependencies.preparation.controlApi}
                          format={format}
                          source={source}
                          status={status}
                        />
                      </>
                    )
                  }
                  renderReadingControl={() => (
                    <ReadingTextMenu appearanceApi={dependencies.settings.appearanceApi} />
                  )}
                  revealLabel={dependencies.workspace.revealLabel}
                  runtime={documents}
                  sourceApi={dependencies.documents.adapters.source}
                  tableApi={dependencies.documents.adapters.table}
                />
              </div>
              {newTab.open && (
                <NewTabPage
                  className="absolute inset-0"
                  onClose={newTab.close}
                  onCreateDraft={onCreateDraft}
                  onCreateInteractiveNote={onCreateInteractiveNote}
                />
              )}
            </div>
          ) : null
        }
      />
    </DocumentDropZone>
  );
}
