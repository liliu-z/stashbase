/** Conversation surface. Reads session state and invokes runtime actions. */
import { useCallback, useEffect, useState, useRef } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import type { QueuedMessage } from '@/components/ui/input-message';
import type { AgentCatalogPort } from '@/features/agent/application/ports';
import type { AgentSessionRuntime } from '@/features/agent/application/session-runtime';
import { honoredAccessMode } from '@/features/agent/domain/access';
import {
  type Agent,
  agentGate,
  offersRuntimeUpdate,
  undescribedAgent,
} from '@/features/agent/domain/agent-catalog';
import {
  agentSkills,
  agentTurnIsActive,
  agentSessionIsBusy,
  agentCanChangeAgent,
} from '@/features/agent/domain/session';
import { EMPTY_CHAT_PROMPTS } from '@/features/agent/domain/starters';
import { useAgentAccess } from '@/features/agent/hooks/use-agent-access';
import { useAgentCatalog } from '@/features/agent/hooks/use-agent-catalog';
import { useAgentModelRefresh } from '@/features/agent/hooks/use-agent-model-refresh';
import { useAgentPersona } from '@/features/agent/hooks/use-agent-persona';
import { useAgentRuntimeUpdate } from '@/features/agent/hooks/use-agent-runtime-update';
import { useAttentionFocus } from '@/features/agent/hooks/use-attention-focus';
import { useChangedSource } from '@/features/agent/hooks/use-changed-source';
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
import { connectionNotice } from './connection-notice';
import { NewChatButton } from './new-chat-button';
import { AgentPersonaControl } from './persona/agent-persona-control';
import { ScheduledTasksButton } from './scheduled/scheduled-tasks-button';
import { AgentTranscript } from './transcript/transcript';
import { AgentUpgradeOfferCard } from './upgrade-offer';
import { AgentReadinessNotice, AgentWorkStatus } from './work-status';
import type { AgentWorkspaceProps } from './workspace-lazy';

/** Draft first; request account or native runtime access only on Send. */
function ChatWorkspace({
  catalog,
  catalogPort,
  header = true,
  mathMode = false,
  persona: personaApi,
  scheduledTasks,
  tools: toolsApi,
  onBrowsePersonas,
  onOpenAgentSettings,
  onOpenAppSettings,
  onSignIn,
  onOpenExternal,
  onOpenSource,
  onReprocess,
  onReviewTurnChange,
  runtime,
  active,
}: Omit<AgentWorkspaceProps, 'catalog'> & {
  active: AgentSessionRuntime;
  catalog: { agents: Agent[]; error: boolean; loading: boolean; refresh(): void };
  catalogPort: AgentCatalogPort;
}) {
  const activeId = active.id;
  const [crewSaving, setCrewSaving] = useState(false);
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
      persona: session.persona,
      model: session.model,
      models: session.models,
      nativeSessionId: session.nativeSessionId,
      queuedPrompts: session.queuedPrompts,
      scope: session.scope,
      skill: session.skill,
      skillCatalog: session.skillCatalog,
      steers: session.steers,
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
  const runtimeUpdate = useAgentRuntimeUpdate(
    active,
    catalogPort,
    catalog.refresh,
    onOpenAgentSettings,
  );
  const modelRefresh = useAgentModelRefresh(active, catalog.refresh);
  const activeTurn = agentTurnIsActive(state.connection);
  const busy = agentSessionIsBusy(active.store.getState());
  const armedSkill = agentSkills(state.skillCatalog).find((skill) => skill.id === state.skill);
  const empty = state.transcript.length === 0;
  const persona = useAgentPersona(
    personaApi,
    state.persona,
    runtime.choosePersona,
    active.applyPersona,
  );
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
  const sourceFor = useChangedSource(runtime, state.scope);
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
  const followLatest = useStickToBottom(logRef, activeId);
  // Sending returns a reader who scrolled up to the end, where the message lands.
  const send = (text: string, options?: { queuedId?: string }) => {
    followLatest();
    access.send(text, options);
  };
  const steer = (text: string) => {
    followLatest();
    active.steer(text);
  };
  const focusBlockId = useAttentionFocus(runtime, activeId, logRef);
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
            {scheduledTasks && <ScheduledTasksButton runtime={runtime} />}
            <ChatHistoryPopover runtime={runtime} scope={state.scope} />
            <NewChatButton catalog={catalogPort} runtime={runtime} scope={state.scope} />
          </>
        }
      />
      {empty && <div aria-hidden className="min-h-0 grow basis-0" />}
      {/* Keep absolute labels inside the log's clipping, away from the composer. */}
      <div
        aria-busy={activeTurn}
        aria-live="polite"
        aria-label="Chat transcript"
        className={cn('relative min-h-0 overflow-y-auto', empty ? 'flex-initial' : 'flex-1')}
        ref={logRef}
        role="log"
      >
        <div
          className={cn(
            'mx-auto flex min-h-full w-full max-w-[46rem] flex-col gap-3',
            empty ? 'px-4 pt-8 pb-7 max-sm:px-3' : 'px-5 pt-4 pb-6 max-sm:px-4',
          )}
        >
          {empty && !connectionNotice(state.connection) && state.connection.kind !== 'restoring' ? (
            <h2 className="text-center text-ui-28 leading-none font-semibold tracking-[-0.03em] text-foreground max-sm:text-ui-24">
              What’s on your mind?
            </h2>
          ) : (
            <AgentTranscript
              activeTurn={activeTurn}
              blocks={state.transcript}
              focusBlockId={focusBlockId}
              key={activeId}
              modelRefresh={modelRefresh}
              mathMode={mathMode}
              onEditPrompt={composerShown ? editPrompt : undefined}
              onOpenExternal={onOpenExternal}
              onOpenSource={onOpenSource}
              onPermission={active.replyPermission}
              onRetry={active.retry}
              onSignIn={onOpenAgentSettings}
              onUpdateApp={onOpenAppSettings}
              onReviewTurnChange={onReviewTurnChange}
              pending={state.steers}
              runtimeUpdate={selectedAgent.updatable ? runtimeUpdate : undefined}
              sourceFor={sourceFor}
              transientFile={active.fileForTransient}
            />
          )}
        </div>
      </div>

      <AgentWorkStatus
        session={active}
        onOpenSettings={onOpenAgentSettings}
        onUpdateApp={onOpenAppSettings}
        onRefresh={catalog.refresh}
        runtimeUpdate={selectedAgent.updatable ? runtimeUpdate : undefined}
      />
      {composerShown && selectedAgent.updatable && selectedAgent.upgrade && (
        <AgentUpgradeOfferCard offer={selectedAgent.upgrade} runtimeUpdate={runtimeUpdate} />
      )}

      {composerShown && (
        <div className="relative shrink-0 px-4 pb-3 max-sm:px-3">
          <div className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-t from-surface-2 to-transparent" />
          <div className="@container relative mx-auto w-full max-w-[46rem]" ref={composerRef}>
            <AgentContextComposer
              onOpenSource={onOpenSource}
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
              onSend={send}
              onSteer={selectedAgent.abilities.steering ? steer : undefined}
              placeholder={armedSkill?.argumentHint ?? promptPlaceholder ?? 'Message your agent…'}
              placeholderIsPrompt={promptPlaceholder !== null}
              queue={state.queuedPrompts.map(({ context, id, text }) => ({
                files: context.flatMap((item) =>
                  item.kind === 'transient' ? (active.fileForTransient(item.path) ?? []) : [],
                ),
                id,
                text,
              }))}
              // Persona stays beside attachments. Provider, permissions and
              // model controls stay together when the Agent changes.
              leftSlot={
                <AgentPersonaControl disabled={busy} onBrowse={onBrowsePersonas} picker={persona} />
              }
              rightSlot={
                <>
                  <AgentProviderControl
                    activeAgent={selectedAgent}
                    startsNewChat={!agentCanChangeAgent(state)}
                    agents={
                      catalog.agents.some((agent) => agent.id === selectedAgent.id)
                        ? catalog.agents
                        : [selectedAgent, ...catalog.agents]
                    }
                    disabled={busy || runtimeUpdate.busy || preferencesUnavailable}
                    onAgentChange={(agent) => void runtime.chooseAgent(agent)}
                  />
                  {readyAgent && readyAgent.abilities.modes.length > 0 && (
                    <AgentPermissionMode
                      disabled={busy}
                      mode={state.accessMode}
                      modes={readyAgent.abilities.modes}
                      onChange={active.setAccessMode}
                    />
                  )}
                  {readyAgent && (
                    <AgentThinkingControl
                      activeAgent={readyAgent}
                      onEffortChange={active.setEffort}
                      onModelChange={active.setModel}
                      // Opening the control rereads the runtime list for a newly found release.
                      onRequestCatalog={() => {
                        active.start();
                        catalog.refresh();
                      }}
                      runtimeUpdate={
                        offersRuntimeUpdate(readyAgent, runtimeUpdate) ? runtimeUpdate : undefined
                      }
                      state={{ ...state, activeTurn: busy || preferencesUnavailable }}
                      tools={{
                        api: toolsApi,
                        chat: state.nativeSessionId ?? activeId,
                        onChanged: active.applyPersona,
                        onSaving: setCrewSaving,
                      }}
                    />
                  )}
                </>
              }
              sendable={
                !crewSaving &&
                !catalog.loading &&
                !catalog.error &&
                !runtimeUpdate.busy &&
                !runtimeUpdate.signIn &&
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
        needsSignIn={access.needsSignIn}
        open={access.open}
        working={access.working}
        startedAt={access.startedAt}
        preparation={access.preparation}
        failure={access.failure}
        onConfirm={() => {
          void access.confirm();
        }}
        onCancel={access.cancel}
        onOpenSignIn={onOpenExternal}
        onStopWaiting={access.stopWaiting}
      />
      <AgentReadinessNotice
        message={
          preferences.failure ??
          (catalog.error
            ? 'Agent runtime status is unavailable.'
            : catalog.loading
              ? 'Checking agents…'
              : null)
        }
        onRetry={
          preferences.failure
            ? () => {
                void runtime.loadPreferences();
              }
            : catalog.error
              ? catalog.refresh
              : undefined
        }
      />
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
  return <ChatWorkspace active={active} {...props} catalogPort={props.catalog} catalog={catalog} />;
}
