import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  createAgentSessionRuntime,
  type AgentSessionRuntime,
} from '@/features/agent/application/session-runtime';
import { passageContextItem, type AgentScopeEnvironment } from '@/features/agent/domain/context';
import type { SourceReference } from '@/shared/domain/source-reference';
import { typeInto } from '@/test/dom';
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
  overrides: { skills?: boolean; activeSource?: SourceReference | null } = {},
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
    onQueueChange: vi.fn(),
    onRefreshSkills: vi.fn(),
    onSkillChange: vi.fn(),
    onStop: vi.fn(),
  };
  const composer = (activeSource: SourceReference | null) => (
    <AgentContextComposer
      attachments
      environment={{ ...environment, activeSource }}
      queue={[]}
      placeholder="Ask about Research…"
      session={session}
      skills={overrides.skills ?? true}
      status="idle"
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

  it('offers the document in front of the reader and binds it only on a click', async () => {
    const notes = { folderPath: SCOPE.path, path: 'notes.md' };
    const { session } = renderComposer({ activeSource: notes });

    expect(session.store.getState().context).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Attach notes.md' }));

    expect(session.store.getState()).toMatchObject({
      context: [expect.objectContaining({ kind: 'source', source: notes })],
      draft: '@notes.md ',
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Attach notes.md' })).toBeNull(),
    );
  });

  it('keeps a dismissed suggestion hidden until another document comes forward', async () => {
    const notes = { folderPath: SCOPE.path, path: 'notes.md' };
    const essay = { folderPath: SCOPE.path, path: 'drafts/essay.md' };
    const { showDocument } = renderComposer({ activeSource: notes });

    await userEvent.click(screen.getByRole('button', { name: "Don't suggest notes.md" }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Attach notes.md' })).toBeNull(),
    );

    showDocument(essay);
    expect(screen.getByRole('button', { name: 'Attach essay.md' })).not.toBeNull();
    showDocument(notes);
    expect(screen.getByRole('button', { name: 'Attach notes.md' })).not.toBeNull();
  });

  it('suggests nothing without a listed, readable document from this folder', () => {
    const { showDocument } = renderComposer({ activeSource: null });
    showDocument({ folderPath: SCOPE.path, path: 'data.bin' });
    showDocument({ folderPath: SCOPE.path, path: 'unlisted.md' });
    showDocument({ folderPath: '/project/Plans', path: 'notes.md' });

    for (const name of ['data.bin', 'unlisted.md', 'notes.md'])
      expect(screen.queryByRole('button', { name: `Attach ${name}` })).toBeNull();
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
      'This file belongs to a different folder.',
    );
  });
});
