import { describe, expect, it } from 'vite-plus/test';

import { createAgentUsage, type AgentUsageEvent } from './usage';

describe('Agent usage outcomes', () => {
  it('counts preparation failure once even when a later close arrives', () => {
    const events: AgentUsageEvent[] = [];
    const usage = createAgentUsage(
      'codex',
      (event) => events.push(event),
      () => 0,
    );
    usage.start();
    usage.start();
    usage.action({ kind: 'fail', message: '/private authentication details' });
    usage.action({ kind: 'close', message: 'private details' });
    expect(events[0]?.turn_id).toBeTruthy();
    expect(events[1]?.turn_id).toBe(events[0]?.turn_id);
    expect(events.map(({ turn_id: _id, ...event }) => event)).toEqual([
      { event: 'agent_turn_started', runtime: 'codex' },
      { event: 'agent_turn_finished', runtime: 'codex', outcome: 'failed', duration: 'under_10s' },
    ]);
  });
  it('distinguishes cancellation, retry success, and disposal from completion', () => {
    const events: AgentUsageEvent[] = [];
    let now = 0;
    const usage = createAgentUsage(
      'claude',
      (event) => events.push(event),
      () => now,
    );
    usage.start();
    usage.interrupt();
    now = 20000;
    usage.action({ kind: 'settle-turn', isError: false, at: now });
    usage.start();
    now = 100000;
    usage.action({ kind: 'settle-turn', isError: false, at: now });
    usage.start();
    now = 500000;
    usage.action({ kind: 'dispose' });
    expect(
      events
        .filter((event) => event.event === 'agent_turn_finished')
        .map(({ turn_id: _id, ...event }) => event),
    ).toEqual([
      {
        event: 'agent_turn_finished',
        runtime: 'claude',
        outcome: 'cancelled',
        duration: '10s_to_60s',
      },
      { event: 'agent_turn_finished', runtime: 'claude', outcome: 'success', duration: '1m_to_5m' },
      {
        event: 'agent_turn_finished',
        runtime: 'claude',
        outcome: 'cancelled',
        duration: 'over_5m',
      },
    ]);
  });
});
