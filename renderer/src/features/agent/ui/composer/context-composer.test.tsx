import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { QueuedMessage } from '@/components/ui/input-message';
import {
  createAgentSessionRuntime,
  type AgentSessionRuntime,
} from '@/features/agent/application/session-runtime';
import { passageContextItem, type AgentScopeEnvironment } from '@/features/agent/domain/context';
import type { SourceReference } from '@/shared/domain/source-reference';
import { pressKey, typeInto } from '@/test/dom';
import { agentContextPort, agentSessionPort, type FakeAgentSession } from '@/test/fakes/agent';

import { AgentContextComposer } from './context-composer';

const SCOPE = { kind: 'folder', path: '/project/Research' } as const;

const environment: AgentScopeEnvironment = {
  folderPath: SCOPE.path,
  listing: {
    files: [
      { format: 'md', path: 'notes.md' },
      { format: 'image', path: 'chart.png' },
      { format: 'md', path: 'drafts/essay.md' },
      { format: 'generic', path: 'data.bin' },
    ],
    folders: ['drafts'],
  },
  readiness: {},
  versions: {},
};

const runtimes: AgentSessionRuntime[] = [];

afterEach(() => {
  cleanup();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

function renderComposer(
  overrides: {
    skills?: boolean;
    activeSource?: SourceReference | null;
    status?: 'idle' | 'streaming';
    steering?: boolean;
    holdSend?: boolean;
  } = {},
) {
  const port: FakeAgentSession = agentSessionPort();
  const session = createAgentSessionRuntime({
    agent: 'codex',
    context: agentContextPort(),
    environment: () => ({ listing: environment.listing, readiness: environment.readiness }),
    id: 'chat-1',
    port: port.port,
    scope: SCOPE,
  });
  runtimes.push(session);
  const spies = {
    onQueueChange: vi.fn((queue: QueuedMessage[]) =>
      session.setQueue(queue.map(({ id, text }) => ({ id, text }))),
    ),
    onRefreshSkills: vi.fn(),
    onSend: vi.fn((text: string, options?: { queuedId?: string }) => {
      if (!overrides.holdSend) void session.sendPrompt(text, options);
    }),
    onSkillChange: vi.fn(),
    onStop: vi.fn(),
  };
  const composer = (activeSource: SourceReference | null) => (
    <AgentContextComposer
      attachments
      environment={{ ...environment, activeSource }}
      onSteer={overrides.steering ? session.steer : undefined}
      queue={session.store
        .getState()
        .queuedPrompts.map(({ id, text }) => ({ id, text, files: [] }))}
      placeholder="Ask about Research…"
      session={session}
      skills={overrides.skills ?? true}
      status={overrides.status ?? 'idle'}
      {...spies}
    />
  );
  const view = render(composer(overrides.activeSource ?? null));
  const showDocument = (activeSource: SourceReference | null) =>
    view.rerender(composer(activeSource));
  const field = screen.getByRole('textbox', { name: 'Message' });
  return { field, port, session, showDocument, view, ...spies };
}

/** Puts the runtime in the live state a skill catalog arrives in. */
function announceSkills(
  port: FakeAgentSession,
  skills: Array<{ id: string; label: string; description?: string }>,
  state: 'available' | 'empty' | 'failed' = 'available',
) {
  act(() => {
    port.listeners[0]?.onEvent({ kind: 'ready' });
    port.listeners[0]?.onEvent({ error: null, kind: 'skills', skills, state });
  });
}

describe('Agent context composer', () => {
  it('suggests scope files for an @ query and binds the picked one to the draft', async () => {
    const { field, session } = renderComposer();

    typeInto(field, 'Read @not');
    const option = await screen.findByRole('option', { name: /notes\.md/u });
    await userEvent.click(option);

    expect(session.store.getState().draft).toBe('Read @notes.md ');
    expect(session.store.getState().context).toEqual([
      expect.objectContaining({
        kind: 'source',
        source: { folderPath: SCOPE.path, path: 'notes.md' },
      }),
    ]);
  });

  it('closes the suggestion list when the query no longer matches anything', async () => {
    const { field } = renderComposer();

    typeInto(field, 'Read @not');
    expect(await screen.findByRole('listbox', { name: 'Mention a file or folder' })).not.toBeNull();

    typeInto(field, 'hingatall');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('keeps the / panel open with no rows and says why the folder has none', async () => {
    const { field, port } = renderComposer();
    announceSkills(port, []);

    typeInto(field, '/');
    expect(await screen.findByText('No skills are available for this folder.')).not.toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('offers a retry when the runtime could not read its skills', async () => {
    const { field, onRefreshSkills, port } = renderComposer();
    announceSkills(port, [], 'failed');

    typeInto(field, '/');
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(onRefreshSkills).toHaveBeenCalledOnce();
  });

  it('arms the picked skill and reports it to the owner', async () => {
    const { field, onSkillChange, port } = renderComposer();
    announceSkills(port, [{ description: 'Review a draft', id: 'review', label: 'review' }]);

    typeInto(field, '/rev');
    await userEvent.click(await screen.findByRole('option', { name: /review/u }));
    expect(onSkillChange).toHaveBeenCalledWith('review');
  });

  it('ignores / entirely when the runtime cannot run skills', async () => {
    const { field, port } = renderComposer({ skills: false });
    announceSkills(port, [{ id: 'review', label: 'review' }]);

    typeInto(field, '/rev');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(screen.queryByText('No matching skills.')).toBeNull();
  });

  it('gives a bound visual source a preview tile and unbinds it when removed', async () => {
    const { session } = renderComposer();
    act(() => {
      session.addContext({
        boundVersion: null,
        format: 'image',
        kind: 'source',
        source: { folderPath: SCOPE.path, path: 'chart.png' },
      });
    });

    const tiles = await screen.findByRole('list', { name: 'Attached context' });
    expect(tiles).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Remove chart.png' }));
    expect(session.store.getState().context).toEqual([]);
  });

  it('sends the visible document with the request without a separate attach action', async () => {
    const notes = { folderPath: SCOPE.path, path: 'notes.md' };
    const { field, port, session } = renderComposer({ activeSource: notes });

    expect(screen.getByRole('button', { name: 'Remove notes.md' })).not.toBeNull();
    expect(session.store.getState().context).toEqual([]);
    expect(session.isBlank()).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true);
    act(() => port.listeners[0]?.onEvent({ kind: 'ready' }));
    typeInto(field, 'What does this page say?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(port.sent).toContainEqual(
        expect.objectContaining({
          kind: 'prompt',
          text: 'What does this page say?\n\nAttached files:\n- /project/Research/notes.md',
        }),
      ),
    );
    expect(session.store.getState().transcript).toContainEqual(
      expect.objectContaining({
        context: [expect.objectContaining({ kind: 'source', source: notes })],
        kind: 'user',
        text: 'What does this page say?',
      }),
    );
  });

  it('excludes a removed current document until another document comes forward', async () => {
    const notes = { folderPath: SCOPE.path, path: 'notes.md' };
    const essay = { folderPath: SCOPE.path, path: 'drafts/essay.md' };
    const { field, port, showDocument } = renderComposer({ activeSource: notes });

    await userEvent.click(screen.getByRole('button', { name: 'Remove notes.md' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove notes.md' })).toBeNull(),
    );
    act(() => port.listeners[0]?.onEvent({ kind: 'ready' }));
    typeInto(field, 'Brainstorm an idea');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(port.sent).toContainEqual(
        expect.objectContaining({ kind: 'prompt', text: 'Brainstorm an idea' }),
      ),
    );

    showDocument(essay);
    expect(screen.getByRole('button', { name: 'Remove essay.md' })).not.toBeNull();
    showDocument(notes);
    expect(screen.getByRole('button', { name: 'Remove notes.md' })).not.toBeNull();
  });

  it('includes no current document without a listed, readable source from this folder', () => {
    const { showDocument } = renderComposer({ activeSource: null });
    showDocument({ folderPath: SCOPE.path, path: 'data.bin' });
    showDocument({ folderPath: SCOPE.path, path: 'unlisted.md' });
    showDocument({ folderPath: '/project/Plans', path: 'notes.md' });

    for (const name of ['data.bin', 'unlisted.md', 'notes.md'])
      expect(screen.queryByRole('button', { name: `Remove ${name}` })).toBeNull();
  });

  it('captures the visible document before a first-send access gate can hold the request', async () => {
    const notes = { folderPath: SCOPE.path, path: 'notes.md' };
    const { field, onSend, port, session, showDocument } = renderComposer({
      activeSource: notes,
      holdSend: true,
    });
    let contextAtSend = session.store.getState().context;
    onSend.mockImplementation(() => {
      contextAtSend = session.store.getState().context;
    });
    typeInto(field, 'Read this page');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('Read this page', undefined);
    expect(contextAtSend).toEqual([expect.objectContaining({ kind: 'source', source: notes })]);
    showDocument({ folderPath: SCOPE.path, path: 'drafts/essay.md' });
    act(() => port.listeners[0]?.onEvent({ kind: 'ready' }));
    await act(() => session.sendPrompt('Read this page'));
    expect(port.sent).toContainEqual(
      expect.objectContaining({
        kind: 'prompt',
        text: 'Read this page\n\nAttached files:\n- /project/Research/notes.md',
      }),
    );
  });

  it('keeps a queued request bound to the document visible when it was queued', async () => {
    const notes = { folderPath: SCOPE.path, path: 'notes.md' };
    const { field, port, session, showDocument } = renderComposer({
      activeSource: notes,
      status: 'streaming',
    });
    typeInto(field, 'Read this later');
    await userEvent.click(screen.getByRole('button', { name: 'Queue message' }));
    const queued = session.store.getState().queuedPrompts[0];
    if (!queued) throw new Error('The current draft was not queued.');
    expect(queued.context).toEqual([expect.objectContaining({ kind: 'source', source: notes })]);
    showDocument({ folderPath: SCOPE.path, path: 'drafts/essay.md' });
    act(() => port.listeners[0]?.onEvent({ kind: 'ready' }));
    await act(() => session.sendPrompt('Read this later', { queuedId: queued.id }));

    expect(port.sent).toContainEqual(
      expect.objectContaining({
        kind: 'prompt',
        text: 'Read this later\n\nAttached files:\n- /project/Research/notes.md',
      }),
    );
    expect(session.store.getState().context).toEqual([]);
  });

  it('does not capture a different current document when removing a queued request', async () => {
    const { field, session, showDocument } = renderComposer({
      activeSource: { folderPath: SCOPE.path, path: 'notes.md' },
      status: 'streaming',
    });
    typeInto(field, 'Read this later');
    await userEvent.click(screen.getByRole('button', { name: 'Queue message' }));
    showDocument({ folderPath: SCOPE.path, path: 'drafts/essay.md' });
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove queued message: Read this later' }),
    );

    expect(session.store.getState().queuedPrompts).toEqual([]);
    expect(session.store.getState().context).toEqual([]);
  });

  it('includes the current document in a follow-up sent to the running turn', async () => {
    const { field, port, session } = renderComposer({
      activeSource: { folderPath: SCOPE.path, path: 'notes.md' },
      status: 'streaming',
      steering: true,
    });
    act(() => port.listeners[0]?.onEvent({ kind: 'ready' }));
    await act(() => session.sendPrompt('Start writing'));
    act(() => port.listeners[0]?.onEvent({ kind: 'turn-started' }));
    expect(screen.getByRole('button', { name: 'Stop' })).not.toBeNull();
    typeInto(field, 'Use this page too');
    await userEvent.click(screen.getByRole('button', { name: 'Send now' }));

    await waitFor(() =>
      expect(port.sent).toContainEqual(
        expect.objectContaining({
          kind: 'steer',
          text: 'Use this page too\n\nAttached files:\n- /project/Research/notes.md',
        }),
      ),
    );
  });

  it('keeps a removed bound current source excluded in both tile and inline forms', async () => {
    const notes = { folderPath: SCOPE.path, path: 'notes.md' };
    const { field, session, showDocument } = renderComposer({ activeSource: notes });
    act(() => {
      session.addContext({ boundVersion: null, format: 'md', kind: 'source', source: notes });
    });
    await userEvent.click(screen.getByRole('button', { name: 'Remove notes.md' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove notes.md' })).toBeNull(),
    );
    expect(session.store.getState().context).toEqual([]);

    showDocument(null);
    showDocument(notes);
    typeInto(field, '@not');
    await userEvent.click(await screen.findByRole('option', { name: /notes\.md/u }));
    pressKey(field, 'Backspace');
    pressKey(field, 'Backspace');
    expect(session.store.getState().context).toEqual([]);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove notes.md' })).toBeNull(),
    );
  });

  it('shows a passage as a removable chip and takes focus when asked', async () => {
    const { field, session } = renderComposer();
    const passage = passageContextItem(
      { folderPath: SCOPE.path, path: 'drafts/essay.md' },
      'The opening line of the essay runs longer than six words.',
    );
    act(() => {
      if (passage) session.addContext(passage);
      session.requestComposerFocus();
    });

    await waitFor(() => expect(field.contains(document.activeElement)).toBe(true));
    expect(session.store.getState().composerFocusRequested).toBe(false);
    expect(screen.getByText('The opening line of the essay…')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Remove essay.md' }));
    expect(session.store.getState().context).toEqual([]);
  });

  it('shows the refusal the session recorded for the last send', async () => {
    const { port, session } = renderComposer();
    act(() => {
      port.listeners[0]?.onEvent({ kind: 'ready' });
      session.addContext({
        boundVersion: null,
        format: 'md',
        kind: 'source',
        source: { folderPath: '/project/Plans', path: 'gone.md' },
      });
    });
    await act(async () => {
      await session.sendPrompt('Summarize this');
    });

    expect((await screen.findByRole('alert')).textContent).toBe(
      'This file belongs to a different project.',
    );
  });
});
