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
import { logger, errorMessage } from './log.ts';
import type {
  AppearancePreferences,
  AppearanceScale,
  AppearanceTheme,
  ReadingFont,
  UpdatePreferences,
  WorkspacePreferences,
} from '../shared/preferences.ts';
import type { EmbedderProvider } from '../shared/embedding.ts';
import { normalizeHostedDisplayName, parseGoogleAvatarUrl } from './hosted-account-profile.ts';

export type {
  AppearancePreferences,
  AppearanceScale,
  AppearanceTheme,
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

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  theme: 'system',
  uiScale: 'default',
  readingTextSize: 'default',
  readingFont: 'serif',
};

export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = {
  autoCheck: true,
};

export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
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
  refreshToken: string;
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
  agentPreferences?: Array<{
    scope: string;
    agent: 'stashbase' | 'codex' | 'claude';
    efforts?: Partial<Record<'stashbase' | 'codex' | 'claude', string | null>>;
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
  };
  /** Settings-managed bearer credential and explicit exposure preference for
   *  the Streamable HTTP MCP transport. The token lives beside the existing
   *  API key so config.json remains the only persistent app config file. */
  mcpHttp?: {
    token?: string;
    dockerAccess?: boolean;
    dockerPort?: number;
  };
  /** Bounded, user-wide presentation preferences. These deliberately avoid
   * arbitrary theme, font, spacing, and layout customization. */
  appearance?: Partial<AppearancePreferences>;
  /** Application-level Workbench visibility preferences. Absent and invalid
   * values fail closed to the default safe view. */
  workspace?: Partial<WorkspacePreferences>;
  /** Desktop release checks are enabled by default. The Electron main process
   * reads this through the local server so this process remains the sole
   * config writer. */
  updates?: Partial<UpdatePreferences>;
  /** Each project's chosen Agent Persona and its custom prompt, owned by
   * StashBase. Folder entries use the exact spelling of project membership
   * paths; no project file is created. See `agent-persona.ts`. */
  agentPersonas?: {
    folders?: Array<{ path: string; selected?: string; custom?: string }>;
  };
  /** Each native runtime's last-read model catalog and the model it last ran
   * with nothing chosen. A memory rather than a preference: losing it costs
   * one runtime-level read, and no route accepts it from a request body. See
   * `agent-model-catalog.ts`. */
  agentModelCatalogs?: Partial<Record<'claude' | 'codex', AgentModelCatalog>>;
}

export function readAppConfigStrict(): AppConfigFile {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
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

export async function readAppConfigStrictAsync(): Promise<AppConfigFile> {
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
  const tmp = `${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    // 0600 — config may carry API keys; keep it owner-only.
    fs.writeFileSync(tmp, serialized, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, CONFIG_FILE);
    if (process.platform !== 'win32') {
      try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* best effort on special filesystems */ }
    }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
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
    typeof raw.refreshToken !== 'string' || !raw.refreshToken ||
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
    refreshToken: raw.refreshToken,
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



function isAppearanceTheme(value: unknown): value is AppearanceTheme {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isAppearanceScale(value: unknown): value is AppearanceScale {
  return value === 'small' || value === 'default' || value === 'large';
}

function isReadingFont(value: unknown): value is ReadingFont {
  return value === 'serif' || value === 'sans';
}

/** Resolve persisted presentation values defensively so a hand-edited or
 * legacy config cannot prevent Settings from loading. */
export function normalizeAppearancePreferences(value: unknown): AppearancePreferences {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<AppearancePreferences>
    : {};
  return {
    theme: isAppearanceTheme(raw.theme) ? raw.theme : DEFAULT_APPEARANCE_PREFERENCES.theme,
    uiScale: isAppearanceScale(raw.uiScale) ? raw.uiScale : DEFAULT_APPEARANCE_PREFERENCES.uiScale,
    readingTextSize: isAppearanceScale(raw.readingTextSize)
      ? raw.readingTextSize
      : DEFAULT_APPEARANCE_PREFERENCES.readingTextSize,
    readingFont: isReadingFont(raw.readingFont)
      ? raw.readingFont
      : DEFAULT_APPEARANCE_PREFERENCES.readingFont,
  };
}

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
