import { telemetry } from './telemetry.ts';
/**
 * Compatibility-first contract for the Agent Panel.
 *
 * Runtime-specific bridges register a small adapter here.  The renderer and
 * route layer speak only in terms of this contract, while Claude's SDK and
 * Codex's app-server remain free to keep their native lifecycle details.
 */
import type { WebSocket } from 'ws';
import { CLIS } from './terminal.ts';
import { agentCliVersion, resolveAgentCli } from './agent-cli.ts';
import { agentSupportsInAppUpdate, agentBootstrapStatus } from './agent-runtime-installer.ts';
import { ensureAgentMcp } from './agent-mcp.ts';
import { rememberedCatalogFor } from './agent-model-catalog.ts';
import { claudeUpgradeOffer } from './claude-model-catalog.ts';
import { filesystemPath } from './filesystem-path.ts';
import { trackAgentTurns } from './turn-changes.ts';
import { trackChatPersona } from './agent-persona.ts';
import type { AgentModelCatalog, AgentUpgradeOffer } from '../shared/agent-runtime.ts';

/** The renderer↔server wire vocabulary lives in `shared/agent-protocol.ts` so
 * the renderer can import it without pulling this module's server-only graph
 * (`ws`, the CLI resolvers, the runtime installer) into the browser bundle.
 * Re-exported here so server-side callers keep one import site for the whole
 * contract. */
export type {
  AgentClientEvent,
  AgentId,
  AgentModel,
  AgentServerEvent,
  AgentSkill,
} from '../shared/agent-protocol.ts';
import type { AgentId } from '../shared/agent-protocol.ts';

export type AgentRuntimeState = 'available' | 'unavailable' | 'failed';
import { AGENT_ACCESS_MODES, type AgentAccessMode } from '../shared/agent-runtime.ts';

export { AGENT_ACCESS_MODES, type AgentAccessMode };

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
  attachments: boolean;
  /** The permission promises this runtime can honor; empty hides the control. */
  modes: readonly AgentAccessMode[];
  effort: boolean;
  /** The runtime can enumerate native models and accept an explicit choice;
   * the adapter owns whether that choice begins a session or a later turn. */
  models: boolean;
  skills: boolean;
  steering: boolean;
  titleHint: boolean;
}

export interface AgentConnectionOptions {
  windowId: string;
  effort?: string;
  resume?: string;
  access?: AgentAccessMode;
  /** Undefined deliberately means "use the runtime's configured default". */
  model?: string;
  /** Registered project folder captured at connection time. */
  folder?: string;
  /** The library persona this Chat runs under; absent runs none. */
  persona?: string;
}

export type AgentSessionFolderResolution =
  | { ok: true; folder?: string }
  | { ok: false; message: string };

/** Resolve an optional explicit session folder against project membership.
 * Absent/empty → follow the window's current folder (folder stays undefined).
 * Present → it must match a registered member root; the stored member
 * spelling is returned so downstream path-keyed state stays consistent.
 * Anything else is rejected — an agent session must never be bound to an
 * arbitrary filesystem path. */
export function resolveAgentSessionFolder(
  requested: unknown,
  memberRoots: readonly string[],
): AgentSessionFolderResolution {
  if (requested == null) return { ok: true };
  if (typeof requested !== 'string') return { ok: false, message: 'folder must be a project folder path' };
  if (!requested.trim()) return { ok: true };
  if (!filesystemPath.isAbsolute(requested)) return { ok: false, message: 'folder must be an absolute project folder path' };
  for (const root of memberRoots) {
    try {
      if (filesystemPath.equal(root, requested)) return { ok: true, folder: root };
    } catch {
      // A malformed candidate cannot equal a member root; keep checking.
    }
  }
  return { ok: false, message: 'folder is not a registered project folder' };
}

/** A session always belongs to one registered project. */
export type AgentSessionScope = { kind: 'folder'; path: string };
export type AgentSessionScopeResolution =
  | { ok: true; scope: AgentSessionScope }
  | { ok: false; message: string };

export function resolveAgentSessionScope(
  requestedScope: unknown,
  requestedFolder: unknown,
  memberRoots: readonly string[],
): AgentSessionScopeResolution {
  if (requestedScope != null) return { ok: false, message: 'scope is unsupported; select a project folder' };
  const result = resolveAgentSessionFolder(requestedFolder, memberRoots);
  if (!result.ok) return result;
  return result.folder
    ? { ok: true, scope: { kind: 'folder', path: result.folder } }
    : { ok: false, message: 'Open a project before starting a chat.' };
}

/** Native adapters pin the project before starting their process. */
export function resolveSessionBinding(options: {
  folder?: string;
  currentFolder: string | null;
}): { cwd: string } {
  const cwd = options.folder ?? options.currentFolder;
  if (!cwd) throw new Error('Open a project before starting a chat.');
  return { cwd };
}

export interface AgentHistoryActions {
  list(folder: string): Promise<unknown[]>;
  messages(id: string, folder: string): Promise<unknown[]>;
  /** Protocol-v2 replay metadata. Optional keeps third-party/older adapters
   * compatible with the established messages-only history contract. */
  replay?(id: string, folder: string): Promise<unknown>;
  rename(id: string, title: string, folder: string): Promise<unknown>;
  remove(id: string, folder: string): Promise<void>;
}

export interface AgentAdapter {
  id: AgentId;
  label: string;
  vendor: string;
  /** Bundled adapters own their executable, account gate, and local service
   * readiness. External CLI adapters retain the shared discovery/bootstrap
   * path below. */
  runtime?: () => Omit<AgentRuntimeDescriptor, 'id' | 'label' | 'vendor' | 'endpoint' | 'capabilities'>;
  capabilities: AgentCapabilities;
  attach(ws: WebSocket, options: AgentConnectionOptions): void;
  stop(windowId?: string): void;
  /** End every live session bound to this member folder, across all windows.
   * Project removal uses this — a removed folder must not keep
   * running sessions, even in windows currently showing another folder. */
  stopFolder(folderAbs: string): void;
  history: AgentHistoryActions;
}

/** The registry entry shape both runtime session sets satisfy. */
export type AgentSessionTermination = {
  kind: 'scope-removed';
  folder: string;
};

export interface FolderBoundAgentSession {
  boundFolder(): string | null;
  dispose(termination?: AgentSessionTermination): void;
}

/** Dispose exactly the sessions bound to `folderAbs` (filesystem identity
 * comparison), leaving sessions bound to other folders running. Shared by the
 * runtime registries so folder removal has one teardown semantic. */
export function disposeSessionsBoundToFolder<T extends FolderBoundAgentSession>(
  sessions: Set<T>,
  folderAbs: string,
): void {
  for (const session of [...sessions]) {
    const bound = session.boundFolder();
    let matches = false;
    try {
      matches = bound != null && filesystemPath.equal(bound, folderAbs);
    } catch {
      matches = false;
    }
    if (matches) {
      session.dispose({ kind: 'scope-removed', folder: folderAbs });
      sessions.delete(session);
    }
  }
}

export interface AgentRuntimeDescriptor {
  id: AgentId;
  label: string;
  vendor: string;
  installHint: string;
  launchCommand: string;
  endpoint: '/ws/agent';
  installed: boolean;
  source: 'bundled' | 'system' | null;
  state: AgentRuntimeState;
  bootstrap: ReturnType<typeof agentBootstrapStatus>;
  /** The installed executable's own version, when it reports one. */
  version?: string | null;
  /** Whether the official native installation can be updated from the app. */
  updatable?: boolean;
  error?: string;
  capabilities: AgentCapabilities;
  /** The runtime's remembered model catalog, once one has been read. */
  catalog?: AgentModelCatalog;
  /** A model the installed runtime says it is too old to run, when it says
   *  so. */
  upgrade?: AgentUpgradeOffer;
}

const adapters = new Map<AgentId, AgentAdapter>();

export function agentExecutableFor(id: Exclude<AgentId, 'stashbase'>): string | null {
  const config = id === 'claude'
    ? { name: 'claude', envNames: ['STASHBASE_CLAUDE_BIN', 'CLAUDE_CODE_BIN'], logLabel: 'Claude' }
    : { name: 'codex', envNames: ['STASHBASE_CODEX_BIN', 'CODEX_CLI_BIN', 'CODEX_CLI_PATH'], logLabel: 'Codex' };
  return resolveAgentCli(config, () => {});
}

export function registerAgentAdapter(adapter: AgentAdapter): void {
  adapters.set(adapter.id, adapter);
}

/** Pure descriptor builder used by discovery and its contract tests. */
export function runtimeDescriptorFor(
  adapter: AgentAdapter,
  executable = adapter.id === 'stashbase' ? null : agentExecutableFor(adapter.id),
): AgentRuntimeDescriptor {
  if (adapter.runtime) {
    return {
      id: adapter.id,
      label: adapter.label,
      vendor: adapter.vendor,
      endpoint: '/ws/agent',
      capabilities: adapter.capabilities,
      ...adapter.runtime(),
    };
  }
  if (adapter.id === 'stashbase') throw new Error('Bundled Agent adapter must describe its runtime.');
  const cli = CLIS[adapter.id];
  const installed = executable !== null;
  const state: AgentRuntimeState = installed ? 'available' : 'unavailable';
  return {
    id: adapter.id,
    label: adapter.label,
    vendor: adapter.vendor,
    installHint: cli.installHint,
    launchCommand: cli.bin,
    endpoint: '/ws/agent',
    installed,
    source: installed ? 'system' : null,
    version: null,
    updatable: installed && agentSupportsInAppUpdate(adapter.id),
    state,
    bootstrap: agentBootstrapStatus(adapter.id),
    capabilities: adapter.capabilities,
  };
}

export function agentAdapter(id: string): AgentAdapter | null {
  return id === 'stashbase' || id === 'claude' || id === 'codex' ? adapters.get(id) ?? null : null;
}

/** Native discovery is performed at request time so a CLI installed or
 * upgraded while StashBase is open is reflected without a bundled-version
 * assumption. */
export async function discoverAgentRuntimes(): Promise<AgentRuntimeDescriptor[]> {
  return Promise.all([...adapters.values()].map(async (adapter) => {
    const executable = adapter.id === 'stashbase' ? null : agentExecutableFor(adapter.id);
    const descriptor = runtimeDescriptorFor(adapter, executable);
    if (executable) descriptor.version = await agentCliVersion(executable);
    const catalog = rememberedCatalogFor(descriptor);
    // Claude is the only runtime that reports a model it is too old to run;
    // Codex's catalog simply omits what its app-server does not offer.
    const upgrade = descriptor.id === 'claude' && descriptor.installed ? claudeUpgradeOffer() : undefined;
    return {
      ...descriptor,
      ...(catalog ? { catalog } : {}),
      ...(upgrade ? { upgrade } : {}),
    };
  }));
}

export function attachAgentRuntime(id: string, ws: WebSocket, options: AgentConnectionOptions): void {
  const adapter = agentAdapter(id);
  if (!adapter) {
    ws.send(JSON.stringify({ t: 'error', message: 'Unsupported agent runtime.' }));
    ws.close();
    return;
  }
  const runtime = runtimeDescriptorFor(adapter);
  if (!runtime.installed || runtime.state !== 'available') {
    const message = runtime.error ?? `${adapter.label} is not ready.`;
    telemetry.captureError(message, { source: 'agent', operation: 'connection', runtime: adapter.id });
    ws.send(JSON.stringify({ t: 'error', message }));
    ws.close();
    return;
  }
  if (adapter.id !== 'stashbase' && !agentExecutableFor(adapter.id)) {
    telemetry.captureError(`${adapter.label} CLI is not available.`, { source: 'agent', operation: 'connection', runtime: adapter.id });
    ws.send(JSON.stringify({ t: 'error', message: `${adapter.label} CLI is not available.` }));
    ws.close();
    return;
  }
  try {
    if (adapter.id !== 'stashbase') ensureAgentMcp(adapter.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    telemetry.captureError(error, { source: 'agent', operation: 'mcp-connection', runtime: adapter.id });
    ws.send(JSON.stringify({ t: 'error', message: `Could not connect StashBase MCP: ${message}` }));
    ws.close();
    return;
  }
  // Before the adapter registers its listeners, so its first prompt already
  // waits for the baseline. `server/turn-changes.ts` owns why this is the seam.
  if (options.folder) trackAgentTurns(ws, options.folder);
  trackChatPersona(ws, adapter.id, options);
  adapter.attach(ws, options);
}

export function stopAgentRuntime(id: AgentId, windowId?: string): void {
  agentAdapter(id)?.stop(windowId);
}

/** Retire every adapter's sessions before releasing any window binding. */
export function stopAgentRuntimesForFolder(folderAbs: string): void {
  for (const adapter of adapters.values()) adapter.stopFolder(folderAbs);
}
