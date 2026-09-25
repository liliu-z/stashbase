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
} from '@/features/settings/application/ports';
import type { HostedAccount } from '@/features/settings/domain/account';
import type { AgentAllowance, AgentRuntime } from '@/features/settings/domain/agent-catalog';
import type { AppearancePreferences } from '@/features/settings/domain/appearance';
import type { EmbedderState } from '@/features/settings/domain/embedder';
import type { McpAccess, McpHttpAccess } from '@/features/settings/domain/mcp-access';

export const SIGNED_OUT_ACCOUNT: HostedAccount = {
  avatarUrl: null,
  displayName: null,
  email: null,
  signedIn: false,
};

/** A signed-in account with the profile Google reported. */
export const SIGNED_IN_ACCOUNT: HostedAccount = {
  avatarUrl: null,
  displayName: 'Ada Lovelace',
  email: 'ada@example.com',
  signedIn: true,
};

/** Signed out by default, the quiet state: a composition test that is not
 *  about the account should see a plain Sign in row and nothing else. */
export function accountPort(
  account: HostedAccount = SIGNED_OUT_ACCOUNT,
  overrides: Partial<AccountPort> = {},
): AccountPort {
  return {
    avatar: vi.fn(async () => null),
    load: vi.fn(async () => account),
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
    version: null,
    ...overrides,
  };
}

export function agentRuntimePort(overrides: Partial<AgentRuntimePort> = {}): AgentRuntimePort {
  const response = { debug: null, runtimes: [agentRuntime()] };
  return {
    getAllowance: vi.fn(async () => IDLE_ALLOWANCE),
    listAgents: vi.fn(async () => response),
    prepareAgent: vi.fn(async () => response),
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

/** The server's own defaults, and a write that answers with every preset
 *  the way the route does. */
export function appearancePort(overrides: Partial<AppearancePort> = {}): AppearancePort {
  const saved: AppearancePreferences = {
    readingTextSize: 'default',
    readingFont: 'serif',
    theme: 'system',
    uiScale: 'default',
  };
  return {
    load: vi.fn(async () => saved),
    update: vi.fn(async (change) => ({ ...saved, ...change })),
    ...overrides,
  };
}
