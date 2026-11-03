/**
 * One reader-facing sentence per Agent refusal.
 *
 * A hook or a view reports a refusal by what it means rather than by whatever
 * sentence the transport happened to attach, and the map covers the whole
 * ladder, so adding a kind fails the build here. Agent failures include
 * installation prerequisites when reading native history.
 */
import type { AgentSetupFailure } from '@/features/agent/domain/agent-catalog';
import {
  isFeatureError,
  readFailure,
  type FailureView,
  type FeatureFailureKind,
} from '@/shared/domain/feature-error';

import { AgentSetupRefused, AgentUpdateRefused } from './connect-agent';

/** Refusals only the Agent's context resolution can meet: the file is gone, or
 *  its format is one the Agent cannot be given. */
export type AgentContextExtra = 'not-found' | 'unsupported';

export type AgentHistoryExtra = 'installation-required';
type AgentFailureExtra = AgentContextExtra | AgentHistoryExtra;
export type AgentFailureKind = FeatureFailureKind<AgentFailureExtra>;

const MESSAGES: Readonly<Record<AgentFailureKind, string>> = {
  'installation-required': 'Install this agent in Settings → Agents to access its chats.',
  'invalid-response': 'The agent service returned an unexpected response.',
  'not-found': 'That file is no longer in this project.',
  'scope-lost': 'That project is no longer available in this window.',
  unauthorized: 'This window can no longer perform that action.',
  unsupported: 'This file type cannot be given to the agent.',
  unavailable: 'StashBase could not reach the agent service.',
};

/** File choices and an installation prerequisite have a local recovery;
 *  everything else is a capability that could not answer. */
const INPUT_KINDS: readonly AgentFailureKind[] = [
  'not-found',
  'unsupported',
  'installation-required',
];

/** The sentence one kind reads as. */
export function failureMessage(kind: AgentFailureKind): string {
  return MESSAGES[kind];
}

/** The kind behind a rejection, for the few decisions that turn on which
 *  refusal it was rather than on what to tell the reader. A failure this
 *  feature raised names its own; anything else is a capability that could not
 *  be reached. */
export function failureKind(error: unknown): AgentFailureKind {
  return isFeatureError<AgentFailureExtra>(error) ? error.kind : 'unavailable';
}

/** What a replay that could not be read leaves on the conversation. The
 *  transport's own kind decides the rest of the ladder; a replay that arrives
 *  malformed is the one outcome none of those kinds names. */
export const RESTORE_FAILED = 'That chat could not be restored.';

/** What the Agent panel shows in its own region when its chunk never arrives
 *  or its render throws, neither of which is a refusal on the ladder above. */
export const SURFACE_FAILED = 'The agent view could not load.';

/** The sentence and tone a refusal shows, without repeating what it was thrown
 *  with. */
export function agentFailure(error: unknown): FailureView {
  return readFailure<AgentFailureExtra>(error, MESSAGES, { inputKinds: INPUT_KINDS });
}

const SETUP_FAILURE_MESSAGES: Readonly<Record<AgentSetupFailure['stage'], string>> = {
  discovery: 'Agent detection failed.',
  installation: 'Installation failed.',
  authentication: 'Sign-in failed.',
  mcp: 'MCP connection failed.',
};

/** The account signed in, and the provider still will not serve it. */
const ACCOUNT_REFUSED = 'Account not accepted.';

/** What the gate says when nothing more specific reached it. */
const NOT_CONNECTED = 'Could not connect.';

/** The held send survives every refusal the gate shows, so the gate says so
 *  once, last. Its Retry button is the way forward, so no sentence repeats
 *  that. */
const MESSAGE_KEPT = 'Your message was kept.';

/** The step that stopped, then the service's own explanation of it. */
function accessFailureLines(error: unknown): readonly string[] {
  if (error instanceof AgentSetupRefused) {
    const setup = error.setup;
    if (!setup) return [NOT_CONNECTED];
    return [
      setup.accountRefused ? ACCOUNT_REFUSED : SETUP_FAILURE_MESSAGES[setup.stage],
      setup.message.trim(),
    ];
  }
  // A service that answered wrote the sentence naming what stopped, such as a
  // sign-in already running; the mapped line stands only where it could not
  // be reached at all.
  if (isFeatureError<AgentFailureExtra>(error)) {
    return [readFailure(error, MESSAGES, { serverSentenceFor: [error.kind] }).message];
  }
  return [error instanceof Error && error.message.trim() ? error.message.trim() : NOT_CONNECTED];
}

/** Keep the failed step and the service's diagnostic visible where setup was
 * requested. Error messages are plain text; stack traces and error objects
 * are not rendered. */
export function agentAccessFailure(error: unknown): string {
  const lines = accessFailureLines(error).filter((line) => line !== '');
  return [...new Set(lines), MESSAGE_KEPT].join('\n\n');
}

/** What an update that did not finish reads as: the service's own sentence
 *  where it wrote one, since it names the exact step that stopped; the
 *  transport ladder's sentence where the service could not be reached. */
export function agentUpdateFailure(error: unknown): string {
  if (error instanceof AgentUpdateRefused) {
    const sentence = error.cause instanceof Error ? error.cause.message.trim() : '';
    return sentence || UPDATE_FAILED;
  }
  if (isFeatureError<AgentContextExtra>(error)) {
    return readFailure(error, MESSAGES, { serverSentenceFor: [error.kind] }).message;
  }
  return error instanceof Error && error.message.trim()
    ? `${UPDATE_FAILED}\n\n${error.message}`
    : UPDATE_FAILED;
}

const UPDATE_FAILED = 'The update did not finish. Check agent settings and try again.';

/** The runtime is updated, but this conversation could not come back on it. */
/** Why a hosted model list could not be refreshed by reconnecting. */
export function agentModelRefreshFailure(outcome: 'settled' | 'timeout'): string {
  return outcome === 'timeout'
    ? 'This chat did not reconnect in time, so the models were not refreshed. Try again.'
    : 'This chat could not reconnect, so the models were not refreshed. Try again.';
}

export function agentReconnectAfterUpdateFailure(
  label: string,
  outcome: 'settled' | 'timeout',
): string {
  return outcome === 'timeout'
    ? `${label} is updated, but this chat did not reconnect in time. Reconnect and try again.`
    : `${label} is updated, but this chat could not reconnect. Reconnect and try again.`;
}
