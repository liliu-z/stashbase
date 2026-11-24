/** The Chat header: how a blank Chat names itself, when that name becomes a
 *  control, and what a rename does to the record the Chats panel reads. */
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vite-plus/test';

import type { AgentSessionPort } from '@/features/agent/application/ports';
import { pressKey, typeInto } from '@/test/dom';
import { agentGateLifted, agentSessionPort, idleAgentSessionPort } from '@/test/fakes/agent';

import { registerWorkspaceCleanup, renderWorkspace, RESEARCH_SCOPE } from './workspace.harness';

registerWorkspaceCleanup();

describe('Chat header', () => {
  it('names the blank Chat as plain text and lets it be renamed once a turn exists', async () => {
    const { listeners, port } = agentSessionPort();
    const { runtime } = renderWorkspace(port);
    await agentGateLifted();

    // The header labels itself "<title>, <runtime>"; the new-chat button's
    // label has no comma, so the pattern reaches only the header. Before
    // anything is said there is nothing to rename, so the name is not a
    // control.
    expect(await screen.findByRole('heading', { name: /^Untitled, / })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^Untitled, / })).toBeNull();

    typeInto(screen.getByRole('textbox', { name: 'Message' }), 'Inspect the workspace');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    act(() => listeners[0]?.onEvent({ kind: 'ready' }));
    await screen.findAllByText('Inspect the workspace');

    const header = await screen.findByRole('button', {
      name: /^Inspect the workspace, (StashBase Agent|Codex)$/u,
    });
    expect(
      screen.queryByRole('heading', { name: /^Inspect the workspace, (StashBase Agent|Codex)$/u }),
    ).toBeNull();
    pressKey(header, 'F2');
    const field = screen.getByRole('textbox', { name: 'Rename Inspect the workspace' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Reading list{Enter}');

    expect(
      await screen.findByRole('button', { name: /^Reading list, (StashBase Agent|Codex)$/u }),
    ).not.toBeNull();
    expect(runtime.activeSession().store.getState().title).toBe('Reading list');
  });

  it('keeps a header rename on record once the runtime has identified the chat', async () => {
    const entry = {
      agent: 'codex' as const,
      hasContent: true,
      id: 'identified-chat',
      lastModified: Date.now(),
      scope: RESEARCH_SCOPE,
      title: 'Original title',
    };
    const rename = vi.fn<AgentSessionPort['rename']>(async (_entry, title) => ({
      ...entry,
      title,
    }));
    renderWorkspace(
      idleAgentSessionPort({
        list: vi.fn<AgentSessionPort['list']>(async (agent) => (agent === 'codex' ? [entry] : [])),
        rename,
      }),
    );
    await agentGateLifted();

    // Opening the row restores the conversation, which is what binds the
    // pane's session to the record the header will rename.
    await userEvent.click(await screen.findByRole('button', { name: 'Original title' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Original title, Codex' }));
    const field = screen.getByRole('textbox', { name: 'Rename Original title' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Edited title{Enter}');

    expect(await screen.findByRole('button', { name: 'Edited title, Codex' })).not.toBeNull();
    expect(rename).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', id: 'identified-chat', scope: RESEARCH_SCOPE }),
      'Edited title',
      expect.any(AbortSignal),
    );
    // The Chats panel reads the same name without a refetch.
    expect(screen.getByRole('button', { name: 'Edited title' })).not.toBeNull();
  });

  it('hands the old name back and says why when the record refuses the rename', async () => {
    const entry = {
      agent: 'codex' as const,
      hasContent: true,
      id: 'refusing-chat',
      lastModified: Date.now(),
      scope: RESEARCH_SCOPE,
      title: 'Original title',
    };
    renderWorkspace(
      idleAgentSessionPort({
        list: vi.fn<AgentSessionPort['list']>(async (agent) => (agent === 'codex' ? [entry] : [])),
        rename: vi.fn<AgentSessionPort['rename']>(async () => {
          throw new Error('offline');
        }),
      }),
    );
    await agentGateLifted();

    await userEvent.click(await screen.findByRole('button', { name: 'Original title' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Original title, Codex' }));
    const field = screen.getByRole('textbox', { name: 'Rename Original title' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Edited title{Enter}');

    expect(await screen.findByRole('alert')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Original title, Codex' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Edited title, Codex' })).toBeNull();
  });
});
