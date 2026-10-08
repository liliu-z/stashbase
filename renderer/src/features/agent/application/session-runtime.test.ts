/** The session runtime's transport: when a draft first opens one, what the
 *  normalized lifecycle events move, how a lost connection is retried and
 *  resumed, and what restoring or retiring a conversation settles. */
import { describe, expect, it, vi } from 'vite-plus/test';

import { agentSessionPort } from '@/test/fakes/agent';

import { type AgentReconnectScheduler, type AgentSessionPort } from './ports';
import { createAgentSessionRuntime } from './session-runtime';

type AgentConnectRequest = Parameters<AgentSessionPort['connect']>[0];

/** A promise the test opens by hand, so the first replay is still in flight
 *  when the second one starts. */
function openGate(): { open: () => void; opened: Promise<void> } {
  const gate: { open: () => void; opened: Promise<void> } = {
    open: () => undefined,
    opened: Promise.resolve(),
  };
  gate.opened = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  return gate;
}

/** One saved conversation, as the history list reports it. */
const historyEntry = (id: string, title: string) => ({
  agent: 'claude' as const,
  hasContent: true,
  id,
  lastModified: 1,
  scope: { kind: 'folder' as const, path: '/project/Research' },
  title,
});

function harness() {
  const waits: Array<() => void> = [];
  const { listeners, port, sent } = agentSessionPort({
    replay: vi.fn(async () => ({
      effort: 'high',
      transcript: [
        { kind: 'user' as const, id: 'user-1', text: 'Keep this question.' },
        { kind: 'assistant' as const, id: 'assistant-1', text: 'Keep this answer.' },
      ],
    })),
  });
  const scheduler: AgentReconnectScheduler = {
    jitter: (value) => value,
    wait: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          waits.push(resolve);
        }),
    ),
  };
  /** Every connect request in order, read back off the port's own spy. */
  const requests = (): AgentConnectRequest[] =>
    vi.mocked(port.connect).mock.calls.map(([request]) => request);
  return { listeners, port, requests, scheduler, sent, waits };
}

describe('AgentSessionRuntime', () => {
  it('keeps an explicit draft local until its first-use boundary starts transport', () => {
    const test = harness();
    const runtime = createAgentSessionRuntime({
      agent: 'codex',
      autostart: false,
      id: 'chat-1',
      port: test.port,
      scheduler: test.scheduler,
      scope: { kind: 'folder', path: '/project/Research' },
    });

    expect(runtime.store.getState().connection).toEqual({ kind: 'draft' });
    expect(test.requests()).toHaveLength(0);

    runtime.start();

    expect(runtime.store.getState().connection).toEqual({ attempt: 0, kind: 'connecting' });
    expect(test.requests()).toHaveLength(1);
  });

  it('connects a scoped session and handles normalized lifecycle events', () => {
    const test = harness();
    const runtime = createAgentSessionRuntime({
      agent: 'codex',
      id: 'chat-1',
      port: test.port,
      scheduler: test.scheduler,
      scope: { kind: 'folder', path: '/project/Research' },
    });

    expect(test.requests()[0]).toEqual({
      access: 'auto',
      agent: 'codex',
      effort: undefined,
      model: undefined,
      resume: undefined,
      scope: { kind: 'folder', path: '/project/Research' },
    });
    test.listeners[0]?.onEvent({ kind: 'ready' });
    test.listeners[0]?.onEvent({ id: 'native-1', kind: 'identified' });
    expect(runtime.store.getState()).toMatchObject({
      connection: { kind: 'live', turn: null },
      nativeSessionId: 'native-1',
    });

    runtime.dispose();
    test.listeners[0]?.onEvent({ kind: 'titled', title: 'Too late' });
    expect(runtime.store.getState().title).toBe('Untitled');
    expect(runtime.store.getState().connection).toEqual({ kind: 'disposed' });
  });

  it('retains runtime model catalogs and reconnects idle thinking changes', () => {
    const test = harness();
    const runtime = createAgentSessionRuntime({
      agent: 'codex',
      id: 'chat-1',
      port: test.port,
      scheduler: test.scheduler,
      scope: { kind: 'folder', path: '/project/Research' },
    });
    test.listeners[0]?.onEvent({
      activeModel: null,
      fallback: null,
      kind: 'models',
      models: [{ id: 'gpt-codex', label: 'GPT Codex', supportedEfforts: ['low', 'high'] }],
    });
    test.listeners[0]?.onEvent({ kind: 'ready' });

    runtime.setModel('gpt-codex');
    expect(test.sent.at(-1)).toEqual({ kind: 'select-model', model: 'gpt-codex' });
    expect(runtime.store.getState().model).toBe('gpt-codex');

    runtime.setEffort('high');
    expect(test.requests()).toHaveLength(2);
    expect(test.requests().at(-1)).toMatchObject({ effort: 'high', model: 'gpt-codex' });
    expect(runtime.store.getState().effort).toBe('high');
  });

  it('runs a chosen persona by resuming its own conversation, and a draft starts with it', () => {
    const test = harness();
    const runtime = createAgentSessionRuntime({
      agent: 'claude',
      id: 'chat-1',
      port: test.port,
      scheduler: test.scheduler,
      scope: { kind: 'folder', path: '/project/Research' },
    });
    test.listeners[0]?.onEvent({ kind: 'ready' });
    test.listeners[0]?.onEvent({ id: 'native-1', kind: 'identified' });

    expect(runtime.setPersona('journalist')).toBe(true);
    expect(test.requests()).toHaveLength(2);
    expect(test.requests().at(-1)).toMatchObject({ persona: 'journalist', resume: 'native-1' });

    // Choosing what already runs restarts nothing.
    expect(runtime.setPersona('journalist')).toBe(true);
    expect(test.requests()).toHaveLength(2);

    // Editing the running persona restarts on the same conversation.
    runtime.applyPersona();
    expect(test.requests()).toHaveLength(3);
    expect(test.requests().at(-1)).toMatchObject({ persona: 'journalist', resume: 'native-1' });

    const draft = createAgentSessionRuntime({
      agent: 'claude',
      autostart: false,
      id: 'chat-2',
      port: test.port,
      scheduler: test.scheduler,
      scope: { kind: 'folder', path: '/project/Research' },
    });
    draft.setPersona('builder');
    expect(test.requests()).toHaveLength(3);
    draft.start();
    expect(test.requests().at(-1)).toMatchObject({ persona: 'builder' });
  });

  it('loads replay before reconnecting exactly that native session', async () => {
    const test = harness();
    const runtime = createAgentSessionRuntime({
      agent: 'claude',
      id: 'chat-1',
      port: test.port,
      scheduler: test.scheduler,
      scope: { kind: 'folder', path: '/project/Research' },
    });

    const entry = {
      agent: 'claude' as const,
      hasContent: true,
      id: 'native-2',
      lastModified: 42,
      scope: { kind: 'folder' as const, path: '/project/Research' },
      title: 'Saved conversation',
    };
    await expect(runtime.restore(entry)).resolves.toBe(true);
    expect(test.port.replay).toHaveBeenCalledWith(entry, runtime.signal);
    expect(test.requests().at(-1)).toMatchObject({ effort: 'high', resume: 'native-2' });
    expect(runtime.store.getState()).toMatchObject({
      nativeSessionId: 'native-2',
      title: 'Saved conversation',
      transcript: [
        { kind: 'user', id: 'user-1', text: 'Keep this question.' },
        { kind: 'assistant', id: 'assistant-1', text: 'Keep this answer.' },
      ],
    });

    runtime.start();
    expect(test.requests()).toHaveLength(2);
  });

  it('reconnects raw transport loss with a bounded schedule and retained identity', async () => {
    const test = harness();
    const runtime = createAgentSessionRuntime({
      agent: 'stashbase',
      id: 'chat-1',
      port: test.port,
      scheduler: test.scheduler,
      scope: { kind: 'folder', path: '/project/Research' },
    });
    test.listeners[0]?.onEvent({ id: 'native-3', kind: 'identified' });
    test.listeners[0]?.onEvent({ kind: 'ready' });

    for (let index = 0; index < 3; index += 1) {
      test.listeners[index]?.onClose();
      test.waits[index]?.();
      await Promise.resolve();
      expect(test.requests()[index + 1]?.resume).toBe('native-3');
    }
    test.listeners[3]?.onClose();

    const { connection } = runtime.store.getState();
    expect(connection.kind).toBe('failed');
    expect(connection.kind === 'failed' && connection.message).toContain('Reconnect to continue');
  });

  it('refuses a completion captured before the folder was retired', async () => {
    const test = harness();
    const runtime = createAgentSessionRuntime({
      agent: 'codex',
      id: 'chat-1',
      port: test.port,
      scheduler: test.scheduler,
      scope: { kind: 'folder', path: '/project/Research' },
    });

    const capturedScope = runtime.capture();
    const applied = vi.fn();
    expect(runtime.accept(capturedScope, applied)).toBe(true);

    runtime.retire('/project/Research');
    expect(runtime.accept(capturedScope, applied)).toBe(false);
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it('drops a replay that lands after a newer restore started', async () => {
    const test = harness();
    const gate = openGate();
    let call = 0;
    const runtime = createAgentSessionRuntime({
      agent: 'claude',
      autostart: false,
      id: 'chat-1',
      port: agentSessionPort({
        replay: vi.fn(async (entry) => {
          if (++call === 1) await gate.opened;
          return {
            effort: null,
            transcript: [{ id: entry.id, kind: 'notice' as const, text: entry.title }],
          };
        }),
      }).port,
      scheduler: test.scheduler,
      scope: { kind: 'folder', path: '/project/Research' },
    });

    const stale = runtime.restore(historyEntry('native-1', 'Stale'), false);
    const current = runtime.restore(historyEntry('native-2', 'Current'), false);
    gate.open();

    await expect(stale).resolves.toBe(false);
    await expect(current).resolves.toBe(true);
    expect(runtime.store.getState().nativeSessionId).toBe('native-2');
  });

  it('retires a removed folder while stopping without reconnecting it', async () => {
    const test = harness();
    const runtime = createAgentSessionRuntime({
      agent: 'codex',
      id: 'chat-1',
      port: test.port,
      scheduler: test.scheduler,
      scope: { kind: 'folder', path: '/project/Research' },
    });
    test.listeners[0]?.onEvent({ kind: 'ready' });
    await runtime.sendPrompt('Keep the reply');
    runtime.interrupt();
    runtime.retire('/project/Research');
    runtime.reconnect();
    expect(runtime.store.getState().delivery).toBe('stopped');

    expect(runtime.store.getState().connection).toEqual({ kind: 'retired' });
    expect(test.requests()).toHaveLength(1);
  });
});
