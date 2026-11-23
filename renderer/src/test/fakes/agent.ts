/** Fake Agent ports and runtime definitions the Agent tests build on. The
 *  shapes live in one place, so a port change lands here rather than in every
 *  test that names it. */
import { screen, waitFor } from '@testing-library/react';
import { expect, vi } from 'vite-plus/test';

import type {
  AgentCatalogPort,
  AgentConnectionListener,
  AgentContextPort,
  AgentSessionPort,
} from '@/features/agent/application/ports';
import type { Agent, AgentAbilities } from '@/features/agent/domain/agent-catalog';
import type { AgentSessionCommand } from '@/features/agent/domain/session-command';

/** Every capability a native Agent can advertise, all on. A test that needs
 *  one missing spreads this and turns that one off. */
const nativeAbilities: AgentAbilities = {
  attachments: true,
  effort: true,
  models: true,
  modes: ['default', 'plan', 'acceptEdits', 'auto'],
  skills: true,
  steering: true,
};

/** The bundled Agent supports attachments but has no model or effort picker. */
const plainAbilities: AgentAbilities = {
  attachments: true,
  effort: false,
  models: false,
  modes: ['default', 'plan', 'acceptEdits', 'auto'],
  skills: false,
  steering: false,
};

export function agentDefinition(overrides: Partial<Agent> = {}): Agent {
  return {
    abilities: plainAbilities,
    id: 'stashbase',
    label: 'Default',
    models: [],
    needsSignIn: false,
    ready: true,
    ...overrides,
  };
}

/** The bundled agent, plus the two native ones the workspace tests exercise. */
export const BUILT_IN_AGENT = agentDefinition();

export const CODEX_AGENT = agentDefinition({
  abilities: nativeAbilities,
  id: 'codex',
  label: 'Codex',
});

export const CLAUDE_AGENT = agentDefinition({
  abilities: nativeAbilities,
  id: 'claude',
  label: 'Claude',
});

export interface FakeAgentSession {
  /** Every listener a `connect` handed back, in connection order. */
  readonly listeners: AgentConnectionListener[];
  readonly port: AgentSessionPort;
  /** Every session command the composer sent, in send order. */
  readonly sent: AgentSessionCommand[];
}

/** A session port that connects, keeps each listener so a test can drive
 *  server events, and records the commands sent back. */
export function agentSessionPort(overrides: Partial<AgentSessionPort> = {}): FakeAgentSession {
  const listeners: AgentConnectionListener[] = [];
  const sent: AgentSessionCommand[] = [];
  const port: AgentSessionPort = {
    connect: vi.fn<AgentSessionPort['connect']>((_request, listener) => {
      listeners.push(listener);
      return {
        close: vi.fn(),
        send: vi.fn((command: AgentSessionCommand) => {
          sent.push(command);
          return true;
        }),
      };
    }),
    list: vi.fn(async () => []),
    remove: vi.fn(async () => undefined),
    rename: vi.fn(async (entry) => entry),
    replay: vi.fn(async () => ({ effort: null, transcript: [] })),
    ...overrides,
  };
  return { listeners, port, sent };
}

/** A session port that never opens a connection, for tests that assert the
 *  workspace stays idle. */
export function idleAgentSessionPort(overrides: Partial<AgentSessionPort> = {}): AgentSessionPort {
  return agentSessionPort({
    connect: vi.fn(() => ({ close: vi.fn(), send: vi.fn(() => true) })),
    ...overrides,
  }).port;
}

export function agentCatalogPort(
  agents: readonly Agent[] = [BUILT_IN_AGENT, CODEX_AGENT, CLAUDE_AGENT],
  overrides: Partial<AgentCatalogPort> = {},
): AgentCatalogPort {
  return {
    listAgents: vi.fn(async () => ({ agents: [...agents] })),
    prepareAgent: vi.fn(async () => ({ agents: [...agents] })),
    ...overrides,
  };
}

export function agentContextPort(overrides: Partial<AgentContextPort> = {}): AgentContextPort {
  return {
    resolve: vi.fn(async (source) => ({
      available: true,
      folder: 'Research',
      kind: 'direct' as const,
      path: `${source.folderPath}/${source.path}`,
      readPath: source.path,
      reason: '',
      sourceFormat: 'md',
      sourcePath: source.path,
    })),
    upload: vi.fn(async (files: File[]) =>
      files.map((file) => ({ name: file.name, path: `/tmp/attach/${file.name}` })),
    ),
    ...overrides,
  };
}

/** A context port whose calls hang, so the app boots without resolving. */
export function pendingAgentContextPort(): AgentContextPort {
  return agentContextPort({
    resolve: vi.fn(() => new Promise<never>(() => undefined)),
    upload: vi.fn(async () => []),
  });
}

/** The Agent canvas paints before the catalog answers, so a test that assumes
 *  a runtime waits for the setup gate to lift rather than for the heading:
 *  the heading is drawn either way now. */
export async function agentGateLifted(): Promise<void> {
  await waitFor(() => expect(screen.queryByText('Checking agents…')).toBeNull());
}
