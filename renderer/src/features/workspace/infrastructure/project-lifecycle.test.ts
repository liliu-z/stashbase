import { describe, expect, it, vi } from 'vite-plus/test';

import { ProjectError } from '@/features/workspace/application/ports';
import type { ProjectLifecycleBridge } from '@/platform/electron/project-lifecycle';

import { createProjectLifecycleAdapter } from './project-lifecycle';

function bridge(overrides: Partial<ProjectLifecycleBridge> = {}): ProjectLifecycleBridge {
  return {
    cancelEntry: async () => ({ ok: true as const }),
    onEntryCancelled: () => () => {},
    onEnterFolder: () => () => {},
    notifyFolderRemoved: vi.fn(async () => ({ ok: true as const })),
    onFolderRemoved: vi.fn(() => () => undefined),
    onPrepareFolderRemoval: vi.fn(() => () => undefined),
    openFolderWindow: vi.fn(async () => ({ action: 'opened' as const, ok: true as const })),
    prepareFolderRemoval: vi.fn(async () => ({ ok: true as const, ready: true })),
    setActiveFolder: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
}

describe('project lifecycle adapter', () => {
  it('maps the typed bridge without exposing Electron to the feature', async () => {
    const native = bridge();
    const lifecycle = createProjectLifecycleAdapter(native);
    const prepare = vi.fn(async () => true);
    const removed = vi.fn();

    lifecycle.onPrepareFolderRemoval(prepare);
    lifecycle.onFolderRemoved(removed);
    await expect(lifecycle.prepareFolderRemoval('/project/notes')).resolves.toBe(true);
    await expect(lifecycle.setActiveFolder('/project/notes')).resolves.toBeUndefined();
    await expect(lifecycle.notifyFolderRemoved('/project/notes')).resolves.toBeUndefined();

    expect(native.onPrepareFolderRemoval).toHaveBeenCalledWith(prepare);
    expect(native.onFolderRemoved).toHaveBeenCalledWith(removed);
  });

  it('retains and reports classified lifecycle failure', async () => {
    const report = vi.fn();
    const lifecycle = createProjectLifecycleAdapter(
      bridge({
        prepareFolderRemoval: vi.fn(async () => ({
          failure: { kind: 'unauthorized' as const, message: 'Window retired.' },
          ok: false as const,
        })),
      }),
      report,
    );

    await expect(lifecycle.prepareFolderRemoval('/project/notes')).rejects.toEqual(
      new ProjectError('unauthorized', 'Window retired.'),
    );
    expect(report).toHaveBeenCalledWith(expect.any(ProjectError), 'project-lifecycle');
  });
});
