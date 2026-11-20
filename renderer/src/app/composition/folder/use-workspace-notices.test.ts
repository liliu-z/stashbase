import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vite-plus/test';

import { useWorkspaceNotices } from './use-workspace-notices';

function notices(
  overrides: Partial<Parameters<typeof useWorkspaceNotices>[0]> = {},
): Parameters<typeof useWorkspaceNotices>[0] {
  return {
    dismissPreparationFailure: vi.fn(),
    dismissRevisionFailure: vi.fn(),
    hostFailure: null,
    preparationFailure: null,
    revisionFailures: [],
    ...overrides,
  };
}

const messages = (placed: readonly { message: string }[]) => placed.map((n) => n.message);

describe('useWorkspaceNotices', () => {
  it('says nothing when nothing needs saying', () => {
    const { result } = renderHook(() => useWorkspaceNotices(notices()));
    expect(result.current).toEqual({ corner: [], floating: [], strip: [] });
  });

  it('puts each notice where the Visual Style says it goes', () => {
    const { result } = renderHook(() =>
      useWorkspaceNotices(
        notices({
          hostFailure: 'The host lost this folder.',
          preparationFailure: { message: 'Preparation was refused.', tone: 'input' },
          revisionFailures: ['plan.md did not open.'],
        }),
      ),
    );
    // Background work reports from the corner, a request that did not land
    // floats, and the window's standing condition holds the strip.
    expect(messages(result.current.corner)).toEqual(['Preparation was refused.']);
    expect(result.current.corner[0]?.dismissLabel).toBe('Dismiss preparation notice');
    expect(messages(result.current.floating)).toEqual(['plan.md did not open.']);
    expect(messages(result.current.strip)).toEqual(['The host lost this folder.']);
  });

  it('floats a tab menu copy or reveal that failed, dismissed by its own owner', () => {
    const dismissTabMenuFailure = vi.fn();
    const { result } = renderHook(() =>
      useWorkspaceNotices(
        notices({
          dismissTabMenuFailure,
          tabMenuFailure: {
            message: 'StashBase could not reach the clipboard.',
            tone: 'capability',
          },
        }),
      ),
    );
    expect(result.current.corner).toEqual([]);
    expect(messages(result.current.floating)).toEqual(['StashBase could not reach the clipboard.']);
    result.current.floating[0]?.onDismiss?.();
    expect(dismissTabMenuFailure).toHaveBeenCalledOnce();
  });

  it('floats the failure of a reprocess the reader asked for', () => {
    const { result } = renderHook(() =>
      useWorkspaceNotices(
        notices({
          preparationFailure: { message: 'Reprocess was refused.', tone: 'input' },
          preparationRequested: true,
          revisionFailures: ['plan.md did not open.'],
        }),
      ),
    );
    expect(result.current.corner).toEqual([]);
    expect(messages(result.current.floating)).toEqual([
      'Reprocess was refused.',
      'plan.md did not open.',
    ]);
    // A floating card shows its dismissal as words, the same on every card;
    // only the corner's cross carries the longer accessible name.
    expect(result.current.floating.map((notice) => notice.dismissLabel)).toEqual([
      'Dismiss',
      'Dismiss',
    ]);
  });

  it('keeps the strip for a condition only the host can clear', () => {
    const { result } = renderHook(() =>
      useWorkspaceNotices(notices({ hostFailure: 'The host lost this folder.' })),
    );
    expect(result.current.strip[0]?.onDismiss).toBeNull();
    expect(result.current.strip[0]?.tone).toBe('capability');
  });

  it('gives a refusal no action to take up, only an acknowledgement', () => {
    const dismiss = vi.fn();
    const { result } = renderHook(() =>
      useWorkspaceNotices(
        notices({
          dismissPreparationFailure: dismiss,
          preparationFailure: { message: 'Preparation was refused.', tone: 'input' },
        }),
      ),
    );
    expect(result.current.corner[0]?.action).toBeNull();
    expect(result.current.corner[0]?.tone).toBe('input');
    expect(result.current.corner[0]?.onDismiss).toBe(dismiss);
  });

  it('says every review it could not show, and dismisses one by its sentence', () => {
    const dismissRevisionFailure = vi.fn();
    const { result } = renderHook(() =>
      useWorkspaceNotices(
        notices({
          dismissRevisionFailure,
          revisionFailures: ['plan.md did not open.', 'notes.md has a review open.'],
        }),
      ),
    );

    expect(result.current.floating.map((notice) => notice.message)).toEqual([
      'plan.md did not open.',
      'notes.md has a review open.',
    ]);
    expect(result.current.floating.every((notice) => notice.tone === 'capability')).toBe(true);
    result.current.floating[1]?.onDismiss();
    expect(dismissRevisionFailure).toHaveBeenCalledWith('notes.md has a review open.');
  });
});
