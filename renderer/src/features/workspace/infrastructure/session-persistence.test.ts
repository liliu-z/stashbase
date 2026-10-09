import { describe, expect, it, vi } from 'vite-plus/test';

import { SESSION_MESSAGES } from '@/features/workspace/application/failure-messages';
import { createWorkspaceSessionSnapshot } from '@/features/workspace/domain/session';

import { createWorkspaceSessionAdapter } from './session-persistence';

describe('workspace session persistence adapter', () => {
  it('maps the strict preload response into an independent domain snapshot', async () => {
    const wire = {
      ...createWorkspaceSessionSnapshot(),
      folders: [
        {
          activeTabId: null,
          expandedPaths: ['drafts'],
          folderPath: '/project/notes',
          selectedPath: null,
          tabs: [],
        },
      ],
    };
    const adapter = createWorkspaceSessionAdapter({
      read: vi.fn(async () => ({ ok: true, session: wire })),
      write: vi.fn(),
    });

    const loaded = await adapter.load();
    expect(loaded).toEqual(wire);
    expect(loaded).not.toBe(wire);
    expect(loaded?.folders).not.toBe(wire.folders);
  });

  it('persists only protocol-approved state and classifies bridge failures locally', async () => {
    const report = vi.fn();
    const write = vi.fn(async () => ({ ok: true }));
    const adapter = createWorkspaceSessionAdapter(
      {
        read: vi.fn(async () => ({
          ok: false,
          failure: { kind: 'unavailable', message: 'Not available.' },
        })),
        write,
      },
      report,
    );

    // The bridge's own sentence names a path, so it travels as the cause
    // while the reader-facing line comes off the workspace ladder.
    await expect(adapter.load()).rejects.toMatchObject({
      cause: { message: 'Not available.' },
      kind: 'unavailable',
      message: SESSION_MESSAGES.load,
      name: 'WorkspaceSessionError',
    });
    const snapshot = createWorkspaceSessionSnapshot();
    await adapter.save(snapshot);
    expect(write).toHaveBeenCalledWith(snapshot);
    await expect(
      adapter.save({ ...snapshot, shell: { ...snapshot.shell, sidebarWidth: 500 } }),
    ).rejects.toThrow(/Number must be less than or equal to 360/u);
    expect(write).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[0]?.[1]).toBe('workspace-session');
  });
});
