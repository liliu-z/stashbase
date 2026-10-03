import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { AppearancePort } from '@/features/settings/public';
import type { AppearanceSurface } from '@/shared/domain/appearance';
import { publishAppearanceSurface } from '@/shared/runtime/appearance-surface';
import { appearancePort, appearanceSurface } from '@/test/fakes/settings';

const D = appearanceSurface();

import { useAppearanceSurface } from './use-appearance-surface';

const opened: BroadcastChannel[] = [];

/** A change another window published. It has to come from a second channel,
 *  because a `BroadcastChannel` never delivers to the instance that posted. */
function post(surface: AppearanceSurface): void {
  const channel = new BroadcastChannel('stashbase-appearance');
  opened.push(channel);
  channel.postMessage(surface);
}

const root = () => document.documentElement;

afterEach(() => {
  cleanup();
  for (const channel of opened.splice(0)) channel.close();
  root().classList.remove('light', 'dark');
  delete root().dataset.uiScale;
  delete root().dataset.readingTextSize;
});

const read: AppearanceSurface = { ...D, readingTextSize: 'large', theme: 'dark', uiScale: 'small' };

describe('useAppearanceSurface', () => {
  it('applies what the read answered', async () => {
    const port = appearancePort({
      load: async () => read,
    });
    const setAppearance = vi.fn(async () => undefined);
    renderHook(() => useAppearanceSurface(port, setAppearance));

    await waitFor(() => expect(root().classList.contains('dark')).toBe(true));
    expect(root().dataset.uiScale).toBe('small');
    expect(root().dataset.readingTextSize).toBe('large');
    expect(setAppearance).toHaveBeenLastCalledWith(read);
  });

  it("hands this window's own change to the desktop until unmounted", async () => {
    const setAppearance = vi.fn(async () => undefined);
    const { unmount } = renderHook(() =>
      useAppearanceSurface(appearancePort({ load: () => new Promise(() => {}) }), setAppearance),
    );

    publishAppearanceSurface(D);
    expect(setAppearance).toHaveBeenLastCalledWith(D);

    unmount();
    publishAppearanceSurface({ ...D, theme: 'light' });
    expect(setAppearance).toHaveBeenCalledTimes(1);
  });

  it('lets a broadcast mid-read stand against the late answer', async () => {
    let answer: ((preferences: Awaited<ReturnType<AppearancePort['load']>>) => void) | null = null;
    const port = appearancePort({
      load: () => new Promise((resolve) => (answer = resolve)),
    });
    renderHook(() => useAppearanceSurface(port, async () => undefined));
    await waitFor(() => expect(answer).not.toBeNull());

    const chosen: AppearanceSurface = {
      ...D,
      readingTextSize: 'large',
      theme: 'dark',
      uiScale: 'large',
    };
    post(chosen);
    await waitFor(() => expect(root().classList.contains('dark')).toBe(true));

    await act(async () => {
      answer?.({ ...D, readingTextSize: 'small', theme: 'light', uiScale: 'small' });
    });

    expect(root().classList.contains('dark')).toBe(true);
    expect(root().classList.contains('light')).toBe(false);
    expect(root().dataset.uiScale).toBe('large');
    expect(root().dataset.readingTextSize).toBe('large');
  });
});
