import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { workspaceQueryKeys } from '@/features/workspace/application/queries';
import {
  createWorkspaceSessionSnapshot,
  type FolderSessionState,
  type WorkspaceSessionSnapshot,
} from '@/features/workspace/domain/session';
import { projectApi, projectRegistrySnapshot, sessionPersistence } from '@/test/fakes/workspace';
import { createTestQueryClient, queryWrapper } from '@/test/query';

import { useWorkspaceSession } from './use-workspace-session';

afterEach(cleanup);

const member = { favorite: false, openedAt: '2026-09-01T00:00:00.000Z', path: '/project/notes' };
const settled = projectRegistrySnapshot({
  activeFolder: null,
  homeDirectory: '/project',
  projects: [member],
});

/** A saved session naming `folderPath`, which is a current member, and
 *  remembering whatever `folder` says it had expanded, selected, or open. */
const savedSession = (folderPath: string, folder: Partial<FolderSessionState> = {}) => ({
  ...createWorkspaceSessionSnapshot(),
  activeFolderPath: folderPath,
  folders: [
    {
      activeTabId: null,
      expandedPaths: [],
      folderPath,
      selectedPath: null,
      tabs: [],
      ...folder,
      mathMode: folder.mathMode ?? false,
    },
  ],
});

const remembered = { expandedPaths: ['drafts'], selectedPath: 'drafts/plan.md' };

describe('workspace session restore', () => {
  it('lands on the welcome screen rather than reopening the saved folder', async () => {
    // A plain relaunch: the desktop names no folder, and the session file
    // remembers the one that was open. The window lands empty all the same.
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(workspaceQueryKeys.project, settled);
    const api = projectApi({
      load: vi.fn(async () => settled),
      openFolder: vi.fn(async () => {
        throw new Error('not expected');
      }),
    });

    const sidebarFrames: boolean[] = [];
    const hook = renderHook(
      () => {
        const controller = useWorkspaceSession(
          api,
          sessionPersistence({
            load: async () => ({
              ...savedSession(member.path, remembered),
              // Written while working in the folder with the column open.
              shell: { agentPaneWidth: 576, sidebarOpen: true, sidebarWidth: 240 },
            }),
          }),
        );
        sidebarFrames.push(controller.shell.sidebarOpen);
        return controller;
      },
      { wrapper: queryWrapper(queryClient) },
    );

    await waitFor(() =>
      expect(hook.result.current.status).toEqual({ kind: 'ready', restoredFolder: null }),
    );
    expect(api.openFolder).not.toHaveBeenCalled();
    // Arriving at the welcome screen collapses the bare sidebar, and no render
    // on the way there shows it open first.
    expect(hook.result.current.shell.sidebarOpen).toBe(false);
    expect(sidebarFrames).not.toContain(true);
  });

  it('restores the saved folder session once that folder is open', async () => {
    // The server already holds the folder, as it does after a reload or once a
    // reader's click has landed, so what the session remembered about it comes
    // back with it.
    const queryClient = createTestQueryClient();
    const opened = projectRegistrySnapshot({
      ...settled,
      activeFolder: { name: 'notes', path: member.path },
    });
    queryClient.setQueryData(workspaceQueryKeys.project, opened);
    const api = projectApi({
      load: vi.fn(async () => opened),
      openFolder: vi.fn(async () => {
        throw new Error('not expected');
      }),
    });

    const hook = renderHook(
      () =>
        useWorkspaceSession(
          api,
          sessionPersistence({ load: async () => savedSession(member.path, remembered) }),
        ),
      { wrapper: queryWrapper(queryClient) },
    );

    await waitFor(() =>
      expect(hook.result.current.status).toMatchObject({
        kind: 'ready',
        restoredFolder: remembered,
      }),
    );
    expect(api.openFolder).not.toHaveBeenCalled();
    // Landing back in the folder is not an arrival at the welcome screen, so
    // the column the reader had collapsed there stays collapsed.
    expect(hook.result.current.shell.sidebarOpen).toBe(false);
  });

  it('drops a persisted folder that is no longer a project member', async () => {
    const queryClient = createTestQueryClient();
    const forgotten = projectRegistrySnapshot({ ...settled, projects: [] });
    queryClient.setQueryData(workspaceQueryKeys.project, forgotten);
    const save = vi.fn(async (_snapshot: WorkspaceSessionSnapshot) => undefined);
    const api = projectApi({
      load: vi.fn(async () => forgotten),
      openFolder: vi.fn(async () => {
        throw new Error('not expected');
      }),
      removeFolder: vi.fn(async () => {
        throw new Error('not expected');
      }),
    });

    const hook = renderHook(
      () =>
        useWorkspaceSession(
          api,
          sessionPersistence({
            load: async () => ({
              ...savedSession(member.path),
              shell: { agentPaneWidth: 576, sidebarOpen: true, sidebarWidth: 240 },
            }),
            save,
          }),
        ),
      { wrapper: queryWrapper(queryClient) },
    );

    await waitFor(() => expect(hook.result.current.status.kind).toBe('ready'));
    await act(async () => hook.result.current.runtime.flush());
    expect(api.openFolder).not.toHaveBeenCalled();
    // Its folder gone, the window is on the welcome screen, and arrives there
    // with the sidebar collapsed like any other.
    expect(save.mock.calls.at(-1)?.[0]).toMatchObject({
      activeFolderPath: null,
      folders: [],
      shell: { sidebarOpen: false },
    });
  });
});
