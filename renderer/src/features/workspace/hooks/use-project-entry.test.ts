import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { ProjectError, ProjectImportError } from '@/features/workspace/application/ports';
import { folderPicker, githubImportApi, projectLifecycle } from '@/test/fakes/workspace';
import { createTestQueryClient, queryWrapper } from '@/test/query';

import { useProjectEntry } from './use-project-entry';

afterEach(cleanup);
const source = { name: 'Notes', repo: 'https://github.com/owner/notes' };
const HOME = '/home/person/Documents/StashBase';
function setup(
  run = vi.fn(async () => '/home/Notes'),
  enterFolder = vi.fn(async (_path: string) => {}),
  chooseFolder: ReturnType<typeof folderPicker>['chooseFolder'] = vi.fn(async () => ({
    status: 'cancelled' as const,
  })),
) {
  const hook = renderHook(
    () =>
      useProjectEntry(
        folderPicker({ chooseFolder }),
        projectLifecycle({ enterFolder }),
        githubImportApi({ run }),
      ),
    { wrapper: queryWrapper(createTestQueryClient()) },
  );
  return { ...hook, run, enterFolder, chooseFolder };
}

/** Opens a Gallery copy and waits until it can be confirmed: the location
 *  the copy goes to arrives from the server. */
async function openCopy(result: { current: ReturnType<typeof useProjectEntry> }, from = source) {
  act(() => result.current.copy(from));
  await waitFor(() => expect(result.current.importDialog.request.canSubmit).toBe(true));
}

describe('shared project entry', () => {
  it('waits for the reader to confirm a Gallery copy and creates it where they chose', async () => {
    const chooseFolder = vi.fn(async () => ({
      folderPath: '/Users/me/Projects',
      status: 'selected' as const,
    }));
    const { result, run } = setup(undefined, undefined, chooseFolder);
    await openCopy(result);
    const request = () => result.current.importDialog.request;
    expect(run).not.toHaveBeenCalled();
    expect(request().source).toBe('Notes');
    expect(request().location).toBe(HOME);

    act(() => request().chooseLocation());
    await waitFor(() => expect(request().location).toBe('/Users/me/Projects'));
    expect(chooseFolder).toHaveBeenCalledWith({ defaultPath: HOME });
    act(() => request().submit());
    await waitFor(() => expect(result.current.importDialog.open).toBe(false));
    expect(run).toHaveBeenCalledWith(
      source.repo,
      'Notes',
      '/Users/me/Projects',
      expect.any(AbortSignal),
    );
  });

  it('retains a completed copy and retries entry without cloning again', async () => {
    const enter = vi
      .fn()
      .mockRejectedValueOnce(new ProjectError('unavailable', 'window failed'))
      .mockResolvedValue(undefined);
    const { result, run } = setup(undefined, enter);
    await openCopy(result);
    act(() => {
      result.current.importDialog.request.submit();
      result.current.importDialog.request.submit();
      result.current.copy(source);
      result.current.open();
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.importDialog.request.retainedPath).toBe('/home/Notes');
    expect(result.current.importDialog.open).toBe(true);
    act(() => result.current.importDialog.request.submit());
    await waitFor(() => expect(result.current.importDialog.open).toBe(false));
    expect(run).toHaveBeenCalledTimes(1);
    expect(enter).toHaveBeenCalledTimes(2);
  });

  it('offers an explicit existing folder without assuming it is the requested repository', async () => {
    const run = vi.fn(async () => {
      throw new ProjectImportError('Destination exists', 'conflict', {
        path: '/home/Notes',
        directory: true,
      });
    });
    const { result, enterFolder } = setup(run);
    await openCopy(result);
    act(() => result.current.importDialog.request.submit());
    await waitFor(() =>
      expect(result.current.importDialog.request.existingPath).toBe('/home/Notes'),
    );
    expect(enterFolder).not.toHaveBeenCalled();
    act(() => result.current.importDialog.request.openExisting());
    await waitFor(() =>
      expect(enterFolder).toHaveBeenCalledWith('/home/Notes', expect.any(AbortSignal)),
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('requires another name for a file conflict and retains edited input for retry', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new ProjectImportError('Destination exists', 'conflict', {
          path: '/home/Notes',
          directory: false,
        }),
      )
      .mockResolvedValue('/home/Other');
    const { result } = setup(run);
    await openCopy(result);
    act(() => result.current.importDialog.request.submit());
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.importDialog.request.existingPath).toBeNull();
    act(() => result.current.importDialog.request.setFolderName('Other'));
    act(() => result.current.importDialog.request.submit());
    await waitFor(() =>
      expect(run).toHaveBeenLastCalledWith(source.repo, 'Other', HOME, expect.any(AbortSignal)),
    );
  });

  it('cancels without opening a late successful copy and keeps it for the next attempt', async () => {
    let finish!: (path: string) => void;
    const run = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const { result, enterFolder } = setup(run);
    await openCopy(result);
    act(() => result.current.importDialog.request.submit());
    act(() => result.current.importDialog.close());
    await act(async () => finish('/home/Notes'));
    expect(enterFolder).not.toHaveBeenCalled();
    expect(result.current.failure).toBeNull();
    act(() => result.current.copy(source));
    expect(result.current.importDialog.request.retainedPath).toBe('/home/Notes');
    act(() => result.current.importDialog.request.submit());
    await waitFor(() => expect(enterFolder).toHaveBeenCalledOnce());
    expect(run).toHaveBeenCalledOnce();
  });

  it('resolves an unknown receipt before allowing a different copy', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new ProjectImportError('Check result', 'unknown'))
      .mockResolvedValue('/home/Notes');
    const { result } = setup(run);
    await openCopy(result);
    act(() => result.current.importDialog.request.submit());
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.isPending).toBe(false));
    act(() => {
      result.current.importDialog.request.setFolderName('Other');
      result.current.copy({ name: 'Elsewhere', repo: 'https://github.com/owner/elsewhere' });
    });
    expect(result.current.importDialog.request.folderName).toBe('Notes');
    expect(run).toHaveBeenCalledOnce();
    act(() => result.current.importDialog.request.submit());
    await waitFor(() => expect(result.current.importDialog.open).toBe(false));
    expect(run).toHaveBeenLastCalledWith(source.repo, 'Notes', HOME, expect.any(AbortSignal));
  });

  it('treats native cancellation as no entry and shares the entry command with Recent', async () => {
    const { result, enterFolder, chooseFolder } = setup();
    act(() => result.current.create('/home/person'));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(chooseFolder).toHaveBeenCalledWith({ defaultPath: '/home/person' });
    expect(enterFolder).not.toHaveBeenCalled();
    expect(result.current.failure).toBeNull();
    act(() => result.current.select('/arbitrary/.existing folder'));
    await waitFor(() =>
      expect(enterFolder).toHaveBeenCalledWith(
        '/arbitrary/.existing folder',
        expect.any(AbortSignal),
      ),
    );
  });
});
