import type { AgentId, AgentSessionAction } from '@/features/agent/domain/session';

export type AgentUsageEvent =
  | { event: 'agent_turn_started'; runtime: AgentId; turn_id?: string }
  | {
      event: 'agent_turn_finished';
      turn_id?: string;
      runtime: AgentId;
      outcome: 'success' | 'failed' | 'cancelled' | 'blocked';
      duration: 'under_10s' | '10s_to_60s' | '1m_to_5m' | 'over_5m';
    };

/** Counts submitted work once across preparation, streaming, and repeated
 * terminal signals. Only action kind and the error flag enter the outcome. */
export function createAgentUsage(
  runtime: AgentId | (() => AgentId),
  record: ((event: AgentUsageEvent) => void) | undefined,
  now = Date.now,
) {
  let startedAt: number | null = null;
  let interrupted = false;
  let turnId = '';
  let turnRuntime: AgentId | null = null;
  const finish = (outcome: 'success' | 'failed' | 'cancelled' | 'blocked') => {
    if (startedAt === null || turnRuntime === null) return;
    const elapsed = now() - startedAt;
    startedAt = null;
    record?.({
      event: 'agent_turn_finished',
      runtime: turnRuntime,
      turn_id: turnId,
      outcome,
      duration:
        elapsed < 10000
          ? 'under_10s'
          : elapsed < 60000
            ? '10s_to_60s'
            : elapsed < 300000
              ? '1m_to_5m'
              : 'over_5m',
    });
  };
  return {
    start() {
      if (startedAt !== null) return;
      interrupted = false;
      startedAt = now();
      turnId = crypto.randomUUID();
      turnRuntime = typeof runtime === 'function' ? runtime() : runtime;
      record?.({
        event: 'agent_turn_started',
        runtime: turnRuntime,
        turn_id: turnId,
      });
    },
    interrupt() {
      interrupted = true;
    },
    finish,
    action(action: AgentSessionAction) {
      if (action.kind === 'settle-turn')
        finish(interrupted ? 'cancelled' : action.isError ? 'failed' : 'success');
      else if (action.kind === 'turn-fail' || action.kind === 'fail' || action.kind === 'close')
        finish(interrupted ? 'cancelled' : 'failed');
      else if (action.kind === 'retire' || action.kind === 'dispose') finish('cancelled');
    },
  };
}
