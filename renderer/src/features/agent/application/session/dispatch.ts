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
  contextPort: AgentContextPort;
  disposed(): boolean;
  environment(): AgentSessionEnvironment | null;
  ledger: AgentPromptLedger;
  signal: AbortSignal;
  /** Opens the transport for a draft that has just been given its first
   *  prompt; the held prompt goes out when the connection reports ready. */
  start(): void;
  state(): AgentSessionState;
  submit(prompt: PendingPrompt): boolean;
  /** Uploaded Files by temp path, so tiles can render what was sent. */
  transientFiles: Map<string, File>;
  transition(action: AgentSessionAction): void;
}

export interface AgentPromptDispatcher {
  send(text: string, options?: { queuedId?: string }): Promise<AgentSendResult>;
  attach(files: File[]): Promise<void>;
  cancel(): void;
}

export function createPromptDispatcher({
  contextPort,
  disposed,
  environment,
  ledger,
  signal,
  start,
  state,
  submit,
  transientFiles,
  transition,
}: AgentPromptDispatcherOptions): AgentPromptDispatcher {
  let sending = false;
  let generation = 0;

  const refuse = (message: string) => transition({ message, kind: 'set-context-issue' });

  /** Resolves every bound source to what the Agent should read. A source the
   *  server no longer has makes the whole send stale. */
  const resolveLines = async (
    context: readonly AgentContextItem[],
  ): Promise<ResolvedContextLine[] | 'stale'> => {
    const results = await Promise.allSettled(
      context.map(async (item): Promise<ResolvedContextLine> => {
        if (item.kind !== 'source') return { item, resolved: null };
        return { item, resolved: await contextPort.resolve(item.source, signal) };
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
      transition({ kind: 'delivery', value: 'preparing' });
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
          refuse('That file is no longer in this folder.');
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

    async attach(files) {
      if (disposed() || files.length === 0) return;
      let outcomes;
      try {
        outcomes = await contextPort.upload(files, signal);
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
