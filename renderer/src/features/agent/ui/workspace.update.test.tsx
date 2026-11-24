/** The runtime update the composer offers: only for an executable StashBase
 *  installed and only once a newer release is known, including one found
 *  after the chat opened, with the installer's progress while it runs and
 *  the draft kept whether the update succeeds or fails. */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vite-plus/test';

import type { Agent } from '@/features/agent/domain/agent-catalog';
import { draftOf } from '@/test/dom';
import {
  agentGateLifted,
  agentSessionPort,
  BUILT_IN_AGENT,
  CLAUDE_AGENT,
  CODEX_AGENT,
} from '@/test/fakes/agent';

import { registerWorkspaceCleanup, renderWorkspace } from './workspace.harness';

registerWorkspaceCleanup();

describe('Agent workspace runtime updates', () => {
  it('does not offer updates for an externally controlled executable in the composer or failed turn', async () => {
    const { port, listeners } = agentSessionPort();
    const claude = {
      ...CLAUDE_AGENT,
      updatable: false,
      upgrade: { model: 'New model', note: 'New model needs a newer Claude' },
    };
    const { runtime } = renderWorkspace(port, [claude]);
    await agentGateLifted();
    await userEvent.click(screen.getByRole('button', { name: 'Provider: StashBase Agent' }));
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

  it('offers no runtime update in the model picker until a newer release is known', async () => {
    const { listeners, port } = agentSessionPort();
    renderWorkspace(port, [{ ...CODEX_AGENT, updatable: true }]);
    await userEvent.click(await screen.findByRole('button', { name: 'Provider: StashBase Agent' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Codex' }));
    await userEvent.click(screen.getByRole('button', { name: 'Model and thinking: Default' }));
    act(() => {
      listeners[0]?.onEvent({
        kind: 'models',
        activeModel: null,
        fallback: null,
        models: [{ id: 'current-model', label: 'Current model', isDefault: true }],
      });
      listeners[0]?.onEvent({ kind: 'ready' });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Model: Current model' }));
    expect(await screen.findByRole('menuitemradio', { name: 'Current model' })).not.toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Update Codex/u })).toBeNull();
  });

  it('offers a release found after the chat opened when the model control opens', async () => {
    const { listeners, port } = agentSessionPort();
    let codex: Agent = { ...CODEX_AGENT, updatable: true };
    const listAgents = vi.fn(async () => ({ agents: [BUILT_IN_AGENT, codex] }));
    renderWorkspace(port, [BUILT_IN_AGENT, codex], undefined, undefined, { listAgents });
    await userEvent.click(await screen.findByRole('button', { name: 'Provider: StashBase Agent' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Codex' }));
    await waitFor(() => expect(listAgents).toHaveBeenCalled());
    // The host's release reading lands after every read the chat has made.
    codex = { ...codex, availableVersion: '0.164.0' };
    await userEvent.click(screen.getByRole('button', { name: 'Model and thinking: Default' }));
    act(() => {
      listeners[0]?.onEvent({
        kind: 'models',
        activeModel: null,
        fallback: null,
        models: [{ id: 'current-model', label: 'Current model', isDefault: true }],
      });
      listeners[0]?.onEvent({ kind: 'ready' });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Model: Current model' }));
    expect(await screen.findByRole('menuitem', { name: /Update Codex/u })).not.toBeNull();
  });

  it("shows the installer's progress under the model picker's update while it runs", async () => {
    const { listeners, port } = agentSessionPort();
    const codex = { ...CODEX_AGENT, updatable: true, availableVersion: '0.164.0' };
    const installing = {
      ...codex,
      ready: false,
      preparation: { step: 'install' as const, note: 'Downloading the official Codex installer…' },
    };
    const prepareAgent = vi.fn(async () => ({ agents: [installing] }));
    renderWorkspace(port, [codex], undefined, undefined, { prepareAgent });
    await userEvent.click(await screen.findByRole('button', { name: 'Provider: StashBase Agent' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Codex' }));
    await userEvent.click(screen.getByRole('button', { name: 'Model and thinking: Default' }));
    act(() => {
      listeners[0]?.onEvent({
        kind: 'models',
        activeModel: null,
        fallback: null,
        models: [{ id: 'current-model', label: 'Current model', isDefault: true }],
      });
      listeners[0]?.onEvent({ kind: 'ready' });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Model: Current model' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Update Codex/u }));
    expect(await screen.findByText('Downloading the official Codex installer…')).not.toBeNull();
  });

  it.each(['success', 'failure'])(
    'updates Codex from the model picker before sending: %s preserves the draft',
    async (outcome) => {
      const { listeners, port, sent } = agentSessionPort();
      const codex = { ...CODEX_AGENT, updatable: true, availableVersion: '0.163.0' };
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
      await userEvent.click(
        await screen.findByRole('button', { name: 'Provider: StashBase Agent' }),
      );
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
      await userEvent.click(await screen.findByRole('button', { name: 'Model: Older model' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: /Update Codex/u }));
      await waitFor(() =>
        expect(prepareAgent).toHaveBeenCalledWith('codex', 'update', expect.anything()),
      );
      expect(
        screen.getByRole('menuitem', { name: /Updating Codex/u }).getAttribute('aria-disabled'),
      ).toBe('true');
      expect(sent.filter((command) => command.kind === 'prompt')).toHaveLength(0);
      // One Escape leaves the model menu, the next the panel it opened from.
      await userEvent.keyboard('{Escape}{Escape}');
      expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
      await userEvent.click(
        screen.getByRole('button', { name: 'Model and thinking: Older model' }),
      );
      await userEvent.click(await screen.findByRole('button', { name: 'Model: Older model' }));

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
});
