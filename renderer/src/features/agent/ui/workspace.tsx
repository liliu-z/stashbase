/** The Agent conversation surface: the transcript, the connection strip that
 *  explains a stopped session, and the composer beneath them. The workspace
 *  only reads session state and hands verbs back to the runtime; every
 *  decision about what a connection means is a domain selector. */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { Button } from '@/components/ui/button';
import type { QueuedMessage } from '@/components/ui/input-message';
import type { AgentCatalogPort } from '@/features/agent/application/ports';
import type { AgentSessionRuntime } from '@/features/agent/application/session-runtime';
import { honoredAccessMode } from '@/features/agent/domain/access';
import { agentGate, undescribedAgent, type Agent } from '@/features/agent/domain/agent-catalog';
import { changedSource } from '@/features/agent/domain/file-change';
import {
  agentSkills,
  agentTurnIsActive,
  agentSessionIsBusy,
  agentCanChangeAgent,
  scopeLabel,
} from '@/features/agent/domain/session';
import { EMPTY_CHAT_PROMPTS } from '@/features/agent/domain/starters';
import { useAgentAccess } from '@/features/agent/hooks/use-agent-access';
import { useAgentCatalog } from '@/features/agent/hooks/use-agent-catalog';
import { useAgentPersona } from '@/features/agent/hooks/use-agent-persona';
import { useAgentRuntimeUpdate } from '@/features/agent/hooks/use-agent-runtime-update';
import { useRenameConversation } from '@/features/agent/hooks/use-conversation-history';
import { useRotatingPrompt } from '@/features/agent/hooks/use-rotating-prompt';
import { cn } from '@/lib/utils';
import { useStickToBottom } from '@/shared/runtime/use-stick-to-bottom';

import { AgentAccessDialog } from './access-dialog';
import { ChatHeader } from './chat-header';
import { ChatHistoryPopover } from './chats/history-popover';
import { AgentContextComposer } from './composer/context-composer';
import { useAgentComposerFocused } from './composer/focus';
import { AgentPermissionMode } from './composer/permission-mode';
import { AgentProviderControl } from './composer/provider';
import { AgentThinkingControl } from './composer/thinking';
import { AgentConnectionNotice, connectionNotice } from './connection-notice';
import { NewChatButton } from './new-chat-button';
import { AgentPersonaControl } from './persona/agent-persona-control';
import { AgentTranscript } from './transcript/transcript';
import { AgentUpgradeOfferCard } from './upgrade-offer';
import { AgentWorkStatus } from './work-status';
import type { AgentWorkspaceProps } from './workspace-lazy';

interface WorkspaceCatalog {
  agents: Agent[];
  error: boolean;
  loading: boolean;
  refresh(): void;
}

/** Draft first; request account or native runtime access only on Send. */
function ChatWorkspace({
  catalog,
  catalogPort,
  header = true,
  persona: personaApi,
  onOpenAgentSettings,
  onSignIn,
  onOpenExternal,
  onOpenSource,
  onReprocess,
  revisionFor,
  runtime,
  active,
}: Omit<AgentWorkspaceProps, 'catalog'> & {
  active: AgentSessionRuntime;
  catalog: WorkspaceCatalog;
  /** The catalog as a Port, for the new-chat control that reads it itself. */
  catalogPort: AgentCatalogPort;
}) {
  const activeId = active.id;
  const scopeEnvironment = useStore(runtime.store, (state) => state.scopeEnvironment);
  const state = useStore(
    active.store,
    useShallow((session) => ({
      agent: session.agent,
      accessMode: session.accessMode,
      activeModel: session.activeModel,
      connection: session.connection,
      delivery: session.delivery,
      queuePaused: session.queuePaused,
      effort: session.effort,
      model: session.model,
      models: session.models,
      nativeSessionId: session.nativeSessionId,
      queuedPrompts: session.queuedPrompts,
      scope: session.scope,
      skill: session.skill,
      skillCatalog: session.skillCatalog,
      transcript: session.transcript,
    })),
  );
  const gate = agentGate({
    agents: catalog.agents,
    loading: catalog.loading,
    selected: state.agent,
  });
  const readyAgent = gate.kind === 'ready' ? gate.agent : null;
  const preferences = useStore(runtime.preferences);
  const preferencesUnavailable = preferences.loading || Boolean(preferences.failure);
  const selectedAgent =
    catalog.agents.find((agent) => agent.id === state.agent) ?? undescribedAgent(state.agent);
  const access = useAgentAccess({
    runtime,
    agents: catalog.agents,
    catalog: catalogPort,
    onSignIn,
    onRefresh: catalog.refresh,
  });
  const runtimeUpdate = useAgentRuntimeUpdate(active, catalogPort, catalog.refresh);
  const activeTurn = agentTurnIsActive(state.connection);
  const busy = agentSessionIsBusy(active.store.getState());
  const notice = connectionNotice(state.connection);
  const armedSkill = agentSkills(state.skillCatalog).find((skill) => skill.id === state.skill);
  const empty = state.transcript.length === 0;
  const scopeName = scopeLabel(state.scope);
  const persona = useAgentPersona(personaApi, state.scope, active.applyPersona);
  const honoredModes = readyAgent?.abilities.modes;
  useEffect(() => {
    if (!honoredModes || honoredModes.length === 0) return;
    const settled = honoredAccessMode(honoredModes, state.accessMode);
    if (settled !== state.accessMode) active.setAccessMode(settled);
  }, [active, honoredModes, state.accessMode]);
  const rememberedModels = readyAgent?.models;
  const unstarted = state.connection.kind === 'draft';
  useEffect(() => {
    if (unstarted && rememberedModels && rememberedModels.length > 0) {
      active.seedModels(rememberedModels);
    }
  }, [active, rememberedModels, unstarted]);
  const composerFocused = useAgentComposerFocused();
  const rotatingPrompt = useRotatingPrompt(EMPTY_CHAT_PROMPTS, composerFocused || !empty);
  const promptPlaceholder = empty && armedSkill === undefined ? rotatingPrompt : null;
  const scope = state.scope;
  const sourceFor = useMemo(
    () => (path: string) => {
      const source = changedSource(scope, path);
      return source &&
        scopeEnvironment?.folderPath === source.folderPath &&
        scopeEnvironment.listing.files.some((file) => file.path === source.path)
        ? source
        : null;
    },
    [scope, scopeEnvironment],
  );
  const composerRef = useRef<HTMLDivElement>(null);
  const composerShown = state.connection.kind !== 'retired' && state.connection.kind !== 'disposed';
  const editPrompt = useCallback(
    (blockId: string) => {
      if (!active.editPrompt(blockId)) return;
      requestAnimationFrame(() => {
        composerRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
      });
    },
    [active],
  );
  const logRef = useRef<HTMLDivElement>(null);
  const scroll = useStickToBottom(logRef, activeId);
  const renaming = useRenameConversation(runtime);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-surface-2">
      <ChatHeader
        blank={!header}
        failure={renaming.failure}
        onRename={(session, title) => void renaming.rename(session, title)}
        session={active}
        trailing={
          <>
            <ChatHistoryPopover runtime={runtime} scope={state.scope} />
            <NewChatButton catalog={catalogPort} runtime={runtime} scope={state.scope} />
          </>
        }
      />
      {empty && <div aria-hidden className="min-h-0 grow basis-0" />}
      <div
        aria-busy={activeTurn}
        aria-live="polite"
        aria-label="Conversation transcript"
        className={cn('min-h-0 overflow-y-auto', empty ? 'flex-initial' : 'flex-1')}
        ref={logRef}
        role="log"
      >
        <div
          className={cn(
            'mx-auto flex min-h-full w-full max-w-[46rem] flex-col gap-3',
            empty ? 'px-4 pt-8 pb-7 max-sm:px-3' : 'px-5 pt-4 pb-6 max-sm:px-4',
          )}
        >
          {empty && !notice && state.connection.kind !== 'restoring' ? (
            <h2 className="text-center text-ui-28 leading-none font-semibold tracking-[-0.03em] text-foreground max-sm:text-ui-24">
              What’s on your mind?
            </h2>
          ) : (
            <AgentTranscript
              activeTurn={activeTurn}
              blocks={state.transcript}
              key={activeId}
              onEditPrompt={composerShown ? editPrompt : undefined}
              onOpenExternal={onOpenExternal}
              onOpenSource={onOpenSource}
              onPermission={active.replyPermission}
              onRetry={active.retry}
              revisionFor={revisionFor}
              runtimeUpdate={runtimeUpdate}
              sourceFor={sourceFor}
              transientFile={active.fileForTransient}
            />
          )}
        </div>
      </div>

      <AgentWorkStatus session={active} onOpenSettings={onOpenAgentSettings} />
      {!scroll.atBottom && !empty && (
        <Button
          className="mx-auto mb-2"
          size="compact"
          variant="secondary"
          onClick={scroll.scrollToBottom}
        >
          Back to latest
        </Button>
      )}
      {notice && state.delivery !== 'unknown' && (
        <AgentConnectionNotice connection={state.connection} onReconnect={active.reconnect} />
      )}

      {composerShown && selectedAgent.upgrade && (
        <AgentUpgradeOfferCard offer={selectedAgent.upgrade} runtimeUpdate={runtimeUpdate} />
      )}

      {composerShown && (
        <div className="relative shrink-0 px-4 pb-3 max-sm:px-3">
          <div className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-t from-surface-2 to-transparent" />
          <div className="@container relative mx-auto w-full max-w-[46rem]" ref={composerRef}>
            <AgentContextComposer
              attachments={selectedAgent.abilities.attachments}
              environment={scopeEnvironment}
              maxRows={6}
              minRows={3}
              onQueueChange={(queue: QueuedMessage[]) =>
                active.setQueue(queue.map(({ id, text }) => ({ id, text })))
              }
              onRefreshSkills={active.refreshSkills}
              onReprocess={onReprocess}
              onSkillChange={active.setSkill}
              onStop={active.interrupt}
              onSend={access.send}
              placeholder={armedSkill?.argumentHint ?? promptPlaceholder ?? 'Write with StashBase…'}
              placeholderIsPrompt={promptPlaceholder !== null}
              queue={state.queuedPrompts.map(({ context, id, text }) => ({
                files: context.flatMap((item) =>
                  item.kind === 'transient' ? (active.fileForTransient(item.path) ?? []) : [],
                ),
                id,
                text,
              }))}
              leftSlot={
                <>
                  <AgentProviderControl
                    activeAgent={selectedAgent}
                    startsNewChat={!agentCanChangeAgent(state)}
                    agents={
                      catalog.agents.some((agent) => agent.id === selectedAgent.id)
                        ? catalog.agents
                        : [selectedAgent, ...catalog.agents]
                    }
                    disabled={busy || preferencesUnavailable}
                    onAgentChange={(agent) => {
                      void runtime.chooseAgent(agent);
                    }}
                  />
                  {readyAgent && readyAgent.abilities.modes.length > 0 && (
                    <AgentPermissionMode
                      disabled={busy}
                      mode={state.accessMode}
                      modes={readyAgent.abilities.modes}
                      onChange={active.setAccessMode}
                    />
                  )}
                  <AgentPersonaControl disabled={busy} picker={persona} scopeName={scopeName} />
                </>
              }
              rightSlot={
                readyAgent ? (
                  <AgentThinkingControl
                    activeAgent={readyAgent}
                    onEffortChange={active.setEffort}
                    onModelChange={active.setModel}
                    onRequestCatalog={active.start}
                    state={{ ...state, activeTurn: busy || preferencesUnavailable }}
                  />
                ) : null
              }
              sendable={
                !catalog.loading &&
                !catalog.error &&
                !preferencesUnavailable &&
                state.delivery !== 'unknown' &&
                state.delivery !== 'stopping' &&
                state.delivery !== 'preparing' &&
                (activeTurn ||
                  state.connection.kind === 'draft' ||
                  state.connection.kind === 'live') &&
                state.queuedPrompts.length < 20
              }
              session={active}
              skills={readyAgent?.abilities.skills ?? false}
              status={busy && state.delivery !== 'stopping' ? 'streaming' : 'idle'}
            />
          </div>
        </div>
      )}
      <AgentAccessDialog
        agent={access.agent}
        open={access.open}
        working={access.working}
        failure={access.failure}
        onConfirm={() => {
          void access.confirm();
        }}
        onCancel={access.cancel}
      />
      {(catalog.loading || catalog.error || preferences.failure) && (
        <div className="mx-auto flex w-full max-w-[46rem] items-center gap-2 px-4 pb-3 text-caption text-muted-foreground">
          <span>
            {preferences.failure ??
              (catalog.error ? 'Agent runtime status is unavailable.' : 'Checking runtimes…')}
          </span>
          {(preferences.failure || catalog.error) && (
            <Button
              variant="ghost"
              size="compact"
              onClick={
                preferences.failure
                  ? () => {
                      void runtime.loadPreferences();
                    }
                  : catalog.refresh
              }
            >
              Retry
            </Button>
          )}
        </div>
      )}
      {empty && <div aria-hidden className="min-h-0 grow-[1.3] basis-0" />}
    </div>
  );
}

export default function ManagedAgentWorkspace(props: AgentWorkspaceProps) {
  const catalog = useAgentCatalog(props.catalog);
  const active = useStore(props.runtime.store, (state) => props.runtime.session(state.activeId));
  const { refresh } = catalog;
  useEffect(() => {
    if (props.accountSignedIn !== undefined) refresh();
  }, [props.accountSignedIn, refresh]);

  useEffect(() => {
    props.runtime.start(catalog.readyAgents.map((agent) => agent.id));
  }, [catalog.readyAgents, props.runtime]);

  if (!active) return null;
  return (
    <ChatWorkspace
      active={active}
      {...props}
      catalogPort={props.catalog}
      catalog={{
        agents: catalog.agents,
        error: catalog.error,
        loading: catalog.loading,
        refresh: catalog.refresh,
      }}
    />
  );
}
