/** What the runtime binds to a prompt and what it refuses to send: mentioned
 *  sources resolved onto the wire, uploads, the queue's own snapshot, and every
 *  way a source can go stale before or during the send. */
import { describe, expect, it, vi } from 'vite-plus/test';

import { passageContextItem, type AgentContextItem } from '@/features/agent/domain/context';
import { agentContextPort, agentSessionPort } from '@/test/fakes/agent';

import { AgentContextError, type AgentReconnectScheduler, type AgentSessionPort } from './ports';
import { createAgentSessionRuntime } from './session-runtime';

type AgentConnectRequest = Parameters<AgentSessionPort['connect']>[0];

const reportSource: AgentContextItem = {
  boundVersion: 4,
  format: 'pdf',
  kind: 'source',
  source: { folderPath: '/project/Research', path: 'papers/report.pdf' },
};

/** The PDF this suite attaches is only readable through its derived text, so
 *  the prompt has to name the derived read path rather than the source. */
function derivedContextPort() {
  return agentContextPort({
    resolve: vi.fn(async (source) => ({
      available: true,
      folder: 'Research',
      kind: 'derived' as const,
      path: `${source.folderPath}/${source.path}`,
      readPath: '/app-data/derived/report.md',
      reason: '',
      sourceFormat: 'pdf',
      sourcePath: source.path,
    })),
  });
}

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

describe('AgentSessionRuntime context', () => {
  it('binds mentioned sources to the wire prompt while the transcript keeps the typed text', async () => {
    const test = harness();
    const context = derivedContextPort();
    const runtime = createAgentSessionRuntime({
      agent: 'codex',
      context,
      environment: () => ({
        listing: { files: [{ format: 'pdf', path: 'papers/report.pdf' }], folders: [] },
        readiness: { 'papers/report.pdf': 'current' },
      }),
      id: 'chat-1',
      port: test.port,
      scheduler: test.scheduler,
      scope: { kind: 'folder', path: '/project/Research' },
    });
    test.listeners[0]?.onEvent({ kind: 'ready' });
    runtime.addContext(reportSource);
    runtime.addContext(reportSource);
    expect(runtime.store.getState().context).toHaveLength(1);
    runtime.setDraft('Summarize @papers/report.pdf');

    await expect(runtime.sendPrompt()).resolves.toEqual({ ok: true });

    expect(context.resolve).toHaveBeenCalledWith(reportSource.source, runtime.signal);
    expect(test.sent.at(-1)).toMatchObject({
      kind: 'prompt',
      skill: null,
      text: [
        'Summarize @papers/report.pdf',
        '',
        'Attached files:',
        '- papers/report.pdf (for text context, use mcp__stashbase__read_file with path /project/Research/papers/report.pdf; it returns the derived text representation for this pdf)',
      ].join('\n'),
    });
    expect(runtime.store.getState()).toMatchObject({ context: [], draft: '' });
    expect(runtime.store.getState().transcript).toEqual([
      expect.objectContaining({
        context: [reportSource],
        kind: 'user',
        text: 'Summarize @papers/report.pdf',
      }),
    ]);

    test.listeners[0]?.onEvent({ kind: 'failed', message: 'Rate limited.' });
    const failure = runtime.store.getState().transcript.find((block) => block.kind === 'error');
    expect(runtime.retry(failure?.id ?? '')).toBe(true);
    const initial = test.sent.at(-2);
    expect(test.sent.at(-1)).toMatchObject({
      kind: 'prompt',
      skill: null,
      text: initial?.kind === 'prompt' ? initial.text : '',
    });
  });

  it('sends a selected passage as a quoted block without resolving its file', async () => {
    const test = harness();
    const context = agentContextPort();
    const runtime = createAgentSessionRuntime({
      agent: 'codex',
      context,
      environment: () => ({
        listing: { files: [{ format: 'md', path: 'drafts/essay.md' }], folders: [] },
        readiness: {},
      }),
      id: 'chat-1',
      port: test.port,
      scheduler: test.scheduler,
      scope: { kind: 'folder', path: '/project/Research' },
    });
    test.listeners[0]?.onEvent({ kind: 'ready' });
    const passage = passageContextItem(
      { folderPath: '/project/Research', path: 'drafts/essay.md' },
      'The opening line.\n\nThe closing line.',
    );
    if (passage) runtime.addContext(passage);
    runtime.setDraft('Is this clear?');

    await expect(runtime.sendPrompt()).resolves.toEqual({ ok: true });

    expect(context.resolve).not.toHaveBeenCalled();
    expect(test.sent.at(-1)).toMatchObject({
      kind: 'prompt',
      text: [
        'Is this clear?',
        '',
        'Selected passages:',
        '- /project/Research/drafts/essay.md',
        '  > The opening line.',
        '  >',
        '  > The closing line.',
      ].join('\n'),
    });
    expect(runtime.store.getState().transcript).toEqual([
      expect.objectContaining({ context: [passage], text: 'Is this clear?' }),
    ]);
  });

  it('refuses a send whose source left the folder and keeps the draft', async () => {
    const test = harness();
    const context = agentContextPort();
    const runtime = createAgentSessionRuntime({
      agent: 'codex',
      context,
      environment: () => ({ listing: { files: [], folders: [] }, readiness: {} }),
      id: 'chat-1',
      port: test.port,
      scheduler: test.scheduler,
      scope: { kind: 'folder', path: '/project/Research' },
    });
    test.listeners[0]?.onEvent({ kind: 'ready' });
    runtime.addContext(reportSource);
    runtime.setDraft('Summarize @papers/report.pdf');

    await expect(runtime.sendPrompt()).resolves.toEqual({ ok: false, reason: 'stale' });

    expect(context.resolve).not.toHaveBeenCalled();
    expect(test.sent).toEqual([]);
    expect(runtime.store.getState()).toMatchObject({
      context: [reportSource],
      contextIssue: 'This file is no longer in the folder.',
      draft: 'Summarize @papers/report.pdf',
    });
    runtime.setDraft('Summarize @papers/report.pdf again');
    expect(runtime.store.getState().contextIssue).toBeNull();
  });

  it('treats a source the server no longer finds as stale', async () => {
    const test = harness();
    const runtime = createAgentSessionRuntime({
      agent: 'codex',
      context: agentContextPort({
        resolve: vi.fn(async () => {
          throw new AgentContextError('not-found', 'That file is no longer in this folder.');
        }),
      }),
      id: 'chat-1',
      port: test.port,
      scheduler: test.scheduler,
      scope: { kind: 'folder', path: '/project/Research' },
    });
    test.listeners[0]?.onEvent({ kind: 'ready' });
    runtime.addContext(reportSource);

    await expect(runtime.sendPrompt('Read it')).resolves.toEqual({ ok: false, reason: 'stale' });
    expect(test.sent).toEqual([]);
    expect(runtime.store.getState().contextIssue).toBe('That file is no longer in this folder.');
  });

  it('sends a queued prompt with the context it was queued with', async () => {
    const test = harness();
    const runtime = createAgentSessionRuntime({
      agent: 'codex',
      context: agentContextPort(),
      id: 'chat-1',
      port: test.port,
      scheduler: test.scheduler,
      scope: { kind: 'folder', path: '/project/Research' },
    });
    test.listeners[0]?.onEvent({ kind: 'ready' });
    await runtime.sendPrompt('First');
    test.listeners[0]?.onEvent({ kind: 'turn-started' });

    runtime.addContext(reportSource);
    runtime.setQueue([{ id: 'queued-1', text: 'Then read @papers/report.pdf' }]);
    expect(runtime.store.getState()).toMatchObject({
      context: [],
      queuedPrompts: [
        { context: [reportSource], id: 'queued-1', text: 'Then read @papers/report.pdf' },
      ],
    });

    // Delivery removes the queued item only after acceptance.
    test.listeners[0]?.onEvent({ isError: false, kind: 'turn-ended' });
    await expect(
      runtime.sendPrompt('Then read @papers/report.pdf', { queuedId: 'queued-1' }),
    ).resolves.toEqual({ ok: true });

    const queued = test.sent.at(-1);
    expect(queued?.kind === 'prompt' && queued.text).toContain('Attached files:');
    expect(runtime.store.getState().transcript.at(-1)).toMatchObject({
      context: [reportSource],
      kind: 'user',
      text: 'Then read @papers/report.pdf',
    });
  });

  it('returns an edited queued message and its context to the composer', () => {
    const test = harness();
    const runtime = createAgentSessionRuntime({
      agent: 'codex',
      context: agentContextPort(),
      id: 'chat-1',
      port: test.port,
      scheduler: test.scheduler,
      scope: { kind: 'folder', path: '/project/Research' },
    });
    runtime.addContext(reportSource);
    runtime.setQueue([{ id: 'queued-1', text: 'Later' }]);
    expect(runtime.editQueued('queued-1')).toBe(true);

    expect(runtime.store.getState()).toMatchObject({
      context: [reportSource],
      draft: 'Later',
      queuedPrompts: [],
    });
  });

  it('binds uploaded files as transient context and reports the ones that failed', async () => {
    const test = harness();
    const context = agentContextPort({
      upload: vi.fn(async (files: File[]) =>
        files.map((file, index) =>
          index === 0
            ? { name: file.name, path: `/tmp/attach/${file.name}` }
            : { error: 'disk full', name: file.name },
        ),
      ),
    });
    const runtime = createAgentSessionRuntime({
      agent: 'codex',
      context,
      id: 'chat-1',
      port: test.port,
      scheduler: test.scheduler,
      scope: { kind: 'folder', path: '/project/Research' },
    });

    const notes = new File(['a'], 'notes.txt', { type: 'text/plain' });
    await runtime.attachFiles([notes, new File(['b'], 'more.txt', { type: 'text/plain' })]);

    expect(context.upload).toHaveBeenCalledTimes(1);
    expect(runtime.fileForTransient('/tmp/attach/notes.txt')).toBe(notes);
    expect(runtime.store.getState()).toMatchObject({
      context: [{ kind: 'transient', name: 'notes.txt', path: '/tmp/attach/notes.txt' }],
      contextIssue: '1 file could not be attached.',
    });
    runtime.removeContext('transient:/tmp/attach/notes.txt');
    expect(runtime.store.getState().context).toEqual([]);
  });
});
