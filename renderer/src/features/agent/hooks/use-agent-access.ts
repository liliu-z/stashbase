/**
 * The first-send access gate's state: which Agent the prompt asks about, the
 * send it holds, and how the answer is going. A native runtime's answer can
 * take minutes, so the step the service reports and when the answer started
 * travel with it for the prompt to show.
 *
 * Only one dialog is ever open. The StashBase Agent's answer is the account's
 * own sign-in dialog, so the prompt hands over to it and steps aside, still
 * holding the send; it comes back only to say the sign-in did not finish.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';

import { connectAgent } from '@/features/agent/application/connect-agent';
import { agentAccessFailure } from '@/features/agent/application/failure-messages';
import type { AgentCatalogPort } from '@/features/agent/application/ports';
import type { AgentWorkspaceRuntime } from '@/features/agent/application/workspace-runtime';
import {
  DEFAULT_AGENT_ID,
  type Agent,
  type AgentPreparation,
} from '@/features/agent/domain/agent-catalog';
import { agentScopesEqual, type AgentId } from '@/features/agent/domain/session';
import { useRequestSignals } from '@/shared/runtime/use-request-signals';

/** A single explicit Send waits for access. Navigation or edits retire its consent. */
export function useAgentAccess({
  runtime,
  agents,
  catalog,
  onSignIn,
  onRefresh,
}: {
  runtime: AgentWorkspaceRuntime;
  agents: readonly Agent[];
  catalog: AgentCatalogPort;
  onSignIn(signal?: AbortSignal): void | Promise<boolean>;
  onRefresh(): void;
}) {
  // `access` spans a held send; `attempt` spans one answer to it, so stopping
  // an answer ends that lane and nothing more: the send stays held.
  const requestSignal = useRequestSignals<'access' | 'attempt'>();
  const activeId = useStore(runtime.store, (state) => state.activeId);
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** When the answer started, and the step the service reports it is on. */
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [preparation, setPreparation] = useState<AgentPreparation | null>(null);
  /** The Agent the open prompt is about. It outlives the prompt so the panel
   *  keeps its own words while it animates away. */
  const [agent, setAgent] = useState<AgentId>(DEFAULT_AGENT_ID);
  const pending = useRef<null | {
    session: ReturnType<AgentWorkspaceRuntime['activeSession']>;
    snapshot: ReturnType<ReturnType<AgentWorkspaceRuntime['activeSession']>['store']['getState']>;
    busy?: boolean;
    /** The service is still retiring a stopped sign-in. */
    stopping?: boolean;
    text: string;
    options?: { queuedId?: string };
    signal: AbortSignal;
  }>(null);
  const cancel = useCallback(() => {
    requestSignal('access');
    pending.current = null;
    setOpen(false);
    setWorking(false);
    setFailure(null);
    setStartedAt(null);
    setPreparation(null);
  }, [requestSignal]);
  useEffect(() => {
    const check = () => {
      const workspace = runtime.store.getState();
      const request = pending.current;
      if (!request) return;
      const live = request.session.store.getState();
      if (
        workspace.activeId !== request.session.id ||
        live.agent !== request.snapshot.agent ||
        !agentScopesEqual(live.scope, request.snapshot.scope) ||
        live.draft !== request.snapshot.draft ||
        live.context !== request.snapshot.context ||
        live.skill !== request.snapshot.skill ||
        live.connection.kind === 'retired'
      )
        cancel();
    };
    const unsubscribe = runtime.store.subscribe(check);
    const unsubscribeSession = runtime.activeSession().store.subscribe(check);
    return () => {
      unsubscribe();
      unsubscribeSession();
      requestSignal('access');
      pending.current = null;
    };
  }, [runtime, activeId, requestSignal, cancel]);

  const send = (text: string, options?: { queuedId?: string }) => {
    if (pending.current) return;
    const session = runtime.activeSession();
    const snapshot = session.store.getState();
    if (agents.some((entry) => entry.id === snapshot.agent && entry.ready)) {
      void session.sendPrompt(text, options);
      return;
    }
    pending.current = {
      session,
      snapshot,
      text,
      ...(options ? { options } : {}),
      signal: requestSignal('access'),
    };
    setAgent(snapshot.agent);
    setFailure(null);
    setOpen(true);
  };

  /** Answer the prompt for the Agent it asked about: the account for the
   *  bundled runtime, installation and provider sign-in for a native one. */
  const confirm = async () => {
    const request = pending.current;
    if (!request || request.busy) return;
    request.busy = true;
    const chosen = request.snapshot.agent;
    const attempt = requestSignal('attempt');
    setWorking(true);
    setFailure(null);
    setStartedAt(Date.now());
    setPreparation(null);
    const signal = AbortSignal.any([request.signal, request.session.signal, attempt]);
    try {
      // Persist the explicit choice, keeping cancellation active across the write.
      const selected = await runtime.chooseAgent(chosen);
      signal.throwIfAborted();
      if (!selected || runtime.activeSession() !== request.session)
        throw new Error('Your agent choice could not be applied.');
      request.snapshot = request.session.store.getState();
      let ready = agents.find((entry) => entry.id === chosen)?.ready === true;
      if (!ready && chosen === DEFAULT_AGENT_ID) {
        // The account's dialog asks how to sign in; this one steps aside
        // rather than staying open underneath it.
        setOpen(false);
        if (!(await onSignIn(signal))) throw new Error('Sign-in was not completed.');
      } else if (!ready) {
        const entry = agents.find((candidate) => candidate.id === chosen);
        await connectAgent(catalog, chosen, entry, signal, {
          onStep: (step) => {
            if (pending.current === request && !signal.aborted) setPreparation(step);
          },
        });
        ready = true;
      }
      signal.throwIfAborted();
      if (!ready) {
        const refreshed = await catalog.listAgents(signal);
        ready = refreshed.agents.some((candidate) => candidate.id === chosen && candidate.ready);
      }
      signal.throwIfAborted();
      onRefresh();
      if (!ready) throw new Error('This agent is not ready yet.');
      if (pending.current !== request) return;
      pending.current = null;
      setOpen(false);
      setWorking(false);
      setPreparation(null);
      await request.session.sendPrompt(request.text, request.options);
    } catch (error) {
      if (signal.aborted) return;
      request.busy = false;
      setWorking(false);
      setStartedAt(null);
      setPreparation(null);
      // The prompt stays, or comes back from a hand-off, with what stopped:
      // a failure that closed it would leave the reader guessing whether
      // their message went anywhere.
      setFailure(agentAccessFailure(error));
      setOpen(true);
    }
  };

  /** Stops waiting on the browser for this send's runtime. The send stays
   *  held and the prompt returns to its question: only Not now drops it. The
   *  answer stays busy until the service has retired the runtime's own
   *  sign-in, so the next answer starts a new one rather than joining the
   *  stopped one. */
  const stopWaiting = () => {
    const request = pending.current;
    if (!request?.busy || request.stopping) return;
    requestSignal('attempt');
    request.stopping = true;
    setStartedAt(null);
    setPreparation(null);
    const settle = () => {
      request.stopping = false;
      request.busy = false;
      if (pending.current !== request) return;
      setWorking(false);
      onRefresh();
    };
    void catalog.prepareAgent(request.snapshot.agent, 'stop', request.signal).then(settle, settle);
  };

  /** Whether the only thing missing is a sign-in, as for an expired runtime,
   *  rather than a setup that may install it first. */
  const needsSignIn = agents.some((entry) => entry.id === agent && entry.needsSignIn);
  return {
    agent,
    open,
    working,
    startedAt,
    preparation,
    failure,
    needsSignIn,
    send,
    confirm,
    cancel,
    stopWaiting,
  };
}
