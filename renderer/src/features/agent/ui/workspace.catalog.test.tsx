/** Startup readiness must reach a mounted composer without another user action. */
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vite-plus/test';

import type { Agent } from '@/features/agent/domain/agent-catalog';
import {
  agentSessionPort,
  CLAUDE_AGENT,
  CODEX_AGENT,
  idleAgentSessionPort,
} from '@/test/fakes/agent';

import { registerWorkspaceCleanup, renderWorkspace } from './workspace.harness';

registerWorkspaceCleanup();

const readyClaude: Agent = {
  ...CLAUDE_AGENT,
  models: [
    {
      id: 'opus',
      label: 'Opus',
      isDefault: true,
      supportedEfforts: ['low', 'high'],
      defaultEffort: 'high',
    },
  ],
};

it('lets a draft Claude chat switch models after a catalog fallback notice', async () => {
  const { listeners, port, sent } = agentSessionPort();
  const { runtime } = renderWorkspace(port, [readyClaude]);
  const user = userEvent.setup();
  await act(async () => {
    await runtime.chooseAgent('claude');
  });
  await user.click(await screen.findByRole('button', { name: 'Model and thinking: Opus, High' }));

  const fallback = 'The requested model is unavailable. Claude is using its default.';
  act(() => {
    listeners[0]?.onEvent({
      activeModel: 'opus',
      fallback,
      kind: 'models',
      models: [
        ...readyClaude.models,
        { id: 'sonnet', label: 'Sonnet', supportedEfforts: ['high'] },
      ],
    });
    listeners[0]?.onEvent({ kind: 'ready' });
  });
  expect(screen.getByText(fallback)).not.toBeNull();
  expect(screen.queryByText(/Kept for this chat/u)).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Model: Opus' }));
  await user.click(screen.getByRole('menuitemradio', { name: 'Sonnet' }));
  expect(sent).toContainEqual({ kind: 'select-model', model: 'sonnet' });
});

it('restores model, thinking and permissions after startup without losing the draft or sending it', async () => {
  vi.useFakeTimers();
  let claude: Agent = { ...CLAUDE_AGENT, ready: false, preparation: { step: 'check' } };
  const listAgents = vi.fn(async () => ({ agents: [CODEX_AGENT, claude] }));
  const prepareAgent = vi.fn();
  const port = idleAgentSessionPort();
  const { runtime } = renderWorkspace(port, [], undefined, undefined, { listAgents, prepareAgent });
  await act(async () => {
    await runtime.chooseAgent('claude');
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.getByRole('button', { name: 'Provider: Claude' })).not.toBeNull();
  const session = runtime.activeSession();
  act(() => {
    session.setDraft('Keep this unfinished introduction.');
    session.setAccessMode('plan');
    session.seedModels(readyClaude.models);
    session.setModel('opus');
    session.setEffort('low');
  });
  expect(screen.queryByRole('button', { name: /^Model and thinking:/u })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Permission mode:/u })).toBeNull();

  const reads = listAgents.mock.calls.length;
  claude = readyClaude;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });

  expect(listAgents.mock.calls.length).toBeGreaterThan(reads);
  expect(screen.getByRole('button', { name: 'Model and thinking: Opus, Low' })).not.toBeNull();
  expect(screen.getByRole('button', { name: /^Permission mode: Plan/u })).not.toBeNull();
  expect(runtime.activeSession()).toBe(session);
  expect(session.store.getState()).toMatchObject({
    agent: 'claude',
    draft: 'Keep this unfinished introduction.',
    model: 'opus',
    effort: 'low',
    accessMode: 'plan',
  });
  expect(port.connect).not.toHaveBeenCalled();
  expect(prepareAgent).not.toHaveBeenCalled();
});

it('keeps a newer provider choice when another runtime finishes checking', async () => {
  vi.useFakeTimers();
  let claude: Agent = { ...CLAUDE_AGENT, ready: false, preparation: { step: 'check' } };
  const listAgents = vi.fn(async () => ({ agents: [CODEX_AGENT, claude] }));
  const { runtime } = renderWorkspace(idleAgentSessionPort(), [], undefined, undefined, {
    listAgents,
  });
  await act(async () => {
    await runtime.chooseAgent('claude');
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.getByRole('button', { name: 'Provider: Claude' })).not.toBeNull();
  await act(async () => {
    await runtime.chooseAgent('codex');
  });
  const session = runtime.activeSession();
  act(() => session.setDraft('Continue with Codex.'));

  const reads = listAgents.mock.calls.length;
  claude = readyClaude;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });

  expect(listAgents.mock.calls.length).toBeGreaterThan(reads);
  expect(screen.getByRole('button', { name: 'Provider: Codex' })).not.toBeNull();
  expect(runtime.activeSession()).toBe(session);
  expect(session.store.getState()).toMatchObject({ agent: 'codex', draft: 'Continue with Codex.' });
});
