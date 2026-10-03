import { describe, expect, it, vi } from 'vite-plus/test';

import type { HttpClient } from '@/platform/http/client';
import { appearanceSurface } from '@/test/fakes/settings';

import { createAppearanceAdapter } from './appearance-api';

const signal = new AbortController().signal;

const SAVED = { ...appearanceSurface(), theme: 'dark' } as const;

describe('appearance API', () => {
  it('reads the record through the appearance route', async () => {
    const request = vi.fn(async () => ({ body: SAVED, status: 200 }));
    await expect(createAppearanceAdapter({ request }).load(signal)).resolves.toEqual(SAVED);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/appearance' }));
  });

  it('writes one row at a time and answers with the whole record', async () => {
    const request = vi.fn(async () => ({ body: SAVED, status: 200 }));
    const api = createAppearanceAdapter({ request });
    await expect(api.update({ theme: 'dark' }, signal)).resolves.toEqual(SAVED);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { theme: 'dark' },
        method: 'PUT',
        path: '/api/appearance',
      }),
    );
  });

  it('classifies an unreadable setting as unavailable', async () => {
    const client: HttpClient = {
      request: vi.fn(async () => {
        throw new Error('offline');
      }),
    };
    await expect(createAppearanceAdapter(client).load(signal)).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });
});
