import { cleanup, render, screen } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { SoftwareUpdateRow } from '@/shared/domain/software-update';
import type { VoiceModelState } from '@/shared/domain/voice-typing';
import { createTestQueryClient, queryWrapper } from '@/test/query';

import { GeneralPanel } from './general-panel';

afterEach(cleanup);

function renderPanel(softwareUpdate: SoftwareUpdateRow | null = null) {
  return render(<GeneralPanel softwareUpdate={softwareUpdate} />);
}

function updateRow(overrides: Partial<SoftwareUpdateRow> = {}): SoftwareUpdateRow {
  return {
    autoCheckEnabled: false,
    busy: false,
    actionLabel: 'Check for updates',
    checkAgain: null,
    act: vi.fn(),
    failure: null,
    setAutoCheck: vi.fn(),
    status: 'StashBase is up to date.',
    version: '2.0.0',
    ...overrides,
  };
}

describe('GeneralPanel', () => {
  it('owns voice download progress and Stop/Resume controls without introducing a setup prompt', async () => {
    let state: VoiceModelState = {
      phase: 'downloading',
      downloadedBytes: 320000000,
      totalBytes: 731357568,
      error: null,
    };
    const port = {
      load: vi.fn(async () => state),
      command: vi.fn(async (action: 'stop' | 'resume' | 'retry') => {
        state = { ...state, phase: action === 'stop' ? 'paused' : 'downloading' };
        return state;
      }),
    };
    const client = createTestQueryClient();
    render(<GeneralPanel softwareUpdate={null} voiceModelApi={port} />, {
      wrapper: queryWrapper(client),
    });
    await screen.findByRole('progressbar', { name: 'Voice model download' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await screen.findByRole('button', { name: 'Resume' });
    expect(screen.queryByRole('progressbar')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeNull());
    expect(port.command.mock.calls.map(([action]) => action)).toEqual(['stop', 'resume']);
    client.clear();
  });
  it('says nothing about updates in a build with no updater', async () => {
    renderPanel();
    expect(screen.queryByText('Software updates')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull();
  });

  it('names the running build, where it stands, and both update controls', async () => {
    const row = updateRow({ autoCheckEnabled: true });
    renderPanel(row);

    expect(screen.getByText('Version 2.0.0')).not.toBeNull();
    expect(screen.getByText('StashBase is up to date.')).not.toBeNull();
    const auto = screen.getByRole('switch', { name: 'Check for updates automatically' });
    expect(auto.getAttribute('aria-checked')).toBe('true');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(row.act).toHaveBeenCalledOnce();
    await user.click(auto);
    expect(row.setAutoCheck).toHaveBeenCalledWith(false);
  });

  it('locks both controls while the updater is already working', async () => {
    const row = updateRow({ busy: true, status: 'Looking for a new version…' });
    renderPanel(row);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    await user.click(screen.getByRole('switch', { name: 'Check for updates automatically' }));
    expect(row.act).not.toHaveBeenCalled();
    expect(row.setAutoCheck).not.toHaveBeenCalled();
  });
});

it('offers the restart in Settings', async () => {
  const row = updateRow({ actionLabel: 'Restart to update', checkAgain: vi.fn() });
  renderPanel(row);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Restart to update' }));
  expect(row.act).toHaveBeenCalledTimes(1);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Check again' }));
  expect(row.checkAgain).toHaveBeenCalledTimes(1);
  expect(row.act).toHaveBeenCalledTimes(1);
});
