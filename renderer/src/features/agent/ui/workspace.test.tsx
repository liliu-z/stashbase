/** The workspace canvas itself: what it offers with no Agent to talk to, what
 *  the empty canvas keeps quiet, where provider, model and thinking are
 *  chosen, and the first composer turn through its permission decision. The
 *  header that names the Chat is a suite of its own. */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vite-plus/test';

import type { Agent } from '@/features/agent/domain/agent-catalog';
import { draftOf, expectFocused, typeInto } from '@/test/dom';
import {
  agentDefinition,
  agentGateLifted,
  agentSessionPort,
  BUILT_IN_AGENT,
  CODEX_AGENT,
  CLAUDE_AGENT,
  idleAgentSessionPort,
} from '@/test/fakes/agent';

import { registerWorkspaceCleanup, renderWorkspace } from './workspace.harness';

registerWorkspaceCleanup();

describe('Agent workspace', () => {
  it('does not offer updates for an externally controlled executable in the composer or failed turn', async () => {
    const { port, listeners } = agentSessionPort();
    const claude = {
      ...CLAUDE_AGENT,
      updatable: false,
      upgrade: { model: 'New model', note: 'New model needs a newer Claude' },
    };
    const { runtime } = renderWorkspace(port, [claude]);
    await agentGateLifted();
    await userEvent.click(screen.getByRole('button', { name: 'Provider: Default' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Claude' }));
    expect(screen.queryByRole('button', { name: 'Update Claude' })).toBeNull();
    const session = runtime.activeSession();
    await act(async () => {
      session.start();
      listeners[0]?.onEvent({ kind: 'ready' });
      await session.sendPrompt('Use the new model');
      listeners[0]?.onEvent({
        kind: 'failed',
        failure: 'runtime-outdated',
        message: 'Claude is too old for this model.',
      });
    });
    expect(screen.queryByRole('button', { name: 'Update Claude' })).toBeNull();
    expect(screen.getByText(/This installation cannot be updated here/)).not.toBeNull();
  });
  it('shows the native exit cause when an interrupted turn has an unknown outcome', async () => {
    const { port, listeners, sent } = agentSessionPort();
    const { runtime } = renderWorkspace(port);
    await agentGateLifted();
    const session = runtime.activeSession();
    await act(async () => {
      session.start();
      listeners[0]?.onEvent({ kind: 'identified', id: 'interrupted-chat' });
      listeners[0]?.onEvent({ kind: 'ready' });
      await session.sendPrompt('Revise the introduction');
      listeners[0]?.onEvent({ kind: 'text', delta: 'Partial reply' });
      session.setDraft('My next thought');
      listeners[0]?.onEvent({
        kind: 'exited',
        message: 'Claude stream failed: connection reset by peer.',
      });
    });
    expect(screen.getByText('Outcome unknown')).not.toBeNull();
    expect(screen.getByText('Claude stream failed: connection reset by peer.')).not.toBeNull();
    expect(screen.getByText('Partial reply')).not.toBeNull();
    expect(session.store.getState().draft).toBe('My next thought');
    expect(screen.getAllByRole('button', { name: /Reconnect/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect and review' }));
    await act(async () => listeners[1]?.onEvent({ kind: 'ready' }));
    expect(screen.getByText('Outcome unknown')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'I’ve reviewed it — continue' })).not.toBeNull();
    expect(sent.filter((command) => command.kind === 'prompt')).toHaveLength(1);
  });

  it('holds the setup offer back until the catalog has answered', async () => {
    let answer!: (catalog: { agents: Agent[] }) => void;
    const answered = new Promise<{ agents: Agent[] }>((resolve) => {
      answer = resolve;
    });
    renderWorkspace(idleAgentSessionPort(), [], undefined, undefined, {
      listAgents: vi.fn(() => answered),
    });

    expect(await screen.findByText('Checking runtimes…')).not.toBeNull();
    // An unanswered catalog is not the same as nothing being ready: offering
    // setup here shows it for a moment and then withdraws it.
    expect(screen.queryByText('No Agent is ready yet.')).toBeNull();
    await act(async () => {
      answer({ agents: [BUILT_IN_AGENT] });
      await answered;
    });
    await agentGateLifted();
    expect(screen.queryByText('No Agent is ready yet.')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Provider: Default' })).not.toBeNull();
  });

  it('cycles the blank composer through the three requests, and Tab takes the one showing', async () => {
    const port = idleAgentSessionPort();
    const { runtime } = renderWorkspace(port);
    await screen.findByText('What’s on your mind?');
    await agentGateLifted();

    // Taking a suggestion fills the draft without starting a turn.
    expect(screen.getByText('Brainstorm article ideas from this project')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Build/u })).toBeNull();

    const field = screen.getByRole('textbox', { name: 'Message' });
    await userEvent.click(field);
    await userEvent.keyboard('{Tab}');

    expect(draftOf(runtime)).toBe('Brainstorm article ideas from this project');
    // Filled, not sent: the visible request stays the reader's to edit, so
    // what the Agent receives is still exactly what the transcript records.
    expect(port.connect).not.toHaveBeenCalled();
    expectFocused(field);
  });

  it('keeps the empty canvas quiet and puts provider choice in the composer', async () => {
    const port = idleAgentSessionPort();
    const { runtime } = renderWorkspace(port);

    expect(port.connect).not.toHaveBeenCalled();
    expect(await screen.findByText('What’s on your mind?')).not.toBeNull();
    await agentGateLifted();
    expect(screen.queryByText('Research workspace')).toBeNull();
    const composer = screen.getByRole('textbox', { name: 'Message' });
    await userEvent.type(composer, 'Summarize lessons/');
    expect(runtime.activeSession().store.getState().draft).toBe('Summarize lessons/');
    expectFocused(composer);
    expect(port.connect).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Chat scope: Research')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close conversation' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Provider: Default' })).toHaveLength(1);

    const newChat = screen.getByRole('button', { name: 'Start new chat' });
    await userEvent.click(newChat);
    expect(port.connect).not.toHaveBeenCalled();
    expect(runtime.activeSession().store.getState().agent).toBe('stashbase');

    await userEvent.click(screen.getByRole('button', { name: 'Provider: Default' }));
    const codexOption = await screen.findByRole('menuitemradio', { name: 'Codex' });
    const claudeOption = screen.getByRole('menuitemradio', { name: 'Claude' });
    // The provider marks are aria-hidden, injected third-party SVG markup (`@lobehub/icons-static-svg`);
    // their internal shape is the contract here.
    const codexMark = codexOption.querySelector('svg[viewBox="-2 -2 28 28"]'); // dom-contract: see comment above
    const claudeMark = claudeOption.querySelector('svg[viewBox="-2 -2 28 28"]'); // dom-contract: see comment above
    expect(codexMark?.getAttribute('fill')).toBe('currentColor'); // dom-contract: see comment above
    expect(codexMark?.querySelectorAll('path')).toHaveLength(1); // dom-contract: see comment above
    expect(codexMark?.querySelector('linearGradient')).toBeNull(); // dom-contract: see comment above
    expect(claudeMark?.querySelector('path[fill="#D97757"]')).not.toBeNull(); // dom-contract: see comment above
    expect(codexOption.querySelector('svg title')).toBeNull(); // dom-contract: see comment above
    expect(claudeOption.querySelector('svg title')).toBeNull(); // dom-contract: see comment above
    await userEvent.click(codexOption);
    expect(screen.getByRole('button', { name: 'Provider: Codex' })).not.toBeNull();
    expect(runtime.activeSession().store.getState().agent).toBe('codex');
    expect(port.connect).not.toHaveBeenCalled();
  });

  it('uses runtime-native model and thinking choices from the composer', async () => {
    const { listeners, port, sent } = agentSessionPort();
    const requests = () => vi.mocked(port.connect).mock.calls.map(([request]) => request);
    renderWorkspace(port);

    await userEvent.click(await screen.findByRole('button', { name: 'Provider: Default' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Codex' }));
    await userEvent.click(screen.getByRole('button', { name: 'Model and thinking: Default' }));
    expect(requests()).toHaveLength(1);

    act(() => {
      listeners[0]?.onEvent({
        activeModel: null,
        fallback: null,
        kind: 'models',
        models: [
          {
            id: 'gpt-codex',
            label: 'Opus (1M context) with extended reasoning',
            supportedEfforts: ['low', 'high'],
          },
        ],
      });
      listeners[0]?.onEvent({ kind: 'ready' });
    });
    // The menu opened on the level; the model list is one layer deeper, and
    // this runtime has named no default, so nothing is marked there yet.
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Model. Default' }));
    const longModelOption = await screen.findByRole('menuitemradio', {
      name: 'Opus (1M context) with extended reasoning',
    });
    await userEvent.click(longModelOption);
    expect(sent).toContainEqual({ kind: 'select-model', model: 'gpt-codex' });
    expect(
      screen.getByRole('button', {
        name: 'Model and thinking: Opus (1M context) with extended reasoning',
      }),
    ).not.toBeNull();

    // The pick closes the menu, which leaves once its exit has played; the
    // level is chosen from the same control, reopened on its first layer.
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull(), { timeout: 2000 });
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Model and thinking: Opus (1M context) with extended reasoning',
      }),
    );
    const highEffortOption = await screen.findByRole('menuitemradio', {
      name: 'High. Deeper reasoning',
    });
    await userEvent.click(highEffortOption);
    expect(requests().at(-1)).toMatchObject({ effort: 'high', model: 'gpt-codex' });
    expect(
      screen.getByRole('button', {
        name: 'Model and thinking: Opus (1M context) with extended reasoning, High',
      }),
    ).not.toBeNull();
  });

  it.each(['success', 'failure'])(
    'updates Codex from the model picker before sending: %s preserves the draft',
    async (outcome) => {
      const { listeners, port, sent } = agentSessionPort();
      const codex = { ...CODEX_AGENT, updatable: true };
      let finishUpdate!: () => void;
      const updating = new Promise<void>((resolve) => {
        finishUpdate = resolve;
      });
      const prepareAgent = vi.fn(async () => {
        await updating;
        return {
          agents: [
            outcome === 'success'
              ? codex
              : {
                  ...codex,
                  ready: false,
                  setupFailure: { stage: 'installation' as const, message: 'Codex update failed' },
                },
          ],
        };
      });
      const { runtime } = renderWorkspace(port, [codex], undefined, undefined, { prepareAgent });
      await userEvent.click(await screen.findByRole('button', { name: 'Provider: Default' }));
      await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Codex' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'Keep this draft');
      await userEvent.click(screen.getByRole('button', { name: 'Model and thinking: Default' }));
      act(() => {
        listeners[0]?.onEvent({
          kind: 'models',
          activeModel: null,
          fallback: null,
          models: [{ id: 'older-model', label: 'Older model', isDefault: true }],
        });
        listeners[0]?.onEvent({ kind: 'ready' });
      });
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Model. Older model' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: /Update Codex/u }));
      await waitFor(() =>
        expect(prepareAgent).toHaveBeenCalledWith('codex', 'update', expect.anything()),
      );
      expect(
        screen.getByRole('menuitem', { name: /Updating Codex/u }).getAttribute('aria-disabled'),
      ).toBe('true');
      expect(sent.filter((command) => command.kind === 'prompt')).toHaveLength(0);
      await userEvent.keyboard('{Escape}');
      expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
      await userEvent.click(
        screen.getByRole('button', { name: 'Model and thinking: Older model' }),
      );
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Model. Older model' }));

      await act(async () => {
        finishUpdate();
      });
      await waitFor(() => expect(listeners).toHaveLength(outcome === 'success' ? 2 : 1));
      // Only a completed update creates a replacement connection.
      act(() => {
        listeners[1]?.onEvent({
          kind: 'models',
          activeModel: null,
          fallback: null,
          models: [{ id: 'new-model', label: 'New model', isDefault: true }],
        });
        listeners[1]?.onEvent({ kind: 'ready' });
      });
      const result = await screen.findByRole(
        outcome === 'success' ? 'menuitemradio' : 'alert',
        outcome === 'success' ? { name: 'New model' } : {},
      );
      expect(result.textContent).toContain(
        outcome === 'success' ? 'New model' : 'Codex update failed',
      );
      expect(screen.queryByRole('menuitemradio', { name: 'Older model' }) === null).toBe(
        outcome === 'success',
      );
      expect(draftOf(runtime)).toBe('Keep this draft');
      expect(sent.filter((command) => command.kind === 'prompt')).toHaveLength(0);
    },
  );

  it('starts the first composer turn and presents an explicit permission decision', async () => {
    const { listeners, port, sent } = agentSessionPort();
    const { runtime } = renderWorkspace(port);
    await screen.findByText('What’s on your mind?');
    await agentGateLifted();
    await userEvent.click(screen.getByRole('button', { name: 'Provider: Default' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Codex' }));

    const composer = screen.getByRole('textbox', { name: 'Message' });
    typeInto(composer, 'Inspect the workspace');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(draftOf(runtime)).toBe('Inspect the workspace');

    act(() => listeners[0]?.onEvent({ kind: 'ready' }));
    expect((await screen.findAllByText('Inspect the workspace'))[0]).not.toBeNull();
    expect(sent).toEqual([
      {
        kind: 'prompt',
        skill: null,
        text: 'Inspect the workspace',
        titleHint: 'Inspect the workspace',
      },
    ]);

    act(() => {
      listeners[0]?.onEvent({ kind: 'turn-started' });
      listeners[0]?.onEvent({
        id: 'permission-1',
        input: { command: 'pnpm test:agent' },
        kind: 'permission-requested',
        name: 'Bash',
        title: null,
        toolUseId: 'tool-1',
      });
    });
    expect(screen.getByRole('heading', { name: 'Run this command?' })).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(sent.at(-1)).toEqual({
      allow: true,
      always: null,
      answers: null,
      id: 'permission-1',
      kind: 'reply-permission',
    });

    expect(
      screen.getByRole('button', { name: /Permission mode: Auto/u }).hasAttribute('disabled'),
    ).toBe(true);
    act(() => listeners[0]?.onEvent({ kind: 'turn-ended', isError: false }));
    await userEvent.click(screen.getByRole('button', { name: /Permission mode: Auto/u }));
    await userEvent.click(
      await screen.findByRole('menuitemradio', {
        name: 'Ask. Asks before every change and command',
      }),
    );
    expect(sent.at(-1)).toEqual({ kind: 'set-access-mode', mode: 'default' });
  });

  it('names the remembered default model and level before any session exists', async () => {
    const codex = agentDefinition({
      ...CODEX_AGENT,
      models: [
        {
          defaultEffort: 'medium',
          id: 'gpt-6-astra',
          isDefault: true,
          label: 'GPT-6-Astra',
          supportedEfforts: ['low', 'medium', 'high'],
        },
        { id: 'gpt-5.5', label: 'GPT-5.5' },
      ],
    });
    const { port } = agentSessionPort();
    const { runtime } = renderWorkspace(port, [codex]);
    await agentGateLifted();
    await act(async () => {
      await runtime.chooseAgent('codex');
    });

    expect(
      await screen.findByRole('button', { name: 'Model and thinking: GPT-6-Astra, Medium' }),
    ).not.toBeNull();
    // Named from the runtime's remembered catalog: no session was started.
    expect(port.connect).not.toHaveBeenCalled();
  });

  it('offers only the modes the runtime honors and settles a session off one it cannot', async () => {
    const readOnlyRuntime = agentDefinition({
      abilities: { ...BUILT_IN_AGENT.abilities, modes: ['default', 'plan'] },
    });
    const { runtime } = renderWorkspace(idleAgentSessionPort(), [readOnlyRuntime]);
    await agentGateLifted();

    // New sessions start in Auto; this runtime cannot keep that promise, so
    // the session moves to Ask before any turn binds it.
    await waitFor(() =>
      expect(runtime.activeSession().store.getState().accessMode).toBe('default'),
    );
    await userEvent.click(screen.getByRole('button', { name: /^Permission mode: Ask\./u }));
    expect(
      (await screen.findAllByRole('menuitemradio')).map((row) => row.getAttribute('aria-label')),
    ).toEqual([
      'Ask. Asks before every change and command',
      'Plan. Reads and explores, changes nothing',
    ]);
  });

  it('takes the latest prompt back into the composer from its edit control', async () => {
    const { listeners, port } = agentSessionPort();
    const { runtime } = renderWorkspace(port);
    await screen.findByText('What’s on your mind?');
    await agentGateLifted();
    await userEvent.click(screen.getByRole('button', { name: 'Provider: Default' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Codex' }));

    typeInto(screen.getByRole('textbox', { name: 'Message' }), 'Inspect the workspace');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    act(() => listeners[0]?.onEvent({ kind: 'ready' }));
    await screen.findAllByText('Inspect the workspace');
    act(() => {
      listeners[0]?.onEvent({ kind: 'turn-started' });
      listeners[0]?.onEvent({ delta: 'A small workspace.', kind: 'text' });
    });
    // Streaming: copy is there, edit is not.
    expect(screen.getByRole('button', { name: 'Copy message' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Reuse message' })).toBeNull();

    act(() => listeners[0]?.onEvent({ isError: false, kind: 'turn-ended' }));
    expect(draftOf(runtime)).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'Reuse message' }));
    expect(draftOf(runtime)).toBe('Inspect the workspace');
    await waitFor(() => expectFocused(screen.getByRole('textbox', { name: 'Message' })));
    // The sent prompt stays in the transcript; the edit is the next turn.
    expect(screen.getAllByText('Inspect the workspace').length).toBeGreaterThanOrEqual(1);
  });
});
