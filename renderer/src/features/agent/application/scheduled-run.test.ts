/** A scheduled run is a new chat sent through the ordinary send path, in the
 *  background: it never takes the window, it keeps its own title, and what
 *  would refuse a reader's send refuses the run, with the reason kept. */
import { describe, expect, it, vi } from 'vite-plus/test';

import type { ScheduledRunRequest } from '@/features/agent/domain/scheduled-tasks';
import {
  agentCatalogPort,
  agentContextPort,
  agentSessionPort,
  BUILT_IN_AGENT,
  CLAUDE_AGENT,
} from '@/test/fakes/agent';

import { startScheduledRun } from './scheduled-run';
import { createAgentWorkspaceRuntime } from './workspace-runtime';

const FOLDER = '/project/Brief';

const request: ScheduledRunRequest = {
  agent: 'claude',
  files: ['workflows/brief.md'],
  folderPath: FOLDER,
  prompt: '',
  runId: 'run-1',
  taskId: 'daily-brief',
  title: 'Daily brief · Oct 16',
};

function setup(listed: readonly string[] = ['workflows/brief.md', 'topics.md']) {
  let nextId = 0;
  const session = agentSessionPort();
  const runtime = createAgentWorkspaceRuntime({
    context: agentContextPort(),
    createId: () => `chat-${++nextId}`,
    folderPath: FOLDER,
    port: session.port,
  });
  runtime.setScopeEnvironment({
    activeSource: null,
    folderPath: FOLDER,
    listing: { files: listed.map((path) => ({ format: 'md', path })), folders: [] },
    openPaths: [],
    readiness: {},
    versions: {},
  });
  // The reader is in the middle of writing in the chat on screen.
  runtime.activeSession().setDraft('Half a thought');
  return { runtime, session };
}

describe('startScheduledRun', () => {
  it('sends a new chat in the background with the run title and the named files', async () => {
    const { runtime, session } = setup();
    const report = vi.fn(async () => undefined);
    const outcome = startScheduledRun(
      runtime,
      agentCatalogPort(),
      request,
      new AbortController().signal,
      report,
    );

    await vi.waitFor(() => expect(session.listeners).toHaveLength(1));
    const listener = session.listeners[0];
    listener?.onEvent({ id: 'native-1', kind: 'identified' });
    listener?.onEvent({ kind: 'ready' });

    await expect(outcome).resolves.toEqual({
      agent: 'claude',
      sessionId: 'native-1',
      status: 'sent',
    });
    expect(vi.mocked(session.port.connect).mock.calls[0]?.[0]).toMatchObject({ agent: 'claude' });
    expect(session.sent.at(-1)).toMatchObject({
      kind: 'prompt',
      text: expect.stringMatching(
        /^Follow the steps in @workflows\/brief\.md\.\n\nAttached files:\n- \/project\/Brief\/workflows\/brief\.md$/u,
      ),
    });

    // The chat the reader was writing in keeps the window and its draft.
    const workspace = runtime.store.getState();
    expect(workspace.activeId).toBe('chat-1');
    expect(runtime.session('chat-1')?.store.getState().draft).toBe('Half a thought');
    expect(runtime.session('chat-2')?.store.getState()).toMatchObject({
      title: 'Daily brief · Oct 16',
      titleEdited: true,
    });

    // The first turn's end is reported with the start of its last reply, so
    // the task list keeps both and says what the run found.
    expect(report).not.toHaveBeenCalled();
    listener?.onEvent({ delta: 'Reading the workflow.', kind: 'text' });
    listener?.onEvent({ kind: 'notice', message: 'Model fell back.' });
    listener?.onEvent({ delta: "## Brief\n\nI couldn't save **`brief.md`**.", kind: 'text' });
    listener?.onEvent({ isError: false, kind: 'turn-ended' });
    await vi.waitFor(() =>
      expect(report).toHaveBeenCalledWith({
        status: 'completed',
        summary: "Brief I couldn't save brief.md.",
      }),
    );
  });

  it('fails a run whose file left the project, and keeps no empty chat for it', async () => {
    const { runtime, session } = setup(['topics.md']);
    await expect(
      startScheduledRun(runtime, agentCatalogPort(), request, new AbortController().signal),
    ).resolves.toEqual({ reason: 'This file is no longer in the folder.', status: 'failed' });
    expect(session.port.connect).not.toHaveBeenCalled();
    expect(runtime.store.getState().tabs.map((tab) => tab.id)).toEqual(['chat-1']);
  });

  it('fails a run whose Agent is not ready instead of asking a reader who is not there', async () => {
    const { runtime, session } = setup();
    const catalog = agentCatalogPort([BUILT_IN_AGENT, { ...CLAUDE_AGENT, ready: false }]);
    await expect(
      startScheduledRun(runtime, catalog, request, new AbortController().signal),
    ).resolves.toEqual({
      reason: 'Claude is not ready on this computer. Set it up in Chat, then run this task again.',
      status: 'failed',
    });
    expect(session.port.connect).not.toHaveBeenCalled();
    expect(runtime.store.getState().tabs).toHaveLength(1);
  });
});
