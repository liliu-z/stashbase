/** One window owns conversation identity, history operations, and project visits. */
import { createStore } from 'zustand/vanilla';

import {
  createAgentSessionRuntime,
  type AgentSessionRuntime,
} from '@/features/agent/application/session-runtime';
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
import type {
  AgentWorkspaceRuntime,
  AgentWorkspaceRuntimeOptions,
} from './workspace-runtime-contract';
import { syncAgentTab } from './workspace-tabs';

export type { AgentWorkspaceRuntime, AgentWorkspaceRuntimeOptions };

type AgentWorkspaceScope = { readonly folderPath: string | null };

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
  voice,
}: AgentWorkspaceRuntimeOptions): AgentWorkspaceRuntime {
  const sessions = new Map<string, MountedAgentSession>();
  const controller = new AbortController();
  const projectAgents = createProjectAgents(preferencesPort, controller.signal);
  const preferred = (scope: AgentScope) => projectAgents.get(scope);
  const restorations = new Map<string, Promise<boolean>>();
  const pinnedAgents = new Set<string>(); // a late preferences read never moves these
  let folderPath = initialFolderPath;
  let disposed = false;
  let started = autostart;
  let readyAgentIds = new Set<AgentId>();

  const initialId = createId();
  const store = createStore<AgentWorkspaceState>(() => createAgentWorkspaceState(initialId));
  const stopVoiceOnNavigation = store.subscribe((state, previous) => {
    if (state.activeId !== previous.activeId)
      void sessions.get(previous.activeId)?.runtime.voice?.stop();
  });

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
      onModelChange: projectAgents.rememberModel,
      port,
      recordUsage,
      scheduler,
      scope,
      title,
      ...(voice ? { voice } : {}),
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
        if (!pinnedAgents.has(session.id)) projectAgents.apply(session);
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
      else if (agent !== current.agent) projectAgents.seedRuntimeChoices(session);
      return true;
    },
    activate(id) {
      if (!disposed && sessions.has(id))
        store.setState((state) => activateAgentTab(state, id), true);
    },
    visit(direction) {
      if (disposed) return;
      const state = store.getState();
      const index = agentVisitTarget(state, direction);
      const id = index === null ? undefined : state.visits[index];
      if (id && index !== null)
        store.setState({ activeId: id, surface: 'chat', visitIndex: index });
    },
    activeSession() {
      const mounted = sessions.get(store.getState().activeId);
      if (!mounted) throw new Error('Agent workspace has no active session.');
      return mounted.runtime;
    },
    close(id) {
      if (disposed || !sessions.has(id)) return;
      const dictation = sessions.get(id)?.runtime.voice;
      if (dictation?.hasRecording() || dictation?.hasUnsentDraft()) {
        void dictation.stop();
        dictation.store.setState({
          error: 'Your voice draft was kept. Send or clear it before closing this chat.',
        });
        return;
      }
      if (sessions.size === 1) {
        pinnedAgents.delete(id);
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
      pinnedAgents.delete(id);
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
      stopVoiceOnNavigation();
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
    startBackgroundChat({ agent, scope, title }) {
      const id = createId();
      if (disposed || !id.trim() || sessions.has(id)) throw new Error('Cannot start a chat.');
      const { runtime: session } = mountSession(id, agent, scope, false, title);
      pinnedAgents.add(id);
      session.rename(title); // as the reader renaming it: automatic naming never replaces it
      return session;
    },
    preferredAgent: preferred,
    showScheduledTasks(open) {
      if (disposed || store.getState().surface === (open ? 'scheduled-tasks' : 'chat')) return;
      store.setState({ surface: open ? 'scheduled-tasks' : 'chat' });
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
    voiceSessions: () =>
      [...sessions.values()]
        .map((mounted) => mounted.runtime)
        .filter((session) => Boolean(session.voice)),
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
      void sessions.get(store.getState().activeId)?.runtime.voice?.stop();
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
