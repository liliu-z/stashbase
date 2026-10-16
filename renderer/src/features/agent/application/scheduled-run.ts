/**
 * Starting one scheduled run's chat in this window.
 *
 * A run is the reader opening a new chat in the project, writing the request,
 * mentioning the files it names, and pressing Send. It goes through the same
 * session and the same send path, so the Agent, model, permission mode,
 * approvals and questions behave exactly as in a chat the reader started.
 * What differs is that the chat opens without taking the window, and that its
 * title is the run's own.
 *
 * Nothing here can ask the reader anything. A runtime that needs sign-in or
 * setup is a failed run with the reason beside the task; Send's access
 * prompt is never opened on a reader who is not there. Once the request is
 * accepted the run is sent: an approval or a question the turn then raises
 * waits in its chat, which the chat list shows.
 */
import type { StoreApi } from 'zustand/vanilla';

import { honoredAccessMode } from '@/features/agent/domain/access';
import type { Agent } from '@/features/agent/domain/agent-catalog';
import { agentLabel } from '@/features/agent/domain/agent-catalog';
import {
  runSummary,
  scheduledRunPrompt,
  type ScheduledRunOutcome,
  type ScheduledRunRequest,
  type ScheduledTurnOutcome,
} from '@/features/agent/domain/scheduled-tasks';
import {
  agentTurnIsActive,
  type AgentId,
  type AgentScope,
  type AgentSessionState,
} from '@/features/agent/domain/session';

import type { AgentCatalogPort } from './ports';
import type { AgentSessionRuntime } from './session-runtime';
import type { AgentSendResult } from './session/dispatch';
import type { AgentWorkspaceRuntime } from './workspace-runtime';

/** Inside main's own three-minute deadline, so this window reports first. */
const START_DEADLINE_MS = 150_000;
/** How long the window follows a run's first turn: long enough for an
 *  approval to wait for a reader who is away for the day. */
const FIRST_TURN_DEADLINE_MS = 24 * 60 * 60_000;
/** How long a window that just opened may take to settle its project. */
const SETTLE_DEADLINE_MS = 20_000;

const failed = (reason: string): ScheduledRunOutcome => ({ reason, status: 'failed' });

/** Resolves with the first value `read` finds in the store, or undefined when
 *  the deadline or the signal comes first. */
function when<S, T>(
  store: StoreApi<S>,
  read: (state: S) => T | undefined,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T | undefined> {
  const now = read(store.getState());
  if (now !== undefined || signal.aborted) return Promise.resolve(now);
  return new Promise((resolve) => {
    const finish = (value: T | undefined) => {
      unsubscribe();
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      resolve(value);
    };
    const aborted = () => finish(undefined);
    const unsubscribe = store.subscribe((state) => {
      const value = read(state);
      if (value !== undefined) finish(value);
    });
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

function notReady(agent: Agent | undefined, id: AgentId): string {
  const label = agent?.label ?? agentLabel(id);
  return agent?.needsSignIn
    ? `Sign in to use ${label}, then run this task again.`
    : `${label} is not ready on this computer. Set it up in Chat, then run this task again.`;
}

function refusal(result: Exclude<AgentSendResult, { ok: true }>, state: AgentSessionState): string {
  if (result.reason === 'stale') {
    return state.contextIssue ?? 'A file this task names is no longer in the project.';
  }
  if (result.reason === 'empty') return 'This task has nothing to send.';
  return 'The chat could not send its request.';
}

/** Where the started chat stands: sent once its request is in the transcript
 *  and the runtime named the conversation, failed once its connection did. */
function startOutcome(state: AgentSessionState): ScheduledRunOutcome | null {
  const { connection } = state;
  if (connection.kind === 'failed') return failed(connection.message);
  if (connection.kind === 'closed')
    return failed(connection.message ?? 'The Agent stopped before the request was sent.');
  if (connection.kind === 'retired' || connection.kind === 'disposed') {
    return failed('The chat closed before the request was sent.');
  }
  if (state.delivery === 'failed') return failed('The Agent could not take the request.');
  const submitted = state.transcript.some((block) => block.kind === 'user');
  return submitted && state.nativeSessionId
    ? { agent: state.agent, sessionId: state.nativeSessionId, status: 'sent' }
    : null;
}

/** A chat that never sent anything holds nothing worth keeping; the reason
 *  is beside the task. One that reached its runtime stays where it is. */
function discardUnsent(runtime: AgentWorkspaceRuntime, session: AgentSessionRuntime) {
  const state = session.store.getState();
  if (state.nativeSessionId === null && !state.transcript.some((block) => block.kind === 'user')) {
    runtime.close(session.id);
  }
}

export async function startScheduledRun(
  runtime: AgentWorkspaceRuntime,
  catalog: AgentCatalogPort,
  request: ScheduledRunRequest,
  signal: AbortSignal,
  /** Records how the first turn ended, once it has. */
  report?: (outcome: ScheduledTurnOutcome) => Promise<void>,
): Promise<ScheduledRunOutcome> {
  const scope: AgentScope = { kind: 'folder', path: request.folderPath };

  // A new chat starts from the project's own choices.
  const preferences = await when(
    runtime.preferences,
    (state) => (state.loading ? undefined : state),
    SETTLE_DEADLINE_MS,
    signal,
  );
  if (!preferences || preferences.failure) {
    return failed('Your Agent settings could not be read, so the chat was not started.');
  }
  const agentId = request.agent ?? runtime.preferredAgent(scope);

  let agents: readonly Agent[];
  try {
    agents = (await catalog.listAgents(signal)).agents;
  } catch {
    return failed('StashBase could not check whether the Agent is ready.');
  }
  const agent = agents.find((candidate) => candidate.id === agentId);
  if (!agent?.ready) return failed(notReady(agent, agentId));

  // Mentions bind against the project's listing, which a window that just
  // opened may still be reading. Without it the send still checks each file.
  const environment = await when(
    runtime.store,
    (state) =>
      state.scopeEnvironment?.folderPath === request.folderPath
        ? state.scopeEnvironment
        : undefined,
    SETTLE_DEADLINE_MS,
    signal,
  );
  if (signal.aborted) return failed('The run was cancelled.');

  const session = runtime.startBackgroundChat({ agent: agentId, scope, title: request.title });
  // What the chat pane settles for a chat the reader opens: a permission
  // mode this runtime honours and the models it remembers.
  const opening = session.store.getState();
  if (agent.abilities.modes.length > 0) {
    const mode = honoredAccessMode(agent.abilities.modes, opening.accessMode);
    if (mode !== opening.accessMode) session.setAccessMode(mode);
  }
  if (agent.models.length > 0) session.seedModels(agent.models);
  for (const path of request.files) {
    const listed = environment?.listing.files.find((file) => file.path === path);
    session.addContext({
      boundVersion: null,
      format: listed?.format ?? 'generic',
      kind: 'source',
      source: { folderPath: request.folderPath, path },
    });
  }
  session.setDraft(scheduledRunPrompt(request.prompt, request.files));

  const sent = await session.sendPrompt();
  if (!sent.ok) {
    const reason = refusal(sent, session.store.getState());
    discardUnsent(runtime, session);
    return failed(reason);
  }
  const outcome =
    (await when(
      session.store,
      (state) => startOutcome(state) ?? undefined,
      START_DEADLINE_MS,
      signal,
    )) ?? failed('The Agent did not start the chat in time.');
  if (outcome.status === 'failed') {
    discardUnsent(runtime, session);
    return outcome;
  }
  void followFirstTurn(runtime, session, request.title, report);
  return outcome;
}

/** The start of the Agent’s last reply in the turn, if it wrote one. */
function lastReply(state: AgentSessionState): string | null {
  const reply = state.transcript.findLast(
    (block) => block.kind === 'assistant' && block.text.trim() !== '',
  );
  return reply?.kind === 'assistant' ? runSummary(reply.text) : null;
}

/** How a first turn ended, or null when the chat closed without saying. */
function turnOutcome(state: AgentSessionState): ScheduledTurnOutcome | null {
  const { connection, delivery } = state;
  if (connection.kind === 'retired' || connection.kind === 'disposed') return null;
  const summary = lastReply(state);
  if (delivery === 'completed') return { status: 'completed', summary };
  if (delivery === 'stopped') {
    return { reason: 'Stopped before it finished.', status: 'failed', summary };
  }
  if (delivery === 'unknown') return null;
  const error = state.transcript.findLast((block) => block.kind === 'error');
  const lost =
    connection.kind === 'failed' || connection.kind === 'closed' ? connection.message : null;
  const reason =
    (error?.kind === 'error' ? error.text : null) ?? lost ?? 'The Agent did not finish.';
  return { reason, status: 'failed', summary };
}

/**
 * Follows the run's first turn to its end. Its outcome is reported so the
 * task list keeps it after this window closes. Not every runtime keeps a first
 * message's title either, so the run's title is then saved on the
 * conversation, as the reader renaming it would: by then every runtime has the
 * conversation on record. A window closed earlier reports neither.
 */
async function followFirstTurn(
  runtime: AgentWorkspaceRuntime,
  session: AgentSessionRuntime,
  title: string,
  report: ((outcome: ScheduledTurnOutcome) => Promise<void>) | undefined,
) {
  const settled = await when(
    session.store,
    (state) => (agentTurnIsActive(state.connection) ? undefined : state),
    FIRST_TURN_DEADLINE_MS,
    session.signal,
  );
  if (!settled) return;
  const outcome = turnOutcome(settled);
  if (outcome && report) await report(outcome).catch(() => {});
  if (!settled.nativeSessionId) return;
  const entry = {
    agent: settled.agent,
    hasContent: settled.transcript.length > 0,
    id: settled.nativeSessionId,
    lastModified: settled.lastModified,
    scope: settled.scope,
    title: settled.title,
  };
  await runtime.renameHistory(entry, title, session.signal).catch(() => {});
}
