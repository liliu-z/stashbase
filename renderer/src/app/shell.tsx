/**
 * The workspace window's composition root. It owns no behaviour of its own:
 * it publishes the adapter record, calls one binder per capability, and
 * decides which of their results each region of the layout is handed. A rule
 * that belongs to a feature belongs in that feature, and a rule about the
 * window belongs in a hook under `./composition`.
 */
import { useEffect, useState } from 'react';

import { askAbout, useAgentWorkspaceRuntime } from '@/features/agent/public';
import {
  RevisionPreview,
  useDocumentCommands,
  useDocumentSaveBarrier,
  useNewTab,
  useRevisionPreview,
  type DocumentSelection,
} from '@/features/documents/public';
import { useFolderStatus } from '@/features/preparation/public';
import { AccountProvider, useSearchKeyConfigured } from '@/features/settings/public';
import {
  UpdateNotice,
  UpdatePreview,
  useUpdateNotice,
  useUpdatePreview,
} from '@/features/updates/public';
import {
  ProjectWelcome,
  useProjectEntry,
  useProjectEntryReceiver,
  ImportGitHubDialog,
  useFiles,
  useHiddenFiles,
  useProject,
  useWorkspace,
  useWorkspaceSession,
} from '@/features/workspace/public';

import { usePreparationCommands } from './composition/commands/use-preparation-commands';
import { useWorkspaceCommands } from './composition/commands/use-workspace-commands';
import { DependencyProvider, useDependencies } from './composition/dependency-context';
import { useAgentEnvironment } from './composition/folder/use-agent-environment';
import { useDocumentSources } from './composition/folder/use-document-sources';
import { useDocumentWorkspace } from './composition/folder/use-document-workspace';
import { useFolderReadiness } from './composition/folder/use-folder-readiness';
import { useFolderRefresh } from './composition/folder/use-folder-refresh';
import { useTreeFollowsDocument } from './composition/folder/use-tree-follows-document';
import { useTurnReview } from './composition/folder/use-turn-review';
import { useGalleryShop } from './composition/gallery/use-gallery-shop';
import { WorkspaceDialogs } from './composition/layout/workspace-dialogs';
import { WorkspaceLayout } from './composition/layout/workspace-layout';
import { WorkspaceNoticeStrip } from './composition/layout/workspace-notice-strip';
import { WorkspacePanes } from './composition/layout/workspace-panes';
import { WorkspaceSidebar } from './composition/layout/workspace-sidebar';
import { WorkspaceTitlebar } from './composition/layout/workspace-titlebar';
import { useAppearanceSurface } from './composition/use-appearance-surface';
import type { AppDependencies } from './dependencies';
import { ShellBoundary } from './shell-boundary';

/** The window's root: it publishes the adapter record and nothing else. Every
 *  binder below reads what it needs from that one mechanism, so no component
 *  is handed a port it only passes on. The boundary between them contains a
 *  failure in the window's composition, leaving the dependency record and the
 *  providers above it mounted. */
export function App({ dependencies }: { dependencies: AppDependencies }) {
  return (
    <DependencyProvider dependencies={dependencies}>
      <ShellBoundary>
        <WorkspaceWindow />
      </ShellBoundary>
    </DependencyProvider>
  );
}

/** The workspace window, assembled. Every behaviour lives in a hook under
 *  `./composition` and every port in a binder beside it; this function only
 *  decides what each one is given. */
function WorkspaceWindow() {
  const [chatPaneOpen, setChatPaneOpen] = useState(true);
  const dependencies = useDependencies();
  // Two adapter records this function hands on more than once.
  const { documents: docs, workspace: workspaceDeps } = dependencies;
  useAppearanceSurface(dependencies.settings.appearanceApi, dependencies.settings.setAppearance);
  useEffect(() => dependencies.recordUsage({ event: 'app_opened' }), [dependencies]);
  const session = useWorkspaceSession(
    workspaceDeps.adapters.project,
    workspaceDeps.adapters.session,
  );
  const project = useProject(workspaceDeps.adapters.project).data ?? null;
  const workspace = useWorkspace(workspaceDeps.adapters.project, session);
  const documents = useDocumentWorkspace(
    workspace,
    session,
    docs.adapters.source,
    docs.createId,
    docs.adapters,
  );
  useDocumentSaveBarrier(documents, docs.adapters.windowLifecycle);
  const newTab = useNewTab(documents);
  const sources = useDocumentSources(workspaceDeps.adapters, workspace, documents);
  // The tree's selection is the document in front of the reader, not the
  // last row that was clicked, so a tab switch, a reused preview, or the last
  // tab closing all show in the sidebar.
  useTreeFollowsDocument(workspace, documents);

  const activeFolder = project?.activeFolder ?? null;
  const selectedPath = activeFolder?.path ?? null;
  const folderPath = workspace?.scope.folder.path ?? null;
  const listing = useFiles(workspace, workspaceDeps.adapters.files).data;
  const status = useFolderStatus(dependencies.preparation.statusApi, folderPath).data ?? null;
  // Search by meaning exists only once the reader's own key is on. The
  // window reads that once, and every folder's readiness is projected through
  // it, so no folder shows the mode before the key is there.
  const searchKey = useSearchKeyConfigured(dependencies.settings.embedderApi);
  const folder = useFolderReadiness(listing, status, searchKey);
  // The visibility the listing on screen was built with, so the menu and the
  // rows beside it can never disagree.
  const hiddenFiles = useHiddenFiles(
    workspaceDeps.adapters.preferences,
    listing?.showHiddenFiles ?? false,
    folderPath,
  );
  const preparation = usePreparationCommands(dependencies.preparation.controlApi);
  const refresh = useFolderRefresh({
    folderPath,
    reprocessSource: preparation.reprocess,
    syncFolder: preparation.sync,
    treeVersion: status?.treeVersion,
  });

  const runtime = useAgentWorkspaceRuntime({
    context: dependencies.agent.context,
    recordUsage: dependencies.recordUsage,
    createId: docs.createId,
    folderPath: selectedPath,
    onFilesChanged: refresh.onAgentFilesChanged,
    session: dependencies.agent.session,
    ...(dependencies.agent.preferences ? { preferences: dependencies.agent.preferences } : {}),
    subscribeFolderRemoved: workspaceDeps.adapters.lifecycle.onFolderRemoved,
  });

  // Requested turn reviews open in Documents; refusals stay on the notice strip.
  const revisions = useTurnReview({
    documents,
    sourceApi: docs.adapters.source,
    turnChangesApi: docs.adapters.turnChanges,
    workspace,
  });

  const chrome = useWorkspaceCommands({
    documents,
    hostFailure: sources.hostFailure,
    project,
    preparation,
    revisions,
    session,
    workspace,
  });

  const agent = useAgentEnvironment(
    listing,
    status,
    documents,
    folderPath,
    selectedPath,
    chrome.navigator.mode === 'documents',
  );
  useEffect(() => runtime.setScopeEnvironment(agent.environment), [agent.environment, runtime]);
  // Asking about a selection brings the chat beside the document into view
  // and binds the passage there; the save is started so what the Agent reads
  // from disk is what the reader selected.
  const askAgent = (selection: DocumentSelection) => {
    void documents?.flush();
    setChatPaneOpen(true);
    askAbout(runtime, selection.source, selection.markdown);
  };

  useDocumentCommands(documents?.navigation ?? null, documents, {
    enabled: chrome.navigator.mode === 'documents',
    newTab,
  });

  const entry = useProjectEntry(
    dependencies.project.folderPicker,
    workspaceDeps.adapters.lifecycle,
    workspaceDeps.adapters.githubImport,
  );
  useProjectEntryReceiver(
    workspaceDeps.adapters.project,
    workspaceDeps.adapters.lifecycle,
    documents ? folderPath : null,
  );
  const gallery = useGalleryShop(
    dependencies.gallery,
    entry.copy,
    entry.isPending,
    activeFolder?.path ?? null,
  );
  const updateNotice = useUpdateNotice(dependencies.updates);
  const updatePreview = useUpdatePreview(import.meta.env.DEV);
  const revisionPreview = useRevisionPreview(import.meta.env.DEV, documents);
  // A new draft is the tree's to make, beside its selection, and its name is
  // typed in the tree, so the request brings the Files panel on screen
  // before the tree takes it up. It starts from the New tab's page; the
  // draft opening in front is what closes that tab.
  const newDraft = () => {
    session.runtime.setSidebarOpen(true);
    chrome.navigator.select('files');
    workspace?.requestCreate('draft');
  };

  return (
    // One account for the window: the sidebar's footer row, the composer's
    // runtime picker, and Settings all read the same open sign-in rather than
    // each starting one of their own.
    <AccountProvider
      openExternal={(href) => void dependencies.documents.openExternal(href)}
      port={dependencies.settings.accountApi}
    >
      <WorkspaceLayout
        dialogs={
          <>
            {gallery.surfaces}
            <ImportGitHubDialog
              import={entry.importDialog.request}
              onClose={entry.importDialog.close}
              open={entry.importDialog.open}
            />
            <WorkspaceDialogs
              documents={documents}
              quickOpen={chrome.quickOpen}
              revisionPreview={
                import.meta.env.DEV ? (
                  <RevisionPreview
                    onStart={revisionPreview.start}
                    refusal={revisionPreview.refusal}
                  />
                ) : null
              }
              settings={chrome.settings}
              renderUpdatePreview={(closeDeveloper) =>
                import.meta.env.DEV ? (
                  <UpdatePreview
                    active={updatePreview.notice !== null}
                    onShow={(previewStatus) => {
                      updatePreview.show(previewStatus);
                      closeDeveloper();
                      session.runtime.setSidebarOpen(true);
                      chrome.settings.close();
                    }}
                    onStop={updatePreview.stop}
                  />
                ) : null
              }
              workspace={workspace}
            />
          </>
        }
        hasActiveFolder={activeFolder !== null}
        notices={<WorkspaceNoticeStrip notices={chrome.notices} />}
        panes={
          <WorkspacePanes
            chatPaneOpen={chatPaneOpen}
            agent={{ runtime }}
            documents={documents}
            mode={chrome.navigator.mode}
            onAskAgent={askAgent}
            newTab={newTab}
            onCreateDraft={newDraft}
            onPrepare={preparation.prepare}
            onReprocess={refresh.reprocess}
            onReviewTurnChange={revisions.reviewTurnChange}
            onShowDocuments={() => chrome.navigator.selectMode('documents')}
            session={session}
            settings={chrome.settings}
            sources={sources}
            status={status}
          />
        }
        session={session}
        sidebar={
          <WorkspaceSidebar
            activeFolder={activeFolder}
            agent={{ runtime, scope: agent.scope }}
            documents={documents}
            folder={{
              ...folder,
              hiddenFiles: listing
                ? {
                    disabled: hiddenFiles.pending,
                    shown: hiddenFiles.showHiddenFiles,
                    toggle: hiddenFiles.toggle,
                  }
                : null,
            }}
            navigator={chrome.navigator}
            updateNotice={
              <UpdateNotice
                notice={updatePreview.notice ?? updateNotice}
                preview={updatePreview.notice !== null}
              />
            }
            onBrowseGallery={gallery.browse}
            onReprocess={refresh.reprocess}
            settings={chrome.settings}
            sources={sources}
            workspace={workspace}
          />
        }
        started={chrome.started}
        titlebar={
          <WorkspaceTitlebar
            agent={runtime}
            chatPaneOpen={chatPaneOpen}
            newTab={newTab}
            onToggleChatPane={() => setChatPaneOpen((open) => !open)}
            documents={documents}
            hasActiveFolder={activeFolder !== null}
            mode={chrome.navigator.mode}
          />
        }
        welcome={
          <ProjectWelcome
            {...dependencies.project}
            gallery={gallery.band}
            entry={entry}
            isRestoringSession={session.status.kind === 'restoring'}
          />
        }
      />
    </AccountProvider>
  );
}
