import { describe, expect, it, vi } from 'vite-plus/test';

import { createWorkspaceRuntime } from './runtime';

describe('Workspace runtime', () => {
  it('rejects an invalid runtime generation at construction', () => {
    expect(() =>
      createWorkspaceRuntime({
        folder: { name: 'Notes', path: '/project/notes' },
        generation: 0,
        queries: { cancel: vi.fn(async () => undefined), remove: vi.fn() },
      }),
    ).toThrow('Workspace runtime generation must be a positive safe integer.');
  });

  it('owns one folder generation and accepts only its current completions', () => {
    const queries = { cancel: vi.fn(async () => undefined), remove: vi.fn() };
    const runtime = createWorkspaceRuntime({
      folder: { name: 'Notes', path: '/project/notes' },
      generation: 7,
      queries,
    });
    const completion = vi.fn();

    expect(runtime.store.getState()).toEqual({
      expanded: {},
      lifecycle: 'active',
      pendingCreate: null,
      pendingReveal: null,
      selectedPath: null,
      scope: {
        folder: { name: 'Notes', path: '/project/notes' },
        generation: 7,
      },
    });
    expect(runtime.accept(runtime.capture(), completion)).toBe(true);
    expect(completion).toHaveBeenCalledOnce();
    expect(runtime.capture().scope).toBe(runtime.scope);

    const captured = runtime.capture();
    expect(
      runtime.accept(
        {
          ...captured,
          scope: { folder: runtime.scope.folder, generation: runtime.scope.generation - 1 },
        },
        completion,
      ),
    ).toBe(false);
    expect(
      runtime.accept(
        {
          ...captured,
          scope: {
            folder: { name: 'Writing', path: '/project/writing' },
            generation: runtime.scope.generation,
          },
        },
        completion,
      ),
    ).toBe(false);
    expect(completion).toHaveBeenCalledOnce();
  });

  it('refuses a completion for work retired while it was in flight', () => {
    const runtime = createWorkspaceRuntime({
      folder: { name: 'Notes', path: '/project/notes' },
      generation: 1,
      queries: { cancel: vi.fn(async () => undefined), remove: vi.fn() },
    });
    // Captured while the folder was open, the way an async operation takes it
    // before its first await.
    const captured = runtime.capture();
    const completion = vi.fn();

    runtime.retireOperations();

    expect(runtime.accept(captured, completion)).toBe(false);
    expect(completion).not.toHaveBeenCalled();
    // The folder itself is still open, so work started after the retirement
    // still lands.
    expect(runtime.accept(runtime.capture(), completion)).toBe(true);
    expect(completion).toHaveBeenCalledOnce();
  });

  it('aborts work, retires state, and cancels queries exactly once on disposal', () => {
    const queries = { cancel: vi.fn(async () => undefined), remove: vi.fn() };
    const runtime = createWorkspaceRuntime({
      folder: { name: 'Notes', path: '/project/notes' },
      generation: 1,
      queries,
    });
    // Captured while the folder was open, the way an async operation takes it
    // before its first await.
    const capturedScope = runtime.capture();
    const lateCompletion = vi.fn();

    runtime.dispose();
    runtime.dispose();

    expect(runtime.signal.aborted).toBe(true);
    expect(runtime.store.getState().lifecycle).toBe('disposed');
    expect(queries.cancel).toHaveBeenCalledOnce();
    expect(queries.remove).not.toHaveBeenCalled();
    expect(runtime.accept(capturedScope, lateCompletion)).toBe(false);
    expect(lateCompletion).not.toHaveBeenCalled();
  });

  it('evicts scoped queries when authorization retires the runtime', () => {
    const queries = { cancel: vi.fn(async () => undefined), remove: vi.fn() };
    const runtime = createWorkspaceRuntime({
      folder: { name: 'Notes', path: '/project/notes' },
      generation: 1,
      queries,
    });

    runtime.retire();
    runtime.dispose();

    expect(queries.cancel).toHaveBeenCalledOnce();
    expect(queries.remove).toHaveBeenCalledOnce();
  });

  it('upgrades ordinary disposal to query eviction when authorization is later lost', () => {
    const queries = { cancel: vi.fn(async () => undefined), remove: vi.fn() };
    const runtime = createWorkspaceRuntime({
      folder: { name: 'Notes', path: '/project/notes' },
      generation: 1,
      queries,
    });

    runtime.dispose();
    runtime.retire();
    runtime.retire();

    expect(queries.cancel).toHaveBeenCalledOnce();
    expect(queries.remove).toHaveBeenCalledOnce();
  });
});
