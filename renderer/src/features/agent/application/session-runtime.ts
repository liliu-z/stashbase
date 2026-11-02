/** One conversation owns prompt delivery, native history, and retained work. */
import { createStore } from 'zustand/vanilla';

import { agentFailure, RESTORE_FAILED } from '@/features/agent/application/failure-messages';
import {
  createAgentTransport,
  createDefaultScheduler,
} from '@/features/agent/application/session/connection';
import { createSessionControls } from '@/features/agent/application/session/controls';
import {
  createPromptDispatcher,
  unavailableContextPort,
} from '@/features/agent/application/session/dispatch';
import {
  applyAgentSessionEvent,
  type AgentEventContext,
} from '@/features/agent/application/session/events';
import {
  filesChanged,
  folderMayHaveChanged,
  type AgentFilesChanged,
} from '@/features/agent/application/session/files-changed';
import {
  attachmentFields,
  createPromptLedger,
  promptTitleHint,
  queueWith,
  type PendingPrompt,
} from '@/features/agent/application/session/prompts';
import { createSessionRetry } from '@/features/agent/application/session/retry';
import type {
  AgentSessionRuntime,
  AgentSessionRuntimeOptions,
} from '@/features/agent/application/session/runtime-contract';
import { createAgentUsage } from '@/features/agent/application/session/usage';
import { addContextItem, removeContextItem } from '@/features/agent/domain/context';
import {
  agentScopesEqual,
  agentSessionIsBlank,
  agentTurnIsActive,
  createAgentSessionState,
  transitionAgentSession,
  type AgentSessionState,
} from '@/features/agent/domain/session';
import { isFeatureError } from '@/shared/domain/feature-error';
import { createScopeGuard } from '@/shared/runtime/scope-guard';

export type { AgentFilesChanged };
export type { AgentSessionRuntime, AgentSessionRuntimeOptions } from './session/runtime-contract';

export function createAgentSessionRuntime({
  agent,
  autostart = true,
  context: contextPort = unavailableContextPort(),
  environment = () => null,
  id,
  onFilesChanged,
  onEffortChange,
  onModelChange,
  recordUsage,
  port,
  scheduler = createDefaultScheduler(),
  scope,
  title,
}: AgentSessionRuntimeOptions): AgentSessionRuntime {
  const usage = createAgentUsage(() => state().agent, recordUsage);
  const controller = new AbortController();
  const store = createStore<AgentSessionState>(() =>
    createAgentSessionState({ agent, id, scope, title }),
  );
  const ledger = createPromptLedger();
  const transientFiles = new Map<string, File>();
  let disposed = false;
  let started = false;
  let blockSequence = 0;
  let restoreEntry: Parameters<AgentSessionRuntime['restore']>[0] | null = null;

  const state = () => store.getState();
  const { accept, capture, retireOperations } = createScopeGuard({
    disposed: () => disposed,
    sameScope: agentScopesEqual,
    scope: () => state().scope,
  });
  const nextBlockId = (kind: string) => `${id}-${kind}-${++blockSequence}`;
  const transition = (action: Parameters<typeof transitionAgentSession>[1]) => {
    usage.action(action);
    store.setState((current) => transitionAgentSession(current, action), true);
    if (action.kind === 'fail' || action.kind === 'close' || action.kind === 'schedule-reconnect')
      ledger.takeHeld();
    if (action.kind === 'settle-turn') controls.dispose();
    if (action.kind === 'submit-prompt' || action.kind === 'delivery') dispatcher.settleHeld();
    // A follow-up the runtime handed back after its turn ended goes next too.
    if (action.kind === 'settle-turn' || action.kind === 'steer-returned') controls.advanceQueue();
  };

  const notifyFilesChanged = (changed: string[]) => {
    if (!onFilesChanged) return;
    const change = filesChanged(state().scope, changed);
    if (change) onFilesChanged(change);
  };
  const notifyFolderMayHaveChanged = () => onFilesChanged?.(folderMayHaveChanged(state().scope));

  const submit = (prompt: PendingPrompt): boolean => {
    const current = state();
    if (
      prompt.queuedId &&
      !current.queuedPrompts.some(
        (item) =>
          item.id === prompt.queuedId &&
          item.text.trim() === prompt.display &&
          item.context === prompt.context,
      )
    )
      return false;
    const titleHint = promptTitleHint(current, prompt);
    const sent = transport.send({
      kind: 'prompt',
      ...usage.correlation(),
      ...attachmentFields(current.agent, prompt.context),
      skill: prompt.skill?.id ?? null,
      text: prompt.wire,
      ...(titleHint ? { titleHint } : {}),
    });
    if (!sent) return false;
    const blockId = nextBlockId('user');
    ledger.recordTurn(blockId, {
      display: prompt.display,
      context: prompt.context,
      skill: prompt.skill?.id ?? null,
      wire: prompt.wire,
    });
    transition({
      at: Date.now(),
      clearDraft: prompt.draft
        ? state().draft === prompt.draft.text &&
          state().context === prompt.draft.context &&
          state().skill === prompt.draft.skill
        : false,
      ...(titleHint ? { titleHint } : {}),
      context: prompt.context,
      id: blockId,
      text: prompt.skill ? `/${prompt.skill.label} ${prompt.display}`.trimEnd() : prompt.display,
      kind: 'submit-prompt',
    });
    if (prompt.queuedId)
      transition({
        kind: 'set-queue',
        queue: state().queuedPrompts.filter((item) => item.id !== prompt.queuedId),
      });
    return true;
  };

  const transport = createAgentTransport({
    telemetryTurnId: () => usage.correlation().telemetryTurnId,
    disposed: () => disposed,
    onEvent(event) {
      applyAgentSessionEvent(eventContext, event);
    },
    port,
    scheduler,
    signal: controller.signal,
    state,
    transition,
  });

  const eventContext: AgentEventContext = {
    ledger,
    nextBlockId,
    notifyFilesChanged,
    notifyFolderMayHaveChanged,
    state,
    submit,
    transition,
    transport,
  };

  const dispatcher = createPromptDispatcher({
    contextPort,
    telemetryTurnId: () => usage.correlation().telemetryTurnId,
    disposed: () => disposed,
    enqueue: (text) => runtime.setQueue(queueWith(state(), text)),
    environment,
    ledger,
    sendSteer: (steerId, text) => transport.send({ id: steerId, kind: 'steer', text }),
    signal: controller.signal,
    start: () => runtime.start(),
    state,
    submit,
    transientFiles,
    transition,
  });

  const controls = createSessionControls({
    state,
    transition,
    disposed: () => disposed,
    dispatcher,
    transport,
    session: () => runtime,
    isStarted: () => started,
    resetStart: () => {
      started = false;
    },
    onInterrupt: () => usage.interrupt(),
    onEffortChange,
    onModelChange,
    ledger,
    transientFiles,
  });

  const runtime: AgentSessionRuntime = {
    id,
    signal: controller.signal,
    store,
    accept,
    capture,
    isBlank: () => agentSessionIsBlank(state()),
    interrupt: controls.interrupt,
    continueQueue: controls.continueQueue,
    confirmOutcome: controls.confirmOutcome,
    changeAgent: controls.changeAgent,
    editQueued: controls.editQueued,
    replyPermission: controls.replyPermission,
    rename(nextTitle) {
      if (!disposed) transition({ title: nextTitle, kind: 'rename' });
    },
    reconnect() {
      if (disposed || state().connection.kind === 'retired') return;
      if (restoreEntry) {
        void runtime.restore(restoreEntry);
        return;
      }
      started = true;
      transport.open({ attempt: 0, resume: state().nativeSessionId ?? undefined });
    },
    retry: createSessionRetry({
      state,
      disposed: () => disposed,
      usage,
      ledger,
      environment,
      transientFiles,
      transport,
      transition,
    }),
    editPrompt: controls.editPrompt,
    addContext(item) {
      if (disposed) return;
      transition({ context: addContextItem(state().context, item), kind: 'set-context' });
    },
    removeContext(key) {
      if (disposed) return;
      transition({ context: removeContextItem(state().context, key), kind: 'set-context' });
    },
    requestComposerFocus: controls.requestComposerFocus,
    fileForTransient: (path) => transientFiles.get(path),
    attachFiles: dispatcher.attach,
    steer(text) {
      void dispatcher.steer(text);
    },
    async sendPrompt(text = state().draft, options = {}) {
      if (disposed || agentTurnIsActive(state().connection)) return dispatcher.send(text, options);
      if (!text.trim() && !state().context.length && !state().skill)
        return dispatcher.send(text, options);
      usage.start();
      try {
        const result = await dispatcher.send(text, options);
        if (!result.ok && result.reason !== 'busy') usage.finish('blocked');
        return result;
      } catch (error) {
        usage.finish('failed');
        throw error;
      }
    },
    setAccessMode: controls.setAccessMode,
    ...controls.persona,
    setEffort: controls.setEffort,
    setModel: controls.setModel,
    setSkill(skill) {
      if (disposed || state().skill === skill) return;
      transition({ skill, kind: 'set-skill' });
    },
    refreshSkills() {
      if (disposed || state().connection.kind !== 'live') return;
      transport.send({ kind: 'refresh-skills' });
    },
    seedModels(models) {
      const current = state();
      if (disposed || current.connection.kind !== 'draft') return;
      if (JSON.stringify(current.models) === JSON.stringify(models)) return;
      // A provisional catalog populates the picker without erasing pending choices.
      store.setState({ models: [...models] });
    },
    setDraft(draft) {
      if (!disposed) transition({ draft, kind: 'set-draft' });
    },
    setQueue: controls.setQueue,
    async restore(entry, connectWhenReady = true) {
      if (disposed) return false;
      retireOperations();
      const capturedScope = capture();
      transport.close();
      restoreEntry = entry;
      transition({ title: entry.title, kind: 'begin-restore' });
      store.setState({ nativeSessionId: entry.id });
      try {
        const replay = await port.replay(entry, controller.signal);
        return accept(capturedScope, () => {
          restoreEntry = null;
          transition({
            ...replay,
            lastModified: entry.lastModified,
            nativeSessionId: entry.id,
            kind: 'restore',
          });
          if (connectWhenReady) {
            started = true;
            transport.open({ attempt: 0, resume: entry.id });
          } else transition({ message: null, kind: 'close' });
        });
      } catch (cause) {
        const message = isFeatureError(cause) ? agentFailure(cause).message : RESTORE_FAILED;
        accept(capturedScope, () => transition({ message, kind: 'fail' }));
        return false;
      }
    },
    retire(folderPath) {
      if (disposed) return;
      const current = state();
      if (current.scope.kind !== 'folder' || current.scope.path !== folderPath) return;
      retireOperations();
      controls.dispose();
      dispatcher.cancel();
      transport.invalidate();
      transport.close();
      transition({ kind: 'retire' });
    },
    start() {
      if (disposed || started) return;
      started = true;
      transport.open({ resume: state().nativeSessionId ?? undefined });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      retireOperations();
      transport.invalidate();
      controls.dispose();
      dispatcher.cancel();
      transientFiles.clear();
      controller.abort();
      transport.close();
      transition({ kind: 'dispose' });
    },
  };
  if (autostart) runtime.start();
  return runtime;
}
