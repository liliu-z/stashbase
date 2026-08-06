/**
 * Built-in implementations of the Shared Agent Contract.
 *
 * Keeping this declaration separate from server startup makes the common
 * contract testable without creating an HTTP server or native process.
 */
import { attachAgentWebSocket, killActiveAgent } from './agent.ts';
import type { AgentAdapter } from './agent-contract.ts';
import { attachCodexWebSocket, killActiveCodex } from './codex-agent.ts';
import { claudeHistoryActions } from './routes/sessions.ts';
import { codexHistoryActions } from './routes/codex-sessions.ts';

const SHARED_PANEL_CAPABILITIES = {
  connection: true,
  prompts: true,
  interrupt: true,
  transcript: true,
  approvals: true,
  history: true,
  modes: true,
  effort: true,
  models: true,
  skills: true,
} as const;

export const BUILT_IN_AGENT_ADAPTERS: readonly AgentAdapter[] = [
  {
    id: 'claude', label: 'Claude Code', vendor: 'Anthropic',
    capabilities: { ...SHARED_PANEL_CAPABILITIES, steering: false, titleHint: false },
    attach: (ws, options) => attachAgentWebSocket(ws, options.windowId, options.effort, options.resume, options.access, options.model),
    stop: killActiveAgent,
    history: claudeHistoryActions(),
  },
  {
    id: 'codex', label: 'Codex', vendor: 'OpenAI',
    capabilities: { ...SHARED_PANEL_CAPABILITIES, steering: true, titleHint: true },
    attach: (ws, options) => attachCodexWebSocket(ws, options.windowId, options.effort, options.resume, options.access, options.model),
    stop: killActiveCodex,
    history: codexHistoryActions(),
  },
];
