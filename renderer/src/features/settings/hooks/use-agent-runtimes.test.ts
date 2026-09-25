import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { failureMessage } from '@/features/settings/application/failure-messages';
import { AgentRuntimeError, type AgentRuntimePort } from '@/features/settings/application/ports';
import { settingsQueryKeys } from '@/features/settings/application/queries';
import type { AgentCatalog, AgentRuntime } from '@/features/settings/domain/agent-catalog';
import type { AgentId } from '@/shared/domain/agent-id';
import { agentRuntime, agentRuntimePort, IDLE_ALLOWANCE } from '@/test/fakes/settings';
import { createTestQueryClient, queryWrapper } from '@/test/query';

import { useAgentRuntimes } from './use-agent-runtimes';

function codex(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return agentRuntime({
    id: 'codex',
    label: 'Codex',
    ownership: null,
    preparation: { kind: 'idle' },
    ...overrides,
  });
}

function catalog(runtimes: AgentRuntime[]): AgentCatalog {
  return { debug: null, runtimes };
}

/** Every mutation below asserts the exact response it wrote into the shared
 *  catalog cache, so the ambient catalog stays empty and cannot race the
 *  mutation for the same cache entry. */
function emptyCatalog() {
  return vi.fn(async () => catalog([]));
}

/**
 * A hook bound to one port and one client, with the client the test inspects.
 *
 * The first catalog fetch is awaited here: a command's response is written
 * straight into the shared cache, so a test that dispatched before the ambient
 * fetch landed would be asserting against whichever of the two happened to
 * resolve last.
 */
async function mount(port: AgentRuntimePort) {
  const queryClient = createTestQueryClient();
  const view = renderHook(() => useAgentRuntimes(port), { wrapper: queryWrapper(queryClient) });
  await waitFor(() => expect(view.result.current.catalog.loading).toBe(false));
  return { queryClient, view };
}

afterEach(cleanup);

describe('useAgentRuntimes', () => {
  it('refreshes credits when returning from billing and stops after leaving Settings', async () => {
    let current = IDLE_ALLOWANCE;
    const getAllowance = vi.fn(async () => current);
    const { view } = await mount(
      agentRuntimePort({
        listAgents: async () => catalog([agentRuntime({ preparation: { kind: 'ready' } })]),
        getAllowance,
      }),
    );
    await waitFor(() => expect(view.result.current.allowance.allowance).toEqual(IDLE_ALLOWANCE));
    current = { ...IDLE_ALLOWANCE, remainingPercent: 90 };
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(view.result.current.allowance.allowance).toEqual(current));
    view.unmount();
    const calls = getAllowance.mock.calls.length;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(getAllowance).toHaveBeenCalledTimes(calls);
  });

  it('polls every 500ms while a runtime is actively preparing, and stops once none are', async () => {
    const installing = catalog([
      codex({ preparation: { kind: 'running', note: null, stage: 'install' } }),
    ]);
    const settled = catalog([codex({ preparation: { kind: 'ready' } })]);
    let calls = 0;
    const listAgents = vi.fn(async () => (calls++ === 0 ? installing : settled));
    const { view } = await mount(agentRuntimePort({ listAgents }));

    await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(2), { timeout: 2000 });
    // The settled catalog reaching the hook is what turns the interval off,
    // so wait for that rather than for a wall-clock guess.
    await waitFor(() =>
      expect(view.result.current.catalog.runtimes[0]?.preparation.kind).toBe('ready'),
    );
    expect(listAgents).toHaveBeenCalledTimes(2);
  });

  it('leaves the allowance query disabled until a stashbase agent reports ready, then fires it', async () => {
    const notReady = catalog([
      agentRuntime({ preparation: { kind: 'running', note: null, stage: 'install' } }),
    ]);
    const ready = catalog([agentRuntime({ preparation: { kind: 'ready' } })]);
    let calls = 0;
    const listAgents = vi.fn(async () => (calls++ === 0 ? notReady : ready));
    const getAllowance = vi.fn(async () => IDLE_ALLOWANCE);
    const { view } = await mount(agentRuntimePort({ listAgents, getAllowance }));

    await waitFor(() => expect(view.result.current.catalog.runtimes).toHaveLength(1));
    expect(getAllowance).not.toHaveBeenCalled();

    await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await waitFor(() => expect(getAllowance).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.result.current.allowance.allowance).toEqual(IDLE_ALLOWANCE));
  });

  it('installs an agent and writes the response into the shared catalog cache', async () => {
    const installed = catalog([codex({ preparation: { kind: 'ready' } })]);
    const prepareAgent = vi.fn(async () => installed);
    const { queryClient, view } = await mount(
      agentRuntimePort({ listAgents: emptyCatalog(), prepareAgent }),
    );

    act(() => view.result.current.install('codex'));

    await waitFor(() =>
      expect(prepareAgent).toHaveBeenCalledWith('codex', 'bootstrap', expect.anything()),
    );
    await waitFor(() =>
      expect(queryClient.getQueryData(settingsQueryKeys.agentCatalog)).toEqual(installed),
    );
  });

  it('updates an agent through its own updater and writes the response into the shared catalog cache', async () => {
    const updated = catalog([
      codex({ id: 'claude', label: 'Claude', preparation: { kind: 'ready' }, version: '2.1.276' }),
    ]);
    const prepareAgent = vi.fn(async () => updated);
    const { queryClient, view } = await mount(
      agentRuntimePort({ listAgents: emptyCatalog(), prepareAgent }),
    );

    act(() => view.result.current.update('claude'));

    await waitFor(() =>
      expect(prepareAgent).toHaveBeenCalledWith('claude', 'update', expect.anything()),
    );
    await waitFor(() =>
      expect(queryClient.getQueryData(settingsQueryKeys.agentCatalog)).toEqual(updated),
    );
  });

  it('logs in an agent and writes the response into the shared catalog cache', async () => {
    const signedIn = catalog([codex({ preparation: { kind: 'ready' } })]);
    const prepareAgent = vi.fn(async () => signedIn);
    const { queryClient, view } = await mount(
      agentRuntimePort({ listAgents: emptyCatalog(), prepareAgent }),
    );

    act(() => view.result.current.login('claude'));

    await waitFor(() =>
      expect(prepareAgent).toHaveBeenCalledWith('claude', 'login', expect.anything()),
    );
    await waitFor(() =>
      expect(queryClient.getQueryData(settingsQueryKeys.agentCatalog)).toEqual(signedIn),
    );
  });

  it('reports a failed install against the agent it was asked for, and no other', async () => {
    const { view } = await mount(
      agentRuntimePort({
        listAgents: emptyCatalog(),
        prepareAgent: vi.fn(async () => {
          throw new Error('Installer exited with status 1.');
        }),
      }),
    );

    act(() => view.result.current.install('codex'));

    await waitFor(() =>
      expect(view.result.current.failure('codex')?.message).toBe(failureMessage('unavailable')),
    );
    expect(view.result.current.failure('claude')).toBeNull();
    expect(view.result.current.busy('codex')).toBe(false);
  });

  it('updates debug settings and writes the response into the shared catalog cache', async () => {
    const patched = catalog([]);
    const updateDebug = vi.fn(async () => patched);
    const { queryClient, view } = await mount(
      agentRuntimePort({ listAgents: emptyCatalog(), updateDebug }),
    );

    act(() => view.result.current.updateDebug({ nextSetupResult: 'mcp' }));

    await waitFor(() =>
      expect(updateDebug).toHaveBeenCalledWith({ nextSetupResult: 'mcp' }, expect.anything()),
    );
    await waitFor(() =>
      expect(queryClient.getQueryData(settingsQueryKeys.agentCatalog)).toEqual(patched),
    );
  });

  it('installs one runtime without aborting an install already open on another', async () => {
    const signals = new Map<AgentId, AbortSignal>();
    const settle = new Map<AgentId, () => void>();
    const installed = catalog([codex({ preparation: { kind: 'ready' } })]);
    const prepareAgent = vi.fn<AgentRuntimePort['prepareAgent']>(async (id, _action, signal) => {
      signals.set(id, signal);
      await new Promise<void>((resolve) => settle.set(id, resolve));
      return installed;
    });
    const { queryClient, view } = await mount(
      agentRuntimePort({ listAgents: emptyCatalog(), prepareAgent }),
    );

    act(() => view.result.current.install('codex'));
    await waitFor(() => expect(signals.get('codex')).toBeDefined());

    act(() => view.result.current.install('claude'));
    await waitFor(() => expect(signals.get('claude')).toBeDefined());

    // Codex owns its own lane: Claude opening one of its own leaves it alone.
    expect(signals.get('codex')?.aborted).toBe(false);
    expect(view.result.current.busy('codex')).toBe(true);

    act(() => settle.get('codex')?.());

    await waitFor(() => expect(view.result.current.busy('codex')).toBe(false));
    expect(view.result.current.failure('codex')).toBeNull();
    expect(queryClient.getQueryData(settingsQueryKeys.agentCatalog)).toEqual(installed);
  });

  it('carries a separate failure on each row that refused, at the same time', async () => {
    const { view } = await mount(
      agentRuntimePort({
        listAgents: emptyCatalog(),
        prepareAgent: vi.fn(async (id) => {
          throw id === 'codex'
            ? new AgentRuntimeError('unavailable', 'codex install refused')
            : new AgentRuntimeError('scope-lost', 'claude sign-in refused');
        }),
      }),
    );

    act(() => view.result.current.install('codex'));
    await waitFor(() =>
      expect(view.result.current.failure('codex')?.message).toBe(failureMessage('unavailable')),
    );

    act(() => view.result.current.login('claude'));
    await waitFor(() =>
      expect(view.result.current.failure('claude')?.message).toBe(failureMessage('scope-lost')),
    );

    // Each row still reads the refusal its own command produced.
    expect(view.result.current.failure('codex')?.message).toBe(failureMessage('unavailable'));
    expect(view.result.current.failure('claude')?.message).toBe(failureMessage('scope-lost'));
  });

  it('leaves one row a failure while a command runs on another', async () => {
    const settle = new Map<AgentId, () => void>();
    const prepareAgent = vi.fn<AgentRuntimePort['prepareAgent']>(async (id) => {
      if (id === 'codex') throw new AgentRuntimeError('unavailable', 'codex install refused');
      await new Promise<void>((resolve) => settle.set(id, resolve));
      return catalog([]);
    });
    const { view } = await mount(agentRuntimePort({ listAgents: emptyCatalog(), prepareAgent }));

    act(() => view.result.current.install('codex'));
    await waitFor(() =>
      expect(view.result.current.failure('codex')?.message).toBe(failureMessage('unavailable')),
    );

    act(() => view.result.current.install('claude'));
    await waitFor(() => expect(view.result.current.busy('claude')).toBe(true));

    expect(view.result.current.failure('codex')?.message).toBe(failureMessage('unavailable'));

    act(() => settle.get('claude')?.());
    await waitFor(() => expect(view.result.current.busy('claude')).toBe(false));
    expect(view.result.current.failure('codex')?.message).toBe(failureMessage('unavailable'));
  });
});
