import { createStore } from 'zustand/vanilla';

import type {
  AgentPreferencesPort,
  ProjectAgentPreference,
} from '@/features/agent/application/ports';
import { DEFAULT_AGENT_ID } from '@/features/agent/domain/agent-catalog';
import { supportedEffort } from '@/features/agent/domain/model-choice';
import {
  agentScopeKey,
  agentSessionIsUnstarted,
  type AgentId,
  type AgentScope,
} from '@/features/agent/domain/session';

import type { AgentSessionRuntime } from './session-runtime';

/** One cache of explicit project choices; failed reads never become saved defaults. */
export function createProjectAgents(port: AgentPreferencesPort | undefined, signal: AbortSignal) {
  const store = createStore(() => ({ loading: Boolean(port), failure: null as string | null }));
  const choices = new Map<string, ProjectAgentPreference>();
  let loading: Promise<boolean> | null = null;
  let saving = false;
  let pendingSave = Promise.resolve(true);
  const seedEffort = (session: AgentSessionRuntime) => {
    const state = session.store.getState();
    const effort = choices.get(agentScopeKey(state.scope))?.efforts?.[state.agent] ?? null;
    session.store.setState({ effort: supportedEffort(state, effort) });
  };
  /** A new Chat starts with its project's persona; a started one keeps the
   *  persona it already runs under. */
  const seedPersona = (session: AgentSessionRuntime) => {
    const state = session.store.getState();
    if (!agentSessionIsUnstarted(state)) return;
    const persona = choices.get(agentScopeKey(state.scope))?.persona ?? null;
    if (state.persona !== persona) session.store.setState({ persona });
  };
  const save = (
    scope: AgentScope,
    agent: AgentId,
    change?: { effort?: string | null; persona?: string | null },
  ) => {
    pendingSave = pendingSave.then(async () => {
      if (signal.aborted) return false;
      try {
        await port?.save(scope, agent, signal, change);
        signal.throwIfAborted();
        return true;
      } catch {
        if (!signal.aborted)
          store.setState({ failure: 'Could not save your Agent settings. Your message was kept.' });
        return false;
      }
    });
    return pendingSave;
  };
  const load = (): Promise<boolean> => {
    if (!port) return Promise.resolve(true);
    if (loading) return loading;
    store.setState({ loading: true, failure: null });
    loading = pendingSave
      .then(() => port.load(signal))
      .then((entries) => {
        signal.throwIfAborted();
        choices.clear();
        for (const entry of entries) choices.set(entry.scope, entry);
        return true;
      })
      .catch(() => {
        if (!signal.aborted)
          store.setState({ failure: 'Could not load your Agent settings. Retry before sending.' });
        return false;
      })
      .finally(() => {
        loading = null;
        store.setState({ loading: false });
      });
    return loading;
  };
  return {
    store,
    load,
    seedEffort,
    /** What a new or reused Chat starts from: its project's effort and persona. */
    seed(session: AgentSessionRuntime) {
      seedEffort(session);
      seedPersona(session);
    },
    apply(session: AgentSessionRuntime) {
      const state = session.store.getState();
      if (!agentSessionIsUnstarted(state)) return;
      const agent = choices.get(agentScopeKey(state.scope))?.agent ?? DEFAULT_AGENT_ID;
      if (state.agent !== agent) session.changeAgent(agent);
      seedEffort(session);
      seedPersona(session);
    },
    get: (scope: AgentScope) => choices.get(agentScopeKey(scope))?.agent ?? DEFAULT_AGENT_ID,
    rememberEffort(scope: AgentScope, agent: AgentId, effort: string | null) {
      if (signal.aborted || store.getState().loading || store.getState().failure) return;
      const key = agentScopeKey(scope);
      const previous = choices.get(key);
      choices.set(key, {
        scope: key,
        agent: previous?.agent ?? agent,
        efforts: { ...previous?.efforts, [agent]: effort },
      });
      void save(scope, agent, { effort });
    },
    /** Runs a Chat under a persona, or none. A persona chosen in any Chat
     *  becomes the one this project's next new Chat starts with. Refused while
     *  the Chat's turn runs. */
    choose(session: AgentSessionRuntime, persona: string | null): boolean {
      if (!session.setPersona(persona)) return false;
      const { agent, scope } = session.store.getState();
      if (signal.aborted || store.getState().loading || store.getState().failure) return true;
      const key = agentScopeKey(scope);
      const previous = choices.get(key);
      if ((previous?.persona ?? null) === persona) return true;
      choices.set(key, { ...previous, scope: key, agent: previous?.agent ?? agent, persona });
      void save(scope, agent, { persona });
      return true;
    },
    async select(scope: AgentScope, agent: AgentId): Promise<boolean> {
      if (saving || signal.aborted || store.getState().loading || store.getState().failure)
        return false;
      saving = true;
      try {
        if (!(await save(scope, agent))) return false;
        const key = agentScopeKey(scope);
        choices.set(key, { ...choices.get(key), scope: key, agent });
        return true;
      } finally {
        saving = false;
      }
    },
  };
}
