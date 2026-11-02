/**
 * Settings ports and domain values a test can build in one line.
 *
 * The feature's domain spells absence as `null`, which is honest but wordy to
 * write out at every call site, so the builders below carry the boring
 * defaults and let a test say only what its case is about.
 */

import { vi } from 'vite-plus/test';

import type { EmbedderPort } from '@/features/settings/application/embedder-port';
import type {
  AccountPort,
  AgentRuntimePort,
  AppearancePort,
  McpAccessPort,
  ProjectMathPort,
} from '@/features/settings/application/ports';
import type { HostedAccount } from '@/features/settings/domain/account';
import type { AgentAllowance, AgentRuntime } from '@/features/settings/domain/agent-catalog';
import type { AppearancePreferences } from '@/features/settings/domain/appearance';
import type { BillingPlan, BillingStatus } from '@/features/settings/domain/billing';
import type { EmbedderState } from '@/features/settings/domain/embedder';
import type { McpAccess, McpHttpAccess } from '@/features/settings/domain/mcp-access';
import { DEFAULT_APPEARANCE_PREFERENCES } from '@/protocols/http/appearance';
import type { AppearanceSurface } from '@/shared/domain/appearance';

export const SIGNED_OUT_ACCOUNT: HostedAccount = {
  avatarUrl: null,
  displayName: null,
  email: null,
  offers: [],
  signedIn: false,
};

/** A signed-in account with the profile Google reported. */
export const SIGNED_IN_ACCOUNT: HostedAccount = {
  avatarUrl: null,
  displayName: 'Ada Lovelace',
  email: 'ada@example.com',
  offers: [],
  signedIn: true,
};

/** Signed out by default, the quiet state: a composition test that is not
 *  about the account should see a plain Sign in row and nothing else. */
export function accountPort(
  account: HostedAccount = SIGNED_OUT_ACCOUNT,
  overrides: Partial<AccountPort> = {},
): AccountPort {
  return {
    sendEmail: vi.fn(async () => ({ flowId: 'email-flow' })),
    verifyEmail: vi.fn(async () => SIGNED_IN_ACCOUNT),
    cancelEmail: vi.fn(async () => {}),
    methods: vi.fn(async () => ({ email: 'ada@example.com', google: true })),
    sendEmailProof: vi.fn(async () => {}),
    verifyEmailProof: vi.fn(async () => {}),
    sendLinkCode: vi.fn(async () => {}),
    linkGoogle: vi.fn(async () => ({ ticket: 'ticket', url: 'https://accounts.example/link' })),
    unlinkGoogle: vi.fn(async () => {}),
    linkStatus: vi.fn(async () => ({ state: 'pending' as const })),
    avatar: vi.fn(async () => null),
    load: vi.fn(async () => account),
    markOfferSeen: vi.fn(async (offer) => ({
      ...account,
      offers: account.offers.filter((item) => item !== offer),
    })),
    resetOffers: vi.fn(async (): Promise<HostedAccount> => ({
      ...account,
      offers: ['sign-in'],
    })),
    signInStatus: vi.fn(async () => ({ state: 'pending' as const })),
    signOut: vi.fn(async () => SIGNED_OUT_ACCOUNT),
    startSignIn: vi.fn(async () => ({
      flowId: 'flow-1',
      url: 'https://accounts.example/sign-in',
    })),
    ...overrides,
  };
}

export function embedderState(overrides: Partial<EmbedderState> = {}): EmbedderState {
  return {
    hasKey: false,
    model: 'text-embedding-3-small',
    provider: 'openai',
    ...overrides,
  };
}

/** The reader's own key stored and answering embeddings. */
export function keyedEmbedderState(overrides: Partial<EmbedderState> = {}): EmbedderState {
  return embedderState({ hasKey: true, ...overrides });
}

export function embedderPort(
  state: EmbedderState = embedderState(),
  overrides: Partial<EmbedderPort> = {},
): EmbedderPort {
  return {
    load: vi.fn(async () => state),
    removeKey: vi.fn(async () => embedderState()),
    saveKey: vi.fn(async () => ({ warning: null })),
    ...overrides,
  };
}

export const IDLE_ALLOWANCE: AgentAllowance = {
  cacheReadTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  remainingPercent: 100,
  windowEndsAt: null,
};

const BILLING_PLANS: readonly BillingPlan[] = [
  {
    amount: 500,
    planKey: 'plus',
    available: true,
    currency: 'usd',
    interval: 'month',
    name: 'Plus',
    priceId: 'price_plus',
  },
  {
    amount: 2000,
    planKey: 'pro',
    available: true,
    currency: 'usd',
    interval: 'month',
    name: 'Pro',
    priceId: 'price_pro',
  },
];

export const FREE_BILLING: BillingStatus = {
  cancelAtPeriodEnd: false,
  canManage: false,
  paidThrough: null,
  planName: null,
  status: 'free',
};

/** One prepared, StashBase-owned runtime. A test names only what its case is
 *  about; everything else is a runtime that is simply ready. */
export function agentRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: 'stashbase',
    installed: true,
    label: 'Default',
    ownership: 'bundled',
    preparation: { kind: 'ready' },
    upgrade: null,
    updatable: false,
    availableVersion: null,
    version: null,
    ...overrides,
  };
}

export function agentRuntimePort(overrides: Partial<AgentRuntimePort> = {}): AgentRuntimePort {
  const response = { debug: null, runtimes: [agentRuntime()] };
  return {
    getAllowance: vi.fn(async () => IDLE_ALLOWANCE),
    getBillingPlans: vi.fn(async () => BILLING_PLANS),
    getBillingStatus: vi.fn(async () => FREE_BILLING),
    listAgents: vi.fn(async () => response),
    prepareAgent: vi.fn(async () => response),
    openBillingPortal: vi.fn(async () => 'https://billing.stripe.com/p/session/test'),
    changeBilling: async () => {},
    startCheckout: vi.fn(async () => 'https://checkout.stripe.com/c/pay/cs_test'),
    updateDebug: vi.fn(async () => response),
    ...overrides,
  };
}

/** A reachable listener with the Docker opt-in left off. */
export function mcpHttpAccess(overrides: Partial<McpHttpAccess> = {}): McpHttpAccess {
  return {
    dockerAccess: false,
    dockerActive: false,
    dockerError: null,
    dockerPort: 8848,
    dockerUrl: 'http://host.docker.internal:8848/mcp',
    loopbackUrl: 'http://127.0.0.1:7777/mcp',
    settingsError: null,
    token: 'token-abc',
    ...overrides,
  };
}

export function mcpAccess(overrides: Partial<McpAccess> = {}): McpAccess {
  return {
    command: '/home/ada/.stashbase/bin/stashbase-mcp',
    config: '{\n  "mcpServers": {}\n}',
    http: mcpHttpAccess(),
    ...overrides,
  };
}

export function mcpAccessPort(overrides: Partial<McpAccessPort> = {}): McpAccessPort {
  const access = mcpAccess();
  return {
    rotateToken: vi.fn(async () => ({ ...access.http, token: 'token-rotated' })),
    setDockerAccess: vi.fn(async (enabled: boolean) => ({ ...access.http, dockerAccess: enabled })),
    setDockerPort: vi.fn(async (port: number) => ({ ...access.http, dockerPort: port })),
    status: vi.fn(async () => access),
    ...overrides,
  };
}

/** The server's own defaults, with what a test changes laid over them. */
export function appearanceSurface(overrides: Partial<AppearanceSurface> = {}): AppearanceSurface {
  return { ...DEFAULT_APPEARANCE_PREFERENCES, ...overrides };
}

/** The server's own defaults, and a write that answers with the whole record
 *  the way the route does. */
export function appearancePort(overrides: Partial<AppearancePort> = {}): AppearancePort {
  let saved: AppearancePreferences = appearanceSurface();
  return {
    load: vi.fn(async () => saved),
    update: vi.fn(async (change) => (saved = { ...saved, ...change })),
    ...overrides,
  };
}

export function projectMathPort(overrides: Partial<ProjectMathPort> = {}): ProjectMathPort {
  const values = new Map<string, boolean>();
  return {
    load: vi.fn(async (scope) => ({ scope, math_mode: values.get(scope) ?? false })),
    update: vi.fn(async (scope, mathMode) => {
      values.set(scope, mathMode);
      return { scope, math_mode: mathMode };
    }),
    ...overrides,
  };
}
