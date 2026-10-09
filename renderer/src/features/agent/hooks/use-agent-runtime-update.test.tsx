import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vite-plus/test';

import { createAgentSessionRuntime } from '@/features/agent/application/session-runtime';
import { agentCatalogPort, agentSessionPort, CLAUDE_AGENT } from '@/test/fakes/agent';

import { useAgentRuntimeUpdate } from './use-agent-runtime-update';

afterEach(cleanup);

/** A live Claude conversation whose last turn the runtime was too old for. */
async function refusedTurn() {
  const transport = agentSessionPort();
  const session = createAgentSessionRuntime({
    agent: 'claude',
    id: 'chat-1',
    port: transport.port,
    scheduler: { jitter: (value) => value, wait: () => new Promise<void>(() => undefined) },
    scope: { kind: 'folder', path: '/project/Research' },
  });
  transport.listeners[0]?.onEvent({ kind: 'ready' });
  session.setDraft('Map the repo');
  await expect(session.sendPrompt()).resolves.toEqual({ ok: true });
  transport.listeners[0]?.onEvent({
    failure: 'runtime-outdated',
    kind: 'failed',
    message: 'API Error: 400 Claude Code 2.1.220 does not support this model',
  });
  const failure = session.store.getState().transcript.find((block) => block.kind === 'error');
  if (!failure) throw new Error('the refused turn should have failed');
  return { failure, session, transport };
}

it('updates the runtime, reconnects the conversation on it, and resends the refused request', async () => {
  const { failure, session, transport } = await refusedTurn();
  const catalog = agentCatalogPort([{ ...CLAUDE_AGENT, ready: true }]);
  const onRefresh = vi.fn();
  const hook = renderHook(() => useAgentRuntimeUpdate(session, catalog, onRefresh));
  expect(hook.result.current.label).toBe('Claude');

  act(() => hook.result.current.update(failure.id));

  await waitFor(() =>
    expect(catalog.prepareAgent).toHaveBeenCalledWith('claude', 'update', expect.anything()),
  );
  // The runtime is ready again: the conversation reopens its socket so the
  // service spawns the updated executable...
  await waitFor(() => expect(transport.listeners).toHaveLength(2));
  expect(onRefresh).toHaveBeenCalledOnce();
  act(() => transport.listeners[1]?.onEvent({ kind: 'ready' }));
  // ...and the request the old one refused goes out again on it.
  await waitFor(() =>
    expect(transport.sent.filter((command) => command.kind === 'prompt')).toHaveLength(2),
  );
  expect(hook.result.current.completedBlockId).toBe(failure.id);
  expect(hook.result.current.busy).toBe(false);
  expect(hook.result.current.failure).toBeNull();
  session.dispose();
});

it('keeps a refused update on the turn and leaves the conversation where it was', async () => {
  const { failure, session, transport } = await refusedTurn();
  const stuck = {
    ...CLAUDE_AGENT,
    ready: false,
    setupFailure: { stage: 'installation' as const, message: 'npm global folder is not writable' },
  };
  const catalog = agentCatalogPort([stuck], {
    prepareAgent: vi.fn(async () => ({ agents: [stuck] })),
  });
  const hook = renderHook(() => useAgentRuntimeUpdate(session, catalog, vi.fn()));

  act(() => hook.result.current.update(failure.id));

  await waitFor(() =>
    expect(hook.result.current.failure).toBe('npm global folder is not writable'),
  );
  expect(hook.result.current.busy).toBe(false);
  expect(hook.result.current.completedBlockId).toBeNull();
  expect(transport.listeners).toHaveLength(1);
  expect(transport.sent.filter((command) => command.kind === 'prompt')).toHaveLength(1);
  session.dispose();
});
