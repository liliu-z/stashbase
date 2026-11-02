/** Retries the recorded turn only while its scope context and delivery remain safe. */
import { staleContext, validateContext } from '@/features/agent/domain/context';
import {
  agentSessionIsBusy,
  agentTurnFailureIsRetryable,
  type AgentSessionAction,
  type AgentSessionState,
} from '@/features/agent/domain/session';

import type { AgentTransport } from './connection';
import type { AgentSessionEnvironment } from './dispatch';
import { attachmentFields, type AgentPromptLedger } from './prompts';
import type { createAgentUsage } from './usage';

export function createSessionRetry({
  state,
  disposed,
  usage,
  ledger,
  environment,
  transientFiles,
  transport,
  transition,
}: {
  state(): AgentSessionState;
  disposed(): boolean;
  usage: ReturnType<typeof createAgentUsage>;
  ledger: AgentPromptLedger;
  environment(): AgentSessionEnvironment | null;
  transientFiles: Map<string, File>;
  transport: AgentTransport;
  transition(action: AgentSessionAction): void;
}) {
  return (errorBlockId: string): boolean => {
    const current = state();
    if (disposed() || agentSessionIsBusy(current) || current.delivery === 'unknown') return false;
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
      usage.finish('blocked', 'context_invalid');
      transition({
        kind: 'set-context-issue',
        message: stale[0]?.reason ?? 'Review the request context before retrying.',
      });
      return false;
    }
    const sent = transport.send({
      kind: 'prompt',
      ...usage.correlation(),
      skill: turn?.skill ?? null,
      ...attachmentFields(current.agent, turn?.context),
      text: failure.retryablePrompt,
    });
    if (!sent) usage.finish('blocked');
    if (sent) {
      transition({ kind: 'delivery', value: 'idle' });
      transition({ id: errorBlockId, kind: 'settle-error' });
      transition({ kind: 'turn-started' });
    }
    return sent;
  };
}
