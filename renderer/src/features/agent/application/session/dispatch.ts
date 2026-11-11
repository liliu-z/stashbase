/** Getting one prompt out of the composer and onto the wire, and getting one
 *  attachment bound to the draft. Both cross an await — context resolution,
 *  an upload — so both capture the scope the work started under and refuse
 *  their own completion if the conversation has moved to another folder in
 *  the meantime. A stale completion is dropped, never applied to the folder
 *  the user is now looking at. */
import { agentFailure, failureKind } from '@/features/agent/application/failure-messages';
import { AgentContextError, type AgentContextPort } from '@/features/agent/application/ports';
import type {
  AgentPromptLedger,
  PendingPrompt,
} from '@/features/agent/application/session/prompts';
import {
  addContextItem,
  staleContext,
  validateContext,
  type AgentContextItem,
  type AgentContextReadiness,
  type AgentScopeListing,
} from '@/features/agent/domain/context';
import {
  renderPromptContext,
  type ResolvedContextLine,
} from '@/features/agent/domain/prompt-context';
import {
  agentCanSend,
  agentSessionIsBusy,
  agentSkills,
  agentTurnIsActive,
  type AgentSessionAction,
  type AgentSessionState,
} from '@/features/agent/domain/session';
import { isExternalSource } from '@/shared/domain/external-source';

export type AgentSendResult =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'busy' | 'disconnected' | 'stale' };

/** What the session can check bound context against without asking the
 *  server: the live listing and preparation state of its own folder. */
export interface AgentSessionEnvironment {
  listing: AgentScopeListing | null;
  versions?: Readonly<Record<string, number>> | undefined;
  readiness: Readonly<Record<string, AgentContextReadiness>>;
}

const NO_ENVIRONMENT: AgentSessionEnvironment = { listing: null, readiness: {} };

/** A running turn that is neither stopping nor uncertain can take a follow-up. */
const takesFollowUp = (state: AgentSessionState) =>
  agentTurnIsActive(state.connection) && state.delivery === 'idle';

/** A prompt still being prepared or connected starts the turn a follow-up
 *  sent meanwhile joins. */
const startsTurn = (state: AgentSessionState) =>
  !agentTurnIsActive(state.connection) && state.delivery === 'preparing';

const refuseContext = () =>
  Promise.reject(
    new AgentContextError('unavailable', 'File context is unavailable in this session.'),
  );

/** The port a session without file context runs on: every call is refused on
 *  the same ladder a real one would fail on. */
export function unavailableContextPort(): AgentContextPort {
  return { resolve: refuseContext, upload: refuseContext };
}

export interface AgentPromptDispatcherOptions {
  telemetryTurnId?(): string | undefined;
  contextPort: AgentContextPort;
  disposed(): boolean;
  /** Queues a follow-up the running turn cannot take, from the draft. */
  enqueue(text: string): void;
  environment(): AgentSessionEnvironment | null;
  ledger: AgentPromptLedger;
  signal: AbortSignal;
  /** Opens the transport for a draft that has just been given its first
   *  prompt; the held prompt goes out when the connection reports ready. */
  start(): void;
  state(): AgentSessionState;
  submit(prompt: PendingPrompt): boolean;
  /** Puts a follow-up for the running turn on the wire; false when refused. */
  sendSteer(id: string, text: string): boolean;
  /** Uploaded Files by temp path, so tiles can render what was sent. */
  transientFiles: Map<string, File>;
  transition(action: AgentSessionAction): void;
}

export interface AgentPromptDispatcher {
  send(text: string, options?: { queuedId?: string }): Promise<AgentSendResult>;
  /** Hands the draft to the running turn, or queues it when that turn
   *  cannot take it: a skill or files without text only start a turn, and so
   *  does every prompt sent while the turn is stopping or its outcome is
   *  unknown. */
  steer(text: string): Promise<void>;
  /** Sends the follow-ups held for a turn that has now started, or returns
   *  them to the queue when the prompt that was to start it did not. */
  settleHeld(): void;
  attach(files: File[]): Promise<void>;
  cancel(): void;
}

export function createPromptDispatcher({
  telemetryTurnId,
  contextPort,
  disposed,
  enqueue,
  environment,
  ledger,
  signal,
  sendSteer,
  start,
  state,
  submit,
  transientFiles,
  transition,
}: AgentPromptDispatcherOptions): AgentPromptDispatcher {
  let sending = false;
  let generation = 0;
  /** Follow-ups waiting for the turn being started, as their wire text. */
  const held = new Map<string, string>();

  const refuse = (message: string) => transition({ message, kind: 'set-context-issue' });

  /** Resolves every bound source to what the Agent should read. A source the
   *  server no longer has makes the whole send stale. */
  const resolveLines = async (
    context: readonly AgentContextItem[],
  ): Promise<ResolvedContextLine[] | 'stale'> => {
    const results = await Promise.allSettled(
      context.map(async (item): Promise<ResolvedContextLine> => {
        // An external file has no project identity to resolve; the Agent
        // reads it by its own path.
        if (item.kind !== 'source' || isExternalSource(item.source))
          return { item, resolved: null };
        return {
          item,
          resolved: await contextPort.resolve(item.source, signal, telemetryTurnId?.()),
        };
      }),
    );
    const lines: ResolvedContextLine[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        lines.push(result.value);
        continue;
      }
      if (failureKind(result.reason) === 'not-found') return 'stale';
      const item = context[index];
      if (item) lines.push({ item, resolved: null });
    }
    return lines;
  };

  return {
    cancel() {
      generation += 1;
      sending = false;
      held.clear();
      ledger.takeHeld();
    },
    async send(text, options = {}) {
      let opening = state();
      if (disposed() || agentSessionIsBusy(opening) || opening.delivery === 'unknown' || sending) {
        return { ok: false, reason: 'busy' };
      }
      const prompt = text.trim();
      const queued =
        options.queuedId === undefined
          ? undefined
          : opening.queuedPrompts.find((item) => item.id === options.queuedId);
      if (options.queuedId !== undefined && !queued) return { ok: false, reason: 'empty' };
      const context = queued?.context ?? opening.context;
      const skillId = queued ? queued.skill : opening.skill;
      const skill = agentSkills(opening.skillCatalog).find((entry) => entry.id === skillId) ?? null;
      if (!prompt && context.length === 0 && !skill) return { ok: false, reason: 'empty' };
      if (!agentCanSend(opening.connection)) return { ok: false, reason: 'disconnected' };
      // The scope this send is checked and resolved against, captured before
      // the first await instead of read again once the work has finished.
      const startScope = opening.scope;
      const stale = staleContext(
        validateContext(context, {
          ...(environment() ?? NO_ENVIRONMENT),
          scope: startScope,
          hasUpload: (path) => transientFiles.has(path),
        }),
      );
      if (stale.length > 0) {
        refuse(stale[0]?.reason ?? 'This file is no longer available.');
        return { ok: false, reason: 'stale' };
      }
      if (skillId && !skill) {
        refuse('This skill is unavailable. Remove it or select another skill before sending.');
        return { ok: false, reason: 'stale' };
      }
      if (!queued && !opening.draft && text.trim()) {
        transition({ kind: 'set-draft', draft: text });
        opening = state();
      }
      const captured = generation;
      const draft = queued
        ? undefined
        : { text: opening.draft, context: opening.context, skill: opening.skill };
      sending = true;
      transition({
        kind: 'delivery',
        value: 'preparing',
        prompt: {
          id: crypto.randomUUID(),
          text: skill ? `/${skill.label} ${prompt}`.trimEnd() : prompt,
          context,
          skill: skillId,
        },
      });
      try {
        const lines = await resolveLines(context);
        if (disposed() || captured !== generation) return { ok: false, reason: 'disconnected' };
        const current = state();
        const currentStale = staleContext(
          validateContext(context, {
            ...(environment() ?? NO_ENVIRONMENT),
            scope: current.scope,
            hasUpload: (path) => transientFiles.has(path),
          }),
        );
        if (currentStale.length) {
          refuse(currentStale[0]?.reason ?? 'Review the request context before sending.');
          return { ok: false, reason: 'stale' };
        }
        if (lines === 'stale') {
          refuse('That file is no longer in this project.');
          return { ok: false, reason: 'stale' };
        }
        if (agentTurnIsActive(current.connection)) return { ok: false, reason: 'busy' };
        const pending: PendingPrompt = {
          context,
          display: prompt,
          skill,
          wire: renderPromptContext(prompt, lines),
          ...(draft ? { draft } : {}),
          ...(queued ? { queuedId: queued.id } : {}),
        };
        if (current.connection.kind === 'draft') {
          ledger.hold(pending);
          start();
          return { ok: true };
        }
        if (current.connection.kind !== 'live') return { ok: false, reason: 'disconnected' };
        const sent = submit(pending);
        if (!sent)
          refuse('The request was not sent. Your input was kept; reconnect and try again.');
        return sent ? { ok: true } : { ok: false, reason: 'disconnected' };
      } finally {
        if (captured === generation) {
          sending = false;
          if (state().delivery === 'preparing' && state().connection.kind !== 'connecting')
            transition({ kind: 'delivery', value: 'idle' });
        }
      }
    },

    async steer(text) {
      const opening = state();
      const prompt = text.trim();
      if (disposed()) return;
      // Files alone are not a message to read mid-turn; they start one.
      if (!prompt || !(takesFollowUp(opening) || startsTurn(opening)) || opening.skill) {
        enqueue(prompt);
        return;
      }
      const steer = {
        context: opening.context,
        id: crypto.randomUUID(),
        skill: null,
        text: prompt,
      };
      const stale = staleContext(
        validateContext(steer.context, {
          ...(environment() ?? NO_ENVIRONMENT),
          scope: opening.scope,
          hasUpload: (path) => transientFiles.has(path),
        }),
      );
      // The queue holds what cannot go now and refuses it there, with the reason.
      if (stale.length > 0) {
        enqueue(prompt);
        return;
      }
      transition({ kind: 'steer-sent', prompt: steer });
      const lines = await resolveLines(steer.context);
      if (disposed()) return;
      const current = state();
      // A turn that ended meanwhile already sent this follow-up back to the queue.
      if (!current.steers.some((item) => item.id === steer.id)) return;
      if (lines === 'stale') {
        transition({ id: steer.id, kind: 'steer-returned' });
        return;
      }
      const wire = renderPromptContext(prompt, lines);
      if (startsTurn(current)) held.set(steer.id, wire);
      else if (!takesFollowUp(current) || !sendSteer(steer.id, wire))
        transition({ id: steer.id, kind: 'steer-returned' });
    },

    settleHeld() {
      if (held.size === 0 || startsTurn(state())) return;
      for (const [id, wire] of held) {
        held.delete(id);
        if (!state().steers.some((item) => item.id === id)) continue;
        if (!takesFollowUp(state()) || !sendSteer(id, wire))
          transition({ id, kind: 'steer-returned' });
      }
    },

    async attach(files) {
      if (disposed() || files.length === 0) return;
      let outcomes;
      try {
        outcomes = await contextPort.upload(files, signal, state().scope.path);
      } catch (error) {
        if (disposed()) return;
        refuse(agentFailure(error).message);
        return;
      }
      if (disposed()) return;
      let failed = 0;
      let context = state().context;
      outcomes.forEach((outcome, index) => {
        if (!outcome.path) {
          failed += 1;
          return;
        }
        const file = files[index];
        if (file) transientFiles.set(outcome.path, file);
        context = addContextItem(context, {
          kind: 'transient',
          name: outcome.name,
          path: outcome.path,
        });
      });
      transition({ context, kind: 'set-context' });
      if (failed > 0) refuse(`${failed} ${failed === 1 ? 'file' : 'files'} could not be attached.`);
    },
  };
}
