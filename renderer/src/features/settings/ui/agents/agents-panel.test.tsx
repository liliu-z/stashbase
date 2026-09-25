import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { failureMessage } from '@/features/settings/application/failure-messages';
import type { AccountPort, AgentRuntimePort } from '@/features/settings/application/ports';
import type { AgentCatalog, AgentRuntime } from '@/features/settings/domain/agent-catalog';
import { AccountProvider } from '@/features/settings/hooks/account-context';
import {
  accountPort,
  agentRuntime,
  agentRuntimePort,
  SIGNED_IN_ACCOUNT,
} from '@/test/fakes/settings';
import { withQueryClient } from '@/test/query';

import { AgentRuntimesPanel } from './agents-panel';

function catalog(runtimes: AgentRuntime[], debug?: AgentCatalog['debug']): AgentCatalog {
  return { runtimes, debug: debug ?? null };
}

/** A reset runtime comes back not installed with nothing prepared for it. */

function renderPanel(
  port: AgentRuntimePort,
  account: AccountPort = accountPort(),
  onOpenExternal = vi.fn(),
) {
  const rendered = withQueryClient(
    <AccountProvider port={account} openExternal={onOpenExternal}>
      <AgentRuntimesPanel agentRuntimeApi={port} />
    </AccountProvider>,
  );
  return { ...rendered, onOpenExternal };
}

afterEach(cleanup);

const codex = agentRuntime({
  id: 'codex',
  installed: false,
  label: 'Codex',
  ownership: null,
  preparation: { kind: 'idle' },
});

describe('AgentRuntimesPanel', () => {
  it('starts the browser sign-in from a runtime that needs an account', async () => {
    // The row's Sign in and the account row's Sign in are one command over one
    // port, so the runtime can never send the reader somewhere else to do it.
    const port = agentRuntimePort({
      listAgents: vi.fn(async () =>
        catalog([
          agentRuntime({
            id: 'stashbase',
            installed: true,
            label: 'Default',
            preparation: {
              failure: {
                note: 'An account is required to use the Default Agent.',
                refusal: 'account-required',
                stage: 'install',
              },
              kind: 'failed',
            },
          }),
        ]),
      ),
    });
    const account = accountPort();
    const rendered = renderPanel(port, account);
    const user = userEvent.setup();

    await screen.findByText('An account is required to use the Default Agent.');
    const buttons = screen.getAllByRole('button', { name: 'Sign in' });
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0] as HTMLElement);
    await waitFor(() => expect(account.startSignIn).toHaveBeenCalledOnce());
    expect(rendered.onOpenExternal).toHaveBeenCalledWith('https://accounts.example/sign-in');
    expect(await screen.findByRole('button', { name: 'Waiting for browser…' })).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Stop waiting' }));
    expect(screen.queryByRole('button', { name: 'Waiting for browser…' })).toBeNull();
    await user.click(screen.getAllByRole('button', { name: 'Sign in' })[0] as HTMLElement);
    await waitFor(() => expect(account.startSignIn).toHaveBeenCalledTimes(2));
  });

  it('names the signed-in person under Account and signs out from there', async () => {
    const account = accountPort(SIGNED_IN_ACCOUNT);
    const rendered = renderPanel(agentRuntimePort(), account);
    const user = userEvent.setup();

    expect(await screen.findByText('Ada Lovelace · ada@example.com')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(await screen.findByText('Agent credits')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Plans and billing' }));
    expect(rendered.onOpenExternal).toHaveBeenCalledWith('https://stashbase.ai/pricing/');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(account.signOut).toHaveBeenCalledOnce());
    expect(await screen.findByRole('button', { name: 'Sign in' })).not.toBeNull();
  });

  it('installs a not-yet-installed runtime and writes the response into the catalog', async () => {
    const port = agentRuntimePort({
      listAgents: vi.fn(async () => catalog([codex])),
      prepareAgent: vi.fn(async () =>
        catalog([
          { ...codex, installed: true, ownership: 'system', preparation: { kind: 'ready' } },
        ]),
      ),
    });
    renderPanel(port);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Install' }));

    expect(port.prepareAgent).toHaveBeenCalledWith('codex', 'bootstrap', expect.anything());
    await waitFor(() => expect(screen.getByText(/Ready to chat/)).not.toBeNull());
  });

  it('updates an installed runtime in place and shows the version it came back with', async () => {
    const claude = agentRuntime({
      id: 'claude',
      installed: true,
      label: 'Claude',
      ownership: 'system',
      preparation: { kind: 'ready' },
      updatable: true,
      version: '2.1.220',
    });
    const port = agentRuntimePort({
      listAgents: vi.fn(async () => catalog([claude])),
      prepareAgent: vi.fn(async () => catalog([{ ...claude, version: '2.1.276' }])),
    });
    renderPanel(port);
    const user = userEvent.setup();

    expect(await screen.findByText(/Installed on your system · 2\.1\.220/)).not.toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Update' }));

    expect(port.prepareAgent).toHaveBeenCalledWith('claude', 'update', expect.anything());
    await waitFor(() => expect(screen.getByText(/2\.1\.276/)).not.toBeNull());
  });

  it('shows a quiet retry row when the allowance fails to load, never a stale number', async () => {
    const port = agentRuntimePort({
      listAgents: vi.fn(async () => catalog([agentRuntime()])),
      getAllowance: vi.fn(async () => {
        throw new Error('unavailable');
      }),
    });
    renderPanel(port, accountPort(SIGNED_IN_ACCOUNT));

    expect(await screen.findByText('Could not load your credit balance.')).not.toBeNull();
    expect(screen.queryByText(/remaining/)).toBeNull();
  });

  it('hides the dev-only debug block while the catalog carries no debug controls', async () => {
    const port = agentRuntimePort({ listAgents: vi.fn(async () => catalog([codex])) });
    renderPanel(port);

    await screen.findByRole('button', { name: 'Install' });
    expect(screen.queryByText('Agent setup testing')).toBeNull();
  });

  it('keeps a failed install visible on its row instead of silently clearing the busy state', async () => {
    const port = agentRuntimePort({
      listAgents: vi.fn(async () => catalog([codex])),
      prepareAgent: vi.fn(async () => {
        throw new Error('Installer exited with status 1.');
      }),
    });
    renderPanel(port);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Install' }));

    expect(await screen.findByText(failureMessage('unavailable'))).not.toBeNull();
    expect(await screen.findByRole('button', { name: 'Install' })).not.toBeNull();
  });
});
