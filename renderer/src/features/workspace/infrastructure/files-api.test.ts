import { describe, expect, it, vi } from 'vite-plus/test';

import { createHttpClient, type HttpClient } from '@/platform/http/client';
import { errorDiagnostic } from '@/protocols/http/telemetry';
import { listing, listingFile } from '@/test/fakes/workspace';

import { createFilesAdapter } from './files-api';

describe('files API', () => {
  it('requests the explicit folder and maps validated defaults', async () => {
    const client: HttpClient = {
      request: vi.fn(async () => ({
        body: {
          files: [
            {
              format: 'md',
              name: 'notes/plan.md',
              size: 42,
            },
          ],
          folder: 'Research',
          folders: [{ path: 'notes' }],
          showHiddenFiles: false,
        },
        status: 200,
      })),
    };
    const signal = new AbortController().signal;

    await expect(createFilesAdapter(client).load('/project/research', signal)).resolves.toEqual(
      listing(
        [
          listingFile({
            path: 'notes/plan.md',
            size: 42,
          }),
        ],
        ['notes'],
      ),
    );
    expect(client.request).toHaveBeenCalledWith({
      path: '/api/files?folder=%2Fproject%2Fresearch',
      signal,
    });
  });

  it('rejects malformed success responses at the adapter boundary', async () => {
    const api = createFilesAdapter({
      request: vi.fn(async () => ({ body: { files: [], folder: 'Notes' }, status: 200 })),
    });

    await expect(api.load('/project/notes', new AbortController().signal)).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('encodes each reveal path segment and validates the response', async () => {
    const client: HttpClient = {
      request: vi.fn(async () => ({ body: {}, status: 200 })),
    };
    const signal = new AbortController().signal;

    await createFilesAdapter(client).reveal('/project/notes', 'drafts/a #1.md', signal);

    expect(client.request).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/reveal/drafts/a%20%231.md?folder=%2Fproject%2Fnotes',
      signal,
    });
  });

  it('rejects an invalid reveal identity before transport', async () => {
    const client: HttpClient = { request: vi.fn() };

    await expect(
      createFilesAdapter(client).reveal('', 'drafts/plan.md', new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'unavailable', message: 'The item identity is invalid.' });
    expect(client.request).not.toHaveBeenCalled();
  });

  it('classifies a cleared window context as scope loss', async () => {
    const api = createFilesAdapter({
      request: vi.fn(async () => ({
        body: { code: 'NO_FOLDER', error: 'no folder open' },
        status: 412,
      })),
    });

    await expect(api.load('/project/notes', new AbortController().signal)).rejects.toMatchObject({
      kind: 'scope-lost',
      message: 'This project is no longer available in this window.',
    });
  });

  it('creates files and folders inside the explicit folder and settles on the server path', async () => {
    const client: HttpClient = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ body: { content: '', name: 'drafts/Plan.md' }, status: 200 })
        .mockResolvedValueOnce({ body: { path: 'drafts/archive' }, status: 200 }),
    };
    const signal = new AbortController().signal;
    const api = createFilesAdapter(client);

    await expect(
      api.createEntry('/project/notes', 'file', 'drafts', 'Plan', signal),
    ).resolves.toEqual({ path: 'drafts/Plan.md' });
    expect(client.request).toHaveBeenNthCalledWith(1, {
      body: { dir: 'drafts', name: 'Plan' },
      method: 'POST',
      path: expect.stringMatching(/^\/api\/files\?folder=%2Fproject%2Fnotes&operationId=[\w-]+$/u),
      signal,
    });
    await expect(
      api.createEntry('/project/notes', 'folder', 'drafts', 'archive', signal),
    ).resolves.toEqual({ path: 'drafts/archive' });
    expect(client.request).toHaveBeenNthCalledWith(2, {
      body: { path: 'drafts/archive' },
      method: 'POST',
      path: expect.stringMatching(
        /^\/api\/folders\?folder=%2Fproject%2Fnotes&operationId=[\w-]+$/u,
      ),
      signal,
    });
    await expect(
      api.createEntry('/project/notes', 'file', '', 'a/b', signal),
    ).rejects.toMatchObject({ kind: 'rejected' });
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it('renames and deletes entries by kind and classifies refusals', async () => {
    const client: HttpClient = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          body: { linksUpdated: 1, name: 'drafts/Outline.md' },
          status: 200,
        })
        .mockResolvedValueOnce({ body: { path: 'archive' }, status: 200 })
        .mockResolvedValueOnce({ body: { alreadyGone: false }, status: 200 })
        .mockResolvedValueOnce({ body: { error: 'target already exists' }, status: 409 })
        .mockResolvedValueOnce({ body: { code: 'FOLDER_CHANGED', error: 'stale' }, status: 409 })
        .mockResolvedValueOnce({ body: { error: 'new_name required' }, status: 400 }),
    };
    const signal = new AbortController().signal;
    const api = createFilesAdapter(client);

    await expect(
      api.renameEntry(
        '/project/notes',
        { kind: 'file', path: 'drafts/a #1.md' },
        'Outline',
        signal,
      ),
    ).resolves.toEqual({ path: 'drafts/Outline.md' });
    expect(client.request).toHaveBeenNthCalledWith(1, {
      body: { new_name: 'Outline' },
      method: 'PATCH',
      path: expect.stringMatching(
        /^\/api\/files\/drafts\/a%20%231\.md\?folder=%2Fproject%2Fnotes&operationId=[\w-]+$/u,
      ),
      signal,
    });
    await expect(
      api.renameEntry('/project/notes', { kind: 'folder', path: 'drafts' }, 'archive', signal),
    ).resolves.toEqual({ path: 'archive' });
    expect(client.request).toHaveBeenNthCalledWith(2, {
      body: { new_name: 'archive' },
      method: 'PATCH',
      path: expect.stringMatching(
        /^\/api\/folders\/drafts\?folder=%2Fproject%2Fnotes&operationId=[\w-]+$/u,
      ),
      signal,
    });
    await expect(
      api.deleteEntry('/project/notes', { kind: 'folder', path: 'archive' }, signal),
    ).resolves.toBeUndefined();
    expect(client.request).toHaveBeenNthCalledWith(3, {
      method: 'DELETE',
      path: expect.stringMatching(
        /^\/api\/folders\/archive\?folder=%2Fproject%2Fnotes&operationId=[\w-]+$/u,
      ),
      signal,
    });
    await expect(
      api.renameEntry('/project/notes', { kind: 'file', path: 'a.md' }, 'b', signal),
    ).rejects.toMatchObject({
      kind: 'conflict',
      message: 'Something with that name already exists.',
    });
    await expect(
      api.deleteEntry('/project/notes', { kind: 'file', path: 'a.md' }, signal),
    ).rejects.toMatchObject({ kind: 'scope-lost' });
    await expect(
      api.renameEntry('/project/notes', { kind: 'file', path: 'a.md' }, 'b', signal),
    ).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('moves a file or folder into a folder by naming only the destination', async () => {
    const client: HttpClient = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ body: { linksUpdated: 0, name: ' archive/a #1.md' }, status: 200 })
        .mockResolvedValueOnce({ body: { path: ' archive/drafts' }, status: 200 }),
    };
    const signal = new AbortController().signal;
    const api = createFilesAdapter(client);

    await expect(
      api.moveEntry(
        '/project/notes',
        { kind: 'file', path: ' drafts/a #1.md' },
        ' archive',
        signal,
      ),
    ).resolves.toEqual({ path: ' archive/a #1.md' });
    expect(client.request).toHaveBeenCalledWith({
      body: { dir: ' archive' },
      method: 'PATCH',
      path: expect.stringMatching(
        /^\/api\/files\/%20drafts\/a%20%231\.md\?folder=%2Fproject%2Fnotes&operationId=[\w-]+$/u,
      ),
      signal,
    });
    await expect(
      api.moveEntry('/project/notes', { kind: 'folder', path: 'drafts' }, ' archive', signal),
    ).resolves.toEqual({ path: ' archive/drafts' });
    expect(client.request).toHaveBeenLastCalledWith({
      body: { dir: ' archive' },
      method: 'PATCH',
      path: expect.stringMatching(
        /^\/api\/folders\/drafts\?folder=%2Fproject%2Fnotes&operationId=[\w-]+$/u,
      ),
      signal,
    });
  });
});

it('retains the original JSON failure and response identity for a failed listing', async () => {
  const parseError = new SyntaxError('Unexpected end of JSON input');
  const report = vi.fn();
  const response = new Response(null, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'listing-request-42',
    },
  });
  vi.spyOn(response, 'json').mockRejectedValue(parseError);
  const api = createFilesAdapter(
    createHttpClient('http://127.0.0.1:8090', async () => response, report),
  );
  await expect(api.load('/private/project', new AbortController().signal)).rejects.toMatchObject({
    kind: 'invalid-response',
    cause: parseError,
  });
  expect(report).toHaveBeenCalledTimes(1);
  const diagnostic = errorDiagnostic(report.mock.calls[0]?.[0]);
  expect(diagnostic).toMatchObject({
    http_status: 200,
    request_id: 'listing-request-42',
    content_type: 'application/json',
  });
  expect(diagnostic.causes?.[0]).toMatchObject({
    name: 'SyntaxError',
    message: parseError.message,
    stack: parseError.stack,
  });
  expect(report.mock.calls[0]?.slice(1)).toEqual([
    'http-response',
    { method: 'GET', route: '/api/files', elapsed_ms: expect.any(Number) },
  ]);
  expect(JSON.stringify(diagnostic)).not.toContain('/private/project');
});

it('keeps cancellation during the response body out of invalid-listing diagnostics', async () => {
  const controller = new AbortController();
  const report = vi.fn();
  const response = new Response(null, { status: 200 });
  vi.spyOn(response, 'json').mockImplementation(async () => {
    controller.abort();
    throw controller.signal.reason;
  });
  const api = createFilesAdapter(
    createHttpClient('http://127.0.0.1:8090', async () => response, report),
  );
  await expect(api.load('/project', controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(report).not.toHaveBeenCalled();
});
