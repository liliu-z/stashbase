/** Pure session, scope, capability, and work-state queries. */
import { basePathName } from '@/shared/utils/file-path';

import type { AgentSkill } from './runtime-catalog';
import {
  MAX_QUEUED_PROMPTS,
  type AgentActiveTurn,
  type AgentConnection,
  type AgentScope,
  type AgentSessionAction,
  type AgentSessionState,
  type AgentSessionPhase,
  type AgentSkillCatalog,
} from './session-state';

// Connection

/** How many reconnects this connection has already spent. A connection that
 *  is not being retried has spent none, which is what resets the ladder after
 *  a successful `ready` or a manual reconnect. */
export function agentReconnectAttempt(connection: AgentConnection): number {
  return connection.kind === 'connecting' || connection.kind === 'reconnecting'
    ? connection.attempt
    : 0;
}

/** The turn being streamed, or null when nothing is running. */
export function agentActiveTurn(connection: AgentConnection): AgentActiveTurn | null {
  return connection.kind === 'live' ? connection.turn : null;
}

export function agentTurnIsActive(connection: AgentConnection): boolean {
  return agentActiveTurn(connection) !== null;
}

/** Whether the connection can carry a prompt right now. A draft has no
 *  transport yet and opens one on the first send. */
export function agentCanSend(connection: AgentConnection): boolean {
  return connection.kind === 'draft' || (connection.kind === 'live' && connection.turn === null);
}

/** Whether the composer may take another message: the connection can carry
 *  it now or queue it behind the running turn, no earlier send is still
 *  settling, and the queue has room. */
export function agentComposerAccepts(
  state: Pick<AgentSessionState, 'connection' | 'delivery' | 'queuedPrompts'>,
): boolean {
  return (
    (state.connection.kind === 'draft' || state.connection.kind === 'live') &&
    state.delivery !== 'unknown' &&
    state.delivery !== 'stopping' &&
    state.delivery !== 'preparing' &&
    state.queuedPrompts.length < MAX_QUEUED_PROMPTS
  );
}

/** The coarse label tabs and status rows read. A retried connection is still
 *  connecting, and a failure is a connection that closed with a reason. */
export function agentSessionPhase(connection: AgentConnection): AgentSessionPhase {
  switch (connection.kind) {
    case 'reconnecting':
      return 'connecting';
    case 'failed':
      return 'closed';
    default:
      return connection.kind;
  }
}

// Skill catalog

/** The catalog the runtime just reported, as one value. The report is a flat
 *  triple on the wire, so this is where it becomes a state that cannot lie: a
 *  failed read keeps its reason and no skills, and a report carrying none is
 *  empty however the runtime spelled it. */
export function skillCatalogOf(
  report: Extract<AgentSessionAction, { kind: 'skills' }>,
): AgentSkillCatalog {
  if (report.state === 'failed') {
    return { kind: 'failed', message: report.error ?? 'The agent could not read its skills.' };
  }
  return report.skills.length > 0
    ? { kind: 'available', skills: report.skills }
    : { kind: 'empty' };
}

/** The skills the composer can offer right now. Only a stocked catalog has
 *  any, so an empty or failed one answers with none. */
export function agentSkills(catalog: AgentSkillCatalog): AgentSkill[] {
  return catalog.kind === 'available' ? catalog.skills : [];
}

// Session selectors

/** A conversation no turn has left yet: nothing was sent, nothing came back,
 *  and no native session backs it. Its bound runtime is still free to change,
 *  which is what lets a chat follow a runtime the reader sets up after the
 *  window opened. A waiting draft does not start a conversation. */
export function agentSessionIsUnstarted(state: AgentSessionState): boolean {
  return (
    state.nativeSessionId === null &&
    state.transcript.length === 0 &&
    !agentTurnIsActive(state.connection)
  );
}

/** Unstarted and holding nothing the reader typed, dropped, or armed, so a new
 *  chat would be indistinguishable from it. */
export function agentSessionIsBlank(state: AgentSessionState): boolean {
  return (
    agentSessionIsUnstarted(state) &&
    !agentSessionIsBusy(state) &&
    state.connection.kind !== 'restoring' &&
    state.draft.length === 0 &&
    state.skill === null &&
    state.context.length === 0 &&
    state.queuedPrompts.length === 0
  );
}

// Scope

export function agentScopesEqual(left: AgentScope, right: AgentScope): boolean {
  return left.path === right.path;
}

export function scopeForWindowFolder(folderPath: string | null): AgentScope {
  if (!folderPath) throw new Error('Open a project before starting a chat.');
  return { kind: 'folder', path: folderPath };
}

/** Persona and preferences share the project path as their key. */
export function agentScopeKey(scope: AgentScope): string {
  return scope.path;
}

export function scopeLabel(scope: AgentScope): string {
  return basePathName(scope.path);
}

/** User-visible work state, independent of transport availability. */
export function agentWorkStatus(state: AgentSessionState): string | null {
  if (state.delivery === 'unknown') return 'Outcome unknown';
  if (state.delivery === 'stopping') return 'Stopping…';
  if (state.delivery === 'preparing') return 'Preparing…';
  if (agentTurnIsActive(state.connection)) {
    return state.transcript.some((block) => block.kind === 'tool' && block.status === 'awaiting')
      ? 'Waiting for approval'
      : 'Working…';
  }
  if (state.connection.kind === 'restoring') return 'Loading chat…';
  if (state.connection.kind === 'connecting' || state.connection.kind === 'reconnecting')
    return 'Connecting…';
  if (state.delivery === 'stopped') return 'Stopped';
  if (state.delivery === 'failed') return 'Did not finish';
  if (state.delivery === 'completed') return 'Finished';
  return null;
}

export function agentSessionIsBusy(
  state: Pick<AgentSessionState, 'connection' | 'delivery'>,
): boolean {
  return (
    agentTurnIsActive(state.connection) ||
    state.delivery === 'preparing' ||
    state.delivery === 'stopping'
  );
}

/** A catalog connection may exist before the first request; it carries no conversation to transfer. */
export function agentCanChangeAgent(
  state: Pick<AgentSessionState, 'connection' | 'delivery' | 'transcript'>,
): boolean {
  return (
    state.transcript.length === 0 &&
    state.connection.kind !== 'restoring' &&
    !agentSessionIsBusy(state)
  );
}
