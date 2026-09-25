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
  createPromptLedger,
  type PendingPrompt,
} from '@/features/agent/application/session/prompts';
import type {
  AgentSessionRuntime,
  AgentSessionRuntimeOptions,
} from '@/features/agent/application/session/runtime-contract';
import { createAgentUsage } from '@/features/agent/application/session/usage';
import {
  addContextItem,
  removeContextItem,
  validateContext,
  staleContext,
} from '@/features/agent/domain/context';
import {
  agentScopesEqual,
  agentSessionIsBusy,
  agentSessionIsBlank,
  agentTurnFailureIsRetryable,
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
    if (action.kind === 'settle-turn') {
      controls.dispose();
      if (state().delivery === 'completed' && !state().queuePaused) {
        queueMicrotask(() => {
          void runtime.continueQueue();
        });
      }
    }
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
    const titleHint = current.transcript.some((block) => block.kind === 'user')
      ? undefined
      : current.titleEdited
        ? current.title
        : (prompt.display || (prompt.skill ? `/${prompt.skill.label}` : 'Attached files'))
            .replace(/\s+/g, ' ')
            .slice(0, 80);
    const sent = transport.send({
      kind: 'prompt',
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
    disposed: () => disposed,
    onEvent: (event) => applyAgentSessionEvent(eventContext, event),
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
    disposed: () => disposed,
    environment,
    ledger,
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
    retry(errorBlockId) {
      const current = state();
      if (disposed || agentSessionIsBusy(current) || current.delivery === 'unknown') return false;
      const failure = current.transcript.find(
        (block) => block.kind === 'error' && block.id === errorBlockId,
      );
      if (failure?.kind !== 'error' || failure.retryablePrompt === undefined) return false;
      if (current.connection.kind !== 'live') return false;
      if (!agentTurnFailureIsRetryable(failure.failure)) return false;
      usage.start();
      const turn = ledger.turnFor(errorBlockId);
      const stale = staleContext(
        validateContext(turn?.context ?? [], {
          listing: null,
          readiness: {},
          ...environment(),
          scope: current.scope,
          hasUpload: (path) => transientFiles.has(path),
        }),
      );
      if (stale.length) {
        transition({
          kind: 'set-context-issue',
          message: stale[0]?.reason ?? 'Review the request context before retrying.',
        });
        return false;
      }
      const skill = turn?.skill ?? null;
      const sent = transport.send({
        kind: 'prompt',
        skill,
        text: failure.retryablePrompt,
      });
      if (!sent) usage.finish('blocked');
      if (sent) {
        transition({ kind: 'delivery', value: 'idle' });
        transition({ id: errorBlockId, kind: 'settle-error' });
        transition({ kind: 'turn-started' });
      }
      return sent;
    },
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
    fileForTransient(path) {
      return transientFiles.get(path);
    },
    attachFiles(files) {
      return dispatcher.attach(files);
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
    applyPersona: controls.applyPersona,
    setEffort(effort) {
      const previous = state().effort;
      controls.setEffort(effort);
      const current = state();
      if (current.effort !== previous)
        onEffortChange?.(current.scope, current.agent, current.effort);
    },
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
      transition({ activeModel: null, fallback: null, kind: 'models', models: [...models] });
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
            effort: replay.effort,
            lastModified: entry.lastModified,
            nativeSessionId: entry.id,
            transcript: replay.transcript,
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
