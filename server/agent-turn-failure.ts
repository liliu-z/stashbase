/**
 * Turn-scoped runtime failure classification shared by Agent adapters.
 *
 * A live turn error reaches the renderer as provider prose. The renderer must
 * never infer a recovery from that prose, so the adapter — the one place that
 * legitimately reads provider messages — classifies it into a small closed
 * set of failure kinds and attaches the kind to the protocol `error` event.
 * The renderer switches on the kind alone: transient kinds invite resending,
 * `quota` explains the provider-side reset, `auth-expired` routes to each
 * runtime's real sign-in path, `runtime-outdated` offers the runtime's
 * own in-app update before the same request is sent again, `app-outdated`
 * opens application updates in General settings, and
 * `model-changed` refreshes a hosted model list that no longer matches the
 * one the reader chose from.
 *
 * The development turn-failure scripts are provider-shaped and flow through
 * this same classifier, so injecting one in Settings exercises exactly the
 * presentation a live failure would get. A message that matches nothing stays
 * unclassified and renders as a plain error.
 */

import type { AgentTurnFailure, AgentTurnFailureKind } from '../shared/agent-protocol.ts';

export type { AgentTurnFailure, AgentTurnFailureKind } from '../shared/agent-protocol.ts';

/** Ordered: a runtime too old for the chosen model first (the provider names
 * the required version, and the message also carries a 400 that nothing else
 * should read), then authentication (its messages are unambiguous), then plan
 * exhaustion before transient rate limiting (quota messages often carry a
 * 429 as well), then explicit connectivity signals. Patterns prefer precise
 * provider vocabulary over broad words so an unmatched message stays a plain
 * error instead of wearing the wrong recovery. */
const RUNTIME_OUTDATED_PATTERN =
  /does not support this model;? version [\d.]+ or newer is required|run ['"`]?(claude|codex|agy) (update|upgrade)|(claude code|codex)( cli)? (version )?[\d.]+ is (too old|out of date|outdated)/i;
const APP_OUTDATED_PATTERN =
  /client_upgrade_required|StashBase [\d.]+ or newer is required|update StashBase/i;
const AUTH_PATTERN =
  /authentication_error|authentication[_ ]required|unauthenticated|sign[- ]?in (?:is )?required|no saved (?:session|credentials)|please (?:sign|log) in|sign in to StashBase|not signed in|invalid api key|api key.{0,20}invalid|please run \/login|not logged in|logged out|login required|unauthorized|\b401\b|token.{0,30}(expired|revoked|invalid)|oauth.{0,20}(expired|error|revoked)|sign in again|re-?authenticate/i;
const QUOTA_PATTERN =
  /usage limit|quota|credit balance|out of credits|usage cap|spending (limit|cap|budget)|plan limit|(weekly|monthly|5-hour) limit|insufficient_quota/i;
const RATE_LIMIT_PATTERN =
  /rate.?limit|too many (?:agent )?requests|too much short-term usage|agent_usage_recovery_limited|agent calls have unresolved accounting or repeated recent fee waivers|\b429\b|overloaded|\b529\b|throttl/i;
const NETWORK_PATTERN =
  /\bnetwork\b|econnrefused|econnreset|enotfound|etimedout|esockettimedout|eai_again|epipe|fetch failed|socket hang ?up|getaddrinfo|no internet|connection (error|failed|refused|reset|closed|lost)|(could not|couldn.t|unable to) (connect|reach)/i;

/** The hosted broker's own sentences for a profile the service refused. */
const MODEL_CHANGED_PATTERN =
  /selected model configuration has changed|selected model is no longer available|agent_model_configuration_changed|agent_model_unavailable/i;

export function classifyAgentTurnFailure(message: string): AgentTurnFailureKind | null {
  if (APP_OUTDATED_PATTERN.test(message)) return 'app-outdated';
  if (RUNTIME_OUTDATED_PATTERN.test(message)) return 'runtime-outdated';
  if (MODEL_CHANGED_PATTERN.test(message)) return 'model-changed';
  if (AUTH_PATTERN.test(message)) return 'auth-expired';
  if (/hosted_access_restricted|hosted ai access is restricted|agent access is restricted/i.test(message)) return 'access-restricted';
  if (/free agent credits are exhausted|(?:remaining agent credits|available base and bonus credits) cannot cover|agent_allowance_(?:exhausted|reserved)|quota_exhausted|stashbase.{0,30}(agent )?allowance|(weekly|monthly) agent allowance/i.test(message)) return 'allowance-exhausted';
  if (QUOTA_PATTERN.test(message)) return 'quota';
  if (RATE_LIMIT_PATTERN.test(message)) return 'rate-limit';
  if (NETWORK_PATTERN.test(message)) return 'network';
  return null;
}

/** The optional `failure` field of a protocol `error` event: present only
 * when the message classifies, so unclassified errors keep today's shape. */
export function agentTurnFailureFor(message: string): AgentTurnFailure | undefined {
  const kind = classifyAgentTurnFailure(message);
  return kind ? { kind } : undefined;
}

/** The wire `error` event for a turn-scoped runtime failure — message plus
 * its classified kind when one matches. Every adapter sends exactly this
 * shape, so classification cannot drift between them. */
export function agentTurnErrorEvent(
  message: string,
): { t: 'error'; message: string; failure?: AgentTurnFailure } {
  const failure = agentTurnFailureFor(message);
  return { t: 'error', message, ...(failure ? { failure } : {}) };
}

/** Startup and fatal runtime errors need the same repair as turn errors.
 * Keep them terminal: classification must not make an interrupted turn safe
 * to replay or turn an unknown outcome into a completed failure. */
export function agentSessionExitEvent(
  message?: string,
): { t: 'exit'; message?: string; failure?: AgentTurnFailure } {
  const failure = message ? agentTurnFailureFor(message) : undefined;
  return { t: 'exit', ...(message ? { message } : {}), ...(failure ? { failure } : {}) };
}
