import { describe, expect, it, vi } from 'vite-plus/test';

import { createFolderPicker, mapFolderSelection } from './folder-picker';

describe('project folder picker adapter', () => {
  it('maps selected, cancelled, and classified failure responses', () => {
    expect(mapFolderSelection({ ok: true, folderPath: '/project/notes' })).toEqual({
      status: 'selected',
      folderPath: '/project/notes',
    });
    expect(mapFolderSelection({ ok: true, folderPath: null })).toEqual({
      status: 'cancelled',
    });
    expect(
      mapFolderSelection({
        ok: false,
        failure: { kind: 'unavailable', message: 'Folder picker unavailable.' },
      }),
    ).toEqual({
      status: 'failed',
      failure: { kind: 'unavailable', message: 'Folder picker unavailable.' },
    });
  });
});

it('reports native failures while preserving cancellation and the original result', async () => {
  const report = vi.fn();
  const chooseFolder = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, folderPath: null })
    .mockResolvedValueOnce({
      ok: false,
      failure: { kind: 'unavailable', message: 'Private project failed' },
    })
    .mockRejectedValueOnce(new Error('IPC failed'));
  const picker = createFolderPicker({ chooseFolder }, report);
  expect(await picker.chooseFolder()).toEqual({ status: 'cancelled' });
  expect(report).not.toHaveBeenCalled();
  expect(await picker.chooseFolder()).toMatchObject({ status: 'failed' });
  expect(report.mock.calls[0]?.[0].message).not.toContain('Private project');
  await expect(picker.chooseFolder()).rejects.toThrow('IPC failed');
  expect(report).toHaveBeenCalledTimes(2);
});
