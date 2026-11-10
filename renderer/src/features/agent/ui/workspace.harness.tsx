/**
 * The mounted Agent pane, for the suites that exercise it.
 *
 * Both the workspace canvas and the Chat header need the whole pane standing —
 * the Chats panel beside the canvas, a real workspace runtime over a fake
 * session port — because the behaviour they check runs between those pieces:
 * a row opened in the panel is what binds the session the header renames. The
 * wiring is here so neither suite rebuilds it, and so the two cannot drift
 * into testing two slightly different panes.
 *
 * Only a test file imports this. It is not a `test-support.ts`, which is a
 * barrel of values the feature otherwise keeps to itself; this mounts React.
 */
import { act, cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vite-plus/test';
import { createStore, useStore } from 'zustand';

import type {
  AgentCatalogPort,
  AgentContextPort,
  AgentSessionPort,
  AgentToolsPort,
} from '@/features/agent/application/ports';
import {
  createAgentWorkspaceRuntime,
  type AgentWorkspaceRuntime,
} from '@/features/agent/application/workspace-runtime';
import type { Agent } from '@/features/agent/domain/agent-catalog';
import {
  agentCatalogPort,
  agentPersonaApi,
  agentToolsApi,
  BUILT_IN_AGENT,
  CLAUDE_AGENT,
  CODEX_AGENT,
} from '@/test/fakes/agent';
import { createTestQueryClient, withQueryClient } from '@/test/query';

import AgentChats from './chats/chats';
import ManagedAgentWorkspace from './workspace';

export const RESEARCH_SCOPE = { kind: 'folder', path: '/Library/Research' } as const;

const runtimes: AgentWorkspaceRuntime[] = [];

/**
 * Tear the pane down after each test in the calling suite.
 *
 * Called rather than registered at import, so each suite states that it owns
 * the teardown instead of inheriting it from a module it happened to import.
 * A runtime left running holds a socket and a timer past the test that made
 * it.
 */
export function registerWorkspaceCleanup(): void {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    for (const runtime of runtimes.splice(0)) runtime.dispose();
  });
}

export function renderWorkspace(
  session: AgentSessionPort,
  agents: readonly Agent[] = [BUILT_IN_AGENT, CODEX_AGENT, CLAUDE_AGENT],
  context?: AgentContextPort,
  onReprocess?: (source: { folderPath: string; path: string }) => void,
  catalogOverrides: Partial<AgentCatalogPort> = {},
  onSignIn: (signal?: AbortSignal) => void | Promise<boolean> = vi.fn(),
  tools: AgentToolsPort = agentToolsApi(),
) {
  let id = 0;
  const runtime = createAgentWorkspaceRuntime({
    autostart: false,
    context,
    createId: () => `chat-${++id}`,
    folderPath: RESEARCH_SCOPE.path,
    port: session,
  });
  runtimes.push(runtime);
  const catalog = agentCatalogPort(agents, catalogOverrides);
  const onOpenAgentSettings = vi.fn();
  const onOpenAppSettings = vi.fn();
  // Settings is a dialog over the pane in the app; here it is only its flag.
  const settings = createStore(() => ({ open: false }));
  function Pane() {
    const settingsOpen = useStore(settings, (state) => state.open);
    return (
      <div>
        <AgentChats
          catalog={catalog}
          onOpenAgentSettings={onOpenAgentSettings}
          runtime={runtime}
          scope={RESEARCH_SCOPE}
          workspaceName="Research"
        />
        <ManagedAgentWorkspace
          onOpenAppSettings={onOpenAppSettings}
          catalog={catalog}
          persona={agentPersonaApi()}
          tools={tools}
          onOpenAgentSettings={onOpenAgentSettings}
          onOpenExternal={vi.fn()}
          onSignIn={onSignIn}
          onReprocess={onReprocess}
          runtime={runtime}
          settingsOpen={settingsOpen}
        />
      </div>
    );
  }
  const view = withQueryClient(<Pane />, createTestQueryClient(), { strict: true });
  const setSettingsOpen = (open: boolean) => act(() => settings.setState({ open }));
  return { runtime, view, onOpenAgentSettings, onOpenAppSettings, setSettingsOpen };
}
