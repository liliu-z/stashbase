/** The Settings row: what it reports, and when it refuses to offer a button. */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vite-plus/test';

import type { UpdateRefusal, UpdateResult } from '@/features/updates/application/ports';
import type { UpdateState, UpdateStatus } from '@/features/updates/domain/update-status';

import { useSoftwareUpdate } from './use-software-update';
import { useUpdateNotice } from './use-update-notice';

/** The phases where main is already working, so the row must not offer a
 *  button that would only be refused. */
const WORKING: readonly UpdateStatus[] = [
  { phase: 'checking' },
  { percent: 40, phase: 'downloading', version: '1.5.0' },
  { phase: 'installing', version: '1.5.0' },
];

function stateOf(status: UpdateStatus, autoCheckEnabled = true): UpdateState {
  return { autoCheckEnabled, currentVersion: '1.4.0', status };
}

function accepted(status: UpdateStatus, autoCheckEnabled = true): UpdateResult {
  return { ok: true, state: stateOf(status, autoCheckEnabled) };
}

function refused(kind: UpdateRefusal): UpdateResult {
  return { kind, ok: false };
}

/** `read` is what main already knows when Settings opens; `answer` is what
 *  every command answers with, which is the same state unless a test is about
 *  a refusal. */
function harness(read: UpdateResult, answer: UpdateResult = read) {
  const handlers: ((state: UpdateState) => void)[] = [];
  const port = {
    check: vi.fn(async () => answer),
    openReleasePage: vi.fn(async () => answer),
    read: vi.fn(async () => read),
    runPrimaryAction: vi.fn(async () => answer),
    setAutoCheck: vi.fn(async (_enabled: boolean) => answer),
    subscribe: vi.fn((onState: (state: UpdateState) => void) => {
      handlers.push(onState);
      return () => handlers.splice(handlers.indexOf(onState), 1);
    }),
  };
  return {
    port,
    push: (status: UpdateStatus) => {
      for (const handler of handlers) handler(stateOf(status));
    },
  };
}

describe('useSoftwareUpdate', () => {
  it('opens Store updates without offering the app auto-check preference', async () => {
    const updates = harness(accepted({ phase: 'store' }));
    const { result } = renderHook(() => useSoftwareUpdate(updates.port));
    await waitFor(() => expect(result.current.actionLabel).toBe('Open Microsoft Store'));
    expect(result.current.setAutoCheck).toBeNull();
    await act(async () => result.current.act());
    expect(updates.port.runPrimaryAction).toHaveBeenCalledOnce();
    expect(updates.port.check).not.toHaveBeenCalled();
  });
  it('reports the running build, the auto-check flag, and the phase in one sentence', async () => {
    const updates = harness(accepted({ phase: 'current' }, false));
    const { result } = renderHook(() => useSoftwareUpdate(updates.port));

    await waitFor(() => expect(result.current.status).toBe('StashBase is up to date.'));
    expect(result.current.version).toBe('1.4.0');
    expect(result.current.autoCheckEnabled).toBe(false);
    expect(result.current.busy).toBe(false);
  });

  it('runs one command at a time and stays busy until it answers', async () => {
    const updates = harness(accepted({ phase: 'idle' }));
    let release!: (result: UpdateResult) => void;
    updates.port.check.mockImplementation(
      () =>
        new Promise<UpdateResult>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(() => useSoftwareUpdate(updates.port));
    await waitFor(() => expect(updates.port.read).toHaveBeenCalled());

    act(() => {
      result.current.act();
      result.current.act();
    });
    expect(updates.port.check).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(true);

    await act(async () => {
      release(accepted({ phase: 'current' }));
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.status).toBe('StashBase is up to date.');
  });

  it('is busy in the phases where asking again would be refused', async () => {
    const updates = harness(accepted({ phase: 'idle' }));
    const { result } = renderHook(() => useSoftwareUpdate(updates.port));
    await waitFor(() => expect(updates.port.read).toHaveBeenCalled());
    expect(result.current.busy).toBe(false);

    for (const status of WORKING) {
      act(() => updates.push(status));
      expect(result.current.busy, status.phase).toBe(true);
    }
  });

  it('reaches the port for both of its commands', async () => {
    const updates = harness(accepted({ phase: 'idle' }));
    const { result } = renderHook(() => useSoftwareUpdate(updates.port));
    await waitFor(() => expect(updates.port.read).toHaveBeenCalled());

    await act(async () => result.current.setAutoCheck?.(false));
    expect(updates.port.setAutoCheck).toHaveBeenCalledWith(false);

    await act(async () => result.current.act());
    expect(updates.port.check).toHaveBeenCalledTimes(1);
  });

  it('names a refused command and leaves the row usable', async () => {
    const updates = harness(accepted({ phase: 'idle' }), refused('unavailable'));
    const { result } = renderHook(() => useSoftwareUpdate(updates.port));
    await waitFor(() => expect(updates.port.read).toHaveBeenCalled());

    await act(async () => result.current.act());
    await waitFor(() =>
      expect(result.current.failure).toEqual({
        message: 'StashBase could not reach the updater.',
        tone: 'capability',
      }),
    );
    expect(result.current.busy).toBe(false);
    expect(result.current.status).toBe('No update check yet.');
  });

  it('is an inert row with no port behind it', () => {
    const { result } = renderHook(() => useSoftwareUpdate(null));

    act(() => {
      result.current.act();
      result.current.setAutoCheck?.(true);
    });
    expect(result.current.status).toBe('This build of StashBase does not check for updates.');
    expect(result.current.version).toBe('');
    expect(result.current.autoCheckEnabled).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(result.current.failure).toBeNull();
  });
});

describe('Settings recovery after dismissing the update notice', () => {
  it('keeps the restart reachable', async () => {
    const updates = harness(accepted({ phase: 'ready', version: '1.5.0' }));
    const { result } = renderHook(() => ({
      notice: useUpdateNotice(updates.port),
      settings: useSoftwareUpdate(updates.port),
    }));
    await waitFor(() => expect(result.current.notice.offer).not.toBeNull());
    act(() => result.current.notice.dismiss());
    expect(result.current.notice.offer).toBeNull();
    expect(result.current.settings.actionLabel).toBe('Restart to update');
    await act(async () => result.current.settings.act());
    expect(updates.port.runPrimaryAction).toHaveBeenCalledTimes(1);
    expect(updates.port.check).not.toHaveBeenCalled();
  });
});

it('checks again from a ready download without invoking installation', async () => {
  const updates = harness(accepted({ phase: 'ready', version: '2.1.0', checkFailed: true }));
  const { result } = renderHook(() => useSoftwareUpdate(updates.port));
  await waitFor(() => expect(result.current.checkAgain).not.toBeNull());
  expect(result.current.status).toContain('Could not check for a newer version');
  expect(result.current.actionLabel).toBe('Restart to update');
  await act(async () => result.current.checkAgain?.());
  expect(updates.port.check).toHaveBeenCalledTimes(1);
  expect(updates.port.runPrimaryAction).not.toHaveBeenCalled();
  act(() => updates.push({ phase: 'downloading', version: '2.3.0', percent: 0 }));
  expect(result.current.checkAgain).toBeNull();
  expect(result.current.busy).toBe(true);
});
