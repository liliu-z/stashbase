/** Restore presentation state for the server-bound project. Project entry is
 * owned by the entry receiver, through which main reopens the last session's
 * projects at launch; this saved state never chooses a project to open. */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand';

import type {
  ProjectRegistryPort,
  WorkspaceSessionPort,
} from '@/features/workspace/application/ports';
import { projectQuery } from '@/features/workspace/application/queries';
import {
  createWorkspaceSessionRuntime,
  type WorkspaceSessionRuntime,
} from '@/features/workspace/application/session-runtime';
import { restoreFolderSession, type FolderSessionState } from '@/features/workspace/domain/session';
import { useRetainedRuntime } from '@/shared/runtime/use-retained-runtime';

type WorkspaceSessionStatus =
  | { kind: 'restoring' }
  | { kind: 'ready'; restoredFolder: FolderSessionState | null };

export interface WorkspaceSessionController {
  mathMode: boolean;
  runtime: WorkspaceSessionRuntime;
  status: WorkspaceSessionStatus;
  shell: {
    agentPaneWidth: number;
    sidebarOpen: boolean;
    sidebarWidth: number;
  };
}

export function useWorkspaceSession(
  api: ProjectRegistryPort,
  persistence: WorkspaceSessionPort,
): WorkspaceSessionController {
  const runtime = useRetainedRuntime(
    () => createWorkspaceSessionRuntime(persistence),
    (session) => session.dispose(),
  );
  const state = useStore(runtime.store);
  const project = useQuery(projectQuery(api)).data;
  const memberPaths = useMemo(
    () => project?.projects.map((member) => member.path) ?? [],
    [project?.projects],
  );
  useEffect(() => {
    void runtime.restore();
  }, [runtime]);
  useEffect(() => {
    if (!project || state.restoreStatus !== 'ready') return;
    runtime.reconcileMembership(memberPaths);
    runtime.setActiveFolder(project.activeFolder?.path ?? null);
  }, [project, memberPaths, runtime, state.restoreStatus]);
  const arriving = !project?.activeFolder && state.snapshot.activeFolderPath !== null;
  const activeFolder = project?.activeFolder
    ? restoreFolderSession(state.snapshot, project.activeFolder.path)
    : null;
  return {
    mathMode: activeFolder?.mathMode ?? false,
    runtime,
    shell: arriving ? { ...state.snapshot.shell, sidebarOpen: false } : state.snapshot.shell,
    status:
      state.restoreStatus === 'loading'
        ? { kind: 'restoring' }
        : {
            kind: 'ready',
            restoredFolder: activeFolder,
          },
  };
}
