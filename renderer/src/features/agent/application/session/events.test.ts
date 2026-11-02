import { describe, expect, it, vi } from 'vite-plus/test';

import {
  createAgentSessionState,
  transitionAgentSession,
  type AgentSessionAction,
  type AgentSessionEvent,
  type AgentSessionState,
} from '@/features/agent/domain/session';

import type { AgentTransport } from './connection';
import { applyAgentSessionEvent, type AgentEventContext } from './events';
import { createPromptLedger } from './prompts';

/** A context over real session state, so an event's effect is read back as
 *  state rather than as the action it happened to be spelled with. */
function harness(initial?: Partial<AgentSessionState>) {
  let state: AgentSessionState = {
    ...createAgentSessionState({
      agent: 'codex',
      id: 'chat-1',
      scope: { kind: 'folder', path: '/project/Research' },
    }),
    ...initial,
  };
  const actions: AgentSessionAction[] = [];
  const transport = {
    applyAccessMode: vi.fn(() => true),
    applyModel: vi.fn(() => true),
    close: vi.fn(),
    expectClose: vi.fn(),
    invalidate: vi.fn(),
    open: vi.fn(),
    send: vi.fn(() => true),
    syncAccessMode: vi.fn(),
    syncModel: vi.fn(),
  } satisfies AgentTransport;
  let blocks = 0;
  const context: AgentEventContext = {
    ledger: createPromptLedger(),
    nextBlockId: (kind) => `${kind}-${++blocks}`,
    notifyFilesChanged: vi.fn(),
    notifyFolderMayHaveChanged: vi.fn(),
    state: () => state,
    submit: vi.fn(() => true),
    transition: (action) => {
      actions.push(action);
      state = transitionAgentSession(state, action);
    },
    transport,
  };
  return {
    actions,
    apply: (event: AgentSessionEvent) => applyAgentSessionEvent(context, event),
    context,
    state: () => state,
    transport,
  };
}

const live = { connection: { kind: 'live', turn: null } } as const;

describe('applyAgentSessionEvent', () => {
  it('hands an event the reducer already understands straight to it', () => {
    const test = harness();

    test.apply({ id: 'native-7', kind: 'identified' });
    test.apply({ kind: 'titled', title: 'Mapping the repo' });

    // No translation step stands between the wire and the reducer, so the
    // action the state moved on is the event itself.
    expect(test.actions).toEqual([
      { id: 'native-7', kind: 'identified' },
      { kind: 'titled', title: 'Mapping the repo' },
    ]);
    expect(test.state()).toMatchObject({ nativeSessionId: 'native-7', title: 'Mapping the repo' });
  });

  it('re-applies the reader’s access mode and flushes the held prompt once live', () => {
    const test = harness();
    test.context.ledger.hold({ context: [], display: 'Go', skill: null, wire: 'Go' });

    test.apply({ kind: 'ready' });

    expect(test.state().connection).toEqual({ kind: 'live', turn: null });
    expect(test.transport.syncAccessMode).toHaveBeenCalledOnce();
    expect(test.transport.syncModel).toHaveBeenCalledOnce();
    expect(test.context.submit).toHaveBeenCalledWith(
      expect.objectContaining({ display: 'Go', wire: 'Go' }),
    );
  });

  it('keeps newer input when a held prompt is refused', () => {
    const test = harness({ draft: 'Newer idea' });
    vi.mocked(test.context.submit).mockReturnValue(false);
    test.context.ledger.hold({ context: [], display: 'Go', skill: null, wire: 'Go' });

    test.apply({ kind: 'ready' });

    expect(test.state()).toMatchObject({ context: [], draft: 'Newer idea', delivery: 'failed' });
  });

  it('gives every stream delta a transcript block id of its own', () => {
    const test = harness(live);

    test.apply({ delta: 'Reading', kind: 'text' });
    test.apply({ delta: 'Thinking', kind: 'thinking' });
    test.apply({ kind: 'notice', message: 'Model fell back.' });

    expect(test.state().transcript).toEqual([
      { id: 'reply-1', kind: 'assistant', text: 'Reading' },
      { id: 'thinking-2', kind: 'thinking', text: 'Thinking' },
      { id: 'notice-3', kind: 'notice', text: 'Model fell back.' },
    ]);
  });

  it('adds a notice for a model the runtime fell back to', () => {
    const test = harness(live);

    test.apply({
      activeModel: 'fast',
      fallback: 'Using fast instead.',
      kind: 'models',
      models: [],
    });

    expect(test.state().transcript).toEqual([
      { id: 'notice-1', kind: 'notice', text: 'Using fast instead.' },
    ]);
    expect(test.state().activeModel).toBe('fast');
  });

  it('reports the files a tool wrote only once it has settled cleanly', () => {
    const test = harness(live);
    test.apply({
      id: 'tool-1',
      input: { file_path: '/project/Research/notes.md' },
      kind: 'tool-started',
      name: 'Write',
    });

    test.apply({ content: 'ok', id: 'tool-1', isError: false, kind: 'tool-finished' });

    expect(test.context.notifyFilesChanged).toHaveBeenCalledWith(['/project/Research/notes.md']);
  });

  it('reports nothing for a tool that failed', () => {
    const test = harness(live);
    test.apply({
      id: 'tool-1',
      input: { file_path: '/project/Research/notes.md' },
      kind: 'tool-started',
      name: 'Write',
    });

    test.apply({ content: 'boom', id: 'tool-1', isError: true, kind: 'tool-finished' });

    expect(test.context.notifyFilesChanged).not.toHaveBeenCalled();
  });

  it('reports a native diff as soon as it arrives', () => {
    const test = harness(live);

    test.apply({
      additions: 2,
      after: 'b',
      before: 'a',
      deletions: 1,
      id: 'diff-1',
      kind: 'file-changed',
      path: 'notes.md',
    });

    expect(test.context.notifyFilesChanged).toHaveBeenCalledWith(['notes.md']);
  });

  it('reloads every file the host saw a turn change, including ones a command wrote', () => {
    const test = harness(live);

    test.apply({
      files: [
        { additions: 1, change: 'edited', deletions: 0, path: '/project/notes.md' },
        { additions: 0, change: 'deleted', deletions: 3, path: '/project/old.md' },
      ],
      kind: 'turn-changed',
      turnId: 't1',
    });

    expect(test.context.notifyFilesChanged).toHaveBeenCalledWith([
      '/project/notes.md',
      '/project/old.md',
    ]);
  });

  it('reports that the folder may have moved once a turn that ran a command settles', () => {
    const test = harness({ connection: { kind: 'live', turn: { promptBlockId: 'u1' } } });
    test.context.transition({ at: 1, context: [], id: 'u1', kind: 'submit-prompt', text: 'Go' });
    test.apply({
      id: 'tool-1',
      input: { command: "cat > drafts/intro.md <<'EOF'\n# Jev\nEOF" },
      kind: 'tool-started',
      name: 'Bash',
    });
    test.apply({ content: '', id: 'tool-1', isError: false, kind: 'tool-finished' });

    test.apply({ isError: false, kind: 'turn-ended' });

    // The command named no file, so its settled report was empty; the turn's
    // end is the only moment the shell learns the disk may have moved.
    expect(vi.mocked(test.context.notifyFilesChanged).mock.calls).toEqual([[[]]]);
    expect(test.context.notifyFolderMayHaveChanged).toHaveBeenCalledOnce();
    expect(test.state().connection).toEqual({ kind: 'live', turn: null });
  });

  it('leaves the folder alone after a turn of reads and writes it already reported', () => {
    const test = harness({ connection: { kind: 'live', turn: { promptBlockId: 'u1' } } });
    test.context.transition({ at: 1, context: [], id: 'u1', kind: 'submit-prompt', text: 'Go' });
    test.apply({
      id: 'read-1',
      input: { file_path: '/project/Research/notes.md' },
      kind: 'tool-started',
      name: 'Read',
    });
    test.apply({ content: '# Notes', id: 'read-1', isError: false, kind: 'tool-finished' });
    test.apply({
      id: 'write-1',
      input: { content: '# Notes', file_path: '/project/Research/notes.md' },
      kind: 'tool-started',
      name: 'Write',
    });
    test.apply({ content: 'ok', id: 'write-1', isError: false, kind: 'tool-finished' });

    test.apply({ isError: false, kind: 'turn-ended' });

    expect(test.context.notifyFilesChanged).toHaveBeenCalledWith(['/project/Research/notes.md']);
    expect(test.context.notifyFolderMayHaveChanged).not.toHaveBeenCalled();
  });

  it('turns a failure inside a turn into a retry offer and one outside it into a stop', () => {
    const inTurn = harness({ connection: { kind: 'live', turn: { promptBlockId: 'u1' } } });
    inTurn.context.transition({ at: 1, context: [], id: 'u1', kind: 'submit-prompt', text: 'Go' });

    inTurn.context.ledger.recordTurn('u1', { display: 'Go', skill: null, wire: 'Go' });
    inTurn.apply({ kind: 'failed', message: 'Rate limited.' });

    expect(inTurn.state().transcript.at(-1)).toMatchObject({
      kind: 'error',
      retryablePrompt: 'Go',
      text: 'Rate limited.',
    });

    const idle = harness();
    idle.apply({ kind: 'failed', message: 'Rate limited.' });
    expect(idle.state().connection).toEqual({ kind: 'failed', message: 'Rate limited.' });
  });

  it('does not offer a lossy retry for an active request recovered only from native history', () => {
    const restored = harness({
      connection: { kind: 'live', turn: { promptBlockId: null } },
      transcript: [
        {
          kind: 'user',
          id: 'old',
          text: 'Describe this',
          attachments: [{ path: '/tmp/old.png', name: 'old.png' }],
        },
      ],
    });
    restored.apply({ kind: 'failed', message: 'Connection interrupted.', failure: 'network' });
    expect(restored.state().transcript.at(-1)).toMatchObject({
      kind: 'error',
      retryablePrompt: undefined,
      text: expect.stringContaining('Reuse message'),
    });
  });

  it('settles the transport before an ending it was told about', () => {
    const exited = harness(live);
    exited.apply({ kind: 'exited', message: 'Session closed.' });
    expect(exited.transport.expectClose).toHaveBeenCalledOnce();
    expect(exited.state().connection).toEqual({ kind: 'closed', message: 'Session closed.' });

    const retired = harness(live);
    retired.apply({ folderPath: '/project/Research', kind: 'scope-retired' });
    expect(retired.transport.expectClose).toHaveBeenCalledOnce();
    expect(retired.state()).toMatchObject({
      connection: { kind: 'retired' },
      scope: { kind: 'folder', path: '/project/Research' },
    });
  });
});
