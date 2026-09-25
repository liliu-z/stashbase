/** Session controls own cancellation, queue advancement, and guarded draft reuse. */
import { modelChoice } from '@/features/agent/domain/model-choice';
import {
  agentSessionIsBusy,
  agentCanChangeAgent,
  agentTurnIsActive,
  type AgentSessionState,
  type AgentSessionAction,
} from '@/features/agent/domain/session';
import type { AgentId } from '@/features/agent/domain/session';

import type { AgentTransport } from './connection';
import type { AgentPromptDispatcher } from './dispatch';
import { planQueue, type AgentPromptLedger } from './prompts';
/** Request controls own cancellation and queue advancement independently of the mounted composer. */
import type { AgentSessionRuntime } from './runtime-contract';

export function createSessionControls({
  state,
  transition,
  disposed,
  dispatcher,
  transport,
  session,
  resetStart,
  isStarted,
  onInterrupt,
  ledger,
  transientFiles,
}: {
  state(): AgentSessionState;
  transition(action: AgentSessionAction): void;
  disposed(): boolean;
  dispatcher: AgentPromptDispatcher;
  transport: AgentTransport;
  session(): AgentSessionRuntime;
  resetStart(): void;
  isStarted(): boolean;
  onInterrupt(): void;
  ledger: AgentPromptLedger;
  transientFiles: Map<string, File>;
}) {
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  return {
    replyPermission(
      ...[toolUseId, permissionId, allow, decision]: Parameters<
        AgentSessionRuntime['replyPermission']
      >
    ) {
      if (disposed()) return false;
      const tool = state().transcript.find(
        (block) => block.kind === 'tool' && block.id === toolUseId,
      );
      if (
        tool?.kind !== 'tool' ||
        tool.permissionId !== permissionId ||
        tool.status !== 'awaiting'
      ) {
        return false;
      }
      const answers = decision?.answers ?? null;
      const sent = transport.send({
        allow,
        always: decision?.always ?? null,
        answers,
        id: permissionId,
        kind: 'reply-permission',
      });
      if (sent) {
        transition({ allow, toolUseId, kind: 'reply-permission', ...(answers ? { answers } : {}) });
      }
      return sent;
    },
    setAccessMode(mode: Parameters<AgentSessionRuntime['setAccessMode']>[0]) {
      if (disposed() || agentSessionIsBusy(state()) || state().accessMode === mode) return;
      transition({ mode, kind: 'set-access-mode' });
      transport.applyAccessMode(mode);
    },
    setEffort(effort: Parameters<AgentSessionRuntime['setEffort']>[0]) {
      const current = state();
      if (disposed() || agentSessionIsBusy(current) || current.effort === effort) return;
      if (effort && !modelChoice(current).efforts.includes(effort)) return;
      transition({ effort, kind: 'set-effort' });
      if (isStarted()) transport.open({ resume: current.nativeSessionId ?? undefined });
    },
    requestComposerFocus(requested = true) {
      if (disposed() || state().composerFocusRequested === requested) return;
      transition({ kind: 'request-composer-focus', requested });
    },
    applyPersona() {
      const current = state();
      if (disposed() || agentSessionIsBusy(current) || !isStarted()) return;
      transport.open({ resume: current.nativeSessionId ?? undefined });
    },
    setModel(model: Parameters<AgentSessionRuntime['setModel']>[0]) {
      const current = state();
      if (
        disposed() ||
        agentSessionIsBusy(current) ||
        current.model === model ||
        (model !== null && !current.models.some((entry) => entry.id === model))
      ) {
        return;
      }
      const nextModel = current.models.find((entry) => entry.id === model);
      const nextEffort =
        current.effort && !nextModel?.supportedEfforts?.includes(current.effort)
          ? null
          : current.effort;
      transition({ model, kind: 'set-model' });
      if (nextEffort !== current.effort) transition({ effort: nextEffort, kind: 'set-effort' });
      transport.applyModel(model);
    },
    setQueue(queue: Parameters<AgentSessionRuntime['setQueue']>[0]) {
      if (disposed()) return;
      const plan = planQueue(state(), queue);
      transition({ queue: plan.queue, kind: 'set-queue' });
      if (plan.draftTaken) {
        transition({ context: [], kind: 'set-context' });
        transition({ skill: null, kind: 'set-skill' });
      }
    },
    dispose() {
      clearTimeout(stopTimer);
    },
    interrupt() {
      if (disposed() || !agentSessionIsBusy(state()) || state().delivery === 'stopping')
        return false;
      transition({ kind: 'pause-queue', paused: true });
      if (!agentTurnIsActive(state().connection)) {
        dispatcher.cancel();
        transport.invalidate();
        transport.close();
        resetStart();
        transition({ kind: 'close', message: null });
        if (!state().nativeSessionId) transition({ kind: 'reset-draft-connection' });
        transition({ kind: 'delivery', value: 'stopped' });
        return true;
      }
      for (const block of state().transcript) {
        if (block.kind === 'tool' && block.status === 'awaiting' && block.permissionId) {
          session().replyPermission(block.id, block.permissionId, false);
        }
      }
      const sent = transport.send({ kind: 'interrupt' });
      transition({ kind: 'delivery', value: sent ? 'stopping' : 'unknown' });
      if (sent) {
        onInterrupt();
        stopTimer = setTimeout(() => {
          if (!disposed() && state().delivery === 'stopping')
            transition({ kind: 'delivery', value: 'unknown' });
        }, 15_000);
      }
      return sent;
    },
    continueQueue() {
      const current = state();
      const first = current.queuedPrompts[0];
      if (
        disposed() ||
        !first ||
        agentSessionIsBusy(current) ||
        current.delivery === 'unknown' ||
        current.connection.kind !== 'live'
      )
        return Promise.resolve(false);
      transition({ kind: 'pause-queue', paused: false });
      return session()
        .sendPrompt(first.text, { queuedId: first.id })
        .then((result) => {
          if (!result.ok) transition({ kind: 'pause-queue', paused: true });
          return result.ok;
        });
    },
    confirmOutcome() {
      if (state().delivery === 'unknown' && !agentTurnIsActive(state().connection))
        transition({ kind: 'delivery', value: 'stopped' });
    },
    changeAgent(agent: AgentId) {
      if (disposed() || !agentCanChangeAgent(state())) return false;
      transport.invalidate();
      transport.close();
      resetStart();
      transition({ kind: 'select-agent', agent });
      transition({ kind: 'reset-draft-connection' });
      return true;
    },
    editPrompt(blockId: string) {
      const current = state();
      if (disposed() || agentSessionIsBusy(current) || current.delivery === 'unknown') return false;
      const prompt = current.transcript.find(
        (block) => block.kind === 'user' && block.id === blockId,
      );
      if (prompt?.kind !== 'user') return false;
      if (current.draft || current.context.length || current.skill) {
        transition({
          kind: 'set-context-issue',
          message: 'Keep or send your current draft before reusing a message.',
        });
        return false;
      }
      const turn = ledger.turnFor(blockId);
      transition({ draft: turn?.display ?? prompt.text, kind: 'set-draft' });
      const context = [...(prompt.context ?? [])];
      for (const attachment of prompt.attachments ?? []) {
        if (!context.some((item) => item.kind === 'transient' && item.path === attachment.path))
          context.push({ ...attachment, kind: 'transient' });
      }
      transition({ context, kind: 'set-context' });
      transition({ skill: turn?.skill ?? null, kind: 'set-skill' });
      if (
        prompt.attachments?.length ||
        prompt.context?.some((item) => item.kind === 'transient' && !transientFiles.has(item.path))
      ) {
        transition({
          kind: 'set-context-issue',
          message: 'Historical attachments are unavailable. Reattach them before sending.',
        });
      }
      return true;
    },
    editQueued(id: string) {
      const current = state();
      const prompt = current.queuedPrompts.find((item) => item.id === id);
      if (!prompt || current.delivery === 'preparing') return false;
      if (current.draft || current.context.length || current.skill) {
        transition({
          kind: 'set-context-issue',
          message: 'Keep or send your current draft before editing a queued message.',
        });
        return false;
      }
      transition({ kind: 'set-draft', draft: prompt.text });
      transition({ kind: 'set-context', context: prompt.context });
      transition({ kind: 'set-skill', skill: prompt.skill });
      transition({
        kind: 'set-queue',
        queue: current.queuedPrompts.filter((item) => item.id !== id),
      });
      return true;
    },
  };
}
