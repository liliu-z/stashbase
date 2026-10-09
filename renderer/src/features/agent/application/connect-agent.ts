import type { Agent, AgentCatalog, AgentSetupFailure } from '@/features/agent/domain/agent-catalog';
import type { AgentId } from '@/features/agent/domain/session';
import { FeatureError } from '@/shared/domain/feature-error';

import type { AgentCatalogPort } from './ports';

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 1000);
    signal.addEventListener('abort', abort, { once: true });
  });
}

// The host bounds installation (8 minutes) and provider sign-in (10 minutes).
// Keep polling long enough to receive its actionable failure and release of ownership.
const PREPARATION_LIMIT_MS = 20 * 60_000;

/** The runtime's entry once the service has stopped preparing it: the
 *  acknowledgement a setup route answers with is followed until it settles. */
async function settledAgent(
  port: AgentCatalogPort,
  agent: AgentId,
  catalog: AgentCatalog,
  signal: AbortSignal,
  wait: typeof pause,
): Promise<Agent | undefined> {
  let entry = catalog.agents.find((candidate) => candidate.id === agent);
  while (entry?.preparing) {
    await wait(signal);
    signal.throwIfAborted();
    entry = (await port.listAgents(signal)).agents.find((candidate) => candidate.id === agent);
  }
  return entry;
}

/** Setup routes acknowledge starting work; only the selected runtime becoming ready finishes it. */
export async function connectAgent(
  port: AgentCatalogPort,
  agent: AgentId,
  known: Agent | undefined,
  signal: AbortSignal,
  wait = pause,
): Promise<void> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(PREPARATION_LIMIT_MS)]);
  const settled = (catalog: AgentCatalog) => settledAgent(port, agent, catalog, bounded, wait);
  const loginFirst = known?.needsSignIn;
  let entry = await settled(
    await port.prepareAgent(agent, loginFirst ? 'login' : 'bootstrap', bounded),
  );
  if (entry?.needsSignIn && !loginFirst) {
    entry = await settled(await port.prepareAgent(agent, 'login', bounded));
  }
  bounded.throwIfAborted();
  if (!entry?.ready) throw new AgentSetupRefused(entry?.setupFailure);
}

/** Keep the failed step and its explanation through the first-send gate. */
export class AgentSetupRefused extends FeatureError {
  constructor(readonly setup: AgentSetupFailure | undefined) {
    super('AgentSetupRefused', 'unavailable', 'Agent setup did not finish.');
  }
}

/** The service stopped an update short. Its own sentence about why, where it
 *  wrote one, travels as the cause for the failure-message module to read. */
export class AgentUpdateRefused extends FeatureError {
  constructor(sentence: string | undefined) {
    super(
      'AgentUpdateRefused',
      'unavailable',
      'The runtime update did not end ready.',
      sentence ? { cause: new Error(sentence) } : undefined,
    );
  }
}

/** The native installer, run through the service. Done only when the
 *  updated runtime is ready to carry a turn again, so a resend that follows
 *  never races the update it depends on. */
export async function updateAgent(
  port: AgentCatalogPort,
  agent: AgentId,
  signal: AbortSignal,
  wait = pause,
): Promise<void> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(PREPARATION_LIMIT_MS)]);
  const entry = await settledAgent(
    port,
    agent,
    await port.prepareAgent(agent, 'update', bounded),
    bounded,
    wait,
  );
  bounded.throwIfAborted();
  if (!entry?.ready) throw new AgentUpdateRefused(entry?.setupFailure?.message);
}
