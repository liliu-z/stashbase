import { AGENT_TOOL_RESULT_LIMIT, agentToolResultSchema, type AgentToolResult, type TelemetryEvent, type AgentTurnStage, type DiagnosticContext } from '../shared/protocols/http/telemetry.ts';
import type { PendingTurn, QueuedUsage, TelemetryState } from './telemetry-state.ts';

type Finished = Extract<TelemetryEvent, { event: 'agent_turn_finished' }>;
export type TurnObservation =
  | { stage: AgentTurnStage; runtime?: Finished['runtime']; context?: DiagnosticContext }
  | { tool_result: AgentToolResult }
  | { outcome: Finished['outcome']; reason: NonNullable<Finished['reason']>; source?: Finished['source'] };

/** The pending turn owns both counts and de-duplication, so recovery and renderer
 * terminal races preserve the same observed workload without per-tool events. */
export function recordTelemetryToolResult(turn: PendingTurn, input: AgentToolResult): boolean {
  const parsed = agentToolResultSchema.safeParse(input);
  const summary = turn.toolSummary ??= { success: 0, failed: 0, by_category: {}, limited: false };
  if (!parsed.success || (turn.toolCallIds?.length ?? 0) >= AGENT_TOOL_RESULT_LIMIT) {
    if (summary.limited || (parsed.success && turn.toolCallIds?.includes(parsed.data.call_id))) return false;
    summary.limited = true;
    return true;
  }
  const result = parsed.data;
  if (turn.toolCallIds?.includes(result.call_id)) return false;
  (turn.toolCallIds ??= []).push(result.call_id);
  const category = summary.by_category[result.category] ??= { success: 0, failed: 0 };
  category[result.outcome]++;
  summary[result.outcome]++;
  return true;
}

function turnDuration(milliseconds: number): NonNullable<Finished['duration']> {
  return milliseconds < 10_000 ? 'under_10s' : milliseconds < 60_000 ? '10s_to_60s'
    : milliseconds < 300_000 ? '1m_to_5m' : 'over_5m';
}

/** Completing a turn consumes its reserved queue slot in the same config write
 * that removes the pending record. The turn UUID is its stable terminal UUID. */
export function finishTelemetryTurn(state: TelemetryState, turn: PendingTurn, input: Finished, at: number): void {
  const recovered = input.source === 'recovery';
  const timestamp = new Date(at).toISOString();
  const event: Finished = {
    ...input, runtime: turn.runtime, turn_id: turn.turnId,
    last_stage: turn.stage, sequence: turn.sequence + 1,
    started_at: turn.startedAt, last_observed_at: turn.observedAt,
    ...(turn.toolSummary ? { tool_summary: turn.toolSummary } : {}),
    ...(turn.context ? { context: turn.context } : {}),
    ...(recovered ? { recovered_at: timestamp } : {
      finished_at: timestamp, duration: turnDuration(Math.max(0, at - Date.parse(turn.startedAt))),
    }),
  };
  if (!turn.toolSummary) delete event.tool_summary;
  if (recovered) delete event.duration;
  const queued: QueuedUsage = {
    installationId: turn.installationId, anonymousId: turn.anonymousId,
    firstSeenAt: turn.firstSeenAt, ...(turn.userId ? { userId: turn.userId } : {}),
    ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
    version: turn.version, distribution: turn.distribution, os: turn.os, uuid: turn.turnId, timestamp, event,
  };
  (state.queue ??= []).push(queued);
  state.turns = state.turns?.filter((item) => item.turnId !== turn.turnId);
  state.finishedTurns = Object.fromEntries([...Object.entries(state.finishedTurns ?? {}), [turn.turnId, at]].slice(-500));
}
