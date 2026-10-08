/** The index transport: what reaches the shop, what the proxy rewrites, and
 *  why nothing here throws. */
import { describe, expect, it, vi } from 'vite-plus/test';

import type { HttpClient } from '@/platform/http/client';

import { createGalleryIndexAdapter } from './gallery-api';

const ENTRY = {
  about: 'Why I made this.',
  category: 'course',

  description: 'A course.',
  id: 'cs183b',
  name: 'How to Start a Startup',
  repo: 'https://github.com/owner/repo',
};

function client(response: { body: unknown; status?: number } | Error): HttpClient {
  return {
    request: vi.fn(async () => {
      if (response instanceof Error) throw response;
      return { body: response.body, status: response.status ?? 200 };
    }),
  };
}

const load = (transport: HttpClient) =>
  createGalleryIndexAdapter(transport, 'http://127.0.0.1:18196').loadIndex(
    new AbortController().signal,
  );

describe('gallery index adapter', () => {
  it('makes every optional slot explicit rather than absent', async () => {
    const index = await load(client({ body: { wikis: [ENTRY] } }));
    expect(index?.personas).toBeNull();
    expect(index?.wikis).toEqual([
      {
        about: 'Why I made this.',
        category: 'course',

        description: 'A course.',

        id: 'cs183b',

        name: 'How to Start a Startup',
        repo: 'https://github.com/owner/repo',
        screenshot: null,
      },
    ]);
  });

  it('loads an unversioned catalog and proxies its single cover', async () => {
    const entries = await load(
      client({ body: { wikis: [{ ...ENTRY, screenshot: 'https://assets.stashbase.ai/a.png' }] } }),
    );
    expect(entries?.wikis[0]?.screenshot).toBe(
      'http://127.0.0.1:18196/api/gallery/image?src=https%3A%2F%2Fassets.stashbase.ai%2Fa.png',
    );
    const local = await load(client({ body: { wikis: [{ ...ENTRY, screenshot: '/local.png' }] } }));
    expect(local?.wikis[0]?.screenshot).toBe('/local.png');
  });

  it('answers null for every index it cannot read', async () => {
    // Unreachable and malformed responses are one outcome to a shop
    // that always has the snapshot. The offline envelope is a 200 by design,
    // so it has to be caught by the schema rather than by the status.
    expect(await load(client({ body: { error: 'offline' } }))).toBeNull();
    expect(await load(client({ body: { wikis: [{}] } }))).toBeNull();
    expect(await load(client({ body: null, status: 502 }))).toBeNull();
    expect(await load(client(new Error('network down')))).toBeNull();
  });
});
