/**
 * App-level config persistence — the single `~/.stashbase/config.json`.
 * Writes enforce owner-only POSIX permissions; Windows relies on the user's
 * profile ACL. This module owns the file primitives and the user-preference
 * accessors (API keys, Agent Persona, terminal CLI, embedder provider); `folder.ts`
 * reuses the same primitives for project membership. Extracted from folder.ts:
 * credentials and preferences have nothing to do with the folder registry, and
 * routes that only need a key shouldn't import the whole window-context machinery.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from './log.ts';
import { writeFileAtomic } from './atomic-write.ts';
import type {
  AppearancePreferences,
  UpdatePreferences,
  WorkspacePreferences,
} from '../shared/preferences.ts';
import { normalizeAppearancePreferences } from '../shared/protocols/http/appearance.ts';
import type { EmbedderProvider } from '../shared/embedding.ts';
import type { HostedAccountOffer } from '../shared/account.ts';
import type { DefaultAgentToolChoice } from '../shared/protocols/http/agent-tools.ts';
import { normalizeHostedDisplayName, parseGoogleAvatarUrl } from './hosted-account-profile.ts';

export type {
  AppearancePreferences,
  UpdatePreferences,
  WorkspacePreferences,
} from '../shared/preferences.ts';
export type { EmbedderProvider } from '../shared/embedding.ts';
import type { AgentModelCatalog } from '../shared/agent-runtime.ts';

const log = logger('app-config');

const CONFIG_DIR = path.join(os.homedir(), '.stashbase');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface RecentFolder {
  path: string;
  openedAt: string;
  /** User-starred in the Welcome project list. Absent = not a favorite. */
  favorite?: boolean;
}

const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = {
  autoCheck: true,
};

const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
  showHiddenFiles: false,
};

export interface EmbedderConfig {
  provider: EmbedderProvider;
  apiKey?: string;
  model: string;
  dimension: number;
  baseUrl?: string;
}

export interface HostedAccountSession {
  accessToken: string;
  sessionToken: string;
  expiresAt: number;
  userId: string;
  email: string;
  /** Optional display-only Google profile fields. They never participate in
   * authentication, authorization, quota ownership, or source selection. */
  displayName?: string;
  avatarUrl?: string;
}

const EMBEDDER_DEFAULTS: Record<EmbedderProvider, Omit<EmbedderConfig, 'provider' | 'apiKey'>> = {
  openai: {
    model: 'text-embedding-3-small',
    dimension: 1536,
  },
  openrouter: {
    model: 'openai/text-embedding-3-small',
    dimension: 1536,
    baseUrl: 'https://openrouter.ai/api/v1',
  },
};

export function isEmbedderProvider(value: unknown): value is EmbedderProvider {
  return value === 'openai' || value === 'openrouter';
}

export interface AppConfigFile {
  /** The last explicit Agent choice, inherited by projects without their own. */
  lastSelectedAgent?: 'stashbase' | 'codex' | 'claude' | 'antigravity';
  /** Per-Agent defaults for projects without an explicit model or effort choice. */
  lastSelectedModels?: Partial<Record<'stashbase' | 'codex' | 'claude' | 'antigravity', string | null>>;
  lastSelectedEfforts?: Partial<Record<'stashbase' | 'codex' | 'claude' | 'antigravity', string | null>>;
  agentPreferences?: Array<{
    scope: string;
    agent: 'stashbase' | 'codex' | 'claude' | 'antigravity';
    models?: Partial<Record<'stashbase' | 'codex' | 'claude' | 'antigravity', string | null>>;
    efforts?: Partial<Record<'stashbase' | 'codex' | 'claude' | 'antigravity', string | null>>;
    /** The library persona this project's next new Chat starts with. */
    persona?: string | null;
  }>;
  telemetry?: import('./telemetry.ts').TelemetryState;
  recentFolders?: RecentFolder[];
  /** Application-wide embedding provider configuration. */
  embedder?: {
    provider?: EmbedderProvider;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
  account?: {
    session?: HostedAccountSession;
    /** Account banners already taken up or declined. Kept outside the
     *  session so an answer outlasts the launch; signing out forgets the
     *  sign-in banner's answer on purpose. */
    offersSeen?: HostedAccountOffer[];
  };
  /** Settings-managed bearer credential and explicit exposure preference for
   *  the Streamable HTTP MCP transport. The token lives beside the existing
   *  API key so config.json remains the only persistent app config file. */
  mcpHttp?: {
    token?: string;
    dockerAccess?: boolean;
    dockerPort?: number;
  };
  /** User-wide presentation and editor preferences. Every value is a preset
   * except the two font families, which name fonts installed on the system
   * and are validated as names before they are stored. */
  appearance?: Partial<AppearancePreferences>;
  /** Application-level Workbench visibility preferences. Absent and invalid
   * values fail closed to the default safe view. */
  workspace?: Partial<WorkspacePreferences>;
  /** Desktop release checks are enabled by default. The Electron main process
   * reads this through the local server so this process remains the sole
   * config writer. */
  updates?: Partial<UpdatePreferences>;
  /** Each native runtime's last-read model catalog and the model it last ran
   * with nothing chosen. A memory rather than a preference: losing it costs
   * one runtime-level read, and no route accepts it from a request body. See
   * `agent-model-catalog.ts`. */
  agentModelCatalogs?: Partial<Record<'claude' | 'codex' | 'antigravity', AgentModelCatalog>>;
  /** The Default Agent tools the reader attached, each with its hosted
   * profile. Read through `default-agent-tools.ts`, which ignores a profile
   * outside a tool's own list. */
  defaultAgentTools?: Partial<Record<string, DefaultAgentToolChoice>>;
  agentCrewChats?: Record<string, Partial<Record<string, DefaultAgentToolChoice>>>;
  /** Per project, whether each scheduled task is switched on and how its last
   *  run went. The tasks themselves live in the project's `.schedules.json`;
   *  `scheduled-tasks.ts` owns this record's shape. */
  scheduledTasks?: Array<{ scope: string; tasks?: Record<string, unknown> }>;
}

export function readAppConfigStrict(file = CONFIG_FILE): AppConfigFile {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${file} must contain a JSON object`);
    }
    return parsed as AppConfigFile;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    const detail = err instanceof SyntaxError ? `invalid JSON: ${err.message}`
      : err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read ${file}: ${detail}`, { cause: err });
  }
}

async function readAppConfigStrictAsync(): Promise<AppConfigFile> {
  try {
    const raw = await fs.promises.readFile(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${CONFIG_FILE} must contain a JSON object`);
    }
    return parsed as AppConfigFile;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    const detail = err instanceof SyntaxError ? `invalid JSON: ${err.message}`
      : err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read ${CONFIG_FILE}: ${detail}`, { cause: err });
  }
}

export function readAppConfig(): AppConfigFile {
  try {
    return readAppConfigStrict();
  } catch {
    return {};
  }
}

export async function readAppConfigAsync(): Promise<AppConfigFile> {
  try {
    return await readAppConfigStrictAsync();
  } catch {
    return {};
  }
}

// SINGLE-WRITER CONSTRAINT: only the web server process writes the
// config (the :8090 port bind already guarantees one instance). The MCP
// host (mcp/server.ts) must stay read-only — read-modify-write here is
// not cross-process safe (last write wins), and the tmp+rename below
// only protects against torn writes, not lost updates. If the MCP host
// ever needs to write config, add real cross-process locking first.

function isConfigAccessError(err: unknown): err is NodeJS.ErrnoException {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

function configAccessError(cause: unknown): Error {
  let message = 'StashBase cannot save settings in ~/.stashbase. Check that your account has write access to this folder, then try again.';
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    try {
      const owner = fs.lstatSync(CONFIG_DIR);
      if (owner.uid !== process.getuid()) {
        message = 'StashBase cannot save settings because ~/.stashbase belongs to another account. Quit StashBase, then repair its ownership in Terminal with: sudo chown -R "$(id -un)":"$(id -gn)" ~/.stashbase';
      }
    } catch {
      // Keep the general access diagnostic when ownership cannot be inspected.
    }
  }
  const err = new Error(message, { cause }) as Error & { code: string; status: number };
  err.code = 'CONFIG_NOT_WRITABLE';
  err.status = 500;
  return err;
}

function writeSerializedConfig(serialized: string): void {
  // 0600 — config may carry API keys; keep it owner-only.
  writeFileAtomic(CONFIG_FILE, serialized, { mode: 0o600 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* best effort on special filesystems */ }
  }
}

export function writeAppConfigStrict(cfg: AppConfigFile): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (isConfigAccessError(err)) throw configAccessError(err);
    throw err;
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* best effort on special filesystems */ }
  }
  const serialized = JSON.stringify(cfg, null, 2) + '\n';
  try {
    writeSerializedConfig(serialized);
  } catch (err) {
    if (!isConfigAccessError(err)) throw err;
    throw configAccessError(err);
  }
}

export function getHostedAccountSession(): HostedAccountSession | undefined {
  const raw = readAppConfig().account?.session;
  if (!raw || typeof raw !== 'object') return undefined;
  if (
    typeof raw.accessToken !== 'string' || !raw.accessToken ||
    typeof raw.sessionToken !== 'string' || !raw.sessionToken ||
    typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt) ||
    typeof raw.userId !== 'string' || !raw.userId ||
    typeof raw.email !== 'string' || !raw.email
  ) return undefined;
  const displayName = normalizeHostedDisplayName(raw.displayName);
  const avatarUrl = parseGoogleAvatarUrl(raw.avatarUrl)?.toString();
  // Select fields explicitly: malformed/legacy provider metadata and any
  // future credentials must never hitchhike into the normalized session.
  return {
    accessToken: raw.accessToken,
    sessionToken: raw.sessionToken,
    expiresAt: raw.expiresAt,
    userId: raw.userId,
    email: raw.email,
    ...(displayName ? { displayName } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

export function setHostedAccountSession(session: HostedAccountSession | undefined): void {
  const cfg = readAppConfigStrict();
  if (session) cfg.account = { ...(cfg.account ?? {}), session: { ...session } };
  else {
    delete cfg.account?.session;
    if (cfg.account && Object.keys(cfg.account).length === 0) delete cfg.account;
  }
  writeAppConfigStrict(cfg);
}

const ACCOUNT_OFFERS: readonly HostedAccountOffer[] = ['sign-in'];

/** Offers still to show. An unreadable or malformed record shows them again,
 *  which costs one dismissal rather than hiding sign-in. */
export function pendingAccountOffers(): HostedAccountOffer[] {
  const seen = readAppConfig().account?.offersSeen;
  const list = Array.isArray(seen) ? seen : [];
  return ACCOUNT_OFFERS.filter((offer) => !list.includes(offer));
}

export function markAccountOfferSeen(offer: HostedAccountOffer): void {
  const cfg = readAppConfigStrict();
  const seen = Array.isArray(cfg.account?.offersSeen) ? cfg.account.offersSeen : [];
  if (seen.includes(offer)) return;
  cfg.account = { ...(cfg.account ?? {}), offersSeen: [...seen.filter((item) => ACCOUNT_OFFERS.includes(item)), offer] };
  writeAppConfigStrict(cfg);
}

/** Shows an offer again: signing out returns the reader to where the
 *  sign-in banner first found them. */
export function forgetAccountOfferSeen(offer: HostedAccountOffer): void {
  const cfg = readAppConfigStrict();
  const seen = cfg.account?.offersSeen;
  if (!Array.isArray(seen) || !seen.includes(offer)) return;
  cfg.account = { ...cfg.account, offersSeen: seen.filter((item) => item !== offer) };
  writeAppConfigStrict(cfg);
}

/** Development reset: the next launch behaves like a first one for banners. */
export function resetAccountOffers(): void {
  const cfg = readAppConfigStrict();
  if (!cfg.account?.offersSeen) return;
  delete cfg.account.offersSeen;
  if (Object.keys(cfg.account).length === 0) delete cfg.account;
  writeAppConfigStrict(cfg);
}

/** Key presence only; authentication, connectivity, and index readiness are separate. */
export function isEmbeddingConfigured(): boolean {
  return !!getEmbedderConfig().apiKey;
}

/** Request backfill on first key setup or a provider change; rotation preserves vectors. */
export function shouldBackfillAfterKeyChange(
  previous: EmbedderProvider,
  next: EmbedderProvider,
  previouslyConfigured: boolean,
): boolean {
  return previous !== next || !previouslyConfigured;
}

export function getEmbedderConfig(): EmbedderConfig {
  const cfg = readAppConfig();
  const provider = isEmbedderProvider(cfg.embedder?.provider) ? cfg.embedder.provider : 'openai';
  const defaults = EMBEDDER_DEFAULTS[provider];
  const rawKey = cfg.embedder?.apiKey;
  const apiKey = typeof rawKey === 'string' && rawKey.trim() ? rawKey.trim() : undefined;
  const model = defaults.model;
  const baseUrl = defaults.baseUrl;
  return {
    provider,
    apiKey,
    model,
    dimension: defaults.dimension,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

/** Persist (or clear, when `key` is falsy) the active embedding key. */
export function setApiKey(key: string | undefined, provider: EmbedderProvider = getEmbedderConfig().provider): void {
  setEmbedderConfig({ provider, apiKey: key });
}

export function setEmbedderConfig(next: { provider: EmbedderProvider; apiKey?: string }): EmbedderConfig {
  const cfg = readAppConfigStrict();
  const defaults = EMBEDDER_DEFAULTS[next.provider];
  cfg.embedder = {
    provider: next.provider,
    model: defaults.model,
    ...(defaults.baseUrl ? { baseUrl: defaults.baseUrl } : {}),
  };
  if (next.apiKey && next.apiKey.trim()) cfg.embedder.apiKey = next.apiKey.trim();
  else delete cfg.embedder.apiKey;
  writeAppConfigStrict(cfg);
  return getEmbedderConfig();
}

export function getEmbedderProvider(): EmbedderProvider {
  return getEmbedderConfig().provider;
}



export { normalizeAppearancePreferences };

export function getAppearancePreferences(): AppearancePreferences {
  return normalizeAppearancePreferences(readAppConfig().appearance);
}

export function setAppearancePreferences(next: Partial<AppearancePreferences>): AppearancePreferences {
  const cfg = readAppConfigStrict();
  const current = normalizeAppearancePreferences(cfg.appearance);
  const resolved = normalizeAppearancePreferences({ ...current, ...next });
  cfg.appearance = resolved;
  writeAppConfigStrict(cfg);
  return resolved;
}

export function normalizeWorkspacePreferences(value: unknown): WorkspacePreferences {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<WorkspacePreferences>
    : {};
  return {
    showHiddenFiles: typeof raw.showHiddenFiles === 'boolean'
      ? raw.showHiddenFiles
      : DEFAULT_WORKSPACE_PREFERENCES.showHiddenFiles,
  };
}

/** Fallback read: an unreadable config must fail safe to the default view
 *  rather than block folder listings. */
export function getWorkspacePreferences(): WorkspacePreferences {
  return normalizeWorkspacePreferences(readAppConfig().workspace);
}

/** Strict read-modify-write: a malformed config fails the toggle instead of
 *  being silently replaced with defaults. */
export function setWorkspacePreferences(next: Partial<WorkspacePreferences>): WorkspacePreferences {
  const cfg = readAppConfigStrict();
  const resolved = normalizeWorkspacePreferences({
    ...normalizeWorkspacePreferences(cfg.workspace),
    ...next,
  });
  cfg.workspace = resolved;
  writeAppConfigStrict(cfg);
  return resolved;
}

export function normalizeUpdatePreferences(value: unknown): UpdatePreferences {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<UpdatePreferences>
    : {};
  return {
    autoCheck: typeof raw.autoCheck === 'boolean'
      ? raw.autoCheck
      : DEFAULT_UPDATE_PREFERENCES.autoCheck,
  };
}

export interface UpdatePreferencesStore {
  get(): UpdatePreferences;
  set(next: Partial<UpdatePreferences>): UpdatePreferences;
}

export function createUpdatePreferencesStore(io: {
  read(): AppConfigFile;
  write(config: AppConfigFile): void;
}): UpdatePreferencesStore {
  return {
    get: () => normalizeUpdatePreferences(io.read().updates),
    set(next) {
      const config = io.read();
      const resolved = normalizeUpdatePreferences({
        ...normalizeUpdatePreferences(config.updates),
        ...next,
      });
      config.updates = resolved;
      io.write(config);
      return resolved;
    },
  };
}

const updatePreferences = createUpdatePreferencesStore({
  // Writes and their read-modify-write precondition must fail closed on a
  // malformed or inaccessible config instead of replacing it with defaults.
  read: readAppConfigStrict,
  write: writeAppConfigStrict,
});

export function getUpdatePreferences(): UpdatePreferences {
  return updatePreferences.get();
}

export function setUpdatePreferences(next: Partial<UpdatePreferences>): UpdatePreferences {
  return updatePreferences.set(next);
}
