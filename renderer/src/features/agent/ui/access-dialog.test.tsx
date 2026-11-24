import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vite-plus/test';

import type { Agent } from '@/features/agent/domain/agent-catalog';
import { draftOf, typeInto } from '@/test/dom';
import {
  agentDefinition,
  agentGateLifted,
  agentSessionPort,
  CODEX_AGENT,
} from '@/test/fakes/agent';

import { AgentAccessDialog } from './access-dialog';
import { registerWorkspaceCleanup, renderWorkspace } from './workspace.harness';

registerWorkspaceCleanup();

/** The gate asks about the Agent the chat is already on, so the panel it opens
 *  is named after that one. */
async function requestAccess(name = 'Sign in to use the StashBase Agent') {
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
    // The account's own dialog takes the question from here: the gate does
    // not stay open beneath it.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
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

  it('comes back with the message kept when the reader leaves the sign-in, and sends only on Retry', async () => {
    let attempts = 0;
    let ready = false;
    const signIn = vi.fn(async () => {
      attempts += 1;
      ready = attempts > 1;
      return ready;
    });
    const { port } = agentSessionPort();
    const { runtime } = renderWorkspace(
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
    const back = within(
      await screen.findByRole('dialog', { name: 'Sign in to use the StashBase Agent' }),
    );
    expect((await back.findByRole('status')).textContent).toBe(
      'Sign-in was not completed.\n\nYour message was kept.',
    );
    expect(port.connect).not.toHaveBeenCalled();
    expect(draftOf(runtime)).toBe('Help me write an introduction');
    await userEvent.click(back.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(port.connect).toHaveBeenCalledOnce());
    expect(signIn).toHaveBeenCalledTimes(2);
  });

  it.each(['edit', 'project'] as const)(
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
    await userEvent.click(screen.getByRole('button', { name: 'Provider: StashBase Agent' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Codex' }));
    const dialog = await requestAccess('Connect Codex');
    await userEvent.click(dialog.getByRole('button', { name: 'Connect Codex' }));
    const failure = await dialog.findByRole('status');
    expect(failure.textContent).toContain('Installation failed.');
    expect(failure.textContent).toContain('Download failed (403) from chatgpt.com.');
    expect(failure.textContent).toContain('Your message was kept.');
    expect(failure.textContent).not.toContain('Try again');
    expect(port.connect).not.toHaveBeenCalled();
    expect(draftOf(runtime)).toBe('Help me write an introduction');
    await userEvent.click(dialog.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(port.connect).toHaveBeenCalledOnce());
    expect(port.connect).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex' }),
      expect.anything(),
    );
    expect(runtime.newChat().store.getState().agent).toBe('codex');
  });

  it('shows the step the service is on, with its sign-in page, until the runtime is ready', async () => {
    const { port } = agentSessionPort();
    let codex: Agent = { ...CODEX_AGENT, ready: false };
    renderWorkspace(port, [], undefined, undefined, {
      listAgents: vi.fn(async () => ({ agents: [agentDefinition({ ready: false }), codex] })),
      prepareAgent: vi.fn(async () => {
        codex = {
          ...CODEX_AGENT,
          ready: false,
          preparation: {
            step: 'sign-in',
            note: 'Finish signing in to Codex in your browser.',
            signInUrl: 'https://auth.example.com/oauth/authorize',
          },
        };
        return { agents: [codex] };
      }),
    });
    await agentGateLifted();
    await userEvent.click(screen.getByRole('button', { name: 'Provider: StashBase Agent' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Codex' }));
    const dialog = await requestAccess('Connect Codex');
    await userEvent.click(dialog.getByRole('button', { name: 'Connect Codex' }));
    const step = await dialog.findByRole('status');
    await waitFor(() =>
      expect(step.textContent).toBe('Finish signing in to Codex in your browser.'),
    );
    expect(dialog.getByRole('button', { name: 'Open sign-in page' })).not.toBeNull();
    expect(port.connect).not.toHaveBeenCalled();
    codex = CODEX_AGENT;
    await waitFor(() => expect(port.connect).toHaveBeenCalledOnce(), { timeout: 3000 });
  });

  it('asks an expired runtime to sign in, and stopping the wait keeps the send for the next answer', async () => {
    const { port } = agentSessionPort();
    let codex: Agent = { ...CODEX_AGENT, needsSignIn: true, ready: false };
    let retire!: () => void;
    const prepareAgent = vi.fn(async (_id: string, action: string) => {
      if (action === 'stop') await new Promise<void>((resolve) => (retire = resolve));
      codex =
        action === 'stop'
          ? { ...CODEX_AGENT, needsSignIn: true, ready: false }
          : {
              ...CODEX_AGENT,
              ready: false,
              preparation: {
                step: 'sign-in',
                note: 'Finish signing in to Codex in your browser.',
                signInUrl: 'https://auth.example.com/oauth/authorize',
              },
            };
      return { agents: [codex] };
    });
    const { runtime } = renderWorkspace(port, [], undefined, undefined, {
      listAgents: vi.fn(async () => ({ agents: [agentDefinition({ ready: false }), codex] })),
      prepareAgent,
    });
    await agentGateLifted();
    await userEvent.click(screen.getByRole('button', { name: 'Provider: StashBase Agent' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Codex' }));
    // Only the sign-in lapsed, so the gate asks for that and not a setup.
    const dialog = await requestAccess('Sign in to use Codex');
    expect(dialog.queryByRole('button', { name: 'Connect Codex' })).toBeNull();
    await userEvent.click(dialog.getByRole('button', { name: 'Sign in' }));
    expect(prepareAgent).toHaveBeenCalledWith('codex', 'login', expect.any(AbortSignal));
    await userEvent.click(await dialog.findByRole('button', { name: 'Stop waiting' }));
    await waitFor(() =>
      expect(prepareAgent).toHaveBeenCalledWith('codex', 'stop', expect.any(AbortSignal)),
    );
    // Until the service has retired the login, another answer would join it.
    const signIn = dialog.getByRole<HTMLButtonElement>('button', { name: 'Sign in' });
    expect(signIn.disabled).toBe(true);
    await userEvent.click(signIn);
    expect(prepareAgent.mock.calls.filter(([, action]) => action === 'login')).toHaveLength(1);
    retire();
    await waitFor(() => expect(signIn.disabled).toBe(false));
    // The gate is back at its question with the send still held.
    expect(dialog.queryByRole('status')).toBeNull();
    expect(dialog.getByRole('button', { name: 'Sign in' })).not.toBeNull();
    expect(port.connect).not.toHaveBeenCalled();
    expect(draftOf(runtime)).toBe('Help me write an introduction');
  });
});

it('opens the sign-in page the runtime printed, for a browser that did not open', async () => {
  const onOpenSignIn = vi.fn();
  render(
    <AgentAccessDialog
      agent="claude"
      failure={null}
      open
      preparation={{
        step: 'sign-in',
        note: 'Finish signing in to Claude in your browser.',
        signInUrl: 'https://claude.example.com/oauth/authorize?state=1',
      }}
      startedAt={Date.now() - 75_000}
      working
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      onOpenSignIn={onOpenSignIn}
    />,
  );
  expect(screen.getByText('1m 15s')).not.toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Open sign-in page' }));
  expect(onOpenSignIn).toHaveBeenCalledWith('https://claude.example.com/oauth/authorize?state=1');
});
