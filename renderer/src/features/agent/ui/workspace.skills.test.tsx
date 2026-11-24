/** The composer's `/` panel: the advertised skills it lists, the one it arms
 *  and spends on a single turn, the plain text it leaves for a runtime that
 *  runs none, and the retry it offers when the read failed. */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vite-plus/test';

import { draftOf, pressKey, typeInto } from '@/test/dom';
import { agentGateLifted, agentContextPort, agentSessionPort } from '@/test/fakes/agent';

import { registerWorkspaceCleanup, renderWorkspace } from './workspace.harness';

registerWorkspaceCleanup();

async function skillWorkspace() {
  const test = agentSessionPort();
  const { runtime } = renderWorkspace(test.port, undefined, agentContextPort());
  await screen.findByText('What’s on your mind?');
  await agentGateLifted();
  await userEvent.click(screen.getByRole('button', { name: 'Provider: StashBase Agent' }));
  await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Codex' }));
  act(() => runtime.activeSession().start());
  return { ...test, runtime };
}

describe('AgentWorkspace composer skills', () => {
  it('lists advertised skills for /, arms the picked one, and sends it alone', async () => {
    const test = await skillWorkspace();
    act(() => {
      test.listeners[0]?.onEvent({
        error: null,
        kind: 'skills',
        skills: [
          { id: 'review', label: 'review', description: 'Review the draft' },
          { id: 'summarize', label: 'summarize', description: 'Summarize a folder' },
        ],
        state: 'available',
      });
      test.listeners[0]?.onEvent({ kind: 'ready' });
    });

    const composer = screen.getByRole('textbox', { name: 'Message' });
    typeInto(composer, '/rev');
    expect(await screen.findByRole('listbox', { name: 'Run a skill' })).not.toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(1);

    pressKey(composer, 'Enter');
    expect(test.runtime.activeSession().store.getState().skill).toBe('review');
    expect(composer.querySelector('[data-skill="review"]')?.textContent).toContain('/review'); // dom-contract: CodeMirror WidgetType in the editor's text layer
    expect(draftOf(test.runtime)).toBe('');
    expect(screen.queryByRole('listbox')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(test.sent).toContainEqual({
        kind: 'prompt',
        telemetryTurnId: expect.any(String),
        skill: 'review',
        text: '',
        titleHint: '/review',
      }),
    );
    expect(test.runtime.activeSession().store.getState().skill).toBe(null);
    expect((await screen.findAllByText('/review')).length).toBeGreaterThan(0);
  });

  it('leaves / as plain text for a runtime that runs no skills', async () => {
    const test = agentSessionPort();
    const { runtime } = renderWorkspace(test.port, undefined, agentContextPort());
    await screen.findByText('What’s on your mind?');
    await agentGateLifted();
    act(() => runtime.activeSession().start());

    const composer = screen.getByRole('textbox', { name: 'Message' });
    typeInto(composer, '/rev');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(draftOf(runtime)).toBe('/rev');
  });

  it('offers a retry when the runtime could not read its skills', async () => {
    const test = await skillWorkspace();
    act(() => {
      test.listeners[0]?.onEvent({
        error: 'Skill folder is unreadable.',
        kind: 'skills',
        skills: [],
        state: 'failed',
      });
      test.listeners[0]?.onEvent({ kind: 'ready' });
    });

    const composer = screen.getByRole('textbox', { name: 'Message' });
    typeInto(composer, '/');
    expect(await screen.findByText('Could not load skills.')).not.toBeNull();
    expect(screen.queryByRole('option')).toBeNull();

    // The panel is explaining itself, so Enter must not send the text behind it.
    pressKey(composer, 'Enter');
    expect(test.sent).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(test.sent).toContainEqual({ kind: 'refresh-skills' });
  });
});
