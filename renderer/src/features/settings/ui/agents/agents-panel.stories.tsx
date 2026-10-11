import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { AccountPort, AgentRuntimePort } from '@/features/settings/application/ports';
import type { AgentCatalog, AgentRuntime } from '@/features/settings/domain/agent-catalog';
import type { BillingStatus } from '@/features/settings/domain/billing';
import { AccountProvider } from '@/features/settings/hooks/account-context';

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
  version: null,
};

const FREE: BillingStatus = {
  cancelAtPeriodEnd: false,
  canManage: false,
  paidThrough: null,
  planName: null,
  status: 'free',
};

function fakePort(): AgentRuntimePort {
  return {
    getAllowance: async () => ({
      remainingPercent: 62,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      windowEndsAt: null,
    }),
    getBillingPlans: async () => [
      {
        amount: 1000,
        available: true,
        currency: 'usd',
        interval: 'month',
        name: 'Plus',
        priceId: 'price_plus',
      },
      {
        amount: 2000,
        available: true,
        currency: 'usd',
        interval: 'month',
        name: 'Pro',
        priceId: 'price_pro',
      },
    ],
    getBillingStatus: async () => FREE,
    listAgents: async () => catalog([codex, claude, stashbase]),
    openBillingPortal: async () => 'https://billing.stripe.com/p/session/story',
    prepareAgent: async () => catalog([codex, claude, stashbase]),
    startCheckout: async () => 'https://checkout.stripe.com/c/pay/story',
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

const SIGNED_OUT = {
  avatarUrl: null,
  displayName: null,
  email: null,
  offers: [],
  signedIn: false,
} as const;

const signedIn: AccountPort = {
  avatar: async () => null,
  load: async () => ({
    avatarUrl: null,
    displayName: 'Ada Lovelace',
    email: 'ada@example.com',
    offers: [],
    signedIn: true,
  }),
  signInStatus: async () => ({ state: 'pending' }),
  markOfferSeen: async () => SIGNED_OUT,
  resetOffers: async () => SIGNED_OUT,
  signOut: async () => SIGNED_OUT,
  startSignIn: async () => ({ flowId: 'flow', url: 'https://accounts.example/sign-in' }),
};

/** Nobody signed in, so the bundled agent cannot run a turn yet: the row
 *  recedes and says what would clear it, and the account row above offers the
 *  same sign-in in the same shape. */
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
        note: 'Sign in to StashBase to use the included weekly Agent allowance.',
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
        <AgentRuntimesPanel agentRuntimeApi={port} />
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

export const UpdateOffersAModel: Story = {
  args: { account: signedIn, port: upgradeOfferedPort() },
};
