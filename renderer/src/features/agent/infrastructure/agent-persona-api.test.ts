import { describe, expect, it, vi } from 'vite-plus/test';

import type { HttpClient } from '@/platform/http/client';

import { createAgentPersonaAdapter } from './agent-persona-api';

const PERSONA = {
  description: 'A neutral news report',
  gallery: 'journalist',
  icon: 'newspaper',
  id: 'journalist',
  name: 'Journalist',
  prompt: 'Report what happened.',
};
const signal = () => new AbortController().signal;

function adapter(body: unknown = PERSONA) {
  const request = vi.fn(async () => ({ body, status: 200 }));
  return { adapter: createAgentPersonaAdapter({ request } as HttpClient), request };
}

describe('agent persona adapter', () => {
  it('lists the library', async () => {
    const { adapter: api } = adapter([PERSONA]);
    await expect(api.list(signal())).resolves.toEqual([PERSONA]);
  });

  it('edits one persona by its id, encoded into the path', async () => {
    const { adapter: api, request } = adapter();
    await api.update(
      'journalist',
      { description: '', icon: 'newspaper', name: 'Reporter', prompt: 'Report.' },
      signal(),
    );

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'PUT', path: '/api/agent-personas/journalist' }),
    );
  });

  it('refuses a persona the service answers with a path for an id', async () => {
    const { adapter: api } = adapter({ ...PERSONA, id: '../escape' });
    await expect(
      api.create({ description: '', icon: 'drama', name: 'X', prompt: 'P' }, signal()),
    ).rejects.toThrow('unexpected response');
  });
});
