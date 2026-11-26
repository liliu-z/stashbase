/**
 * Reload local model metadata after a hosted model refusal.
 *
 * The gateway selects the default for each new turn and pins admitted turns.
 * Reconnecting refreshes the native runtime's catalog and compaction limits;
 * it does not send a prompt. The reader can then retry the failed turn while
 * the conversation, draft, and paused queue stay as they were.
 */
import { useCallback, useMemo, useRef, useState } from 'react';

import { agentModelRefreshFailure } from '@/features/agent/application/failure-messages';
import type { AgentSessionRuntime } from '@/features/agent/application/session-runtime';
import { reconnected } from '@/features/agent/hooks/use-agent-runtime-update';
import { useRequestSignals } from '@/shared/runtime/use-request-signals';

export interface AgentModelRefreshView {
  readonly busy: boolean;
  /** Why the last refresh did not finish, or null. */
  readonly failure: string | null;
  /** The failed turn a refresh has already run for, so its block offers a
   *  plain retry instead of another refresh. */
  readonly refreshedBlockId: string | null;
  refresh(errorBlockId: string): void;
}

/** `onRefresh` refreshes the shared runtime catalog after reconnecting. */
export function useAgentModelRefresh(
  session: AgentSessionRuntime,
  onRefresh: () => void,
): AgentModelRefreshView {
  const requestSignal = useRequestSignals<'refresh'>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [refreshedBlockId, setRefreshedBlockId] = useState<string | null>(null);
  const running = useRef(false);

  const refresh = useCallback(
    (errorBlockId: string) => {
      if (running.current) return;
      running.current = true;
      const signal = AbortSignal.any([requestSignal('refresh'), session.signal]);
      setBusy(true);
      setFailure(null);
      void (async () => {
        try {
          session.reconnect();
          const outcome = await reconnected(session, signal);
          if (outcome === 'cancelled') return;
          if (outcome !== 'live') {
            setFailure(agentModelRefreshFailure(outcome));
            return;
          }
          onRefresh();
          setRefreshedBlockId(errorBlockId);
        } finally {
          running.current = false;
          if (!signal.aborted) setBusy(false);
        }
      })();
    },
    [onRefresh, requestSignal, session],
  );

  return useMemo(
    () => ({ busy, failure, refresh, refreshedBlockId }),
    [busy, failure, refresh, refreshedBlockId],
  );
}
