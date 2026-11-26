import { describe, expect, it, vi } from 'vite-plus/test';

import { PreparationError } from '@/features/preparation/application/ports';
import type { HttpClient } from '@/platform/http/client';

import { createPreparationStatusAdapter } from './status-api';

const wire = {
  conversionProgress: { 'a.pdf': { lane: 'heavy', phase: 'queued', tasksAhead: 1 } },
  conversionRevision: 3,
  conversionVersions: {},
  folder: '/project/research',
  indexReady: true,
  indexWarning: { at: '2026-09-09T00:00:00.000Z', message: 'daemon restarted' },
  indexed: 2,
  orphaned: [],
  orphanedCount: 0,
  pending: ['notes.md'],
  pendingConversions: ['a.pdf'],
  pendingCount: 1,
  preparationFailures: [],
  semanticIndexing: { state: 'indexing' },
  total: 5,
  treeVersion: 9,
  upToDate: false,
  visibleIndexingSettled: true,
};

describe('preparation status API', () => {
  it('requests the explicit folder and maps the semantic block', async () => {
    const request = vi.fn(async () => ({ body: wire, status: 200 }));
    const status = await createPreparationStatusAdapter({ request }).load(
      '/project/research',
      new AbortController().signal,
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/index-status?folder=%2Fproject%2Fresearch' }),
    );
    expect(status.conversionProgress['a.pdf']?.phase).toBe('queued');
    expect(status.semantic).toEqual({ partial: false, remaining: 1, state: 'indexing' });
    expect(status.indexSettled).toBe(true);
    expect(status.indexWarning).toEqual({
      at: '2026-09-09T00:00:00.000Z',
      sentence: 'daemon restarted',
    });
  });

  it('folds a partial daemon state into the variant that carries what it means', async () => {
    const partial = {
      ...wire,
      semanticIndexing: { state: 'partial-indexing' },
      visibleIndexingSettled: false,
    };
    const request = vi.fn(async () => ({ body: partial, status: 200 }));

    const status = await createPreparationStatusAdapter({ request }).load(
      '/project/research',
      new AbortController().signal,
    );

    expect(status.semantic).toEqual({ partial: true, remaining: 1, state: 'indexing' });
    expect(status.indexSettled).toBe(false);
  });

  it('classifies a lost folder scope and an invalid body', async () => {
    const lost: HttpClient = {
      request: vi.fn(async () => ({
        body: { code: 'NO_FOLDER', error: 'no folder' },
        status: 412,
      })),
    };
    await expect(
      createPreparationStatusAdapter(lost).load('/project/x', new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'scope-lost' });
    const invalid: HttpClient = {
      request: vi.fn(async () => ({ body: { nope: true }, status: 200 })),
    };
    await expect(
      createPreparationStatusAdapter(invalid).load('/project/x', new AbortController().signal),
    ).rejects.toBeInstanceOf(PreparationError);
  });
});
