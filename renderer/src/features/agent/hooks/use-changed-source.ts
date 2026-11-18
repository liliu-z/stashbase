import { useMemo } from 'react';
import { useStore } from 'zustand';

import type { AgentWorkspaceRuntime } from '@/features/agent/application/workspace-runtime';
import { changedSource } from '@/features/agent/domain/file-change';
import type { AgentScope } from '@/features/agent/domain/session';

/** Resolves a path a turn changed to the project source it names, only while
 *  the scope's listing still holds that file. */
export function useChangedSource(runtime: AgentWorkspaceRuntime, scope: AgentScope) {
  const environment = useStore(runtime.store, (state) => state.scopeEnvironment);
  return useMemo(
    () => (path: string) => {
      const source = changedSource(scope, path);
      return source &&
        environment?.folderPath === source.folderPath &&
        environment.listing.files.some((file) => file.path === source.path)
        ? source
        : null;
    },
    [scope, environment],
  );
}

/** Names a path a turn touched by its place in the project, whether or not
 *  the file exists now: a file about to be created or just deleted still has
 *  a project folder. Labels use this; opening a file still needs
 *  `useChangedSource`, which also requires the file to be listed. */
export function useProjectPathFor(scope: AgentScope) {
  return useMemo(() => (path: string) => changedSource(scope, path)?.path ?? null, [scope]);
}
