/**
 * Bundled implementations of the Shared Agent Contract.
 *
 * Keeping this declaration separate from server startup makes the common
 * contract testable without creating an HTTP server or native process.
 */
import { attachAgentWebSocket, killActiveAgent, killAgentSessionsForFolder } from './agent.ts';
import { AGENT_ACCESS_MODES, type AgentAdapter } from './agent-contract.ts';
import { attachCodexWebSocket, killActiveCodex, killCodexSessionsForFolder } from './codex-session-runtime.ts';
import {
  attachAntigravityWebSocket,
  killActiveAntigravity,
  killAntigravitySessionsForFolder,
} from './antigravity-session-runtime.ts';
import { antigravityHistory } from './antigravity-history.ts';
import { ANTIGRAVITY_ACCESS_MODES } from './antigravity-protocol.ts';
import { claudeHistoryActions } from './claude-history.ts';
import { codexHistoryActions } from './codex-history-adapter.ts';
import {
  attachOpenCodeWebSocket,
  killActiveOpenCode,
  killOpenCodeSessionsForFolder,
  openCodeHistoryActions,
} from './opencode-agent.ts';
import { openCodeRuntimeAvailability } from './opencode-runtime.ts';

const SHARED_PANEL_CAPABILITIES = {
  connection: true,
  prompts: true,
  interrupt: true,
  transcript: true,
  approvals: true,
  history: true,
  attachments: true,
  modes: AGENT_ACCESS_MODES,
  effort: true,
  models: true,
  skills: true,
} as const;

export const BUILT_IN_AGENT_ADAPTERS: readonly AgentAdapter[] = [
  {
    id: 'codex', label: 'Codex', vendor: 'OpenAI',
    capabilities: { ...SHARED_PANEL_CAPABILITIES, steering: true, titleHint: true },
    attach: attachCodexWebSocket,
    stop: killActiveCodex,
    stopFolder: killCodexSessionsForFolder,
    history: codexHistoryActions(),
  },
  {
    id: 'claude', label: 'Claude', vendor: 'Anthropic',
    capabilities: { ...SHARED_PANEL_CAPABILITIES, steering: true, titleHint: false },
    attach: attachAgentWebSocket,
    stop: killActiveAgent,
    stopFolder: killAgentSessionsForFolder,
    history: claudeHistoryActions(),
  },
  {
    id: 'antigravity', label: 'Antigravity', vendor: 'Google',
    capabilities: {
      ...SHARED_PANEL_CAPABILITIES,
      // Headless `agy` takes text messages only, so attachments travel as the
      // paths in the prompt's `Attached files:` block, which it reads with its
      // own tools, as Claude and Codex do.
      attachments: true,
      modes: ANTIGRAVITY_ACCESS_MODES,
      // Antigravity discovers the project's skills itself and offers no
      // listing to invoke one by name.
      skills: false,
      steering: false,
      titleHint: true,
    },
    attach: attachAntigravityWebSocket,
    stop: killActiveAntigravity,
    stopFolder: killAntigravitySessionsForFolder,
    history: antigravityHistory.actions(),
  },
  {
    id: 'stashbase', label: 'StashBase Agent', vendor: 'StashBase · OpenCode',
    capabilities: {
      ...SHARED_PANEL_CAPABILITIES,
      modes: AGENT_ACCESS_MODES,
      effort: false,
      // The main agent runs on the service's default profile; models are
      // chosen per role in Settings, not per chat.
      models: false,
      skills: false,
      steering: false,
      titleHint: true,
    },
    runtime: openCodeRuntimeAvailability,
    attach: attachOpenCodeWebSocket,
    stop: killActiveOpenCode,
    stopFolder: killOpenCodeSessionsForFolder,
    history: openCodeHistoryActions(),
  },
];
