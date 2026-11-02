import { act, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vite-plus/test';

import { assetApi, sourceApi } from '@/test/fakes/documents';

import { registerSourceCleanup, renderSource } from './document-source.harness';

registerSourceCleanup();

it('retains the HTML frame on unchanged or failed reads and reloads it for newer source bytes', async () => {
  const before = {
    kind: 'source' as const,
    url: 'data:text/html,one',
    version: 'one',
  };
  const api = assetApi({ load: vi.fn(async () => before) });
  renderSource(
    sourceApi(),
    { folderPath: '/project/notes', path: 'archive.html' },
    {
      assetApi: api,
    },
  );
  const frame = await screen.findByTitle('archive.html HTML preview');
  expect(frame.getAttribute('src')).toBe(before.url);

  vi.mocked(api.load).mockClear();
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  await waitFor(() => expect(api.load).toHaveBeenCalledOnce());
  expect(screen.getByTitle('archive.html HTML preview')).toBe(frame);

  vi.mocked(api.load).mockRejectedValueOnce(new Error('offline'));
  act(() => window.dispatchEvent(new Event('focus')));
  await screen.findByText('Refresh failed. Showing the last loaded preview.');
  expect(screen.getByTitle('archive.html HTML preview')).toBe(frame);

  const after = { ...before, url: 'data:text/html,two', version: 'two' };
  vi.mocked(api.load).mockResolvedValue(after);
  act(() => window.dispatchEvent(new Event('focus')));
  // The replacement shows after its status has spun and the old page has faded.
  await waitFor(
    () => {
      const refreshed = screen.getByTitle('archive.html HTML preview');
      expect(refreshed).not.toBe(frame);
      expect(refreshed.getAttribute('src')).toBe(after.url);
      expect(refreshed.getAttribute('sandbox')).toBe('allow-scripts');
    },
    { timeout: 3_000 },
  );
});
