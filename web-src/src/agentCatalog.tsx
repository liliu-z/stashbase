import type { ComponentType } from 'react';
import { ClaudeIcon, CodexIcon } from './icons';

export type AgentKind = 'claude' | 'codex';
export type McpClientId = 'claude-code' | 'codex-cli' | 'claude-desktop';

/** Bootstrap contract used until the server has returned live runtime
 * discovery. The server descriptor takes precedence once available. */
export interface AgentPanelCapabilities {
  connection: true;
  prompts: true;
  interrupt: true;
  transcript: true;
  approvals: true;
  history: true;
  modes: boolean;
  effort: boolean;
  models: boolean;
  steering: boolean;
  titleHint: boolean;
  skills: true;
}

export interface AgentMeta {
  id: AgentKind;
  name: string;
  shortName: string;
  launcherLabel: string;
  mcpClientId: McpClientId;
  capabilities: AgentPanelCapabilities;
  controlsNote: string;
  Icon: ComponentType<{ className?: string }>;
}

export const AGENT_META: Record<AgentKind, AgentMeta> = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    shortName: 'Claude',
    launcherLabel: 'Claude Code',
    mcpClientId: 'claude-code',
    capabilities: { connection: true, prompts: true, interrupt: true, transcript: true, approvals: true, history: true, modes: true, effort: true, models: true, steering: false, titleHint: false, skills: true },
    controlsNote: 'Access applies live · Effort on new session',
    Icon: ClaudeIcon,
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    shortName: 'Codex',
    launcherLabel: 'Codex',
    mcpClientId: 'codex-cli',
    capabilities: { connection: true, prompts: true, interrupt: true, transcript: true, approvals: true, history: true, modes: true, effort: true, models: true, steering: true, titleHint: true, skills: true },
    controlsNote: 'Access and effort apply on new session',
    Icon: CodexIcon,
  },
};

export const AGENTS: AgentMeta[] = [AGENT_META.claude, AGENT_META.codex];

export interface McpClientMeta {
  id: McpClientId;
  name: string;
  detail: string;
  cliId?: AgentKind;
  Icon: ComponentType<{ className?: string }>;
}

export const MCP_CLIENTS: McpClientMeta[] = [
  {
    id: AGENT_META.claude.mcpClientId,
    name: 'Claude Code',
    detail: 'Built-in chat and terminal sessions',
    cliId: 'claude',
    Icon: AGENT_META.claude.Icon,
  },
  {
    id: AGENT_META.codex.mcpClientId,
    name: 'Codex CLI',
    detail: 'Built-in chat and terminal sessions',
    cliId: 'codex',
    Icon: AGENT_META.codex.Icon,
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    detail: 'Desktop app connector',
    Icon: ClaudeIcon,
  },
];

export function isAgentKind(value: string): value is AgentKind {
  return value === 'claude' || value === 'codex';
}

export function agentMeta(value: string): AgentMeta {
  return isAgentKind(value) ? AGENT_META[value] : AGENT_META.claude;
}

export function mcpClientLabel(id: McpClientId): string {
  return MCP_CLIENTS.find((client) => client.id === id)?.name ?? id;
}
