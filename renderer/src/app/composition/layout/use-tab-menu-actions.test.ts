import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { AppDependencies } from '@/app/dependencies';

import { useTabMenuActions } from './use-tab-menu-actions';

const source = { folderPath: String.raw`C:\Users\me\notes`, path: 'drafts/plan.md' };

function dependencies(reveal: () => Promise<void>) {
  return {
    documents: { adapters: { externalFiles: { reveal: vi.fn() } } },
    workspace: { adapters: { files: { reveal: vi.fn(reveal) } }, revealLabel: 'Show in Explorer' },
  } as unknown as Pick<AppDependencies, 'documents' | 'workspace'>;
}

function clipboard(writeText: (text: string) => Promise<void>) {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(writeText) } });
}

afterEach(() => vi.unstubAllGlobals());

describe('useTabMenuActions', () => {
  it('copies the system path and reports a clipboard that refuses until a copy succeeds', async () => {
    let refuse = true;
    clipboard(async () => {
      if (refuse) throw new Error('denied');
    });
    const { result } = renderHook(() => useTabMenuActions(dependencies(async () => undefined)));

    act(() => result.current.actions.onCopyPath(source, 'absolute'));
    await waitFor(() =>
      expect(result.current.failure?.message).toBe('StashBase could not reach the clipboard.'),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      String.raw`C:\Users\me\notes\drafts\plan.md`,
    );

    refuse = false;
    act(() => result.current.actions.onCopyPath(source, 'relative'));
    await waitFor(() => expect(result.current.failure).toBeNull());
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(String.raw`drafts\plan.md`);
  });

  it('reports a reveal the file manager could not answer, until dismissed', async () => {
    const { result } = renderHook(() =>
      useTabMenuActions(dependencies(() => Promise.reject(new Error('unavailable')))),
    );

    act(() => result.current.actions.onReveal(source));
    await waitFor(() =>
      expect(result.current.failure?.message).toBe(
        'The file could not be shown in the system file manager.',
      ),
    );
    act(() => result.current.dismissFailure());
    expect(result.current.failure).toBeNull();
  });
});
