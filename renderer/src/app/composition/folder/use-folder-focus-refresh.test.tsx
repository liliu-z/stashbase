import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { usePreparationCommands } from '@/app/composition/commands/use-preparation-commands';
import { PreparationError } from '@/features/preparation/test-support';
import { useFiles, type WorkspaceRuntime } from '@/features/workspace/public';
import { createWorkspaceRuntime, workspaceQueryKeys } from '@/features/workspace/test-support';
import { preparationControlApi } from '@/test/fakes/preparation';
import { filesApi, listing, workspaceRuntimeOptions } from '@/test/fakes/workspace';
import { createRetainingTestQueryClient, queryWrapper } from '@/test/query';

import { useFolderRefresh } from './use-folder-refresh';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const FIRST = '/project/first';
const SECOND = '/project/second';

function workspace(path = FIRST) {
  return createWorkspaceRuntime(workspaceRuntimeOptions({ folder: { name: 'Project', path } }));
}

function mount(control = preparationControlApi()) {
  let disk = listing(['notes.md']);
  const files = filesApi({ load: vi.fn(async () => disk) });
  const client = createRetainingTestQueryClient();
  const view = renderHook(
    (runtime: WorkspaceRuntime | null) => {
      const commands = usePreparationCommands(control);
      useFolderRefresh({
        folderPath: runtime?.scope.folder.path ?? null,
        reprocessSource: commands.reprocess,
        syncFolder: commands.sync,
        treeVersion: 1,
      });
      return { listing: useFiles(runtime, files).data, failure: commands.failure };
    },
    { initialProps: workspace() as WorkspaceRuntime | null, wrapper: queryWrapper(client) },
  );
  return { ...view, client, control, files, setDisk: (next: typeof disk) => (disk = next) };
}

async function advance(milliseconds = 1) {
  await act(() => vi.advanceTimersByTimeAsync(milliseconds));
}

async function focus() {
  act(() => window.dispatchEvent(new Event('focus')));
  await advance();
}

describe('folder refresh on application focus', () => {
  it('shows external changes on focus even when visibility and tree revision have not changed', async () => {
    const { result, setDisk, control } = mount();
    await advance();
    expect(result.current.listing?.files.map((file) => file.path)).toEqual(['notes.md']);

    setDisk(listing(['notes.md', 'journal/entry.md'], ['journal', 'empty']));
    await advance(10_000);
    expect(result.current.listing?.folders).toEqual([]);
    expect(control.sync).not.toHaveBeenCalled();

    await focus();
    expect(result.current.listing?.folders.map((folder) => folder.path)).toEqual([
      'journal',
      'empty',
    ]);
    expect(control.sync).toHaveBeenCalledExactlyOnceWith(FIRST, expect.any(AbortSignal));

    setDisk(listing(['archive/entry.md'], ['archive']));
    await advance(5_000);
    await focus();
    expect(result.current.listing?.folders.map((folder) => folder.path)).toEqual(['archive']);
    expect(result.current.listing?.files.map((file) => file.path)).toEqual(['archive/entry.md']);
  });

  it('throttles repeated focus and never stacks a second focus sync while one is pending', async () => {
    let finish: (() => void) | undefined;
    const sync = vi.fn(() => new Promise<boolean>((resolve) => (finish = () => resolve(true))));
    const { control, result, setDisk } = mount(preparationControlApi({ sync }));
    await advance();
    await focus();
    setDisk(listing(['changed-during-sync.md']));
    await advance(6_000);
    await focus();
    expect(control.sync).toHaveBeenCalledTimes(1);
    expect(result.current.listing?.files.map((file) => file.path)).toEqual([
      'changed-during-sync.md',
    ]);

    await act(async () => finish?.());
    await focus();
    expect(control.sync).toHaveBeenCalledTimes(1);
    await advance(5_000);
    await focus();
    expect(control.sync).toHaveBeenCalledTimes(2);
    await act(async () => finish?.());
    await focus();
    expect(control.sync).toHaveBeenCalledTimes(2);
  });

  it('refreshes browsing promptly and reports a failed sync through the existing notice', async () => {
    let fail: ((error: unknown) => void) | undefined;
    const control = preparationControlApi({
      sync: vi.fn(() => new Promise<boolean>((_resolve, reject) => (fail = reject))),
    });
    const { result, setDisk } = mount(control);
    await advance();
    setDisk(listing(['external.md']));

    await focus();
    expect(result.current.listing?.files.map((file) => file.path)).toEqual(['external.md']);
    expect(result.current.failure).toBeNull();
    await act(async () => fail?.(new PreparationError('unavailable', 'offline')));
    expect(result.current.failure?.message).toBe('Preparation is unavailable. Try again.');

    vi.mocked(control.sync).mockResolvedValue(true);
    await advance(5_000);
    setDisk(listing(['recovered.md']));
    await focus();
    expect(result.current.listing?.files.map((file) => file.path)).toEqual(['recovered.md']);
  });

  it('uses the current folder and retires pending completion across switches and closure', async () => {
    let finish: (() => void) | undefined;
    const control = preparationControlApi({
      sync: vi.fn(() => new Promise<boolean>((resolve) => (finish = () => resolve(true)))),
    });
    const { rerender, client, files } = mount(control);
    await advance();
    await focus();
    const finishFirst = finish;

    rerender(workspace(SECOND));
    await advance();
    await focus();
    expect(vi.mocked(control.sync).mock.calls.map(([folder]) => folder)).toEqual([FIRST, SECOND]);
    await act(async () => finish?.());

    // Reopening the first path creates a new workspace. The old sync must not
    // invalidate the new generation's listing when it eventually settles.
    rerender(workspace());
    await advance();
    client.setQueryData(workspaceQueryKeys.files(FIRST), listing(['new-generation.md']));
    const loadsBeforeCompletion = vi.mocked(files.load).mock.calls.length;
    await act(async () => finishFirst?.());
    expect(client.getQueryState(workspaceQueryKeys.files(FIRST))?.isInvalidated).toBe(false);
    expect(files.load).toHaveBeenCalledTimes(loadsBeforeCompletion);

    rerender(null);
    await focus();
    expect(control.sync).toHaveBeenCalledTimes(2);
  });

  it.each([SECOND, null])('ignores a late sync failure after leaving for %s', async (next) => {
    let failFirst: ((error: unknown) => void) | undefined;
    const control = preparationControlApi({
      sync: vi.fn((folder: string) =>
        folder === FIRST
          ? new Promise<boolean>((_resolve, reject) => (failFirst = reject))
          : Promise.resolve(true),
      ),
    });
    const { result, rerender } = mount(control);
    await advance();
    await focus();
    rerender(next ? workspace(next) : null);
    await advance();
    await focus();
    expect(vi.mocked(control.sync).mock.calls[0]?.[1].aborted).toBe(true);
    expect(result.current.failure).toBeNull();

    await act(async () => failFirst?.(new PreparationError('unauthorized', 'old folder removed')));
    expect(result.current.failure).toBeNull();
  });

  it('removes its focus listener on unmount', async () => {
    const { unmount, control } = mount();
    await advance();
    unmount();
    await focus();
    expect(control.sync).not.toHaveBeenCalled();
  });
});
