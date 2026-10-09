import type { AgentSetupFailure } from '@/features/agent/domain/agent-catalog';
/**
 * One reader-facing sentence per Agent refusal.
 *
 * A hook or a view reports a refusal by what it means rather than by whatever
 * sentence the transport happened to attach, and the map covers the whole
 * ladder, so adding a kind fails the build here. Both Agent ladders are
 * covered: a session failure can only be one of the shared transport kinds.
 */
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

export type AgentContextErrorKind = FeatureFailureKind<AgentContextExtra>;

const MESSAGES: Readonly<Record<AgentContextErrorKind, string>> = {
  'invalid-response': 'The Agent service returned an unexpected response.',
  'not-found': 'That file is no longer in this folder.',
  'scope-lost': 'That folder is no longer available in this window.',
  unauthorized: 'This window can no longer perform that action.',
  unsupported: 'This file type cannot be given to the Agent.',
  unavailable: 'StashBase could not reach the Agent service.',
};

/** A file the reader picked that the Agent cannot take is theirs to change;
 *  everything else is a capability that could not answer. */
const INPUT_KINDS: readonly AgentContextErrorKind[] = ['not-found', 'unsupported'];

/** The sentence one kind reads as. */
export function failureMessage(kind: AgentContextErrorKind): string {
  return MESSAGES[kind];
}

/** The kind behind a rejection, for the few decisions that turn on which
 *  refusal it was rather than on what to tell the reader. A failure this
 *  feature raised names its own; anything else is a capability that could not
 *  be reached. */
export function failureKind(error: unknown): AgentContextErrorKind {
  return isFeatureError<AgentContextExtra>(error) ? error.kind : 'unavailable';
}

/** What a replay that could not be read leaves on the conversation. The
 *  transport's own kind decides the rest of the ladder; a replay that arrives
 *  malformed is the one outcome none of those kinds names. */
export const RESTORE_FAILED = 'That conversation could not be restored.';

/** What the Agent panel shows in its own region when its chunk never arrives
 *  or its render throws, neither of which is a refusal on the ladder above. */
export const SURFACE_FAILED = 'The Agent view could not load.';

/** The sentence and tone a refusal shows, without repeating what it was thrown
 *  with. */
export function agentFailure(error: unknown): FailureView {
  return readFailure<AgentContextExtra>(error, MESSAGES, { inputKinds: INPUT_KINDS });
}

const SETUP_FAILURE_MESSAGES: Readonly<Record<AgentSetupFailure['stage'], string>> = {
  discovery: 'Agent detection failed.',
  installation: 'Installation failed.',
  authentication: 'Sign-in failed.',
  mcp: 'MCP connection failed.',
};

/** Keep the failed step and diagnostic visible where setup was requested.
 * Error messages are plain text; stack traces and error objects are not rendered. */
export function agentAccessFailure(error: unknown): string {
  const setup = error instanceof AgentSetupRefused ? error.setup : undefined;
  const summary =
    error instanceof AgentSetupRefused
      ? setup
        ? SETUP_FAILURE_MESSAGES[setup.stage]
        : 'Could not connect.'
      : isFeatureError(error)
        ? agentFailure(error).message
        : 'Could not connect.';
  const cause = isFeatureError(error) ? error.cause : error;
  const detail = setup?.message.trim() ?? (cause instanceof Error ? cause.message.trim() : '');
  return [
    summary,
    ...(detail && detail !== summary ? [detail] : []),
    'Your message was kept. Try again.',
  ].join('\n\n');
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

const UPDATE_FAILED = 'The update did not finish. Check Agent settings and try again.';

/** The runtime is updated, but this conversation could not come back on it. */
export function agentReconnectAfterUpdateFailure(
  label: string,
  outcome: 'settled' | 'timeout',
): string {
  return outcome === 'timeout'
    ? `${label} is updated, but this conversation did not reconnect in time. Reconnect and try again.`
    : `${label} is updated, but this conversation could not reconnect. Reconnect and try again.`;
}
