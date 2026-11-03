import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { AccountPort, AgentRuntimePort } from '@/features/settings/application/ports';
import type { AgentCatalog, AgentRuntime } from '@/features/settings/domain/agent-catalog';
import { AccountProvider } from '@/features/settings/ui/account/account-provider';
import {
  accountRuntimePort,
  signedIn,
  SIGNED_OUT,
} from '@/features/settings/ui/account/account-story-fixtures';

import { AgentRuntimesPanel } from './agents-panel';

function catalog(runtimes: AgentRuntime[]): AgentCatalog {
  return { runtimes, debug: null };
}

const codex: AgentRuntime = {
  id: 'codex',
  label: 'Codex',
  installed: true,
  ownership: 'system',
  preparation: { kind: 'ready' },
  upgrade: null,
  updatable: true,
  availableVersion: null,
  version: '0.155.0',
};

const claude: AgentRuntime = {
  id: 'claude',
  label: 'Claude',
  installed: true,
  ownership: 'system',
  preparation: { kind: 'ready' },
  upgrade: null,
  updatable: true,
  availableVersion: '2.1.302',
  version: '2.1.276',
};

const stashbase: AgentRuntime = {
  id: 'stashbase',
  label: 'Default',
  installed: true,
  ownership: 'bundled',
  preparation: { kind: 'ready' },
  upgrade: null,
  updatable: false,
  availableVersion: null,
  version: null,
};

function fakePort(): AgentRuntimePort {
  return {
    ...accountRuntimePort(),
    listAgents: async () => catalog([codex, claude, stashbase]),
    prepareAgent: async () => catalog([codex, claude, stashbase]),
    updateDebug: async () => catalog([codex, claude, stashbase]),
  };
}

/** A Plus subscriber: the plan list gives way to the Portal. */
function subscribedPort(cancelAtPeriodEnd = false): AgentRuntimePort {
  return {
    ...fakePort(),
    getBillingStatus: async () => ({
      cancelAtPeriodEnd,
      canManage: true,
      paidThrough: '2099-11-05T00:00:00.000Z',
      planName: 'Plus',
      status: 'active',
    }),
  };
}

/** Nobody signed in, so the bundled agent cannot run a turn yet: its row
 *  recedes and says it needs sign-in, and the Account row below owns the
 *  action. */
const signedOut: AccountPort = {
  ...signedIn,
  load: async () => SIGNED_OUT,
};

function accountRequiredPort(): AgentRuntimePort {
  const blocked: AgentRuntime = {
    ...stashbase,
    preparation: {
      kind: 'failed',
      failure: {
        note: 'Sign in to StashBase to use the included monthly agent allowance.',
        refusal: 'account-required',
        stage: 'authenticate',
      },
    },
  };
  const runtimes = [codex, { ...claude, installed: false, ownership: null }, blocked];
  return {
    ...fakePort(),
    getAllowance: async () => {
      throw new Error('unauthorized');
    },
    listAgents: async () => catalog(runtimes),
  };
}

/** Claude names a model this installation is too old to run. The row leads
 *  with that model instead of its readiness, and the Update it already
 *  carried is now the thing to do. */
function upgradeOfferedPort(): AgentRuntimePort {
  const behind: AgentRuntime = {
    ...claude,
    upgrade: { model: 'Opus 5.5', note: 'Update to 2.1.280+ to use Opus 5.5' },
  };
  const runtimes = [codex, behind, stashbase];
  return { ...fakePort(), listAgents: async () => catalog(runtimes) };
}

function Harness({ account, port }: { account: AccountPort; port: AgentRuntimePort }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <AccountProvider port={account} openExternal={() => undefined}>
        <AgentRuntimesPanel agentRuntimeApi={port} onOpenAccount={() => undefined} />
      </AccountProvider>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Settings/AgentRuntimesPanel',
  component: Harness,
  parameters: { fluidCanvas: { width: '28rem', minHeight: '30rem' } },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof Harness>;

export const Ready: Story = { args: { account: signedIn, port: fakePort() } };

export const Subscribed: Story = { args: { account: signedIn, port: subscribedPort() } };

export const RenewalCanceled: Story = { args: { account: signedIn, port: subscribedPort(true) } };

export const NeedsSignIn: Story = { args: { account: signedOut, port: accountRequiredPort() } };

export const InvalidClaudeCredentials: Story = {
  args: {
    account: signedIn,
    port: {
      ...fakePort(),
      listAgents: async () =>
        catalog([
          codex,
          {
            ...claude,
            preparation: {
              kind: 'failed',
              failure: {
                note: 'Claude · Check · authentication\n401 / OAuth access token is invalid',
                refusal: 'authentication-required',
                retryAction: 'login',
                stage: 'authenticate',
              },
            },
          },
          stashbase,
        ]),
    },
  },
};

export const UpdateOffersAModel: Story = {
  args: { account: signedIn, port: upgradeOfferedPort() },
};

export const ReservedCredits: Story = {
  args: {
    account: signedIn,
    port: {
      ...fakePort(),
      getAllowance: async () => ({
        remainingPercent: 15,
        reservedPercent: 24.565635,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        windowEndsAt: '2026-10-18T09:06:28.329Z',
      }),
    },
  },
};

export const DowngradeScheduled: Story = {
  args: {
    account: signedIn,
    port: {
      ...fakePort(),
      getBillingStatus: async () => ({
        cancelAtPeriodEnd: false,
        canManage: true,
        paidThrough: '2099-11-05T00:00:00.000Z',
        planName: 'Pro',
        planKey: 'pro',
        status: 'active',
        scheduledChange: { priceId: 'price_plus', effectiveAt: '2099-11-05T00:00:00.000Z' },
      }),
    },
  },
};
