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
    await expect(client.request({ path: '/api/projects' })).resolves.toMatchObject({
      body: null,
      bodyError: expect.any(SyntaxError),
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

  it('recovers a bare 304 once without treating an empty body as settings', async () => {
    const fetchRequest = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(Response.json({ current: 'live-project' }));
    const report = vi.fn();
    const signal = new AbortController().signal;
    const client = createHttpClient('http://127.0.0.1:8090', fetchRequest, report);
    await expect(client.request({ path: '/api/account', signal })).resolves.toMatchObject({
      body: { current: 'live-project' },
      status: 200,
    });
    expect(fetchRequest).toHaveBeenCalledTimes(2);
    expect(fetchRequest.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store', signal });
    expect(fetchRequest.mock.calls[1]?.[1]).toMatchObject({ cache: 'reload', signal });
    expect(report).not.toHaveBeenCalled();
  });

  it('bounds 304 recovery and never replays writes or cancelled reads', async () => {
    for (const method of ['GET', 'POST'] as const) {
      const fetchRequest = vi.fn(async () => new Response(null, { status: 304 }));
      const report = vi.fn();
      const client = createHttpClient('http://127.0.0.1:8090', fetchRequest, report);
      await expect(client.request({ path: '/api/account', method })).resolves.toMatchObject({
        status: 304,
        bodyError: expect.any(SyntaxError),
      });
      expect(fetchRequest).toHaveBeenCalledTimes(method === 'GET' ? 2 : 1);
      expect(report).toHaveBeenCalledTimes(1);
    }
    const controller = new AbortController();
    const fetchRequest = vi.fn(async () => {
      controller.abort();
      return new Response(null, { status: 304 });
    });
    const report = vi.fn();
    const client = createHttpClient('http://127.0.0.1:8090', fetchRequest, report);
    await expect(client.request({ path: '/api/account', signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );
    expect(fetchRequest).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  });

  it('exposes metadata for HEAD requests without trying to parse an absent body', async () => {
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
  const ids: string[] = [];
  const client = createHttpClient(
    'http://127.0.0.1:8090',
    vi.fn(async (_url, init) => {
      ids.push(new Headers(init?.headers).get('x-stashbase-request-id') ?? '');
      throw error;
    }),
    report,
  );
  await expect(
    client.request({ path: '/api/files/private.md?folder=private', body: { content: 'private' } }),
  ).rejects.toBe(error);
  expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(report).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      message: error.message,
      name: error.name,
      request_id: ids[0],
    }),
    'http-transport',
    {
      method: 'GET',
      route: '/api/files/*',
      elapsed_ms: expect.any(Number),
    },
  );
  const signal = AbortSignal.abort();
  await expect(client.request({ path: '/api/files/private.md', signal })).rejects.toBe(error);
  expect(report).toHaveBeenCalledTimes(1);
  expect(ids[1]).not.toBe(ids[0]);
  expect(JSON.stringify(report.mock.calls)).not.toContain('private');
});

it('retains correlation when a response body times out without replaying the request', async () => {
  const timeout = new DOMException('The operation timed out', 'TimeoutError');
  const report = vi.fn();
  let requestId = '';
  const fetchRequest = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requestId = new Headers(init?.headers).get('x-stashbase-request-id') ?? '';
    return Object.assign(Response.json({}), {
      json: async () => {
        throw timeout;
      },
    });
  });
  const client = createHttpClient('http://127.0.0.1:8090', fetchRequest, report);
  const result = await client.request({ path: '/api/scheduled-tasks/projects?folder=secret' });
  expect(result.bodyError).toBe(timeout);
  expect(fetchRequest).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({
      request_id: requestId,
      status: 200,
      cause: timeout,
    }),
    'http-response',
    expect.objectContaining({ route: '/api/scheduled-tasks/projects' }),
  );
});
