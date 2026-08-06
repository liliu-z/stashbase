/**
 * Compatibility-first contract for the built-in Agent panel.
 *
 * Runtime-specific bridges register a small adapter here.  The renderer and
 * route layer speak only in terms of this contract, while Claude's SDK and
 * Codex's app-server remain free to keep their native lifecycle details.
 */
import type { WebSocket } from 'ws';
import { CLIS, launchCommandFor } from './terminal.ts';
import { resolveAgentCli } from './agent-cli.ts';

export type AgentId = 'claude' | 'codex';
export type AgentRuntimeState = 'available' | 'unavailable' | 'failed';
export const AGENT_ACCESS_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
export type AgentAccessMode = (typeof AGENT_ACCESS_MODES)[number];

export function isAgentAccessMode(value: unknown): value is AgentAccessMode {
  return typeof value === 'string' && (AGENT_ACCESS_MODES as readonly string[]).includes(value);
}

/** Effort identifiers are runtime-owned opaque strings. Keep the URL boundary
 * bounded and free of control characters without narrowing future runtimes to
 * a StashBase-maintained enum. */
export function parseAgentEffort(value: unknown): string | undefined {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 64
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
}

export interface AgentCapabilities {
  connection: true;
  prompts: true;
  interrupt: true;
  transcript: true;
  approvals: true;
  history: true;
  modes: boolean;
  effort: boolean;
  /** The runtime can enumerate and select its own session models. */
  models: boolean;
  steering: boolean;
  titleHint: boolean;
  skills: true;
}

/** A runtime-owned workflow surfaced by the compact composer picker. The
 * renderer deliberately never receives native invocation details. */
export interface AgentSkill {
  /** Opaque runtime-scoped identity; never a filesystem path. */
  id: string;
  name: string;
  description: string;
}

export interface AgentConnectionOptions {
  windowId: string;
  effort?: string;
  resume?: string;
  access?: AgentAccessMode;
  /** Undefined deliberately means "use the runtime's configured default". */
  model?: string;
}

/** A model is always advertised by the native runtime, never a StashBase list. */
export interface AgentModel {
  id: string;
  label: string;
  description?: string;
  supportedEfforts?: string[];
}

/** The stable panel wire protocol. Adapters may translate native events,
 * but they must only emit this transcript and lifecycle vocabulary. */
export type AgentClientEvent =
  | { t: 'prompt'; text: string; titleHint?: string; skill?: { id: string } }
  | { t: 'skills-refresh' }
  | { t: 'steer'; id: string; text: string }
  | { t: 'permission-reply'; id: string; allow: boolean; always?: boolean }
  | { t: 'interrupt' }
  | { t: 'close' }
  | { t: 'set-mode'; mode: string };

export type AgentServerEvent =
  | { t: 'ready' }
  | { t: 'skills'; skills: AgentSkill[]; loading?: boolean; error?: string }
  | { t: 'session-id'; id: string }
  | { t: 'session-title'; title: string }
  | { t: 'models'; models: AgentModel[]; activeModel?: string; fallback?: string }
  | { t: 'turn-start' }
  | { t: 'text'; delta: string }
  | { t: 'thinking'; delta: string }
  | { t: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | { t: 'tool-delta'; id: string; delta: string }
  | { t: 'tool-result'; id: string; content: string; isError: boolean }
  | { t: 'permission'; id: string; toolUseId: string; name: string; title: string | null; input: Record<string, unknown> }
  | { t: 'steer-result'; id: string; ok: boolean; message?: string }
  | { t: 'turn-end'; isError: boolean }
  | { t: 'error'; message: string }
  | { t: 'exit' };

export interface AgentHistoryActions {
  list(folder: string | null): Promise<unknown[]>;
  messages(id: string, folder: string | null): Promise<unknown[]>;
  rename(id: string, title: string, folder: string | null): Promise<unknown>;
  remove(id: string, folder: string | null): Promise<void>;
}

export interface AgentAdapter {
  id: AgentId;
  label: string;
  vendor: string;
  capabilities: AgentCapabilities;
  attach(ws: WebSocket, options: AgentConnectionOptions): void;
  stop(windowId?: string): void;
  history: AgentHistoryActions;
}

export interface AgentRuntimeDescriptor {
  id: AgentId;
  label: string;
  vendor: string;
  installHint: string;
  launchCommand: string;
  endpoint: '/ws/agent';
  installed: boolean;
  state: AgentRuntimeState;
  error?: string;
  capabilities: AgentCapabilities;
}

const adapters = new Map<AgentId, AgentAdapter>();
const runtimeFailures = new Map<AgentId, string>();

export function agentExecutableFor(id: AgentId): string | null {
  const config = id === 'claude'
    ? { name: 'claude', envNames: ['STASHBASE_CLAUDE_BIN', 'CLAUDE_CODE_BIN'], logLabel: 'Claude Code' }
    : { name: 'codex', envNames: ['STASHBASE_CODEX_BIN', 'CODEX_CLI_BIN', 'CODEX_CLI_PATH'], logLabel: 'Codex' };
  return resolveAgentCli(config, () => {});
}

export function registerAgentAdapter(adapter: AgentAdapter): void {
  adapters.set(adapter.id, adapter);
}

/** Pure descriptor builder used by discovery and its contract tests. */
export function runtimeDescriptorFor(adapter: AgentAdapter, executable = agentExecutableFor(adapter.id)): AgentRuntimeDescriptor {
  const cli = CLIS[adapter.id];
  const installed = executable !== null;
  const failure = runtimeFailures.get(adapter.id);
  const state: AgentRuntimeState = !installed ? 'unavailable' : failure ? 'failed' : 'available';
  return {
    id: adapter.id,
    label: adapter.label,
    vendor: adapter.vendor,
    installHint: cli.installHint,
    launchCommand: launchCommandFor(cli),
    endpoint: '/ws/agent',
    installed,
    state,
    ...(failure ? { error: failure } : {}),
    capabilities: adapter.capabilities,
  };
}

export function agentAdapter(id: string): AgentAdapter | null {
  return id === 'claude' || id === 'codex' ? adapters.get(id) ?? null : null;
}

/** Native discovery is performed at request time so a CLI installed or
 * upgraded while StashBase is open is reflected without a bundled-version
 * assumption. */
export function discoverAgentRuntimes(): AgentRuntimeDescriptor[] {
  return [...adapters.values()].map((adapter) => runtimeDescriptorFor(adapter));
}

export function attachAgentRuntime(id: string, ws: WebSocket, options: AgentConnectionOptions): void {
  const adapter = agentAdapter(id);
  if (!adapter) {
    ws.send(JSON.stringify({ t: 'error', message: 'Unsupported agent runtime.' }));
    ws.close();
    return;
  }
  if (!agentExecutableFor(adapter.id)) {
    ws.send(JSON.stringify({ t: 'error', message: `${adapter.label} CLI is not available.` }));
    ws.close();
    return;
  }
  clearAgentRuntimeFailure(adapter.id);
  adapter.attach(ws, options);
}

export function stopAgentRuntime(id: AgentId, windowId?: string): void {
  agentAdapter(id)?.stop(windowId);
}

export function reportAgentRuntimeFailure(id: AgentId, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  runtimeFailures.set(id, message.slice(0, 500));
}

export function clearAgentRuntimeFailure(id: AgentId): void {
  runtimeFailures.delete(id);
}
