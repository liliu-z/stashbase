import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { agentContextPort, agentSessionPort } from '@/test/fakes/agent';

import { createAgentSessionRuntime, type AgentSessionRuntime } from './session-runtime';
import { heldScheduler } from './session-runtime.harness';
import { createAgentWorkspaceRuntime } from './workspace-runtime';

const sessions: AgentSessionRuntime[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

function live() {
  const fake = agentSessionPort();
  const session = createAgentSessionRuntime({
    agent: 'codex',
    id: 'chat',
    port: fake.port,
    scope: { kind: 'folder', path: '/project' },
    scheduler: heldScheduler().scheduler,
  });
  sessions.push(session);
  fake.listeners[0]?.onEvent({ kind: 'ready' });
  const listener = fake.listeners[0];
  if (!listener) throw new Error('Expected a connected session');
  return { ...fake, session, emit: listener.onEvent };
}

describe('conversation recovery and pending work', () => {
  it('advances the queue after success without consuming a newer composer draft', async () => {
    const { session, emit, sent } = live();
    await session.sendPrompt('First');
    session.setDraft('Second');
    session.setQueue([{ id: 'q', text: 'Second' }]);
    session.setDraft('A different unsent idea');
    emit({ kind: 'turn-ended', isError: false });
    await vi.waitFor(() =>
      expect(sent.filter((command) => command.kind === 'prompt')).toHaveLength(2),
    );
    expect(session.store.getState().queuedPrompts).toEqual([]);
    expect(session.store.getState().draft).toBe('A different unsent idea');
  });

  it('takes a follow-up into the running turn where the runtime reads it', async () => {
    const { session, emit, sent } = live();
    await session.sendPrompt('Draft the intro');
    emit({ kind: 'text', delta: 'Working on it' });
    session.setDraft('Keep it short');
    session.steer('Keep it short');
    await vi.waitFor(() =>
      expect(sent.at(-1)).toMatchObject({ kind: 'steer', text: 'Keep it short' }),
    );
    const steer = sent.at(-1) as { id: string };
    expect(session.store.getState()).toMatchObject({
      draft: '',
      steers: [{ text: 'Keep it short' }],
    });
    // Until the runtime reads it, the reply in progress keeps its own block.
    emit({ kind: 'text', delta: ', still' });
    emit({ kind: 'steer-result', id: steer.id, ok: true });
    emit({ kind: 'text', delta: 'Short version:' });
    expect(
      session.store
        .getState()
        .transcript.map((block) => [block.kind, 'text' in block ? block.text : null]),
    ).toEqual([
      ['user', 'Draft the intro'],
      ['assistant', 'Working on it, still'],
      ['user', 'Keep it short'],
      ['assistant', 'Short version:'],
    ]);
    expect(session.store.getState().steers).toEqual([]);
    expect(sent.filter((command) => command.kind === 'prompt')).toHaveLength(1);
  });

  it('holds a follow-up sent while the first prompt connects for the turn that prompt starts', async () => {
    const fake = agentSessionPort();
    const session = createAgentSessionRuntime({
      agent: 'codex',
      autostart: false,
      id: 'chat',
      port: fake.port,
      scope: { kind: 'folder', path: '/project' },
      scheduler: heldScheduler().scheduler,
    });
    sessions.push(session);
    const wire = () =>
      fake.sent.flatMap((command) =>
        command.kind === 'prompt' || command.kind === 'steer' ? [[command.kind, command.text]] : [],
      );
    expect(await session.sendPrompt('What is the weather today?')).toEqual({ ok: true });
    session.steer('Shanghai');
    await vi.waitFor(() =>
      expect(session.store.getState().steers).toMatchObject([{ text: 'Shanghai' }]),
    );
    expect(session.store.getState().queuedPrompts).toEqual([]);
    expect(wire()).toEqual([]);
    fake.listeners[0]?.onEvent({ kind: 'ready' });
    await vi.waitFor(() =>
      expect(wire()).toEqual([
        ['prompt', 'What is the weather today?'],
        ['steer', 'Shanghai'],
      ]),
    );
  });

  it('sends a follow-up next when the turn ends before the runtime reads it', async () => {
    const { session, emit, sent } = live();
    const prompts = () => sent.filter((command) => command.kind === 'prompt');
    await session.sendPrompt('Draft the intro');
    session.steer('Keep it short');
    await vi.waitFor(() => expect(sent.some((command) => command.kind === 'steer')).toBe(true));
    const steer = sent.find((command) => command.kind === 'steer') as { id: string };
    emit({ kind: 'turn-ended', isError: false });
    await vi.waitFor(() => expect(prompts()).toHaveLength(2));
    expect(prompts().at(-1)).toMatchObject({ text: 'Keep it short' });
    // A late answer for the follow-up it already sent changes nothing.
    emit({ kind: 'steer-result', id: steer.id, ok: true });
    expect(
      session.store
        .getState()
        .transcript.flatMap((block) => (block.kind === 'user' ? [block.text] : [])),
    ).toEqual(['Draft the intro', 'Keep it short']);
  });

  it('queues a follow-up the running turn cannot take, without losing it', async () => {
    const { session, emit, sent } = live();
    const prompts = () => sent.filter((command) => command.kind === 'prompt');
    await session.sendPrompt('Draft the intro');
    session.steer('Keep it short');
    await vi.waitFor(() => expect(sent.some((command) => command.kind === 'steer')).toBe(true));
    const steer = sent.find((command) => command.kind === 'steer') as { id: string };
    emit({ kind: 'steer-result', id: steer.id, ok: false });
    expect(session.store.getState()).toMatchObject({
      queuedPrompts: [{ text: 'Keep it short' }],
      steers: [],
    });
    expect(prompts()).toHaveLength(1);
    emit({ kind: 'turn-ended', isError: false });
    await vi.waitFor(() => expect(prompts()).toHaveLength(2));
    expect(prompts().at(-1)).toMatchObject({ text: 'Keep it short' });
  });

  it('keeps a refused queued request held instead of retrying it', async () => {
    const { session, emit, port } = live();
    await session.sendPrompt('First');
    session.setQueue([{ id: 'q', text: 'Second' }]);
    const socket = vi.mocked(port.connect).mock.results[0]?.value;
    if (!socket) throw new Error('Expected a connected socket');
    vi.mocked(socket.send).mockReturnValue(false);
    emit({ kind: 'turn-ended', isError: false });
    await vi.waitFor(() => expect(session.store.getState().queuePaused).toBe(true));
    expect(session.store.getState().queuedPrompts.map((item) => item.text)).toEqual(['Second']);
    expect(session.store.getState().transcript.filter((item) => item.kind === 'user')).toHaveLength(
      1,
    );
  });

  it('stops approvals and sends the next queued request once cancellation is confirmed', async () => {
    const { session, emit, sent } = live();
    await session.sendPrompt('First');
    session.setQueue([{ id: 'q', text: 'Second' }]);
    emit({
      kind: 'permission-requested',
      id: 'permission',
      toolUseId: 'tool',
      name: 'Write',
      title: null,
      input: { file_path: 'draft.md' },
    });
    expect(session.interrupt()).toBe(true);
    expect(session.store.getState().delivery).toBe('stopping');
    expect(sent).toContainEqual({
      kind: 'reply-permission',
      id: 'permission',
      allow: false,
      always: null,
      answers: null,
    });
    // Nothing advances while the stop is unconfirmed.
    expect(session.store.getState().queuedPrompts).toHaveLength(1);
    emit({ kind: 'turn-ended', isError: false });
    expect(session.store.getState().delivery).toBe('stopped');
    await vi.waitFor(() =>
      expect(sent.filter((command) => command.kind === 'prompt')).toHaveLength(2),
    );
    expect(session.store.getState().queuedPrompts).toEqual([]);
  });

  it('holds the queue after a failed turn and releases it when the next turn completes', async () => {
    const { session, emit, sent } = live();
    const prompts = () => sent.filter((command) => command.kind === 'prompt');
    await session.sendPrompt('First');
    session.setQueue([{ id: 'q', text: 'Depends on first' }]);
    emit({ kind: 'turn-ended', isError: true });
    await Promise.resolve();
    expect(session.store.getState().queuePaused).toBe(true);
    expect(prompts()).toHaveLength(1);
    await session.sendPrompt('First, again');
    emit({ kind: 'turn-ended', isError: false });
    await vi.waitFor(() => expect(prompts()).toHaveLength(3));
    expect(prompts().at(-1)).toMatchObject({ text: 'Depends on first' });
  });

  it('pauses on failure and preserves uncertainty through reconnect without automatically resending', async () => {
    const { session, listeners, sent, emit } = live();
    await session.sendPrompt('Change a file');
    session.setQueue([{ id: 'q', text: 'Follow-up' }]);
    listeners[0]?.onClose();
    expect(session.store.getState().delivery).toBe('unknown');
    session.reconnect();
    listeners[1]?.onEvent({ kind: 'ready' });
    expect(await session.sendPrompt('Another change')).toEqual({ ok: false, reason: 'busy' });
    expect(sent.filter((command) => command.kind === 'prompt')).toHaveLength(1);
    // Reviewing the uncertain turn is the go-ahead; the queue continues by itself.
    session.confirmOutcome();
    await vi.waitFor(() =>
      expect(sent.filter((command) => command.kind === 'prompt')).toHaveLength(2),
    );
    listeners[1]?.onEvent({ kind: 'failed', message: 'Try later', failure: 'rate-limit' });
    emit({ kind: 'text', delta: 'late old output' });
    expect(session.store.getState().queuePaused).toBe(true);
    expect(session.store.getState().transcript.some((item) => item.kind === 'assistant')).toBe(
      false,
    );
  });

  it('preserves newer input during preparation and cancels a later preparation before sending', async () => {
    const fake = agentSessionPort();
    let release: (() => void) | undefined;
    const context = agentContextPort({
      resolve: async (source) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          available: true,
          kind: 'direct',
          path: '/project/note.md',
          folder: 'project',
          readPath: '/project/note.md',
          sourcePath: source.path,
          sourceFormat: 'md',
          reason: '',
        };
      },
    });
    const session = createAgentSessionRuntime({
      agent: 'codex',
      id: 'chat',
      port: fake.port,
      context,
      scope: { kind: 'folder', path: '/project' },
    });
    sessions.push(session);
    fake.listeners[0]?.onEvent({ kind: 'ready' });
    session.addContext({
      kind: 'source',
      source: { folderPath: '/project', path: 'note.md' },
      format: 'md',
      boundVersion: null,
    });
    session.setDraft('First');
    const sending = session.sendPrompt();
    session.setDraft('Newer idea');
    release?.();
    expect(await sending).toEqual({ ok: true });
    expect(session.store.getState().draft).toBe('Newer idea');
    fake.listeners[0]?.onEvent({ kind: 'turn-ended', isError: false });
    const cancelled = session.sendPrompt();
    expect(session.interrupt()).toBe(true);
    release?.();
    expect((await cancelled).ok).toBe(false);
    expect(fake.sent.filter((command) => command.kind === 'prompt')).toHaveLength(1);
    expect(session.store.getState().draft).toBe('Newer idea');
  });

  it('protects existing drafts during reuse and preserves them when selecting another Agent', () => {
    const { session } = live();
    session.store.setState({
      connection: { kind: 'live', turn: null },
      nativeSessionId: 'catalog-only',
      transcript: [],
      model: 'codex-model',
      effort: 'high',
      skill: 'draft',
    });
    session.setDraft('Unsent idea');
    expect(session.changeAgent('stashbase')).toBe(true);
    expect(session.store.getState()).toMatchObject({
      agent: 'stashbase',
      draft: 'Unsent idea',
      nativeSessionId: null,
      model: null,
      effort: null,
      skill: null,
      contextIssue: null,
    });
    session.store.setState({ transcript: [{ kind: 'user', id: 'sent', text: 'Old question' }] });
    expect(session.editPrompt('sent')).toBe(false);
    expect(session.store.getState().draft).toBe('Unsent idea');
    session.setDraft('');
    expect(session.editPrompt('sent')).toBe(true);
    expect(session.store.getState().draft).toBe('Old question');
  });

  it('keeps historical attachment requirements visible until explicitly replaced or removed', async () => {
    const { session, sent } = live();
    session.store.setState({
      transcript: [
        {
          kind: 'user',
          id: 'old',
          text: 'Read this',
          attachments: [{ name: 'missing.png', path: '/tmp/missing.png' }],
        },
      ],
    });
    expect(session.editPrompt('old')).toBe(true);
    expect(await session.sendPrompt()).toEqual({ ok: false, reason: 'stale' });
    expect(session.store.getState().draft).toBe('Read this');
    expect(sent).toEqual([]);
    session.removeContext('transient:/tmp/missing.png');
    expect(await session.sendPrompt()).toEqual({ ok: true });
  });

  it('reconnects to the same native session while retaining partial output and unsent work', async () => {
    const { session, emit, listeners, port } = live();
    emit({ kind: 'identified', id: 'native-chat' });
    await session.sendPrompt('Revise the introduction');
    emit({ kind: 'text', delta: 'Partial reply' });
    session.setDraft('Next idea');
    session.setQueue([{ id: 'q', text: 'Later' }]);
    const transcript = session.store.getState().transcript;
    listeners[0]?.onClose();
    session.reconnect();
    expect(port.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ resume: 'native-chat' }),
      expect.any(Object),
    );
    listeners[1]?.onEvent({ kind: 'ready' });
    expect(session.store.getState()).toMatchObject({
      draft: 'Next idea',
      delivery: 'unknown',
      queuePaused: true,
      transcript,
    });
    expect(session.store.getState().queuedPrompts).toHaveLength(1);
  });

  it('joins repeated restores and keeps a user-chosen title when native updates arrive', async () => {
    let release: (() => void) | undefined;
    const fake = agentSessionPort({
      replay: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { effort: null, transcript: [] };
      },
    });
    let sequence = 0;
    const workspace = createAgentWorkspaceRuntime({
      createId: () => `chat-${++sequence}`,
      folderPath: '/project',
      port: fake.port,
    });
    const entry = {
      agent: 'codex' as const,
      id: 'native',
      scope: { kind: 'folder' as const, path: '/project' },
      title: 'Saved',
      lastModified: 1,
      hasContent: true,
    };
    const first = workspace.restore(entry);
    const second = workspace.restore(entry);
    expect(workspace.store.getState().tabs).toHaveLength(1);
    release?.();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    const session = workspace.activeSession();
    session.rename('My title');
    session.start();
    fake.listeners[0]?.onEvent({ kind: 'titled', title: 'Automatic title' });
    expect(session.store.getState().title).toBe('My title');
    workspace.dispose();
  });
});
