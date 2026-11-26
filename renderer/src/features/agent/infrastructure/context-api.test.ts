import { describe, expect, it, vi } from 'vite-plus/test';

import { AgentContextError } from '@/features/agent/application/ports';
import { httpClient } from '@/test/fakes/http';

import { createAgentContextAdapter } from './context-api';

const origin = 'http://127.0.0.1:43123';
const source = { folderPath: '/Library/Research', path: 'papers/report.pdf' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof AgentContextError ? error.kind : 'other';
  }
}

describe('Agent context API', () => {
  it('resolves a derived source through the JSON client', async () => {
    const http = httpClient({
      available: true,
      folder: 'Research',
      kind: 'derived',
      path: '/Library/Research/papers/report.pdf',
      reason: '',
      sourceFormat: 'pdf',
      sourcePath: 'papers/report.pdf',
    });
    const api = createAgentContextAdapter(http, origin);
    const resolved = await api.resolve(source, new AbortController().signal);
    expect(resolved).toMatchObject({
      kind: 'derived',
      path: '/Library/Research/papers/report.pdf',
    });
    const request = vi.mocked(http.request).mock.calls[0]?.[0];
    expect(request?.path).toBe(
      `/api/project/agent-context-file?${new URLSearchParams({ path: '/Library/Research/papers/report.pdf' })}`,
    );
  });

  it('maps a missing file, an unsupported format, and an invalid body', async () => {
    const signal = new AbortController().signal;
    expect(
      await kindOf(
        createAgentContextAdapter(httpClient({ error: 'not found' }, 404), origin).resolve(
          source,
          signal,
        ),
      ),
    ).toBe('not-found');
    expect(
      await kindOf(
        createAgentContextAdapter(httpClient({ error: 'unsupported format' }, 415), origin).resolve(
          source,
          signal,
        ),
      ),
    ).toBe('unsupported');
    expect(
      await kindOf(
        createAgentContextAdapter(httpClient({ path: 1 }), origin).resolve(source, signal),
      ),
    ).toBe('invalid-response');
  });

  it('uploads transient files as multipart to the server origin', async () => {
    const fetchRequest = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        files: [
          { name: 'shot.png', path: '/tmp/stashbase-attachments/1/shot.png' },
          { error: 'write failed', name: 'big.bin' },
        ],
      }),
    );
    const api = createAgentContextAdapter(httpClient(null), origin, fetchRequest);
    const outcomes = await api.upload(
      [new File(['png'], 'shot.png', { type: 'image/png' }), new File(['x'], 'big.bin')],
      new AbortController().signal,
      '/project/Research',
    );
    expect(outcomes).toEqual([
      { name: 'shot.png', path: '/tmp/stashbase-attachments/1/shot.png' },
      { error: 'write failed', name: 'big.bin' },
    ]);
    const [url, init] = fetchRequest.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${origin}/api/agent/attach`);
    expect(init?.method).toBe('POST');
    const form = init?.body;
    if (!(form instanceof FormData)) throw new Error('The upload sent no multipart body.');
    expect(form.get('folder')).toBe('/project/Research');
    expect(form.getAll('files').map((entry) => (entry instanceof File ? entry.name : ''))).toEqual([
      'shot.png',
      'big.bin',
    ]);
  });

  it('maps a failed upload to unavailable with the server message', async () => {
    const api = createAgentContextAdapter(
      httpClient(null),
      origin,
      vi.fn(async () => jsonResponse({ error: 'could not secure attachment storage' }, 500)),
    );
    const promise = api.upload(
      [new File(['x'], 'a.txt')],
      new AbortController().signal,
      '/project/Research',
    );
    await expect(promise).rejects.toMatchObject({
      kind: 'unavailable',
      message: 'could not secure attachment storage',
    });
  });
});
