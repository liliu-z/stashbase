import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vite-plus/test';

import { agentGateLifted, agentSessionPort, CODEX_AGENT } from '@/test/fakes/agent';

import { registerWorkspaceCleanup, renderWorkspace } from './workspace.harness';

registerWorkspaceCleanup();

describe('Agent workspace recovery', () => {
  it.each(['error-then-exit', 'terminal-exit'] as const)(
    'keeps sign-in recovery for a startup %s and never loses the held draft',
    async (ending) => {
      const { port, listeners, sent } = agentSessionPort();
      const listAgents = vi.fn(async () => ({ agents: [CODEX_AGENT] }));
      const { runtime, onOpenAgentSettings } = renderWorkspace(
        port,
        [CODEX_AGENT],
        undefined,
        undefined,
        { listAgents },
      );
      await agentGateLifted();
      await act(async () => {
        await runtime.chooseAgent('codex');
        await runtime.activeSession().sendPrompt('Keep my first message');
      });
      const reads = listAgents.mock.calls.length;
      act(() => {
        if (ending === 'error-then-exit')
          listeners[0]?.onEvent({
            kind: 'failed',
            failure: 'auth-expired',
            message: 'Not logged in',
          });
        listeners[0]?.onEvent({
          kind: 'exited',
          message: ending === 'terminal-exit' ? 'Not logged in' : null,
          ...(ending === 'terminal-exit' ? { failure: 'auth-expired' as const } : {}),
        });
        listeners[0]?.onClose();
      });
      await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
      expect(onOpenAgentSettings).toHaveBeenCalledOnce();
      await waitFor(() => expect(listAgents.mock.calls.length).toBeGreaterThan(reads));
      expect(runtime.activeSession().store.getState().draft).toBe('Keep my first message');
      expect(sent.filter((command) => command.kind === 'prompt')).toHaveLength(0);
      await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
      await waitFor(() => expect(listeners).toHaveLength(2));
      act(() => listeners[1]?.onEvent({ kind: 'ready' }));
      expect(sent.filter((command) => command.kind === 'prompt')).toHaveLength(0);
      await userEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() =>
        expect(sent.filter((command) => command.kind === 'prompt')).toHaveLength(1),
      );
    },
  );

  it.each([false, true])(
    'updates a runtime refused during startup and handles a sign-in prerequisite (%s) without sending the held draft',
    async (needsSignIn) => {
      const { port, listeners, sent } = agentSessionPort();
      let entry = { ...CODEX_AGENT, updatable: true, ready: !needsSignIn, needsSignIn };
      const prepareAgent = vi.fn(async () => ({ agents: [entry] }));
      const listAgents = vi.fn(async () => ({ agents: [entry] }));
      const { runtime, onOpenAgentSettings } = renderWorkspace(
        port,
        [{ ...CODEX_AGENT, updatable: true }],
        undefined,
        undefined,
        { prepareAgent, listAgents },
      );
      await agentGateLifted();
      await act(async () => {
        await runtime.chooseAgent('codex');
        await runtime.activeSession().sendPrompt('Keep my first message');
        listeners[0]?.onEvent({
          kind: 'exited',
          failure: 'runtime-outdated',
          message: 'Run codex update',
        });
        listeners[0]?.onClose();
      });
      await userEvent.click(await screen.findByRole('button', { name: 'Update Codex' }));
      if (needsSignIn) {
        await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
        entry = { ...entry, ready: true, needsSignIn: false };
        await userEvent.click(screen.getByRole('button', { name: 'Continue after sign-in' }));
      }
      await waitFor(() => expect(listeners).toHaveLength(2));
      expect(onOpenAgentSettings).toHaveBeenCalledTimes(needsSignIn ? 1 : 0);
      expect(prepareAgent).toHaveBeenCalledOnce();
      act(() => listeners[1]?.onEvent({ kind: 'ready' }));
      expect(prepareAgent).toHaveBeenCalledWith('codex', 'update', expect.anything());
      expect(runtime.activeSession().store.getState().draft).toBe('Keep my first message');
      expect(sent.filter((command) => command.kind === 'prompt')).toHaveLength(0);
    },
  );

  it.each(['startup', 'turn'] as const)(
    'opens application updates for a Default Agent %s refusal',
    async (phase) => {
      const { port, listeners, sent } = agentSessionPort();
      const { runtime, onOpenAppSettings, onOpenAgentSettings } = renderWorkspace(port);
      await agentGateLifted();
      const session = runtime.activeSession();
      await act(async () => {
        session.start();
        if (phase === 'turn') {
          listeners[0]?.onEvent({ kind: 'ready' });
          await session.sendPrompt('My request');
          listeners[0]?.onEvent({
            kind: 'failed',
            failure: 'app-outdated',
            message: 'StashBase 2.18.0 or newer is required.',
          });
          listeners[0]?.onEvent({ kind: 'turn-ended', isError: true });
        } else {
          listeners[0]?.onEvent({
            kind: 'exited',
            failure: 'app-outdated',
            message: 'StashBase 2.18.0 or newer is required.',
          });
          listeners[0]?.onClose();
        }
        session.setDraft('Keep my draft');
      });
      await userEvent.click(await screen.findByRole('button', { name: 'Update StashBase' }));
      expect(onOpenAppSettings).toHaveBeenCalledOnce();
      expect(onOpenAgentSettings).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(session.store.getState().draft).toBe('Keep my draft');
      expect(sent.filter((command) => command.kind === 'prompt')).toHaveLength(
        phase === 'turn' ? 1 : 0,
      );
    },
  );

  it('stops asking for sign-in once Settings has signed the refused agent in', async () => {
    const { port, listeners, sent } = agentSessionPort();
    let entry = { ...CODEX_AGENT };
    const listAgents = vi.fn(async () => ({ agents: [entry] }));
    const { runtime, setSettingsOpen } = renderWorkspace(
      port,
      [CODEX_AGENT],
      undefined,
      undefined,
      { listAgents },
    );
    await agentGateLifted();
    const session = runtime.activeSession();
    await act(async () => {
      await runtime.chooseAgent('codex');
      session.start();
      listeners[0]?.onEvent({ kind: 'ready' });
      await session.sendPrompt('Refused request');
      // The host withdraws readiness before it reports the refusal.
      entry = { ...CODEX_AGENT, ready: false, needsSignIn: true };
      listeners[0]?.onEvent({ kind: 'failed', failure: 'auth-expired', message: 'Not logged in' });
      listeners[0]?.onEvent({ kind: 'turn-ended', isError: true });
    });
    const card = (await screen.findByRole('heading', { name: 'Sign in to continue' })).closest(
      'section',
    );
    if (!card) throw new Error('The refusal has no card.');
    await waitFor(() =>
      expect(within(card).getByRole('button', { name: 'Sign in' })).not.toBeNull(),
    );
    // Closing Settings without signing in reads readiness again, and the
    // refusal it still reports keeps the card asking.
    setSettingsOpen(true);
    const reads = listAgents.mock.calls.length;
    setSettingsOpen(false);
    await waitFor(() => expect(listAgents.mock.calls.length).toBeGreaterThan(reads));
    expect(within(card).getByRole('button', { name: 'Sign in' })).not.toBeNull();
    setSettingsOpen(true);
    entry = { ...CODEX_AGENT };
    setSettingsOpen(false);
    expect(await within(card).findByText(/^You are signed in again\./u)).not.toBeNull();
    expect(within(card).queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(sent.filter((command) => command.kind === 'prompt')).toHaveLength(1);
  });

  it('retains an unknown outcome and paused queue when a fatal failure requires sign-in', async () => {
    const { port, listeners, sent } = agentSessionPort();
    const { runtime, onOpenAgentSettings } = renderWorkspace(port);
    await agentGateLifted();
    const session = runtime.activeSession();
    await act(async () => {
      session.start();
      listeners[0]?.onEvent({ kind: 'ready' });
      await session.sendPrompt('Write a file');
      session.setDraft('Unsent draft');
      session.setQueue([{ id: 'later', text: 'Queued work' }]);
      listeners[0]?.onEvent({
        kind: 'exited',
        failure: 'auth-expired',
        message: 'Unauthorized (401)',
      });
      listeners[0]?.onClose();
    });
    expect(await screen.findByText('Outcome unknown')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(onOpenAgentSettings).toHaveBeenCalledOnce();
    expect(session.store.getState()).toMatchObject({
      delivery: 'unknown',
      draft: 'Unsent draft',
      queuePaused: true,
      queuedPrompts: [{ text: 'Queued work' }],
    });
    expect(sent.filter((command) => command.kind === 'prompt')).toHaveLength(1);
  });

  it('reconnects without resending while retaining history, draft, and paused queue', async () => {
    const { port, listeners, sent } = agentSessionPort();
    const { runtime } = renderWorkspace(port);
    await agentGateLifted();
    const session = runtime.activeSession();
    await act(async () => {
      session.start();
      listeners[0]?.onEvent({ kind: 'identified', id: 'model-refresh-chat' });
      listeners[0]?.onEvent({ kind: 'ready' });
      await session.sendPrompt('Keep this refused request');
      session.setDraft('An unsent follow-up');
      session.setQueue([{ id: 'pending', text: 'Queued work' }]);
      listeners[0]?.onEvent({
        kind: 'failed',
        message: 'Reconnect to refresh the available models.',
      });
      listeners[0]?.onEvent({ kind: 'turn-ended', isError: true });
      listeners[0]?.onEvent({
        kind: 'exited',
        message: 'Reconnect to refresh the available models.',
      });
      listeners[0]?.onClose();
    });
    expect(session.store.getState().delivery).toBe('failed');
    expect(
      session.store
        .getState()
        .transcript.some(
          (block) => block.kind === 'user' && block.text === 'Keep this refused request',
        ),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Reconnect' })).not.toBeNull();
    expect(port.connect).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(port.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ resume: 'model-refresh-chat' }),
      expect.anything(),
    );
    await act(async () => {
      listeners[1]?.onEvent({
        kind: 'models',
        models: [{ id: 'refreshed', label: 'Updated model' }],
        activeModel: 'refreshed',
        fallback: null,
      });
      listeners[1]?.onEvent({ kind: 'ready' });
    });
    expect(session.store.getState().models).toEqual([{ id: 'refreshed', label: 'Updated model' }]);
    expect(session.store.getState().draft).toBe('An unsent follow-up');
    expect(session.store.getState().queuedPrompts.map((item) => item.text)).toEqual([
      'Queued work',
    ]);
    expect(session.store.getState().queuePaused).toBe(true);
    expect(sent.filter((command) => command.kind === 'prompt')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
  });
});
