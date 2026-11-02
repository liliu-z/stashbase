import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vite-plus/test';

import type { DocumentSourcePort } from '@/features/documents/application/ports';
import { assetApi, sourceApi } from '@/test/fakes/documents';

import { registerSourceCleanup, renderSource } from './document-source.harness';

registerSourceCleanup();
afterEach(() => vi.unstubAllGlobals());

it('counts native input in the active HTML reader and retires its subscription when covered', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const recordUsage = vi.fn();
  const listeners = new Set<(kind: 'keyboard' | 'pointer') => void>();
  const { runtime } = renderSource(
    sourceApi(),
    { folderPath: '/project/notes', path: 'form.html' },
    {
      assetApi: assetApi({
        load: vi.fn(async () => ({
          kind: 'source' as const,
          url: 'data:text/html,form',
          version: 'one',
        })),
      }),
      onInputActivity: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      recordUsage,
    },
  );
  const frame = await screen.findByTitle<HTMLIFrameElement>('form.html HTML preview');
  frame.focus();
  const hover = vi.spyOn(frame, 'matches').mockReturnValue(false);
  const emit = async (kind: 'keyboard' | 'pointer') => {
    vi.useFakeTimers();
    act(() => {
      for (const listener of listeners) listener(kind);
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    vi.useRealTimers();
  };
  fireEvent.focus(frame);
  fireEvent.keyDown(frame);
  await emit('pointer');
  expect(recordUsage).not.toHaveBeenCalled();
  await emit('keyboard');
  expect(recordUsage).toHaveBeenLastCalledWith({
    event: 'document_engaged',
    activity: 'read',
    format: 'html',
  });
  hover.mockReturnValue(true);
  await emit('pointer');
  expect(recordUsage).toHaveBeenCalledTimes(2);
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  await emit('keyboard');
  expect(recordUsage).toHaveBeenCalledTimes(2);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  await act(async () => {
    await runtime.open({ folderPath: '/project/notes', path: 'other.html' });
  });
  await screen.findByTitle('other.html HTML preview');
  frame.focus();
  await emit('keyboard');
  expect(recordUsage).toHaveBeenCalledTimes(2);
});

it('binds only its own frame, requires input activation, autosaves data, keeps the form through navigation, and reloads it for HTML and data changes', async () => {
  const activation = { isActive: false };
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'userActivation');
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: activation });
  const asset = { kind: 'source' as const, url: 'data:text/html,form', version: 'v1' };
  const assets = assetApi({ load: vi.fn(async () => asset) });
  let disk = '{"name":"old"}';
  let version = 'v1';
  const api = sourceApi({
    load: vi.fn<DocumentSourcePort['load']>(async () => ({
      content: disk,
      format: 'json',
      version,
    })),
    save: vi.fn<DocumentSourcePort['save']>(async (_source, input) => {
      disk = input.content;
      version += '+';
      return { content: disk, format: 'json', version };
    }),
  });
  const { queryClient, runtime } = renderSource(
    api,
    { folderPath: '/project/notes', path: 'form.html' },
    { assetApi: assets },
  );
  queryClient.setQueryDefaults(['documents'], { gcTime: Number.POSITIVE_INFINITY });
  try {
    const frame = await screen.findByTitle<HTMLIFrameElement>('form.html HTML preview');
    let target = required(frame.contentWindow);
    let reply = vi.spyOn(target, 'postMessage');
    let id = 0;
    const send = async (method: string, content?: string, source: Window = target) => {
      const requestId = ++id;
      act(() =>
        window.dispatchEvent(
          new MessageEvent('message', {
            source,
            data: { type: 'stashbase-data-request', id: requestId, method, content },
          }),
        ),
      );
      await waitFor(() =>
        expect(reply).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'stashbase-data-result',
            id: requestId,
          }),
          '*',
        ),
      );
      return required(reply.mock.calls.find(([message]) => message.id === requestId)?.[0]);
    };
    fireEvent.load(frame);
    expect(reply).toHaveBeenCalledWith({ type: 'stashbase-data-ready' }, '*');
    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window,
          data: { type: 'stashbase-data-request', id: 900, method: 'load' },
        }),
      ),
    );
    expect(api.load).not.toHaveBeenCalled();
    expect((await send('load')).value).toEqual({ name: 'old' });
    expect(screen.queryByText('Data: form.json')).toBeNull();
    expect((await send('update', '{"name":"refused"}')).error).toContain('form control');
    activation.isActive = true;
    expect((await send('update', '{"name":"draft"}')).error).toBeUndefined();
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'form.json' }),
        { baseVersion: 'v1', content: '{"name":"draft"}' },
        expect.any(AbortSignal),
      ),
    );
    const json = required(runtime.getDocument('tab-1')?.htmlData?.store.getState().document);
    expect(runtime.store.getState().tabs.map((tab) => tab.source.path)).toEqual(['form.html']);
    await act(async () => {
      await runtime.open(json.scope.source);
    });
    expect(screen.getByTitle('form.html HTML preview')).toBe(frame);
    expect((await send('update', '{"name":"hidden"}')).error).toContain('form control');
    await act(async () => {
      await runtime.activate('tab-1');
    });
    vi.mocked(assets.load).mockResolvedValue({
      ...asset,
      url: 'data:text/html,new',
      version: 'v2',
    });
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(
      () => expect(screen.getByTitle('form.html HTML preview')).not.toBe(frame),
      REPLACED,
    );
    const rewritten = screen.getByTitle<HTMLIFrameElement>('form.html HTML preview');
    expect(rewritten.getAttribute('sandbox')).toBe('allow-scripts');
    target = required(rewritten.contentWindow);
    reply = vi.spyOn(target, 'postMessage');
    expect((await send('load')).value).toEqual({ name: 'draft' });
    expect((await send('save')).error).toBeUndefined();

    await act(async () => {
      json.change('{"name":"JSON editor"}');
      await json.save(api);
    });
    await waitFor(
      () => expect(screen.getByTitle('form.html HTML preview')).not.toBe(rewritten),
      REPLACED,
    );
    const fromEditor = screen.getByTitle<HTMLIFrameElement>('form.html HTML preview');
    target = required(fromEditor.contentWindow);
    reply = vi.spyOn(target, 'postMessage');
    expect((await send('load')).value).toEqual({ name: 'JSON editor' });

    disk = '{"name":"external"}';
    version += '!';
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(
      () => expect(screen.getByTitle('form.html HTML preview')).not.toBe(fromEditor),
      REPLACED,
    );
    target = required(screen.getByTitle<HTMLIFrameElement>('form.html HTML preview').contentWindow);
    reply = vi.spyOn(target, 'postMessage');
    expect((await send('load')).value).toEqual({ name: 'external' });

    // Reopening the JSON editor must not replay its older cached source while
    // the next disk read is pending.
    const reads = vi.mocked(api.load).mock.calls.length;
    vi.mocked(api.load).mockImplementationOnce(() => new Promise(() => undefined));
    await act(async () => {
      await runtime.activate(json.scope.id);
    });
    await waitFor(() => expect(vi.mocked(api.load).mock.calls.length).toBeGreaterThan(reads));
    expect(json.store.getState().editor?.value).toBe('{"name":"external"}');
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'userActivation', descriptor);
    else Reflect.deleteProperty(navigator, 'userActivation');
  }
});

/** A replacement shows after its status has spun and the old page has faded. */
const REPLACED = { timeout: 3_000 };

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('Expected the form document to exist.');
  return value;
}
