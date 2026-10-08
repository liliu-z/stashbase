/** One window owns conversation identity, history operations, and project visits. */
import { createStore, type StoreApi } from 'zustand/vanilla';

import type {
  AgentContextPort,
  AgentPreferencesPort,
  AgentReconnectScheduler,
  AgentSessionPort,
} from '@/features/agent/application/ports';
import {
  createAgentSessionRuntime,
  type AgentFilesChanged,
  type AgentSessionRuntime,
} from '@/features/agent/application/session-runtime';
import type { AgentUsageEvent } from '@/features/agent/application/session/usage';
import type { AgentScopeEnvironment } from '@/features/agent/domain/context';
import type { AgentHistoryEntry } from '@/features/agent/domain/conversation-history';
import {
  agentScopesEqual,
  agentSessionIsUnstarted,
  scopeForWindowFolder,
  UNTITLED_CHAT_TITLE,
  type AgentId,
  type AgentScope,
} from '@/features/agent/domain/session';
import {
  activateAgentTab,
  agentVisitTarget,
  createAgentWorkspaceState,
  disposeAgentWorkspace,
  removeAgentTab,
  type AgentWorkspaceState,
} from '@/features/agent/domain/workspace';
import { createScopeGuard } from '@/shared/runtime/scope-guard';

import { createProjectAgents } from './project-agents';
import { syncAgentTab } from './workspace-tabs';

type AgentWorkspaceScope = { readonly folderPath: string | null };

export interface AgentWorkspaceRuntime {
  readonly store: StoreApi<AgentWorkspaceState>;
  readonly preferences: ReturnType<typeof createProjectAgents>['store'];
  loadPreferences(): Promise<void>;
  chooseAgent(agent: AgentId): Promise<boolean>;
  choosePersona(persona: string | null): boolean;
  activate(id: string): void;
  visit(direction: -1 | 1): void;
  activeSession(): AgentSessionRuntime;
  close(id: string): void;
  dispose(): void;
  listHistory(agent: AgentId, scope: AgentScope, signal: AbortSignal): Promise<AgentHistoryEntry[]>;
  newChat(agent?: AgentId, scope?: AgentScope): AgentSessionRuntime;
  removeHistory(entry: AgentHistoryEntry, signal: AbortSignal): Promise<void>;
  renameHistory(
    entry: AgentHistoryEntry,
    title: string,
    signal: AbortSignal,
  ): Promise<AgentHistoryEntry>;
  restore(entry: AgentHistoryEntry): Promise<boolean>;
  retireFolder(folderPath: string): void;
  session(id: string): AgentSessionRuntime | null;
  start(availableAgents?: readonly AgentId[]): void;
  startActive(): void;
  setScopeEnvironment(environment: AgentScopeEnvironment | null): void;
  setWindowFolder(folderPath: string | null): void;
}

export interface AgentWorkspaceRuntimeOptions {
  recordUsage?: ((event: AgentUsageEvent) => void) | undefined;
  autostart?: boolean | undefined;
  context?: AgentContextPort | undefined;
  createId(): string;
  folderPath: string | null;
  initialAgent?: AgentId | undefined;
  preferences?: AgentPreferencesPort | undefined;
  onFilesChanged?: ((change: AgentFilesChanged) => void) | undefined;
  port: AgentSessionPort;
  scheduler?: AgentReconnectScheduler | undefined;
}

interface MountedAgentSession {
  followsWindow: boolean;
  runtime: AgentSessionRuntime;
  unsubscribe(): void;
}

function boundTo({ runtime }: MountedAgentSession, entry: AgentHistoryEntry): boolean {
  const { agent, nativeSessionId, scope } = runtime.store.getState();
  return (
    agent === entry.agent && nativeSessionId === entry.id && agentScopesEqual(scope, entry.scope)
  );
}

export function createAgentWorkspaceRuntime({
  autostart = true,
  context,
  createId,
  folderPath: initialFolderPath,
  initialAgent,
  preferences: preferencesPort,
  onFilesChanged,
  recordUsage,
  port,
  scheduler,
}: AgentWorkspaceRuntimeOptions): AgentWorkspaceRuntime {
  const sessions = new Map<string, MountedAgentSession>();
  const controller = new AbortController();
  const projectAgents = createProjectAgents(preferencesPort, controller.signal);
  const preferred = (scope: AgentScope) => projectAgents.get(scope);
  const restorations = new Map<string, Promise<boolean>>();
  let folderPath = initialFolderPath;
  let disposed = false;
  let started = autostart;
  let readyAgentIds = new Set<AgentId>();

  const initialId = createId();
  const store = createStore<AgentWorkspaceState>(() => createAgentWorkspaceState(initialId));

  const operationSignal = (signal: AbortSignal) => AbortSignal.any([controller.signal, signal]);

  const guard = createScopeGuard<AgentWorkspaceScope>({
    disposed: () => disposed,
    sameScope: (captured, live) => captured.folderPath === live.folderPath,
    scope: () => ({ folderPath }),
  });

  const syncTab = (id: string) => {
    const session = sessions.get(id)?.runtime;
    if (session) syncAgentTab(store, id, session);
  };

  const mountSession = (
    id: string,
    agent: AgentId,
    scope: AgentScope,
    followsWindow: boolean,
    title = UNTITLED_CHAT_TITLE,
  ): MountedAgentSession => {
    const previous = sessions.get(id);
    previous?.unsubscribe();
    previous?.runtime.dispose();
    const session = createAgentSessionRuntime({
      agent,
      autostart: false,
      context,
      environment: () => {
        const environment = store.getState().scopeEnvironment;
        const sessionScope = sessions.get(id)?.runtime.store.getState().scope ?? scope;
        return environment &&
          sessionScope.kind === 'folder' &&
          environment.folderPath === sessionScope.path
          ? {
              listing: environment.listing,
              readiness: environment.readiness,
              versions: environment.versions,
            }
          : null;
      },
      id,
      onFilesChanged,
      onEffortChange: projectAgents.rememberEffort,
      port,
      recordUsage,
      scheduler,
      scope,
      title,
    });
    projectAgents.seed(session);
    const mounted: MountedAgentSession = {
      followsWindow,
      runtime: session,
      unsubscribe: session.store.subscribe(() => syncTab(id)),
    };
    sessions.set(id, mounted);
    syncTab(id);
    return mounted;
  };

  if (folderPath)
    mountSession(
      initialId,
      initialAgent ?? preferred(scopeForWindowFolder(folderPath)),
      scopeForWindowFolder(folderPath),
      true,
    );

  const runtime: AgentWorkspaceRuntime = {
    store,
    preferences: projectAgents.store,
    async loadPreferences() {
      if (!preferencesPort || !(await projectAgents.load()) || disposed) return;
      for (const { runtime: session } of sessions.values()) {
        projectAgents.apply(session);
      }
    },
    async chooseAgent(agent) {
      const session = runtime.activeSession();
      const before = session.store.getState();
      if (!(await projectAgents.select(before.scope, agent)) || disposed) return false;
      const current = session.store.getState();
      if (
        runtime.activeSession() !== session ||
        current.agent !== before.agent ||
        !agentScopesEqual(current.scope, before.scope)
      )
        return false;
      if (agent !== current.agent && !session.changeAgent(agent))
        runtime.newChat(agent, current.scope);
      else if (agent !== current.agent) projectAgents.seedEffort(session);
      return true;
    },
    choosePersona: (persona) => !disposed && projectAgents.choose(runtime.activeSession(), persona),
    activate(id) {
      if (!disposed && sessions.has(id))
        store.setState((state) => activateAgentTab(state, id), true);
    },
    visit(direction) {
      if (disposed) return;
      const state = store.getState();
      const index = agentVisitTarget(state, direction);
      const id = index === null ? undefined : state.visits[index];
      if (id && index !== null) store.setState({ activeId: id, visitIndex: index });
    },
    activeSession() {
      const mounted = sessions.get(store.getState().activeId);
      if (!mounted) throw new Error('Agent workspace has no active session.');
      return mounted.runtime;
    },
    close(id) {
      if (disposed || !sessions.has(id)) return;
      if (sessions.size === 1) {
        mountSession(
          id,
          preferred(scopeForWindowFolder(folderPath)),
          scopeForWindowFolder(folderPath),
          true,
        );
        return;
      }
      const wasActive = store.getState().activeId === id;
      const mounted = sessions.get(id);
      mounted?.unsubscribe();
      mounted?.runtime.dispose();
      sessions.delete(id);
      const visibleScope = scopeForWindowFolder(folderPath);
      const nextWorkspace = removeAgentTab(store.getState(), id, visibleScope);
      store.setState(nextWorkspace, true);
      if (wasActive && !nextWorkspace.activeId) {
        mountSession(id, preferred(visibleScope), visibleScope, true);
        store.setState((state) => activateAgentTab(state, id), true);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      for (const mounted of sessions.values()) {
        mounted.unsubscribe();
        mounted.runtime.dispose();
      }
      sessions.clear();
      store.setState((state) => disposeAgentWorkspace(state), true);
    },
    listHistory(agent, scope, signal) {
      return port.list(agent, scope, operationSignal(signal));
    },
    newChat(agent, scope?: AgentScope) {
      if (disposed) throw new Error('Agent workspace is disposed.');
      const followsCurrentFolder = scope === undefined;
      const nextScope = scope ?? scopeForWindowFolder(folderPath);
      agent ??= preferred(nextScope);
      const blank = [...sessions.values()].find(({ runtime: session }) => session.isBlank());
      const id = blank?.runtime.id ?? createId();
      if (!id.trim() || (!blank && sessions.has(id)))
        throw new Error('Agent tab ids must be non-empty and unique.');
      const existing = blank?.runtime.store.getState();
      const mounted =
        blank && existing?.agent === agent && agentScopesEqual(existing.scope, nextScope)
          ? blank
          : mountSession(id, agent, nextScope, followsCurrentFolder);
      mounted.followsWindow = followsCurrentFolder;
      projectAgents.seed(mounted.runtime);
      store.setState((state) => activateAgentTab(state, id), true);
      return mounted.runtime;
    },
    async removeHistory(entry, signal) {
      const captured = guard.capture();
      await port.remove(entry, operationSignal(signal));
      guard.accept(captured, () => {
        for (const [id, mounted] of sessions) {
          if (boundTo(mounted, entry)) runtime.close(id);
        }
      });
    },
    async renameHistory(entry, title, signal) {
      const captured = guard.capture();
      const updated = await port.rename(entry, title, operationSignal(signal));
      guard.accept(captured, () => {
        for (const mounted of sessions.values()) {
          if (boundTo(mounted, entry)) mounted.runtime.rename(updated.title);
        }
      });
      return updated;
    },
    async restore(entry) {
      const key = JSON.stringify([entry.agent, entry.scope, entry.id]);
      const existing = [...sessions.values()].find((mounted) => boundTo(mounted, entry));
      if (existing) {
        runtime.activate(existing.runtime.id);
        return restorations.get(key) ?? true;
      }
      const pending = restorations.get(key);
      if (pending) return pending;
      const session = runtime.newChat(entry.agent, entry.scope);
      const restore = session.restore(entry, readyAgentIds.has(entry.agent));
      restorations.set(key, restore);
      try {
        return await restore;
      } finally {
        restorations.delete(key);
      }
    },
    retireFolder(retiredFolderPath) {
      if (disposed) return;
      guard.retireOperations();
      for (const mounted of sessions.values()) {
        const session = mounted.runtime;
        const state = session.store.getState();
        if (state.scope.kind !== 'folder' || state.scope.path !== retiredFolderPath) continue;
        session.retire(retiredFolderPath);
      }
    },
    session(id) {
      return sessions.get(id)?.runtime ?? null;
    },
    start(availableAgents) {
      if (disposed) return;
      if (availableAgents) readyAgentIds = new Set(availableAgents);
      started = true;
      for (const { runtime: session } of sessions.values()) {
        const state = session.store.getState();
        if (!agentSessionIsUnstarted(state) && readyAgentIds.has(state.agent)) session.start();
      }
    },
    startActive() {
      if (disposed || !started) return;
      sessions.get(store.getState().activeId)?.runtime.start();
    },
    setScopeEnvironment(environment) {
      if (disposed || store.getState().scopeEnvironment === environment) return;
      store.setState((state) => ({ ...state, scopeEnvironment: environment }), true);
    },
    setWindowFolder(nextFolderPath) {
      if (disposed || nextFolderPath === folderPath) return;
      folderPath = nextFolderPath;
      if (!folderPath) return;
      if (!sessions.size) {
        runtime.newChat();
        return;
      }
      for (const [id, mounted] of sessions) {
        if (!mounted.followsWindow) continue;
        const session = mounted.runtime;
        if (!session.isBlank()) {
          mounted.followsWindow = false;
          continue;
        }
        mountSession(
          id,
          preferred(scopeForWindowFolder(folderPath)),
          scopeForWindowFolder(folderPath),
          true,
        );
      }
      const nextScope = scopeForWindowFolder(folderPath);
      const current = runtime.activeSession().store.getState();
      const scopedTabs = store
        .getState()
        .tabs.filter((tab) => agentScopesEqual(tab.scope, nextScope));
      const retained = scopedTabs.findLast((tab) => !tab.blank);
      if (retained) {
        store.setState((state) => activateAgentTab(state, retained.id), true);
        return;
      }
      if (agentScopesEqual(current.scope, nextScope)) return;
      const matching = scopedTabs.at(-1);
      if (matching) {
        store.setState((state) => activateAgentTab(state, matching.id), true);
        return;
      }
      runtime.newChat();
    },
  };

  return runtime;
}
