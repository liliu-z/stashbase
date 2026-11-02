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
  vi.restoreAllMocks();
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
  it('shows changes on quick returns even while another sync is throttled', async () => {
    const { result, setDisk, control } = mount();
    await advance();
    expect(result.current.listing?.files.map((file) => file.path)).toEqual(['notes.md']);
    await focus();

    setDisk(listing(['notes.md', 'journal/entry.md'], ['journal', 'empty']));
    await advance(1_000);
    expect(result.current.listing?.folders).toEqual([]);

    await focus();
    expect(result.current.listing?.folders.map((folder) => folder.path)).toEqual([
      'journal',
      'empty',
    ]);
    expect(control.sync).toHaveBeenCalledExactlyOnceWith(FIRST, expect.any(AbortSignal));

    setDisk(listing(['archive/entry.md'], ['archive']));
    await advance(1_000);
    await focus();
    expect(result.current.listing?.folders.map((folder) => folder.path)).toEqual(['archive']);
    expect(result.current.listing?.files.map((file) => file.path)).toEqual(['archive/entry.md']);
    expect(control.sync).toHaveBeenCalledTimes(1);
  });

  it('periodically shows external additions, renames and deletions without starting sync', async () => {
    const { result, setDisk, control } = mount();
    await advance();

    setDisk(listing(['notes.md', 'journal/entry.md'], ['journal']));
    await advance(5_001);
    expect(result.current.listing?.files.map((file) => file.path)).toEqual([
      'notes.md',
      'journal/entry.md',
    ]);

    setDisk(listing(['archive/renamed.md'], ['archive']));
    await advance(5_001);
    expect(result.current.listing?.files.map((file) => file.path)).toEqual(['archive/renamed.md']);
    expect(result.current.listing?.folders.map((folder) => folder.path)).toEqual(['archive']);
    expect(control.sync).not.toHaveBeenCalled();
  });

  it('pauses checks while hidden and refreshes immediately when visible again', async () => {
    const { result, setDisk, control, files } = mount();
    await advance();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    const readsBeforeHidden = vi.mocked(files.load).mock.calls.length;

    setDisk(listing(['changed-while-hidden.md']));
    await advance(15_001);
    expect(files.load).toHaveBeenCalledTimes(readsBeforeHidden);
    expect(result.current.listing?.files.map((file) => file.path)).toEqual(['notes.md']);

    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await advance();
    expect(result.current.listing?.files.map((file) => file.path)).toEqual([
      'changed-while-hidden.md',
    ]);
    expect(control.sync).not.toHaveBeenCalled();
  });

  it('shares a slow listing read across checks and quick focus returns', async () => {
    const control = preparationControlApi({
      sync: vi.fn(() => new Promise<boolean>(() => {})),
    });
    const { result, files } = mount(control);
    await advance();
    let finish: ((value: ReturnType<typeof listing>) => void) | undefined;
    let signal: AbortSignal | undefined;
    vi.mocked(files.load)
      .mockClear()
      .mockImplementation((_folder, captured) => {
        signal = captured;
        return new Promise((resolve) => (finish = resolve));
      });

    await advance(5_001);
    await focus();
    await focus();
    await advance(10_001);
    await focus();
    expect(files.load).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    expect(control.sync).toHaveBeenCalledTimes(1);

    await act(async () => finish?.(listing(['slow-result.md'])));
    await advance();
    expect(result.current.listing?.files.map((file) => file.path)).toEqual(['slow-result.md']);
  });

  it('polls only the selected project and stops after project closure', async () => {
    const { rerender, files, control } = mount();
    await advance();
    rerender(workspace(SECOND));
    await advance();
    vi.mocked(files.load).mockClear();

    await advance(10_001);
    expect(files.load).toHaveBeenCalled();
    expect(vi.mocked(files.load).mock.calls.every(([folder]) => folder === SECOND)).toBe(true);

    rerender(null);
    vi.mocked(files.load).mockClear();
    await advance(10_001);
    expect(files.load).not.toHaveBeenCalled();
    expect(control.sync).not.toHaveBeenCalled();
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

  it('removes its focus listener and polling on unmount', async () => {
    const { unmount, control, files } = mount();
    await advance();
    unmount();
    vi.mocked(files.load).mockClear();
    await advance(10_001);
    await focus();
    expect(files.load).not.toHaveBeenCalled();
    expect(control.sync).not.toHaveBeenCalled();
  });
});
