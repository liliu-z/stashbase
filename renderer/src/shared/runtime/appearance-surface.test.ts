import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import type { AppearanceSurface } from '@/shared/domain/appearance';

import {
  applyAppearanceSurface,
  publishAppearanceSurface,
  subscribeToAppearanceSurface,
} from './appearance-surface';

const opened: BroadcastChannel[] = [];

/** A second view of the same channel, standing in for another open window. */
function peer(): BroadcastChannel {
  const channel = new BroadcastChannel('stashbase-appearance');
  opened.push(channel);
  return channel;
}

/** A change another window published. It has to come from a second channel,
 *  because a `BroadcastChannel` never delivers to the instance that posted —
 *  which is also the reason the module applies its own change locally. */
function post(published: AppearanceSurface): void {
  peer().postMessage(published);
}

function surface(overrides: Partial<AppearanceSurface> = {}): AppearanceSurface {
  return {
    themeClass: null,
    uiScale: 'default',
    readingTextSize: 'default',
    readingFont: 'serif',
    ...overrides,
  };
}

afterEach(() => {
  for (const channel of opened.splice(0)) channel.close();
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  delete root.dataset.uiScale;
  delete root.dataset.readingTextSize;
  delete root.dataset.readingFont;
});

describe('applyAppearanceSurface', () => {
  it('stamps both scales and the reading font on the document root', () => {
    applyAppearanceSurface(
      surface({ uiScale: 'large', readingTextSize: 'small', readingFont: 'sans' }),
    );

    expect(document.documentElement.dataset.uiScale).toBe('large');
    expect(document.documentElement.dataset.readingTextSize).toBe('small');
    expect(document.documentElement.dataset.readingFont).toBe('sans');
  });

  it('carries the pinned theme as its class', () => {
    applyAppearanceSurface(surface({ themeClass: 'light' }));
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    applyAppearanceSurface(surface({ themeClass: 'dark' }));
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('leaves neither class on when the theme follows the system', () => {
    applyAppearanceSurface(surface({ themeClass: 'dark' }));
    applyAppearanceSurface(surface({ themeClass: null }));

    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

describe('publishAppearanceSurface', () => {
  it('applies to this window and reaches another', async () => {
    const received: AppearanceSurface[] = [];
    peer().addEventListener('message', (event: MessageEvent<AppearanceSurface>) =>
      received.push(event.data),
    );

    publishAppearanceSurface(surface({ themeClass: 'dark', uiScale: 'small' }));

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.dataset.uiScale).toBe('small');
    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual(surface({ themeClass: 'dark', uiScale: 'small' }));
  });
});

describe('subscribeToAppearanceSurface', () => {
  it('delivers a change made in another window', async () => {
    const received: AppearanceSurface[] = [];
    const stop = subscribeToAppearanceSurface((next) => received.push(next));

    post(surface({ readingTextSize: 'large' }));

    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.readingTextSize).toBe('large');
    stop();
  });

  it('stops delivering after its teardown', async () => {
    const abandoned: AppearanceSurface[] = [];
    subscribeToAppearanceSurface((next) => abandoned.push(next))();

    const kept: AppearanceSurface[] = [];
    const stop = subscribeToAppearanceSurface((next) => kept.push(next));
    post(surface({ uiScale: 'large' }));

    await waitFor(() => expect(kept).toHaveLength(1));
    expect(abandoned).toEqual([]);
    stop();
  });
});
