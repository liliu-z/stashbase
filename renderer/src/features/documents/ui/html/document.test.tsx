import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { createDocumentNavigationRuntime } from '@/features/documents/application/navigation-runtime';

import { HtmlDocument } from './document';

let userActivationDescriptor: PropertyDescriptor | undefined;

const frames = () => screen.getAllByTitle<HTMLIFrameElement>('dashboard.html HTML preview');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  globalThis.document.documentElement.classList.remove('dark', 'light');
  if (userActivationDescriptor) {
    Object.defineProperty(globalThis.navigator, 'userActivation', userActivationDescriptor);
  } else {
    Reflect.deleteProperty(globalThis.navigator, 'userActivation');
  }
  userActivationDescriptor = undefined;
});

describe('HTML document', () => {
  it('uses an opaque-origin script sandbox and the versioned source asset', async () => {
    const navigation = createDocumentNavigationRuntime('tab-1');
    render(
      <HtmlDocument
        active
        name="archive.html"
        navigation={navigation}
        onNavigate={vi.fn()}
        onOpenExternal={vi.fn(async () => true)}
        resource={{
          kind: 'source',
          url: 'data:text/html,archive',
          version: 'one',
        }}
        source={{ folderPath: '/project', path: 'archive.html' }}
        tabId="tab-1"
      />,
    );

    const frame = screen.getByTitle<HTMLIFrameElement>('archive.html HTML preview');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.referrerPolicy).toBe('no-referrer');
    expect(frame.src).toBe('data:text/html,archive');

    const frameWindow = frame.contentWindow;
    expect(frameWindow).not.toBeNull();
    if (!frameWindow) throw new Error('HTML preview frame has no content window.');
    const postMessage = vi.spyOn(frameWindow, 'postMessage');
    globalThis.document.documentElement.classList.add('dark');
    fireEvent.load(frame);
    expect(postMessage).toHaveBeenCalledWith({ theme: 'dark', type: 'stashbase-theme' }, '*');
    await waitFor(() => expect(navigation.store.getState().find.available).toBe(true));
  });

  it('accepts frame Find replies and routes only user-activated document links', async () => {
    const navigation = createDocumentNavigationRuntime('tab-1');
    const onNavigate = vi.fn();
    const onOpenExternal = vi.fn(async () => true);
    const userActivation = { isActive: false };
    userActivationDescriptor = Object.getOwnPropertyDescriptor(
      globalThis.navigator,
      'userActivation',
    );
    Object.defineProperty(globalThis.navigator, 'userActivation', {
      configurable: true,
      value: userActivation,
    });
    render(
      <HtmlDocument
        active
        name="archive.html"
        navigation={navigation}
        onNavigate={onNavigate}
        onOpenExternal={onOpenExternal}
        resource={{
          kind: 'source',
          url: 'data:text/html,archive',
          version: 'one',
        }}
        source={{ folderPath: '/project', path: 'pages/archive.html' }}
        tabId="tab-1"
      />,
    );
    const frame = screen.getByTitle<HTMLIFrameElement>('archive.html HTML preview');
    const frameWindow = frame.contentWindow;
    expect(frameWindow).not.toBeNull();
    if (!frameWindow) throw new Error('HTML preview frame has no content window.');
    const postMessage = vi.spyOn(frameWindow, 'postMessage');

    act(() => navigation.setFindQuery('guide'));
    const request = postMessage.mock.calls.find(
      ([message]) => (message as Record<string, unknown>).type === 'stashbase-find',
    )?.[0] as Record<string, unknown>;
    expect(request.query).toBe('guide');
    act(() => {
      globalThis.dispatchEvent(
        new MessageEvent('message', {
          data: {
            current: 1,
            reqId: request.reqId,
            total: 3,
            type: 'stashbase-find-result',
          },
          source: frameWindow,
        }),
      );
    });
    await waitFor(() => expect(navigation.store.getState().find.total).toBe(3));

    act(() => {
      globalThis.dispatchEvent(
        new MessageEvent('message', {
          data: { href: 'next.html#details', type: 'stashbase-nav' },
          source: frameWindow,
        }),
      );
    });
    expect(onNavigate).not.toHaveBeenCalled();

    userActivation.isActive = true;
    act(() => {
      globalThis.dispatchEvent(
        new MessageEvent('message', {
          data: { href: 'next.html#details', type: 'stashbase-nav' },
          source: frameWindow,
        }),
      );
      globalThis.dispatchEvent(
        new MessageEvent('message', {
          data: { href: 'https://example.com/guide', type: 'stashbase-open-external' },
          source: frameWindow,
        }),
      );
    });
    expect(onNavigate).toHaveBeenCalledWith({
      anchor: 'details',
      source: { folderPath: '/project', path: 'pages/next.html' },
    });
    expect(onOpenExternal).toHaveBeenCalledWith('https://example.com/guide');

    fireEvent.load(frame);
  });

  it('keeps the shown page until its replacement is ready, at the same reading position', async () => {
    const navigation = createDocumentNavigationRuntime('tab-1');
    const page = (version: string) => (
      <HtmlDocument
        active
        name="dashboard.html"
        navigation={navigation}
        onNavigate={vi.fn()}
        onOpenExternal={vi.fn(async () => true)}
        resource={{ kind: 'source', url: `data:text/html,${version}`, version }}
        source={{ folderPath: '/project', path: 'dashboard.html' }}
        tabId="tab-1"
      />
    );
    const view = render(page('one'));
    const [shown] = frames();
    const shownWindow = shown?.contentWindow;
    if (!shown || !shownWindow) throw new Error('HTML preview frame has no content window.');
    fireEvent.load(shown);
    act(() => {
      globalThis.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'stashbase-scroll-position', x: 0, y: 420 },
          source: shownWindow,
        }),
      );
    });

    view.rerender(page('two'));
    const [, replacement] = frames();
    const replacementWindow = replacement?.contentWindow;
    if (!replacement || !replacementWindow) throw new Error('No replacement frame.');
    // Neither page takes input while one replaces the other.
    expect(frames()[0]).toBe(shown);
    expect(shown.closest('[inert]')).not.toBeNull();
    expect(replacement.closest('[inert]')).not.toBeNull();
    const postMessage = vi.spyOn(replacementWindow, 'postMessage');
    fireEvent.load(replacement);
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stashbase-scroll-restore', x: 0, y: 420 }),
        '*',
      ),
    );
    expect(frames()).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toBe('Updating page');

    const restore = postMessage.mock.calls.find(
      ([message]) => (message as Record<string, unknown>).type === 'stashbase-scroll-restore',
    )?.[0] as Record<string, unknown>;
    act(() => {
      globalThis.dispatchEvent(
        new MessageEvent('message', {
          data: { reqId: restore.reqId, type: 'stashbase-scroll-restored' },
          source: replacementWindow,
        }),
      );
    });
    // The page and its check land together, after the status has spun.
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Page updated'));
    expect(replacement.closest('[inert]')).toBeNull();
    await waitFor(() => expect(frames()).toEqual([replacement]));
  });
});
