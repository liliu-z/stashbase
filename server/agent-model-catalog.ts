import { retireAgentProcess } from './agent-process.ts';
/** What a runtime offers to run on, read at the runtime level.
 *
 * A model catalog is a property of the runtime, not of a chat: Codex answers
 * `model/list` from a bare app-server with no thread, and every chat on the
 * same runtime gets the same answer. So the catalog is read once here, kept
 * in memory and in the config file, and handed to new chats through the
 * runtime listing, which is how a fresh Chat names the model and level it
 * will run on before any session exists. A live session still reads its own
 * catalog when it starts and refreshes this memory, and the model it reports
 * running with nothing chosen is remembered as the runtime's default for a
 * runtime that flags none. Claude's read lives in `claude-model-catalog.ts`,
 * because its default comes from the CLI's own settings rather than from the
 * handshake. The StashBase Agent's catalog is the hosted service's list of
 * approved profiles: it belongs to the account rather than this machine, so
 * it is kept in memory only and read again once it is a few minutes old. */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import type { AgentId, AgentModel } from '../shared/agent-protocol.ts';
import type { AgentModelCatalog } from '../shared/agent-runtime.ts';
import { readAppConfig, readAppConfigStrict, writeAppConfigStrict } from './app-config.ts';
import { readClaudeModelCatalog } from './claude-model-catalog.ts';
import { readAntigravityModelCatalog } from './antigravity-model-catalog.ts';
import { isNativeAgentId, NATIVE_AGENT_IDS } from './native-agents.ts';
import { spawnCodexAppServerProcess } from './codex-app-server-process.ts';
import { loadCodexModelCatalog } from './codex-model-catalog.ts';
import { fetchHostedAgentProfiles, hostedAgentCatalogModels } from './hosted-agent-models.ts';
import { connectCodexAppServer } from './codex-rpc-transport.ts';
import { errorMessage, logger } from './log.ts';

const log = logger('agent-model-catalog');

type PersistedAgentId = Exclude<AgentId, 'stashbase'>;

/** One runtime-level reading: the catalog, and the default it names when the
 * runtime keeps that outside the catalog. */
export interface CatalogReading {
  models: AgentModel[];
  defaultModel?: string;
}

/** A runtime-level read that failed, or that could not complete a memory, is
 * not repeated before this much time passes, so a runtime that cannot answer
 * does not slow every listing. */
const READ_RETRY_MS = 5 * 60_000;

/** How long the hosted profile list stands before a listing reads it again.
 * Sessions read their own list when they start, whatever this memory holds. */
const HOSTED_CATALOG_TTL_MS = 5 * 60_000;

const memory = new Map<AgentId, AgentModelCatalog>();
const inFlight = new Map<AgentId, Promise<AgentModelCatalog | undefined>>();
const attemptedAt = new Map<AgentId, number>();

/** A memory a session wrote before the runtime's default was known: it lists
 * models but names none as the one an unchosen turn runs on. */
function incomplete(catalog: AgentModelCatalog): boolean {
  return !catalog.defaultModel && !catalog.models.some((model) => model.isDefault === true);
}
let loaded = false;

function persisted(id: AgentId): id is PersistedAgentId {
  return isNativeAgentId(id);
}

function stale(id: AgentId, catalog: AgentModelCatalog, now: number, maxAgeMs?: number): boolean {
  const limit = maxAgeMs ?? (id === 'stashbase' ? HOSTED_CATALOG_TTL_MS : undefined);
  return limit !== undefined && !(now - Date.parse(catalog.readAt) < limit);
}

function load(): void {
  if (loaded) return;
  loaded = true;
  const stored = readAppConfig().agentModelCatalogs;
  for (const id of NATIVE_AGENT_IDS) {
    const entry = stored?.[id];
    if (!entry || !Array.isArray(entry.models) || typeof entry.readAt !== 'string') continue;
    memory.set(id, {
      models: entry.models,
      ...(typeof entry.defaultModel === 'string' ? { defaultModel: entry.defaultModel } : {}),
      readAt: entry.readAt,
    });
  }
}

function persist(): void {
  try {
    const config = readAppConfigStrict();
    config.agentModelCatalogs = Object.fromEntries([...memory].filter(([id]) => persisted(id)));
    writeAppConfigStrict(config);
  } catch (err: unknown) {
    // Disposable catalog caching must neither replace unreadable settings nor
    // interrupt a working Agent session. The fresh catalog remains in memory.
    log.warn(`could not cache model catalog:`, err);
  }
}

export function recallAgentModels(id: AgentId): AgentModelCatalog | undefined {
  load();
  return memory.get(id);
}

/** Keeps a catalog a session or a runtime-level read has just produced. An
 * observed default survives as long as the new catalog still lists it. */
export function rememberAgentModels(id: AgentId, models: AgentModel[]): void {
  if (models.length === 0) return;
  load();
  const previous = memory.get(id)?.defaultModel;
  const defaultModel = previous && models.some((model) => model.id === previous) ? previous : undefined;
  memory.set(id, { models, ...(defaultModel ? { defaultModel } : {}), readAt: new Date().toISOString() });
  if (persisted(id)) persist();
}

/** Keeps the model a runtime reported running when nothing was chosen. Only
 * a listed model can be a default; an unlisted one is not invented. */
export function rememberAgentDefaultModel(id: AgentId, modelId: string): void {
  if (!persisted(id)) return;
  load();
  const entry = memory.get(id);
  if (!entry || entry.defaultModel === modelId || !entry.models.some((model) => model.id === modelId)) return;
  memory.set(id, { ...entry, defaultModel: modelId });
  persist();
}

/** The catalog a runtime listing entry carries: what is remembered, for a
 * runtime that can run a turn and offers a choice of model. */
export function rememberedCatalogFor(runtime: {
  id: AgentId;
  installed: boolean;
  state: string;
  capabilities: { models: boolean };
}): AgentModelCatalog | undefined {
  if (!runtime.capabilities.models || !runtime.installed || runtime.state !== 'available') return undefined;
  return recallAgentModels(runtime.id);
}

/** Codex's catalog from a bare app-server: initialize, list, exit. The
 * process runs in the home directory, so what it reports is the user's own
 * default rather than a folder's project override. */
export async function readCodexModelCatalog(
  spawn: (cwd: string) => ChildProcessWithoutNullStreams = (cwd) => spawnCodexAppServerProcess(cwd, {}, { purpose: 'models' }),
  timeoutMs = 8_000,
): Promise<CatalogReading> {
  const proc = spawn(os.homedir());
  const { rpc, initialize, close } = connectCodexAppServer(proc, { requestTimeoutMs: timeoutMs });
  try {
    await initialize();
    return { models: await loadCodexModelCatalog((method, params) => rpc.request(method, params)) };
  } finally {
    close();
    await retireAgentProcess(proc);
  }
}

/** The StashBase Agent's approved profiles, as the picker names them. */
export async function readHostedAgentModelCatalog(): Promise<CatalogReading> {
  return { models: hostedAgentCatalogModels(await fetchHostedAgentProfiles()) };
}

const CATALOG_READERS: Record<AgentId, () => Promise<CatalogReading>> = {
  stashbase: readHostedAgentModelCatalog,
  codex: () => readCodexModelCatalog(),
  claude: () => readClaudeModelCatalog(),
  antigravity: () => readAntigravityModelCatalog(),
};

/** The runtime's catalog for the listing: what is remembered, or with nothing
 * complete (or, for the hosted list, nothing recent) remembered yet, one runtime-level read shared by every caller
 * waiting on it. A read that fails, or that still names no default, leaves
 * what was remembered in place and is not repeated until the retry pause has
 * passed or a session reads a catalog of its own. */
export function ensureAgentModelCatalog(
  id: AgentId,
  options: {
    read?: () => Promise<CatalogReading>;
    now?: () => number;
    /** Read again once the memory is this old, for a session that refreshes
     *  the runtime's catalog when it starts. */
    maxAgeMs?: number;
  } = {},
): Promise<AgentModelCatalog | undefined> {
  const known = recallAgentModels(id);
  const now = options.now ?? Date.now;
  if (known && !incomplete(known) && !stale(id, known, now(), options.maxAgeMs)) return Promise.resolve(known);
  const lastAttempt = attemptedAt.get(id);
  if (lastAttempt !== undefined && now() - lastAttempt < READ_RETRY_MS) return Promise.resolve(known);
  const pending = inFlight.get(id);
  if (pending) return pending;
  const read = options.read ?? CATALOG_READERS[id];
  const reading = read()
    .then((result) => {
      rememberAgentModels(id, result.models);
      if (result.defaultModel) rememberAgentDefaultModel(id, result.defaultModel);
      const completed = recallAgentModels(id);
      if (completed && incomplete(completed)) attemptedAt.set(id, now());
      else attemptedAt.delete(id);
      return completed;
    })
    .catch((err: unknown) => {
      attemptedAt.set(id, now());
      log.debug(`could not read the ${id} model catalog: ${errorMessage(err)}`);
      return recallAgentModels(id);
    })
    .finally(() => inFlight.delete(id));
  inFlight.set(id, reading);
  return reading;
}
