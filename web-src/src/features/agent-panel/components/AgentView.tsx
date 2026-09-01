/**
 * Structured chat view for an agent tab — the VSCode-extension-style
 * panel. Built-in (OpenCode), Claude (Agent SDK), and Codex
 * (app-server) connect through the Shared Agent Contract at `/ws/agent`;
 * their adapters live in server.
 * All adapters render the event stream as ordered blocks:
 * user / assistant bubbles, collapsible thinking, tool cards with
 * inline diffs + approve/reject, and error notices. A composer at the
 * bottom sends prompts, stops a running turn, takes dropped files, and
 * `@`-mentions library files.
 *
 * This component is composition: connection/session state lives in
 * `useAgentSession`, attachment upload/preview bookkeeping lives in
 * `useAgentAttachments`, and the runtime-not-ready cards live in
 * `AgentRuntimeGate`. See those modules for the actual state machine.
 *
 * See design-docs/architecture.md §8 for the shared library path.
 */
import { useState } from 'react';
import type { AgentKind } from '@/common/lib/agentCatalog';
import { FILE_MIME } from '@/common/lib/dragMime';
import { acceptsAgentContextDrop, dragPayloadKinds } from '@/common/lib/dragRouting';
import { useAppActions, useChat, useWorkspace } from '@/store/contexts/AppContext';
import { Button } from '@/common/components/ui/button';
import { AgentComposer } from '@/features/agent-panel/components/AgentComposer';
import { AgentRuntimeGate } from '@/features/agent-panel/components/AgentRuntimeGate';
import { BuildWikiPagesAction, EmptyChatGreeting } from '@/features/agent-panel/components/AgentEmptyState';
import { MessageList } from '@/features/agent-panel/components/AgentMessages';
import { useAgentAttachments } from '@/features/agent-panel/hooks/useAgentAttachments';
import { useAgentSession } from '@/features/agent-panel/hooks/useAgentSession';
import { openSettings } from '@/common/lib/settingsTrigger';
import type { LibraryScope } from '@/common/lib/libraryScope';

export function AgentView({
  active,
  id,
  title,
  agent = 'claude',
  initialScope,
}: {
  active: boolean;
  id: string;
  title: string;
  agent?: AgentKind;
  initialScope?: LibraryScope;
}) {
  const workspace = useWorkspace();
  const chat = useChat();
  const { dispatch, actions } = useAppActions();

  // Composer attachments (context files) — lifted here so a drop anywhere
  // on the panel, the composer `+`, and the send path all share one list.
  const attach = useAgentAttachments({ toast: actions.toast });

  const session = useAgentSession({
    active,
    id,
    title,
    agent,
    workspace,
    chat,
    dispatch,
    actions,
    attachments: attach.attachments,
    attachmentsRef: attach.attachmentsRef,
    clearComposerAttachments: attach.clearComposerAttachments,
    discardAttachmentsForReset: attach.discardAttachmentsForReset,
    initialScope,
  });
  // The session groups its state by owner; destructure the namespaces once
  // so the JSX below reads as composition rather than prop threading.
  const { controls, mentions, queue, runtime, similaritySearch, skills, transcript, wiki } = session;

  const [dragOver, setDragOver] = useState(false);

  // Drag files anywhere onto the panel to attach them as context: OS files
  // (Finder screenshots / PDFs) become transient attachments (temp dir,
  // NOT the folder); sidebar files (FILE_MIME) reference their existing
  // path. `stopPropagation` is load-bearing: it stops the event before it
  // reaches the window-level `useGlobalDragDrop` listener, which would
  // otherwise *also* fire and import the file into the folder.
  function onPanelDragOver(e: React.DragEvent) {
    if (!runtime.capabilities.attachments) return;
    const kinds = dragPayloadKinds(e.dataTransfer);
    if (!acceptsAgentContextDrop(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    // The sidebar drag source sets effectAllowed='move'; match it so the
    // drop isn't silently cancelled (OS files accept 'copy').
    e.dataTransfer.dropEffect = kinds.internalFile && !kinds.osFiles ? 'move' : 'copy';
    if (transcript.phase === 'live') setDragOver(true);
  }
  function onPanelDragLeave(e: React.DragEvent) {
    // Only clear when the pointer actually leaves the panel, not when it
    // crosses between child elements.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
  }
  function onPanelDrop(e: React.DragEvent) {
    if (!runtime.capabilities.attachments) return;
    if (!acceptsAgentContextDrop(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (transcript.phase !== 'live') return;
    const osFiles = Array.from(e.dataTransfer.files ?? []);
    if (osFiles.length) void attach.uploadFiles(osFiles);
    else {
      const filePath = e.dataTransfer.getData(FILE_MIME);
      if (filePath) attach.addFolderFiles([filePath], mentions.knownFilePaths);
    }
  }

  // Runtime-readiness gates, most fundamental first: discovery has not
  // answered yet, preparation is running, preparation failed, CLI missing.
  // Chat UI below owns the pane once the runtime is usable.
  const showRuntimeGate = !runtime.runtime || runtime.bootstrapActive || runtime.bootstrapFailed || runtime.runtimeUnavailable;

  // Empty chat (no turns yet, session usable) renders the hero layout:
  // greeting + centered composer. Any transcript
  // content, a queued prompt, or a closed/failed session falls back to the
  // standard transcript-over-bottom-composer layout. The composer keeps its
  // `key` so the same mounted instance moves between the two layouts.
  const emptyChat = transcript.blocks.length === 0 && queue.queuedTurns.length === 0 && transcript.phase !== 'closed' && !transcript.fatal;
  const folderScoped = controls.sessionScope.kind === 'folder';
  const canOfferBuildWikiPages = folderScoped
    && transcript.blocks.length === 0
    && queue.queuedTurns.length === 0
    && !transcript.fatal
    && (!controls.hasDraftText && attach.attachments.length === 0 || wiki.pending);

  function requestBuildWikiPages() {
    if (!wiki.requestBuildWikiPages()) return;
    // Building the Wiki is independent of semantic indexing, but the
    // Built-in Agent still needs its own model source before it can write.
    if (agent === 'stashbase' && runtime.runtime?.bootstrap?.failure?.code === 'account-required') {
      openSettings('agents');
    }
  }

  const buildWikiPagesAction = canOfferBuildWikiPages ? (
    <BuildWikiPagesAction
      pending={wiki.pending}
      onBuild={requestBuildWikiPages}
      onCancel={wiki.cancelBuildWikiPages}
    />
  ) : null;

  return (
    // `agent-view` stays as a routing hook: useGlobalDragDrop uses
    // `closest('.agent-view')` to keep panel drops out of folder import.
    <div
      // Documents are paper (base); chat sits on the CANVAS role — a cool
      // near-white between paper and chrome, identical in BOTH layouts,
      // floating its white cards (user turns, composer, code blocks). The
      // surface never changes with layout, so opening a document only
      // resizes the panel — no mode jump.
      className="agent-view relative flex min-h-0 flex-1 flex-col bg-canvas"
      onDragOver={onPanelDragOver}
      onDragLeave={onPanelDragLeave}
      onDrop={onPanelDrop}
    >
      {dragOver && (
        // pointer-events-none so the overlay never steals the drop or
        // flickers dragenter/leave; the panel's own handlers take the drop.
        <div className="pointer-events-none absolute inset-1.5 z-chrome grid place-items-center rounded-xl border-2 border-dashed border-accent/55 bg-accent/7 backdrop-blur-[1.5px]">
          <div className="rounded-lg border border-border bg-popover px-3.5 py-2 text-sm font-medium text-popover-foreground shadow-elevation">Drop files to add as context</div>
        </div>
      )}
      {/* No pane header: the chat tab already names the conversation and
        * the composer's scope pill carries the binding — repeating either
        * here was pure noise. */}
      {showRuntimeGate ? (
        <AgentRuntimeGate
          runtime={runtime.runtime}
          fallbackName={session.meta.name}
          bootstrapActive={runtime.bootstrapActive}
          bootstrapFailed={runtime.bootstrapFailed}
          runtimeUnavailable={runtime.runtimeUnavailable}
          onRefresh={() => void runtime.refreshRuntimes()}
          onCheck={() => void runtime.checkRuntime()}
          onInstall={() => void runtime.startRuntimeBootstrap()}
          onLogin={() => void runtime.loginToCodex()}
          onOpenAccount={() => openSettings('agents')}
          onCopyInstall={runtime.copyInstallHint}
          onOpenMcpSetup={() => openSettings('mcp')}
          footer={buildWikiPagesAction}
        />
      ) : <>
        {emptyChat ? (
          // Empty chat: the composer is the hero. The greeting bottoms out
          // this flex-[3] band. Folder scope balances it with an equal empty
          // band below the fixed composer + Build Wiki action, centering the
          // whole action group. Only the VERTICAL placement changes on send — the
          // composer holds one width in both states, and the transcript
          // adopts it.
          <div key="empty-above" className="flex min-h-0 flex-[3] flex-col justify-end overflow-hidden px-2">
            <div className="mx-auto w-measure-md">
              <EmptyChatGreeting
                agentShortName={session.meta.shortName}
                connecting={transcript.phase === 'connecting'}
              />
            </div>
          </div>
        ) : (
          <MessageList
            key="messages"
            blocks={transcript.blocks}
            queuedTurns={queue.queuedTurns}
            turnActive={transcript.turnActive}
            turnMeta={transcript.turnMeta}
            phase={transcript.phase}
            fatal={transcript.fatal}
            fatalRecoveryLabel={transcript.fatalRecoveryLabel}
            scopeRetired={transcript.scopeRetired}
            agentKind={agent}
            agentShortName={session.meta.shortName}
            onTurnFailureAction={transcript.handleTurnFailureAction}
            onPermission={transcript.replyPermission}
            onSteerQueued={queue.steerQueuedPrompt}
            onDeleteQueued={queue.deleteQueuedPrompt}
            onCopyUserMessage={transcript.copyUserMessage}
            onResendUserMessage={queue.resend}
            onRetry={transcript.reconnectAfterFatal}
            onStartLibraryChat={transcript.startLibraryChat}
            onOpenArtifact={transcript.openArtifactLink}
          />
        )}
        {transcript.phase === 'closed' && !transcript.fatal && !transcript.scopeRetired && (
          <div className="flex items-center justify-between gap-2.5 border-t border-border px-3 py-2 text-sm text-muted-foreground">
            <span>Session ended.</span>
            <Button variant="outline" size="sm" onClick={transcript.reconnect}>Reconnect</Button>
          </div>
        )}
      <AgentComposer
        key="composer"
        hero={emptyChat}
        phase={transcript.phase}
        disabled={transcript.phase !== 'live'}
        turnActive={transcript.turnActive}
        active={active}
        agentShortName={session.meta.shortName}
        closedPlaceholder={transcript.scopeRetired ? 'Folder removed — start a Library chat to continue…' : undefined}
        mode={{ show: runtime.capabilities?.modes === true, value: controls.mode, onSet: controls.changeMode }}
        effort={{
          show: runtime.capabilities?.effort === true,
          level: controls.effort,
          inherited: controls.effortInherited,
          locked: controls.effortLocked,
          supported: controls.supportedEfforts,
          onSet: controls.changeEffort,
        }}
        model={{
          show: controls.modelVisible,
          selected: controls.modelControl.selectedModel,
          active: controls.modelControl.activeModel,
          models: controls.modelControl.models,
          locked: controls.modelLockReason !== null,
          lockReason: controls.modelLockReason,
          notice: controls.modelControl.notice,
          resumedSession: controls.modelControl.resumedSession,
          onSet: controls.changeModel,
        }}
        scope={{
          current: controls.sessionScope,
          entries: controls.folderEntries,
          homeDir: workspace.homeDir,
          locked: controls.folderLocked || wiki.pending,
          onSet: controls.changeScope,
        }}
        similaritySearch={{
          enabled: similaritySearch.enabled,
          availabilityKnown: similaritySearch.availabilityKnown,
          onChange: similaritySearch.change,
        }}
        mentions={{ files: mentions.mentionFiles, folders: mentions.mentionFolders }}
        skills={{ list: skills.skills, state: skills.skillState, onRefresh: skills.refreshSkills }}
        attachments={{
          enabled: runtime.capabilities.attachments,
          items: attach.attachments,
          uploading: attach.uploading,
          onPick: attach.uploadFiles,
          onPasteImages: attach.pasteImages,
          onRemove: attach.removeAttachment,
        }}
        onDraftChange={controls.handleDraftChange}
        onFocusChange={transcript.setAgentComposerFocused}
        onSend={queue.send}
        onStop={transcript.stop}
      />
      {emptyChat && folderScoped && buildWikiPagesAction}
      {emptyChat && <div key="empty-below" className="min-h-0 flex-[3]" aria-hidden="true" />}
      </>}
    </div>
  );
}
