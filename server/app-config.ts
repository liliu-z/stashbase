/**
 * App-level config persistence — the single `~/.stashbase/config.json`.
 * Writes enforce owner-only POSIX permissions; Windows relies on the user's
 * profile ACL. This module owns the file primitives and the user-preference
 * accessors (API keys, terminal CLI, embedder provider); `folder.ts`
 * reuses the same primitives for library membership. Extracted from folder.ts:
 * credentials and preferences have nothing to do with the folder registry, and
 * routes that only need a key shouldn't import the whole window-context machinery.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger, errorMessage } from './log.ts';
import { normalizeTranscriptionLanguage } from '../shared/transcription.ts';
import type { LocalTranscriptionModelId } from '../shared/transcription.ts';
import transcriptionToolchain from '../native/transcription/toolchain.json' with { type: 'json' };

const log = logger('app-config');

const CONFIG_DIR = path.join(os.homedir(), '.stashbase');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface RecentFolder {
  path: string;
  openedAt: string;
  /** User-starred in the Welcome library list. Absent = not a favorite. */
  favorite?: boolean;
}

export type EmbedderProvider = 'openai' | 'openrouter';
export type EmbeddingSource = EmbedderProvider | 'stashbase-account';
export type TranscriptionModelId = LocalTranscriptionModelId;
export type AppearanceTheme = 'system' | 'light' | 'dark';
export type AppearanceScale = 'small' | 'default' | 'large';

export interface AppearancePreferences {
  theme: AppearanceTheme;
  uiScale: AppearanceScale;
  readingTextSize: AppearanceScale;
}

export interface CapturePreferences {
  /** Offer focused-window clipboard images for explicit library import. */
  clipboardImageImport: boolean;
}

export interface UpdatePreferences {
  /** Check the official desktop release channel after launch and periodically. */
  autoCheck: boolean;
}

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  theme: 'system',
  uiScale: 'default',
  readingTextSize: 'default',
};

export const DEFAULT_CAPTURE_PREFERENCES: CapturePreferences = {
  clipboardImageImport: false,
};

export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = {
  autoCheck: true,
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
  /** NOTE: the legacy `folderHome` field is no longer read or written — the
   *  configurable folder-home concept is gone. Existing configs may still carry
   *  it on disk; it is ignored. The default folder home is now a fixed,
   *  non-configurable path (see `folder.ts:getFolderHome`). */
  recentFolders?: RecentFolder[];
  /** Legacy field from when the concept was called "vault". Read for
   *  back-compat (existing users keep their recents) and rewritten as
   *  `recentFolders` on the next write. */
  recentVaults?: RecentFolder[];
  apiKey?: string;
  /** Library-wide embedding endpoint. `apiKey` at the top level and
   *  `openaiKey` are legacy OpenAI-only fields; new writes use
   *  `embedder.apiKey` so OpenRouter can be selected without overloading
   *  the old name. */
  embedder?: {
    provider?: EmbedderProvider;
    apiKey?: string;
    openaiKey?: string;
    model?: string;
    baseUrl?: string;
  };
  /** Active AI Index funding source. BYOK credentials and the account
   * session are retained independently so switching never destroys the
   * other option or silently falls back after a hosted failure. */
  embeddingSource?: EmbeddingSource;
  account?: {
    session?: HostedAccountSession;
  };
  /** Legacy last-used agent field. No longer written or read by the
   *  chat panel; kept so old config files parse without churn. */
  terminalCli?: string;
  /** Set once the bundled built-in folder (the product manual) has been
   *  seeded into a fresh folder home on first launch. A latch, not live state:
   *  it stays true even if the user later deletes the folder, so we
   *  never recreate it behind their back. See `seedBuiltinFolder`. */
  builtinSeeded?: boolean;
  /** Settings-managed bearer credential and explicit exposure preference for
   *  the Streamable HTTP MCP transport. The token lives beside the existing
   *  API key so config.json remains the only persistent app config file. */
  mcpHttp?: {
    token?: string;
    dockerAccess?: boolean;
    dockerPort?: number;
  };
  /** Local audio-transcription preferences. Model weights themselves live
   *  under AppData and are managed explicitly from Settings. */
  transcription?: {
    /** Provider ids are registry keys; only whisper.cpp is registered in the
     * current product, while the persisted shape does not assume local-only
     * inference. */
    providerId?: string;
    modelId?: string;
    /** Whisper language code or `auto`. */
    language?: string;
  };
  /** Bounded, user-wide presentation preferences. These deliberately avoid
   * arbitrary theme, font, spacing, and layout customization. */
  appearance?: Partial<AppearancePreferences>;
  /** Explicit opt-ins for ambient capture. Absent and invalid values fail
   * closed so upgrades never begin reading the clipboard automatically. */
  capture?: Partial<CapturePreferences>;
  /** Desktop release checks are enabled by default. The Electron main process
   * reads this through the local server so this process remains the sole
   * config writer. */
  updates?: Partial<UpdatePreferences>;
  onboarding?: OnboardingPreferences;
}

export interface OnboardingPreferences {
  sourceCodeNoticeVersion?: number;
  unsupportedFormatsNoticeVersion?: number;
}

export function readAppConfigStrict(): AppConfigFile {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${CONFIG_FILE} must contain a JSON object`);
    }
    // Migrate `recentVaults` → `recentFolders` on read so legacy users
    // don't lose their list when the rename rolls out.
    if (parsed.recentVaults && !parsed.recentFolders) {
      parsed.recentFolders = parsed.recentVaults;
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

// SINGLE-WRITER CONSTRAINT: only the web server process writes the
// config (the :8090 port bind already guarantees one instance). The MCP
// host (mcp/server.ts) must stay read-only — read-modify-write here is
// not cross-process safe (last write wins), and the tmp+rename below
// only protects against torn writes, not lost updates. If the MCP host
// ever needs to write config, add real cross-process locking first.
export function writeAppConfig(cfg: AppConfigFile): void {
  try {
    writeAppConfigStrict(cfg);
  } catch (err: any) {
    log.warn(`failed to persist config: ${errorMessage(err)}`);
  }
}

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
  return { ...raw };
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

export function getEmbeddingSource(): EmbeddingSource {
  const cfg = readAppConfig();
  const value = cfg.embeddingSource;
  if (value === 'stashbase-account' || isEmbedderProvider(value)) return value;
  const direct = getEmbedderConfig();
  if (direct.apiKey) return direct.provider;
  if (getHostedAccountSession()) return 'stashbase-account';
  return direct.provider;
}

export function setEmbeddingSource(source: EmbeddingSource): EmbeddingSource {
  const cfg = readAppConfigStrict();
  if (source === 'stashbase-account') {
    if (!getHostedAccountSession()) throw new Error('Sign in before selecting the StashBase account allowance.');
  } else {
    const direct = getEmbedderConfig();
    if (!direct.apiKey || direct.provider !== source) throw new Error(`Add a ${source === 'openrouter' ? 'OpenRouter' : 'OpenAI'} key before selecting it.`);
  }
  cfg.embeddingSource = source;
  writeAppConfigStrict(cfg);
  return source;
}

export function isEmbeddingConfigured(): boolean {
  const source = getEmbeddingSource();
  if (source === 'stashbase-account') return !!getHostedAccountSession();
  const direct = getEmbedderConfig();
  return direct.provider === source && !!direct.apiKey;
}

export function getEmbedderConfig(): EmbedderConfig {
  const cfg = readAppConfig();
  const provider = isEmbedderProvider(cfg.embedder?.provider) ? cfg.embedder.provider : 'openai';
  const defaults = EMBEDDER_DEFAULTS[provider];
  const rawKey = cfg.embedder?.apiKey
    ?? (provider === 'openai' ? cfg.apiKey ?? cfg.embedder?.openaiKey : undefined);
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
    ...(cfg.embedder ?? {}),
    provider: next.provider,
    model: defaults.model,
    ...(defaults.baseUrl ? { baseUrl: defaults.baseUrl } : {}),
  };
  if (next.apiKey && next.apiKey.trim()) cfg.embedder.apiKey = next.apiKey.trim();
  else delete cfg.embedder.apiKey;
  delete cfg.embedder.openaiKey;
  if (next.provider === 'openai' && cfg.embedder.apiKey) cfg.apiKey = cfg.embedder.apiKey;
  else delete cfg.apiKey;
  if (cfg.embedder.apiKey) cfg.embeddingSource = next.provider;
  else if (cfg.embeddingSource === next.provider) {
    cfg.embeddingSource = cfg.account?.session ? 'stashbase-account' : next.provider;
  }
  writeAppConfigStrict(cfg);
  return getEmbedderConfig();
}

export function getEmbedderProvider(): EmbedderProvider {
  return getEmbedderConfig().provider;
}

export interface TranscriptionPreferences {
  providerId: string;
  modelId: string;
  language: string;
}

const TRANSCRIPTION_MODEL_IDS = new Set<TranscriptionModelId>(['tiny', 'base', 'small']);

export function getTranscriptionPreferences(): TranscriptionPreferences {
  const raw = readAppConfig().transcription;
  const providerId = typeof raw?.providerId === 'string' && raw.providerId.trim()
    ? raw.providerId.trim()
    : transcriptionToolchain.providerId;
  const modelId = typeof raw?.modelId === 'string' && raw.modelId.trim()
    ? raw.modelId.trim()
    : 'small';
  const language = normalizeTranscriptionLanguage(raw?.language) ?? 'auto';
  return { providerId, modelId, language };
}

export function setTranscriptionPreferences(next: Partial<TranscriptionPreferences>): TranscriptionPreferences {
  const current = getTranscriptionPreferences();
  const providerId = next.providerId?.trim() || current.providerId;
  const modelId = next.modelId ?? current.modelId;
  if (!providerId) throw new Error('transcription provider id is required');
  if (providerId === transcriptionToolchain.providerId && !TRANSCRIPTION_MODEL_IDS.has(modelId as TranscriptionModelId)) {
    throw new Error(`unsupported transcription model: ${modelId}`);
  }
  const language = next.language === undefined
    ? current.language
    : normalizeTranscriptionLanguage(next.language);
  if (!language) throw new Error('transcription language must be `auto` or a language code');
  const cfg = readAppConfigStrict();
  cfg.transcription = { providerId, modelId, language };
  writeAppConfigStrict(cfg);
  return { providerId, modelId, language };
}

function isAppearanceTheme(value: unknown): value is AppearanceTheme {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isAppearanceScale(value: unknown): value is AppearanceScale {
  return value === 'small' || value === 'default' || value === 'large';
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
  };
}

export interface AppearancePreferencesStore {
  get(): AppearancePreferences;
  set(next: Partial<AppearancePreferences>): AppearancePreferences;
}

/** The small injected seam keeps preference recovery and persistence testable
 * without coupling tests to the user's actual config file. */
export function createAppearancePreferencesStore(io: {
  read(): AppConfigFile;
  write(config: AppConfigFile): void;
}): AppearancePreferencesStore {
  return {
    get: () => normalizeAppearancePreferences(io.read().appearance),
    set(next) {
      const current = normalizeAppearancePreferences(io.read().appearance);
      const resolved = normalizeAppearancePreferences({ ...current, ...next });
      const config = io.read();
      config.appearance = resolved;
      io.write(config);
      return resolved;
    },
  };
}

const appearancePreferences = createAppearancePreferencesStore({
  read: readAppConfig,
  write: writeAppConfigStrict,
});

export function getAppearancePreferences(): AppearancePreferences {
  return appearancePreferences.get();
}

export function setAppearancePreferences(next: Partial<AppearancePreferences>): AppearancePreferences {
  const cfg = readAppConfigStrict();
  const current = normalizeAppearancePreferences(cfg.appearance);
  const resolved = normalizeAppearancePreferences({ ...current, ...next });
  cfg.appearance = resolved;
  writeAppConfigStrict(cfg);
  return resolved;
}

export function normalizeCapturePreferences(value: unknown): CapturePreferences {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<CapturePreferences>
    : {};
  return {
    clipboardImageImport: typeof raw.clipboardImageImport === 'boolean'
      ? raw.clipboardImageImport
      : DEFAULT_CAPTURE_PREFERENCES.clipboardImageImport,
  };
}

export interface CapturePreferencesStore {
  get(): CapturePreferences;
  set(next: Partial<CapturePreferences>): CapturePreferences;
}

export function createCapturePreferencesStore(io: {
  read(): AppConfigFile;
  write(config: AppConfigFile): void;
}): CapturePreferencesStore {
  return {
    get: () => normalizeCapturePreferences(io.read().capture),
    set(next) {
      const config = io.read();
      const resolved = normalizeCapturePreferences({
        ...normalizeCapturePreferences(config.capture),
        ...next,
      });
      config.capture = resolved;
      io.write(config);
      return resolved;
    },
  };
}

const capturePreferences = createCapturePreferencesStore({
  read: readAppConfig,
  write: writeAppConfigStrict,
});

export function getCapturePreferences(): CapturePreferences {
  return capturePreferences.get();
}

export function setCapturePreferences(next: Partial<CapturePreferences>): CapturePreferences {
  const cfg = readAppConfigStrict();
  const resolved = normalizeCapturePreferences({
    ...normalizeCapturePreferences(cfg.capture),
    ...next,
  });
  cfg.capture = resolved;
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

/** One-time upgrade from the very first global-embedder schema, when
 *  the OpenAI key lived under `embedder.openaiKey` instead of the
 *  top-level `apiKey`. Migrates that key forward and drops the
 *  sub-field. Safe to call repeatedly. */
export function migrateLegacyEmbedderConfig(): void {
  const cfg = readAppConfig();
  if (!cfg.embedder?.openaiKey) return;
  const oldKey = cfg.embedder.openaiKey;
  if (typeof oldKey === 'string' && oldKey.trim() && !cfg.embedder.apiKey && !cfg.apiKey) {
    cfg.embedder.apiKey = oldKey.trim();
    cfg.apiKey = oldKey.trim();
  }
  cfg.embedder.provider = 'openai';
  cfg.embedder.model = EMBEDDER_DEFAULTS.openai.model;
  delete cfg.embedder.openaiKey;
  writeAppConfig(cfg);
  log.info('migrated legacy embedder.openaiKey into active embedder config');
}

export function getOnboardingPreferences(): OnboardingPreferences {
  return readAppConfig().onboarding ?? {};
}

export function setOnboardingPreferences(next: Partial<OnboardingPreferences>): OnboardingPreferences {
  const cfg = readAppConfigStrict();
  const current = cfg.onboarding ?? {};
  const updated = {
    ...current,
    ...next,
  };
  cfg.onboarding = updated;
  writeAppConfigStrict(cfg);
  return updated;
}
