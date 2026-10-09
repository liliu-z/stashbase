import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vite-plus/test';

import { draftOf, typeInto } from '@/test/dom';
import {
  agentDefinition,
  agentGateLifted,
  agentSessionPort,
  CODEX_AGENT,
} from '@/test/fakes/agent';

import { registerWorkspaceCleanup, renderWorkspace } from './workspace.harness';

registerWorkspaceCleanup();

/** The gate asks about the Agent the chat is already on, so the panel it opens
 *  is named after that one. */
async function requestAccess(name = 'Sign in to use Default Agent') {
  await agentGateLifted();
  typeInto(screen.getByRole('textbox', { name: 'Message' }), 'Help me write an introduction');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  return within(await screen.findByRole('dialog', { name }));
}

describe('first-send Agent access', () => {
  it('keeps Default even with Codex ready, and asks before opening login or starting a session', async () => {
    const { port } = agentSessionPort();
    const signIn = vi.fn();
    const { runtime } = renderWorkspace(
      port,
      [agentDefinition({ ready: false }), CODEX_AGENT],
      undefined,
      undefined,
      {},
      signIn,
    );
    const dialog = await requestAccess();
    expect(runtime.activeSession().store.getState().agent).toBe('stashbase');
    // The panel opens on itself, so neither answer starts out looking chosen.
    expect(document.activeElement?.getAttribute('role')).toBe('dialog');
    // One question about the selected Agent: another runtime being ready is
    // not an offer to switch this chat onto it.
    expect(dialog.getByRole('button', { name: 'Sign in' })).not.toBeNull();
    expect(dialog.queryByRole('button', { name: /Codex/ })).toBeNull();
    expect(signIn).not.toHaveBeenCalled();
    expect(port.connect).not.toHaveBeenCalled();
    await userEvent.click(dialog.getByRole('button', { name: 'Not now' }));
    expect(draftOf(runtime)).toBe('Help me write an introduction');
    expect(port.connect).not.toHaveBeenCalled();
  });

  it('continues the retained first send exactly once after explicit sign-in completes', async () => {
    let finish!: (value: boolean) => void;
    const signedIn = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    let ready = false;
    const signIn = vi.fn(() => signedIn);
    const { port, listeners, sent } = agentSessionPort();
    renderWorkspace(
      port,
      [],
      undefined,
      undefined,
      {
        listAgents: vi.fn(async () => ({ agents: [agentDefinition({ ready })] })),
      },
      signIn,
    );
    const dialog = await requestAccess();
    await userEvent.click(dialog.getByRole('button', { name: 'Sign in' }));
    expect(signIn).toHaveBeenCalledOnce();
    expect(port.connect).not.toHaveBeenCalled();
    await act(async () => {
      ready = true;
      finish(true);
      await signedIn;
    });
    await waitFor(() => expect(port.connect).toHaveBeenCalledOnce());
    act(() => listeners[0]?.onEvent({ kind: 'ready' }));
    expect(sent.filter((command) => command.kind === 'prompt')).toHaveLength(1);
  });

  it.each(['close', 'edit', 'project'] as const)(
    'does not send after %s while login is pending',
    async (reason) => {
      let finish!: (value: boolean) => void;
      const signedIn = new Promise<boolean>((resolve) => {
        finish = resolve;
      });
      const { port } = agentSessionPort();
      const { runtime } = renderWorkspace(
        port,
        [agentDefinition({ ready: false })],
        undefined,
        undefined,
        {},
        () => signedIn,
      );
      const dialog = await requestAccess();
      const original = runtime.activeSession();
      await userEvent.click(dialog.getByRole('button', { name: 'Sign in' }));
      // The browser wait may never come back, so the way out stays live
      // through it.
      if (reason === 'close') await userEvent.click(dialog.getByRole('button', { name: 'Close' }));
      else
        act(() => {
          if (reason === 'edit') original.setDraft('A different request');
          else runtime.setWindowFolder('/another-project');
        });
      await act(async () => {
        finish(true);
        await signedIn;
      });
      expect(port.connect).not.toHaveBeenCalled();
      expect(original.store.getState().draft).toBe(
        reason === 'edit' ? 'A different request' : 'Help me write an introduction',
      );
    },
  );

  it('connects the selected native Agent and resumes, preserving the draft on failure', async () => {
    const { port } = agentSessionPort();
    const prepareAgent = vi
      .fn()
      .mockResolvedValueOnce({
        agents: [
          {
            ...CODEX_AGENT,
            ready: false,
            setupFailure: {
              stage: 'installation',
              message: 'Download failed (403) from chatgpt.com.',
            },
          },
        ],
      })
      .mockResolvedValue({ agents: [CODEX_AGENT] });
    const { runtime } = renderWorkspace(
      port,
      [agentDefinition({ ready: false }), { ...CODEX_AGENT, ready: false }],
      undefined,
      undefined,
      { prepareAgent },
    );
    await agentGateLifted();
    await userEvent.click(screen.getByRole('button', { name: 'Provider: Default' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Codex' }));
    const dialog = await requestAccess('Connect Codex');
    await userEvent.click(dialog.getByRole('button', { name: 'Connect Codex' }));
    const failure = await dialog.findByRole('status');
    expect(failure.textContent).toContain('Installation failed.');
    expect(failure.textContent).toContain('Download failed (403) from chatgpt.com.');
    expect(failure.textContent).toContain('Your message was kept. Try again.');
    expect(port.connect).not.toHaveBeenCalled();
    expect(draftOf(runtime)).toBe('Help me write an introduction');
    await userEvent.click(dialog.getByRole('button', { name: 'Connect Codex' }));
    await waitFor(() => expect(port.connect).toHaveBeenCalledOnce());
    expect(port.connect).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex' }),
      expect.anything(),
    );
    expect(runtime.newChat().store.getState().agent).toBe('codex');
  });
});
