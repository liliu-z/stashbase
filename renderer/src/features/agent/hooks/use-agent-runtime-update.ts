/**
 * The native update of a conversation's runtime, run from the turn that
 * runtime was too old for, or from the offer of a model it cannot reach.
 *
 * The service runs the provider's native installer and reports the runtime ready
 * again; the conversation's process still runs the old executable, so the
 * session is reconnected to spawn the updated one, and the request the old
 * one refused is sent again. Installation stays owned by the host; the
 * runtime keeps ownership of its own files throughout.
 *
 * The same update also runs with nothing to resend, from a chat that offers
 * a newer model rather than reporting a failure. That is the whole difference
 * between the two callers: one has a refused request waiting, the other has
 * only a reader who said yes. Everything before the resend is identical, so
 * it is written once here rather than twice.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';

import { updateAgent } from '@/features/agent/application/connect-agent';
import {
  agentReconnectAfterUpdateFailure,
  agentUpdateFailure,
} from '@/features/agent/application/failure-messages';
import type { AgentCatalogPort } from '@/features/agent/application/ports';
import type { AgentSessionRuntime } from '@/features/agent/application/session-runtime';
import { agentLabel } from '@/features/agent/domain/agent-catalog';
import { useRequestSignals } from '@/shared/runtime/use-request-signals';

/** How long a reconnect onto the updated runtime may take before the turn
 *  reports it instead of waiting silently. */
const RECONNECT_LIMIT_MS = 30_000;

export interface AgentRuntimeUpdateView {
  /** What the runtime is called, for the action's label. */
  readonly label: string;
  readonly busy: boolean;
  /** Why the last update did not finish, or null. */
  readonly failure: string | null;
  /** The failed turn an update has already run for, so its block offers a
   *  plain retry instead of another update. */
  readonly completedBlockId: string | null;
  /** Whether an update finished here, so an offer that prompted one stops
   *  offering it. */
  readonly completed: boolean;
  /** With a failed turn's id, the same request is sent again once the
   *  updated runtime is live. Without one, the update simply happens. */
  update(errorBlockId?: string): void;
}

type ReconnectOutcome = 'live' | 'settled' | 'timeout' | 'cancelled';

/** Settles once the session is live on its new socket, or as soon as the
 *  connection settles anywhere it cannot carry a resend. */
function reconnected(session: AgentSessionRuntime, signal: AbortSignal): Promise<ReconnectOutcome> {
  return new Promise((resolve) => {
    let cleanup: (() => void) | null = null;
    const settle = (outcome: ReconnectOutcome) => {
      cleanup?.();
      resolve(outcome);
    };
    const check = () => {
      const { connection } = session.store.getState();
      if (connection.kind === 'live') settle('live');
      else if (
        connection.kind === 'failed' ||
        connection.kind === 'closed' ||
        connection.kind === 'retired' ||
        connection.kind === 'disposed'
      )
        settle('settled');
    };
    const timer = setTimeout(() => settle('timeout'), RECONNECT_LIMIT_MS);
    const abort = () => settle('cancelled');
    const unsubscribe = session.store.subscribe(check);
    signal.addEventListener('abort', abort, { once: true });
    cleanup = () => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener('abort', abort);
    };
    check();
  });
}

/** `onRefresh` re-reads the runtime catalog, so the rest of the window sees
 *  the runtime ready on its new version. */
export function useAgentRuntimeUpdate(
  session: AgentSessionRuntime,
  catalog: AgentCatalogPort,
  onRefresh: () => void,
): AgentRuntimeUpdateView {
  const requestSignal = useRequestSignals<'update'>();
  const agent = useStore(session.store, (state) => state.agent);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [completedBlockId, setCompletedBlockId] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const running = useRef(false);

  const update = useCallback(
    (errorBlockId?: string) => {
      if (running.current) return;
      running.current = true;
      const signal = AbortSignal.any([requestSignal('update'), session.signal]);
      const label = agentLabel(agent);
      setBusy(true);
      setFailure(null);
      void (async () => {
        try {
          await updateAgent(catalog, agent, signal);
          signal.throwIfAborted();
          onRefresh();
          // The process behind this conversation still runs the old
          // executable: reconnect to spawn the updated one, then send the
          // refused request again on it.
          session.reconnect();
          const outcome = await reconnected(session, signal);
          if (outcome === 'cancelled') return;
          if (outcome !== 'live') {
            setFailure(agentReconnectAfterUpdateFailure(label, outcome));
            return;
          }
          setCompleted(true);
          if (errorBlockId === undefined) return;
          setCompletedBlockId(errorBlockId);
          session.retry(errorBlockId);
        } catch (error) {
          if (!signal.aborted) setFailure(agentUpdateFailure(error));
        } finally {
          running.current = false;
          if (!signal.aborted) setBusy(false);
        }
      })();
    },
    [agent, catalog, onRefresh, requestSignal, session],
  );

  return useMemo(
    () => ({ busy, completed, completedBlockId, failure, label: agentLabel(agent), update }),
    [agent, busy, completed, completedBlockId, failure, update],
  );
}
