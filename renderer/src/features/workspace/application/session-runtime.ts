import { createStore, type StoreApi } from 'zustand/vanilla';

import type { WorkspaceSessionPort } from '@/features/workspace/application/ports';
import {
  createWorkspaceSessionSnapshot,
  normalizeWorkspaceSession,
  reconcileSessionMembership,
  recordFolderSession,
  setSessionActiveFolder,
  setSessionAgentPaneWidth,
  setSessionMathMode,
  setSessionSidebarOpen,
  setSessionSidebarWidth,
  type WorkspaceDocumentSession,
  type WorkspaceSessionSnapshot,
} from '@/features/workspace/domain/session';
import type { WorkspaceState } from '@/features/workspace/domain/workspace';

interface WorkspaceSessionRuntimeState {
  lifecycle: 'active' | 'disposed';
  restoreStatus: 'loading' | 'ready';
  snapshot: WorkspaceSessionSnapshot;
}

export interface WorkspaceSessionRuntime {
  readonly store: StoreApi<WorkspaceSessionRuntimeState>;
  dispose(): void;
  flush(): Promise<void>;
  reconcileMembership(memberPaths: readonly string[]): void;
  recordWorkspace(workspace: WorkspaceState, documents?: WorkspaceDocumentSession): void;
  restore(): Promise<void>;
  setActiveFolder(folderPath: string | null): void;
  setAgentPaneWidth(width: number): void;
  setMathMode(folderPath: string, enabled: boolean): void;
  setSidebarOpen(open: boolean): void;
  setSidebarWidth(width: number): void;
}

export function createWorkspaceSessionRuntime(
  persistence: WorkspaceSessionPort,
): WorkspaceSessionRuntime {
  const store = createStore<WorkspaceSessionRuntimeState>(() => ({
    lifecycle: 'active',
    restoreStatus: 'loading',
    snapshot: createWorkspaceSessionSnapshot(),
  }));
  let disposed = false;
  let shellChangedBeforeRestore = false;
  let restorePromise: Promise<void> | null = null;
  let pendingSave: WorkspaceSessionSnapshot | null = null;
  let saveLoop: Promise<void> | null = null;

  const drainSaves = () => {
    if (saveLoop) return saveLoop;
    saveLoop = (async () => {
      while (pendingSave) {
        const next = pendingSave;
        pendingSave = null;
        try {
          await persistence.save(next);
        } catch {
          // Session persistence is best effort and cannot make the workspace unusable.
        }
      }
    })().finally(() => {
      saveLoop = null;
      if (pendingSave) void drainSaves();
    });
    return saveLoop;
  };

  const queueSave = (snapshot: WorkspaceSessionSnapshot) => {
    if (disposed || store.getState().restoreStatus !== 'ready') return;
    pendingSave = snapshot;
    void drainSaves();
  };

  const update = (transition: (snapshot: WorkspaceSessionSnapshot) => WorkspaceSessionSnapshot) => {
    if (disposed) return;
    const current = store.getState();
    const snapshot = transition(current.snapshot);
    if (snapshot === current.snapshot) return;
    store.setState({ ...current, snapshot });
    queueSave(snapshot);
  };

  return {
    store,
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingSave = null;
      store.setState((state) => ({ ...state, lifecycle: 'disposed' }));
    },
    async flush() {
      await drainSaves();
    },
    reconcileMembership(memberPaths) {
      update((snapshot) => reconcileSessionMembership(snapshot, memberPaths));
    },
    recordWorkspace(workspace, documents) {
      if (workspace.lifecycle !== 'active') return;
      update((snapshot) => recordFolderSession(snapshot, workspace, documents));
    },
    restore() {
      if (restorePromise) return restorePromise;
      restorePromise = (async () => {
        let restored: WorkspaceSessionSnapshot | null = null;
        try {
          restored = await persistence.load();
        } catch {
          // A missing or unreadable presentation snapshot falls back to defaults.
        }
        if (disposed) return;
        const current = store.getState();
        const normalized = normalizeWorkspaceSession(restored ?? createWorkspaceSessionSnapshot());
        store.setState({
          ...current,
          restoreStatus: 'ready',
          snapshot: shellChangedBeforeRestore
            ? { ...normalized, shell: current.snapshot.shell }
            : normalized,
        });
      })();
      return restorePromise;
    },
    setActiveFolder(folderPath) {
      update((snapshot) => setSessionActiveFolder(snapshot, folderPath));
    },
    setAgentPaneWidth(width) {
      if (store.getState().restoreStatus === 'loading') shellChangedBeforeRestore = true;
      update((snapshot) => setSessionAgentPaneWidth(snapshot, width));
    },
    setMathMode(folderPath, enabled) {
      update((snapshot) => setSessionMathMode(snapshot, folderPath, enabled));
    },
    setSidebarOpen(open) {
      if (store.getState().restoreStatus === 'loading') shellChangedBeforeRestore = true;
      update((snapshot) => setSessionSidebarOpen(snapshot, open));
    },
    setSidebarWidth(width) {
      if (store.getState().restoreStatus === 'loading') shellChangedBeforeRestore = true;
      update((snapshot) => setSessionSidebarWidth(snapshot, width));
    },
  };
}
