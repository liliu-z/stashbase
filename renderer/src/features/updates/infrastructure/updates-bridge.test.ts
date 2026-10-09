/** The updates boundary: what the wire schema lets through, what it drops, and
 *  why every refusal a reader cannot act on arrives as one outcome. */
import { describe, expect, it, vi } from 'vite-plus/test';

import type { UpdateState, UpdateStatus } from '@/features/updates/domain/update-status';
import type { UpdatesBridge } from '@/platform/electron/updates';

import { createUpdatesAdapter } from './updates-bridge';

const BUILD = { autoCheckEnabled: true, currentVersion: '1.4.0' };
const NEXT = '1.5.0';

const CURRENT = { ok: true, snapshot: { ...BUILD, phase: 'current' } };
const UNAVAILABLE = { kind: 'unavailable', ok: false };

const STOP = () => undefined;

const state = (status: UpdateStatus): UpdateState => ({ ...BUILD, status });

function bridge(answer: unknown, overrides: Partial<UpdatesBridge> = {}): UpdatesBridge {
  const reply = vi.fn<UpdatesBridge['read']>(async () => answer);
  return {
    check: reply,
    onSnapshot: vi.fn<UpdatesBridge['onSnapshot']>(() => STOP),
    openReleasePage: reply,
    primaryAction: reply,
    read: reply,
    setAutoCheck: reply,
    ...overrides,
  };
}

function pushed(...snapshots: unknown[]) {
  const onState = vi.fn<(next: UpdateState) => void>();
  const onSnapshot = vi.fn<UpdatesBridge['onSnapshot']>(() => STOP);
  createUpdatesAdapter(bridge(CURRENT, { onSnapshot })).subscribe(onState);
  const push = onSnapshot.mock.calls[0]?.[0];
  for (const snapshot of snapshots) push?.(snapshot);
  return onState;
}

describe('updates adapter', () => {
  it('hands a reader only the version and percentage its phase has', () => {
    const onState = pushed(
      { ...BUILD, availableVersion: NEXT, phase: 'available' },
      { ...BUILD, availableVersion: NEXT, percent: 42, phase: 'downloading' },
      { ...BUILD, availableVersion: NEXT, phase: 'downloading' },
      { ...BUILD, phase: 'current' },
    );
    expect(onState.mock.calls.flat()).toEqual([
      state({ phase: 'available', version: NEXT }),
      state({ percent: 42, phase: 'downloading', version: NEXT }),
      state({ percent: null, phase: 'downloading', version: NEXT }),
      state({ phase: 'current' }),
    ]);
  });

  it('drops a snapshot carrying a field its phase does not have', () => {
    // The wire union is strict precisely so a field that cannot exist for a
    // phase never reaches a reader. A snapshot that disagrees describes an
    // updater this build does not model, so there is nothing safe to trim it
    // down to.
    const onState = pushed(
      { ...BUILD, availableVersion: NEXT, phase: 'current' },
      { ...BUILD, availableVersion: NEXT, percent: 100, phase: 'ready' },
    );
    expect(onState).not.toHaveBeenCalled();
  });

  it('refuses every command when the window may not manage updates', async () => {
    const updates = createUpdatesAdapter(bridge({ failure: { kind: 'unauthorized' }, ok: false }));
    const refusal = { kind: 'unauthorized', ok: false };
    expect(await updates.read()).toEqual(refusal);
    expect(await updates.check()).toEqual(refusal);
    expect(await updates.runPrimaryAction()).toEqual(refusal);
    expect(await updates.openReleasePage()).toEqual(refusal);
    expect(await updates.setAutoCheck(true)).toEqual(refusal);
  });

  it('reads an unreachable updater and an unreadable answer as one outcome', async () => {
    // None of the three is anything a reader could fix, so the surface is never
    // given the chance to tell them apart.
    const rejected = createUpdatesAdapter(
      bridge(CURRENT, {
        primaryAction: vi.fn<UpdatesBridge['primaryAction']>(() =>
          Promise.reject(new Error('no updater')),
        ),
      }),
    );
    expect(await rejected.runPrimaryAction()).toEqual(UNAVAILABLE);

    const malformed = createUpdatesAdapter(
      bridge(CURRENT, {
        read: vi.fn<UpdatesBridge['read']>(async () => ({
          ok: true,
          snapshot: { ...BUILD, phase: 'sideways' },
        })),
      }),
    );
    expect(await malformed.read()).toEqual(UNAVAILABLE);

    const failed = createUpdatesAdapter(bridge({ failure: { kind: 'failed' }, ok: false }));
    expect(await failed.setAutoCheck(false)).toEqual(UNAVAILABLE);
  });

  it('asks each command its own channel and carries the auto-check answer', async () => {
    // Five one-line methods over one helper is exactly the shape a swapped
    // channel hides in, and no other test would notice.
    const channels: UpdatesBridge = {
      check: vi.fn<UpdatesBridge['check']>(async () => CURRENT),
      onSnapshot: vi.fn<UpdatesBridge['onSnapshot']>(() => STOP),
      openReleasePage: vi.fn<UpdatesBridge['openReleasePage']>(async () => CURRENT),
      primaryAction: vi.fn<UpdatesBridge['primaryAction']>(async () => CURRENT),
      read: vi.fn<UpdatesBridge['read']>(async () => CURRENT),
      setAutoCheck: vi.fn<UpdatesBridge['setAutoCheck']>(async () => CURRENT),
    };
    const updates = createUpdatesAdapter(channels);

    await updates.check();
    await updates.openReleasePage();
    await updates.read();
    await updates.runPrimaryAction();
    await updates.setAutoCheck(false);

    expect(channels.check).toHaveBeenCalledOnce();
    expect(channels.openReleasePage).toHaveBeenCalledOnce();
    expect(channels.read).toHaveBeenCalledOnce();
    expect(channels.primaryAction).toHaveBeenCalledOnce();
    expect(channels.setAutoCheck).toHaveBeenCalledWith(false);
  });

  it('hands back the bridge unsubscribe so a window can stop listening', () => {
    const stop = vi.fn();
    const onSnapshot = vi.fn<UpdatesBridge['onSnapshot']>(() => stop);
    expect(createUpdatesAdapter(bridge(CURRENT, { onSnapshot })).subscribe(() => undefined)).toBe(
      stop,
    );
  });
});

it('reports caught update failures and pushed errors without changing recovery state', async () => {
  const report = vi.fn();
  const onSnapshot = vi.fn<UpdatesBridge['onSnapshot']>(() => STOP);
  const updates = createUpdatesAdapter(
    bridge({ failure: { kind: 'failed' }, ok: false }, { onSnapshot }),
    report,
  );
  expect(await updates.check()).toEqual(UNAVAILABLE);
  expect(report).toHaveBeenCalledTimes(1);
  const onState = vi.fn();
  updates.subscribe(onState);
  onSnapshot.mock.calls[0]?.[0]({ ...BUILD, phase: 'error' });
  expect(onState).toHaveBeenCalledWith(state({ phase: 'error' }));
  expect(report).toHaveBeenCalledTimes(2);
});
