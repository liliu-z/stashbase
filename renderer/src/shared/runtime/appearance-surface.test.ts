import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import type { AppearanceSurface } from '@/shared/domain/appearance';
import { appearanceSurface as fixture } from '@/test/fakes/settings';

import {
  applyAppearanceSurface,
  connectNativeAppearance,
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
  return { ...fixture(), ...overrides };
}

afterEach(() => {
  for (const channel of opened.splice(0)) channel.close();
  const root = document.documentElement;
  applyAppearanceSurface(fixture());
  root.classList.remove('light', 'dark');
});

describe('applyAppearanceSurface', () => {
  it('stamps both scales on the document root', () => {
    applyAppearanceSurface(surface({ uiScale: 'large', readingTextSize: 'small' }));

    expect(document.documentElement.dataset.uiScale).toBe('large');
    expect(document.documentElement.dataset.readingTextSize).toBe('small');
  });

  it('carries the pinned theme as its class', () => {
    applyAppearanceSurface(surface({ theme: 'light' }));
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    applyAppearanceSurface(surface({ theme: 'dark' }));
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('leaves neither class on when the theme follows the system', () => {
    applyAppearanceSurface(surface({ theme: 'dark' }));
    applyAppearanceSurface(surface({ theme: 'system' }));

    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

const root = () => document.documentElement;

describe('theme and font overrides', () => {
  it('stamps a named theme on its own side and clears it for StashBase', () => {
    applyAppearanceSurface(surface({ darkTheme: 'catppuccin-mocha' }));
    expect(root().style.getPropertyValue('--dark-surface-1')).toBe('#1e1e2e');
    expect(root().style.getPropertyValue('--light-surface-1')).toBe('');

    applyAppearanceSurface(surface());
    expect(root().style.getPropertyValue('--dark-surface-1')).toBe('');
  });

  it('carries a chosen font with the bundled stack behind it', () => {
    applyAppearanceSurface(surface({ codeFont: 'JetBrains Mono', writingFont: 'Literata' }));
    expect(root().style.getPropertyValue('--writing-font')).toBe('"Literata", var(--font-sans)');
    expect(root().style.getPropertyValue('--code-font')).toBe('"JetBrains Mono", var(--font-mono)');

    applyAppearanceSurface(surface());
    expect(root().style.getPropertyValue('--writing-font')).toBe('');
  });

  it('hands every applied surface to the desktop until disconnected', () => {
    const reported: AppearanceSurface[] = [];
    const disconnect = connectNativeAppearance((next) => reported.push(next));
    applyAppearanceSurface(surface({ spellcheck: false }));
    disconnect();
    applyAppearanceSurface(surface());
    expect(reported).toEqual([surface({ spellcheck: false })]);
  });
});

describe('publishAppearanceSurface', () => {
  it('applies to this window and reaches another', async () => {
    const received: AppearanceSurface[] = [];
    peer().addEventListener('message', (event: MessageEvent<AppearanceSurface>) =>
      received.push(event.data),
    );

    publishAppearanceSurface(surface({ theme: 'dark', uiScale: 'small' }));

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.dataset.uiScale).toBe('small');
    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual(surface({ theme: 'dark', uiScale: 'small' }));
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
