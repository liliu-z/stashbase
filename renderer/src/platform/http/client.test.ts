import { describe, expect, it, vi } from 'vite-plus/test';

import { createHttpClient } from './client';

describe('HTTP client', () => {
  it('targets the configured server origin and serializes JSON without renderer identity', async () => {
    const fetchRequest = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ current: null }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
    );
    const client = createHttpClient('http://127.0.0.1:43123', fetchRequest);

    await client.request({
      body: { path: '/project/notes' },
      method: 'POST',
      path: '/api/projects/open',
    });

    const firstCall = fetchRequest.mock.calls[0];
    if (!firstCall) throw new Error('Expected the client to issue a fetch.');
    const [url, init] = firstCall;
    expect(String(url)).toBe('http://127.0.0.1:43123/api/projects/open');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ path: '/project/notes' }));
    expect(new Headers(init?.headers).get('x-stashbase-window-id')).toBeNull();
  });

  it('leaves invalid JSON for the owning adapter to classify', async () => {
    const client = createHttpClient(
      'http://127.0.0.1:8090',
      vi.fn(async () => new Response('not-json', { status: 502 })),
    );
    await expect(client.request({ path: '/api/projects' })).resolves.toEqual({
      body: null,
      status: 502,
    });
  });

  it('supports versioned PUT bodies', async () => {
    const fetchRequest = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ version: 'v2' }), { status: 200 }),
    );
    const client = createHttpClient('http://127.0.0.1:8090', fetchRequest);

    await client.request({
      body: { baseVersion: 'v1', content: 'changed' },
      method: 'PUT',
      path: '/api/files/notes.txt?folder=%2Fproject%2Fnotes',
    });

    const firstCall = fetchRequest.mock.calls[0];
    if (!firstCall) throw new Error('Expected the client to issue a fetch.');
    const [, init] = firstCall;
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe(JSON.stringify({ baseVersion: 'v1', content: 'changed' }));
  });

  it('exposes response headers only for metadata HEAD requests', async () => {
    const client = createHttpClient(
      'http://127.0.0.1:8090',
      vi.fn(
        async () =>
          new Response(null, {
            headers: { 'x-stashbase-file-version': 'v3' },
            status: 204,
          }),
      ),
    );

    await expect(client.request({ method: 'HEAD', path: '/api/files/paper.pdf' })).resolves.toEqual(
      {
        body: null,
        headers: { 'x-stashbase-file-version': 'v3' },
        status: 204,
      },
    );
  });
});

it('reports transport failures without capturing the request and ignores requested cancellation', async () => {
  const error = new TypeError('Failed to fetch');
  const report = vi.fn();
  const client = createHttpClient(
    'http://127.0.0.1:8090',
    vi.fn(async () => {
      throw error;
    }),
    report,
  );
  await expect(
    client.request({ path: '/api/files/private.md?folder=private', body: { content: 'private' } }),
  ).rejects.toBe(error);
  expect(report).toHaveBeenCalledExactlyOnceWith(error, 'http-transport');
  const signal = AbortSignal.abort();
  await expect(client.request({ path: '/api/files/private.md', signal })).rejects.toBe(error);
  expect(report).toHaveBeenCalledTimes(1);
});
