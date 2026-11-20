/** Explicit project choices seed new chats and agent switches; native history
 *  and catalog fallback never overwrite the remembered preferences. */
import { createStore } from 'zustand/vanilla';

import type {
  AgentPreferencesPort,
  ProjectAgentPreference,
} from '@/features/agent/application/ports';
import { DEFAULT_AGENT_ID } from '@/features/agent/domain/agent-catalog';
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
  let defaultAgent: AgentId = DEFAULT_AGENT_ID;
  let defaultModels: ProjectAgentPreference['models'];
  let defaultEfforts: ProjectAgentPreference['efforts'];
  const preferred = (scope: AgentScope) => choices.get(agentScopeKey(scope))?.agent ?? defaultAgent;
  let loading: Promise<boolean> | null = null;
  let saving = false;
  let pendingSave = Promise.resolve(true);
  const seedRuntimeChoices = (session: AgentSessionRuntime) => {
    const state = session.store.getState();
    const preference = choices.get(agentScopeKey(state.scope));
    // Null is an explicit reset to the native default, not an absent project choice.
    const model = { ...defaultModels, ...preference?.models }[state.agent] ?? null;
    const effort = { ...defaultEfforts, ...preference?.efforts }[state.agent] ?? null;
    session.store.setState({ model, effort });
  };
  const save = (
    scope: AgentScope,
    agent: AgentId,
    change?: Parameters<AgentPreferencesPort['save']>[3],
  ) => {
    pendingSave = pendingSave.then(async () => {
      if (signal.aborted) return false;
      try {
        await port?.save(scope, agent, signal, change);
        signal.throwIfAborted();
        return true;
      } catch {
        if (!signal.aborted)
          store.setState({ failure: 'Could not save your agent settings. Your message was kept.' });
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
      .then(
        ({ defaultAgent: inherited, defaultModels: models, defaultEfforts: efforts, projects }) => {
          signal.throwIfAborted();
          defaultAgent = inherited;
          defaultModels = models;
          defaultEfforts = efforts;
          choices.clear();
          for (const entry of projects) choices.set(entry.scope, entry);
          return true;
        },
      )
      .catch(() => {
        if (!signal.aborted)
          store.setState({ failure: 'Could not load your agent settings. Retry before sending.' });
        return false;
      })
      .finally(() => {
        loading = null;
        store.setState({ loading: false });
      });
    return loading;
  };
  const remember = (
    scope: AgentScope,
    agent: AgentId,
    change: { model?: string | null; effort?: string | null },
  ) => {
    if (signal.aborted || store.getState().loading || store.getState().failure) return;
    const key = agentScopeKey(scope);
    const previous = choices.get(key);
    choices.set(key, {
      ...previous,
      scope: key,
      agent: previous?.agent ?? agent,
      ...(change.model === undefined
        ? {}
        : { models: { ...previous?.models, [agent]: change.model } }),
      ...(change.effort === undefined
        ? {}
        : { efforts: { ...previous?.efforts, [agent]: change.effort } }),
    });
    if (change.model !== undefined) defaultModels = { ...defaultModels, [agent]: change.model };
    if (change.effort !== undefined) defaultEfforts = { ...defaultEfforts, [agent]: change.effort };
    void save(scope, agent, change);
  };
  return {
    store,
    load,
    seedRuntimeChoices,
    /** What a new or reused Chat starts from: its project's model and effort. */
    seed(session: AgentSessionRuntime) {
      seedRuntimeChoices(session);
    },
    apply(session: AgentSessionRuntime) {
      const state = session.store.getState();
      if (!agentSessionIsUnstarted(state)) return;
      const agent = preferred(state.scope);
      if (state.agent !== agent) session.changeAgent(agent);
      seedRuntimeChoices(session);
    },
    get: preferred,
    rememberEffort(scope: AgentScope, agent: AgentId, effort: string | null) {
      remember(scope, agent, { effort });
    },
    rememberModel(scope: AgentScope, agent: AgentId, model: string | null) {
      remember(scope, agent, { model });
    },
    async select(scope: AgentScope, agent: AgentId): Promise<boolean> {
      if (saving || signal.aborted || store.getState().loading || store.getState().failure)
        return false;
      saving = true;
      try {
        if (!(await save(scope, agent))) return false;
        const key = agentScopeKey(scope);
        choices.set(key, { ...choices.get(key), scope: key, agent });
        defaultAgent = agent;
        return true;
      } finally {
        saving = false;
      }
    },
  };
}
