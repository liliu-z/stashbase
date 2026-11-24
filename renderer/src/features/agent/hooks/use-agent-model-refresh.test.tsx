import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vite-plus/test';

import { createAgentSessionRuntime } from '@/features/agent/application/session-runtime';
import { agentSessionPort } from '@/test/fakes/agent';

import { useAgentModelRefresh } from './use-agent-model-refresh';

afterEach(cleanup);

/** A live Default conversation whose last turn the service refused because
 *  the chosen model's configuration changed. */
async function refusedTurn() {
  const transport = agentSessionPort();
  const session = createAgentSessionRuntime({
    agent: 'stashbase',
    id: 'chat-1',
    port: transport.port,
    scheduler: { jitter: (value) => value, wait: () => new Promise<void>(() => undefined) },
    scope: { kind: 'folder', path: '/project/Research' },
  });
  transport.listeners[0]?.onEvent({ kind: 'ready' });
  session.setDraft('Draft the intro');
  await expect(session.sendPrompt()).resolves.toEqual({ ok: true });
  transport.listeners[0]?.onEvent({
    failure: 'model-changed',
    kind: 'failed',
    message:
      'The selected model configuration has changed. Refresh the models, then review and send again.',
  });
  const failure = session.store.getState().transcript.find((block) => block.kind === 'error');
  if (!failure) throw new Error('the refused turn should have failed');
  return { failure, session, transport };
}

it('reconnects to read the models again and sends nothing until the reader retries', async () => {
  const { failure, session, transport } = await refusedTurn();
  session.setDraft('A note I was still writing');
  const onRefresh = vi.fn();
  const hook = renderHook(() => useAgentModelRefresh(session, onRefresh));

  act(() => hook.result.current.refresh(failure.id));

  await waitFor(() => expect(transport.listeners).toHaveLength(2));
  expect(hook.result.current.busy).toBe(true);
  act(() => transport.listeners[1]?.onEvent({ kind: 'ready' }));
  await waitFor(() => expect(hook.result.current.refreshedBlockId).toBe(failure.id));
  expect(onRefresh).toHaveBeenCalledOnce();
  expect(hook.result.current.busy).toBe(false);
  expect(hook.result.current.failure).toBeNull();
  expect(transport.sent.filter((command) => command.kind === 'prompt')).toHaveLength(1);
  const state = session.store.getState();
  expect(state.draft).toBe('A note I was still writing');
  expect(state.transcript.some((block) => block.id === failure.id)).toBe(true);

  expect(session.retry(failure.id)).toBe(true);
  expect(transport.sent.filter((command) => command.kind === 'prompt')).toHaveLength(2);
  session.dispose();
});

it('reports a reconnect that does not come back and leaves the turn as it was', async () => {
  const { failure, session, transport } = await refusedTurn();
  const hook = renderHook(() => useAgentModelRefresh(session, vi.fn()));

  act(() => hook.result.current.refresh(failure.id));
  await waitFor(() => expect(transport.listeners).toHaveLength(2));
  act(() =>
    transport.listeners[1]?.onEvent({
      kind: 'exited',
      message: 'Sign in to StashBase to use the StashBase Agent.',
    }),
  );

  await waitFor(() => expect(hook.result.current.failure).toMatch(/could not reconnect/));
  expect(hook.result.current.refreshedBlockId).toBeNull();
  expect(transport.sent.filter((command) => command.kind === 'prompt')).toHaveLength(1);
  session.dispose();
});
