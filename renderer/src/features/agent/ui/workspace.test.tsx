/** The workspace canvas itself: what it offers with no Agent to talk to, what
 *  the empty canvas keeps quiet, where provider, model and thinking are
 *  chosen, and the first composer turn through its permission decision. The
 *  header that names the Chat is a suite of its own. */
import { act, screen, waitFor, within } from '@testing-library/react';
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
  idleAgentSessionPort,
} from '@/test/fakes/agent';

import { registerWorkspaceCleanup, renderWorkspace } from './workspace.harness';

registerWorkspaceCleanup();

describe('Agent workspace', () => {
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
    expect(screen.getByRole('button', { name: 'Reviewed, continue' })).not.toBeNull();
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

    expect(await screen.findByText('Checking agents…')).not.toBeNull();
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
    expect(screen.getByText('Brainstorm ideas from my notes')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Build/u })).toBeNull();

    const field = screen.getByRole('textbox', { name: 'Message' });
    await userEvent.click(field);
    await userEvent.keyboard('{Tab}');

    expect(draftOf(runtime)).toBe('Brainstorm ideas from my notes');
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
    // The panel opened on the level; the model list is one step deeper, and
    // this runtime has named no default, so nothing is marked there yet.
    await userEvent.click(await screen.findByRole('button', { name: 'Model: Default' }));
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

    // The pick closes the menu and the panel, which leave once their exits
    // have played; the level is chosen from the same control, reopened.
    await waitFor(
      () => {
        expect(screen.queryByRole('menu')).toBeNull();
        expect(screen.queryByRole('dialog')).toBeNull();
      },
      { timeout: 2000 },
    );
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Model and thinking: Opus (1M context) with extended reasoning',
      }),
    );
    // No level is chosen and the model declares none, so the slider starts
    // unplaced; one step lands on the second level, High.
    (await screen.findByRole('slider', { name: 'Thinking' })).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(requests().at(-1)).toMatchObject({ effort: 'high', model: 'gpt-codex' });
    expect(
      screen.getByRole('button', {
        name: 'Model and thinking: Opus (1M context) with extended reasoning, High',
      }),
    ).not.toBeNull();
  });

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
    // A cold native session has not reported ready yet. Its startup must
    // not hold back the reader's own message or put anything on the wire.
    expect(within(screen.getByRole('log')).getByText('Inspect the workspace')).not.toBeNull();
    expect(sent).toEqual([]);

    act(() => listeners[0]?.onEvent({ kind: 'ready' }));
    expect(within(screen.getByRole('log')).getAllByText('Inspect the workspace')).toHaveLength(1);
    expect(runtime.activeSession().store.getState().preparingPrompt).toBeNull();
    expect(sent).toEqual([
      {
        kind: 'prompt',
        telemetryTurnId: expect.any(String),
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
        approvalScopes: ['session'],
        title: null,
        toolUseId: 'tool-1',
      });
    });
    expect(screen.getByRole('heading', { name: 'Run this command?' })).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Allow for this session' }));
    expect(sent.at(-1)).toEqual({
      allow: true,
      always: null,
      scope: 'session',
      answers: null,
      id: 'permission-1',
      kind: 'reply-permission',
    });

    act(() =>
      listeners[0]?.onEvent({
        kind: 'permission-requested',
        id: 'permission-2',
        toolUseId: 'tool-2',
        name: 'Computer Use',
        title: 'Allow Computer Use to use "Google Chrome"?',
        input: { app: 'com.google.Chrome' },
        approvalScopes: ['session', 'always'],
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    expect(sent.at(-1)).toEqual({
      kind: 'reply-permission',
      id: 'permission-2',
      allow: true,
      always: null,
      answers: null,
      scope: 'always',
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
