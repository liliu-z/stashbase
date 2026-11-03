/** The conversation list beside the canvas: which saved chats belong to this
 *  workspace, how one is restored, and how a row is renamed in place or
 *  deleted. */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vite-plus/test';

import { AgentHistoryError, type AgentSessionPort } from '@/features/agent/application/ports';
import { registerWorkspaceCleanup, renderWorkspace } from '@/features/agent/ui/workspace.harness';
import {
  agentDefinition,
  BUILT_IN_AGENT,
  CODEX_AGENT,
  idleAgentSessionPort,
} from '@/test/fakes/agent';

registerWorkspaceCleanup();

describe('AgentChats', () => {
  it('opens installation settings without losing cached or other-agent chats, then rechecks the missing runtime', async () => {
    let installed = true;
    let claudeReadable = true;
    const list = vi.fn<AgentSessionPort['list']>(async (agent, scope) => {
      if (agent === 'codex' && !installed)
        throw new AgentHistoryError('installation-required', 'Codex is not installed.');
      if (agent === 'claude' && !claudeReadable)
        throw new AgentHistoryError('unavailable', 'History read failed.');
      return agent === 'codex' || agent === 'claude'
        ? [
            {
              agent,
              hasContent: true,
              id: `${agent}-chat`,
              lastModified: 20,
              scope,
              title: `${agent} saved work`,
            },
          ]
        : [];
    });
    const { onOpenAgentSettings, view } = renderWorkspace(idleAgentSessionPort({ list }));
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'codex saved work' });
    installed = false;
    claudeReadable = false;
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ['agent', 'history'] });
    });
    await screen.findByText('Install Codex to access saved chats.');
    expect(screen.getByRole('button', { name: 'codex saved work' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'claude saved work' })).not.toBeNull();
    expect(screen.queryByText('Chats unavailable for Codex.')).toBeNull();
    expect(screen.getByText('Chats unavailable for Claude.')).not.toBeNull();
    claudeReadable = true;
    list.mockClear();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('Chats unavailable for Claude.')).toBeNull());
    expect(list.mock.calls.map(([agent]) => agent)).toEqual(['claude']);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open Agents settings' }));
    expect(onOpenAgentSettings).toHaveBeenCalledOnce();
    installed = true;
    list.mockClear();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(screen.queryByText('Install Codex to access saved chats.')).toBeNull(),
    );
    expect(list.mock.calls.map(([agent]) => agent)).toEqual(['codex']);
  });

  it('restores a scoped transcript before resuming its native session', async () => {
    const replay = vi.fn<AgentSessionPort['replay']>(async () => ({
      effort: 'high',
      transcript: [{ id: 'reply-1', kind: 'assistant', text: 'Persisted answer' }],
    }));
    const list = vi.fn<AgentSessionPort['list']>(async (agent) =>
      agent === 'codex'
        ? [
            {
              agent: 'codex',
              hasContent: true,
              id: 'native-47',
              lastModified: 1_800_000_000_000,
              scope: { kind: 'folder', path: '/Library/Research' },
              title: 'Planning notes',
            },
          ]
        : [],
    );
    const port = idleAgentSessionPort({ list, replay });
    renderWorkspace(port);
    await screen.findByText('What’s on your mind?');

    await userEvent.click(await screen.findByRole('button', { name: 'Planning notes' }));

    expect(await screen.findByText('Persisted answer')).not.toBeNull();
    expect(replay).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        id: 'native-47',
        scope: { kind: 'folder', path: '/Library/Research' },
      }),
      expect.any(AbortSignal),
    );
    await waitFor(() =>
      expect(port.connect).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agent: 'codex',
          resume: 'native-47',
          scope: { kind: 'folder', path: '/Library/Research' },
        }),
        expect.anything(),
      ),
    );
  });

  it('shows only conversations belonging to the selected workspace', async () => {
    renderWorkspace(
      idleAgentSessionPort({
        list: vi.fn<AgentSessionPort['list']>(async (agent) =>
          agent === 'codex'
            ? [
                {
                  agent: 'codex',
                  hasContent: true,
                  id: 'research-chat',
                  lastModified: 20,
                  scope: { kind: 'folder', path: '/Library/Research' },
                  title: 'Research thread',
                },
                {
                  agent: 'codex',
                  hasContent: true,
                  id: 'plans-chat',
                  lastModified: 30,
                  scope: { kind: 'folder', path: '/Library/Plans' },
                  title: 'Plans thread',
                },
              ]
            : [],
        ),
      }),
    );

    expect(await screen.findByRole('button', { name: 'Research thread' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Plans thread' })).toBeNull();
    expect(screen.getByLabelText('Chat history in Research')).not.toBeNull();
  });

  it('filters behind the section name and leaves no query standing when closed', async () => {
    const user = userEvent.setup();
    renderWorkspace(
      idleAgentSessionPort({
        list: vi.fn<AgentSessionPort['list']>(async (agent) =>
          agent === 'codex'
            ? [
                {
                  agent: 'codex',
                  hasContent: true,
                  id: 'research-chat',
                  lastModified: 30,
                  scope: { kind: 'folder', path: '/Library/Research' },
                  title: 'Research thread',
                },
                {
                  agent: 'codex',
                  hasContent: true,
                  id: 'budget-chat',
                  lastModified: 20,
                  scope: { kind: 'folder', path: '/Library/Research' },
                  title: 'Budget thread',
                },
              ]
            : [],
        ),
      }),
    );

    await screen.findByRole('button', { name: 'Research thread' });
    await user.click(screen.getByRole('button', { name: 'Search chats' }));

    // The field takes the name's place rather than adding a row.
    const field = screen.getByRole('textbox', { name: 'Search chat titles' });
    expect(field.matches(':focus')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Chats' })).toBeNull();

    await user.type(field, 'budget');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Research thread' })).toBeNull(),
    );
    expect(screen.getByRole('button', { name: 'Budget thread' })).not.toBeNull();

    // Closing must not leave the list filtered behind a name that cannot say so.
    await user.click(screen.getByRole('button', { name: 'Close search' }));
    expect(await screen.findByRole('button', { name: 'Research thread' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Chats' })).not.toBeNull();
  });

  it('keeps native history visible when its Agent runtime is unavailable', async () => {
    const unavailableCodex = agentDefinition({ ...CODEX_AGENT, ready: false });
    renderWorkspace(
      idleAgentSessionPort({
        list: vi.fn<AgentSessionPort['list']>(async (agent, scope) =>
          agent === 'codex'
            ? [
                {
                  agent,
                  hasContent: true,
                  id: 'unavailable-runtime-chat',
                  lastModified: Date.now(),
                  scope,
                  title: 'Retained Codex work',
                },
              ]
            : [],
        ),
      }),
      [BUILT_IN_AGENT, unavailableCodex],
    );

    expect(await screen.findByRole('button', { name: 'Retained Codex work' })).not.toBeNull();
  });

  it('renames inline and keeps only Delete in the conversation menu', async () => {
    const entry = {
      agent: 'codex' as const,
      hasContent: true,
      id: 'editable-chat',
      lastModified: Date.now(),
      scope: { kind: 'folder' as const, path: '/Library/Research' },
      title: 'Original title',
    };
    const rename = vi.fn<AgentSessionPort['rename']>(async (_entry, title) => ({
      ...entry,
      title,
    }));
    const remove = vi.fn<AgentSessionPort['remove']>(async () => undefined);
    renderWorkspace(
      idleAgentSessionPort({
        list: vi.fn<AgentSessionPort['list']>(async (agent) => (agent === 'codex' ? [entry] : [])),
        remove,
        rename,
      }),
    );

    const original = await screen.findByRole('button', { name: 'Original title' });
    // WeightedLabel renders a hidden width-reserving twin of the visible label and neither copy
    // carries a distinguishing role/attribute, so only the DOM shape tells them apart.
    const labelSpans = original.querySelectorAll('span:not([aria-hidden="true"])'); // dom-contract: WeightedLabel's dual-span layout has no accessible hook
    const visibleTitle = Array.from(labelSpans).find(
      (span) => span.textContent === 'Original title' && span.children.length === 0,
    );
    if (!visibleTitle) throw new Error('The conversation row rendered no visible title.');
    const ownerDocument = original.ownerDocument;
    const caretPositionDescriptor = Object.getOwnPropertyDescriptor(
      ownerDocument,
      'caretPositionFromPoint',
    );
    Object.defineProperty(ownerDocument, 'caretPositionFromPoint', {
      configurable: true,
      value: vi.fn(() => ({ offset: 5, offsetNode: visibleTitle?.firstChild })),
    });
    let title: HTMLInputElement;
    try {
      await userEvent.dblClick(visibleTitle);
      title = screen.getByRole('textbox', { name: 'Rename Original title' });
      expect(title.selectionStart).toBe(5);
    } finally {
      if (caretPositionDescriptor) {
        Object.defineProperty(ownerDocument, 'caretPositionFromPoint', caretPositionDescriptor);
      } else {
        Reflect.deleteProperty(ownerDocument, 'caretPositionFromPoint');
      }
    }
    // The editor takes the row's place rather than opening beside it.
    expect(title.closest('[data-conversation-inline-editor]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Original title' })).toBeNull();
    expect(title.style.fontVariationSettings).not.toBe('');
    await userEvent.clear(title);
    await userEvent.type(title, 'Edited title{Enter}');

    expect(await screen.findByRole('button', { name: 'Edited title' })).not.toBeNull();
    expect(rename).toHaveBeenCalledWith(entry, 'Edited title', expect.any(AbortSignal));

    await userEvent.click(screen.getByRole('button', { name: 'Actions for Edited title' }));
    expect(screen.queryByText('Rename or delete')).toBeNull();
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(screen.getByRole('heading', { name: 'Delete chat?' })).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(remove).toHaveBeenCalledOnce());
  });

  it('shows one collapsible recency tree and omits conversations without content', async () => {
    // Group labels are relative to now, so the clock is pinned and the third
    // group's expected label is computed with the same formatter the tree
    // uses, rather than a date spelled the way one locale happens to.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 8, 9, 12));
    const today = new Date(2026, 8, 9, 12);
    const yesterday = new Date(2026, 8, 8, 12);
    const earlier = new Date(2026, 8, 1, 12);

    renderWorkspace(
      idleAgentSessionPort({
        list: vi.fn<AgentSessionPort['list']>(async (agent) => {
          if (agent === 'stashbase') {
            return [
              {
                agent: 'stashbase',
                hasContent: false,
                id: 'empty-chat',
                lastModified: today.getTime() + 1_000,
                scope: { kind: 'folder', path: '/Library/Research' },
                title: 'New Chat',
              },
            ];
          }
          if (agent !== 'codex') return [];
          return [
            {
              agent: 'codex',
              hasContent: true,
              id: 'today-newer',
              lastModified: today.getTime(),
              scope: { kind: 'folder', path: '/Library/Research' },
              title: 'Today newer',
            },
            {
              agent: 'codex',
              hasContent: true,
              id: 'today-older',
              lastModified: today.getTime() - 1_000,
              scope: { kind: 'folder', path: '/Library/Research' },
              title: 'Today older',
            },
            {
              agent: 'codex',
              hasContent: true,
              id: 'yesterday-chat',
              lastModified: yesterday.getTime(),
              scope: { kind: 'folder', path: '/Library/Research' },
              title: 'Yesterday chat',
            },
            {
              agent: 'codex',
              hasContent: true,
              id: 'earlier-chat',
              lastModified: earlier.getTime(),
              scope: { kind: 'folder', path: '/Library/Research' },
              title: 'Earlier chat',
            },
          ];
        }),
      }),
    );

    await screen.findByRole('button', { name: 'Today newer' });
    // The history is named before its day groups, and its name carries the
    // search: the field is behind that glyph, not standing above the list.
    expect(screen.getByText('Chats')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Search chats' })).not.toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Search chat titles' })).toBeNull();
    expect(screen.queryByText('Open', { exact: true })).toBeNull();
    expect(screen.queryByText('History', { exact: true })).toBeNull();
    expect(screen.queryByRole('button', { name: /^New Chat$/u })).toBeNull();

    const tree = screen.getByLabelText('Chat history in Research');
    // The group headers are enumerated by the app-published `data-tree-branch` attribute in DOM
    // order; no role/label query returns them in sequence without also matching chat rows.
    const branches = tree.querySelectorAll('[data-tree-branch]'); // dom-contract: see comment above
    const groupLabels = Array.from(branches).map((item) => item.textContent);
    // The dates above are fixed and the suite pins the locale, so the older
    // group's heading is a literal rather than the formatter's own answer.
    expect(groupLabels).toEqual(['Today', 'Yesterday', 'September 1']);

    // The chat rows are enumerated by the app-published `data-conversation` attribute; WeightedLabel
    // renders each title twice (one aria-hidden), so a textContent/accessible-name read would duplicate it.
    const conversationRows = tree.querySelectorAll('[data-conversation]'); // dom-contract: see comment above
    const chatLabels = Array.from(conversationRows).map((item) => item.getAttribute('title'));
    expect(chatLabels).toEqual(['Today newer', 'Today older', 'Yesterday chat', 'Earlier chat']);

    // A folded branch rolls up rather than vanishing, so its rows leave the
    // tree when the close lands rather than on the click.
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Today newer' })).toBeNull());
  });
});
