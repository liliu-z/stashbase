/**
 * Space registry + config persistence.
 *
 * Single layer of persistent config — everything lives in the global
 * `~/.stashbase/config.json` (0600):
 *   - `recentSpaces`      most-recent first, capped at MAX_RECENT
 *   - `apiKey`            user-level OpenAI key
 *   - `embedder.provider` library-wide embedder choice (onnx | openai)
 *
 * The provider is library-wide: switching re-embeds every space
 * (background, fire-and-forget). Existing vectors in the old
 * (provider, dim) collection stay searchable until the re-embed
 * finishes — see the multi-collection notes in `routes/embedder.ts`.
 *
 * Default provider when unset: `openai`. If no key is configured the
 * runtime silently falls back to onnx (the UI pops a modal asking the
 * user to add one).
 *
 * The currently-open space is in-memory only — server restart goes
 * back to the welcome screen. Other modules subscribe to switches via
 * `onSwitch()`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { logger, errorMessage } from './log.ts';

const log = logger('space');

const CONFIG_DIR = path.join(os.homedir(), '.stashbase');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const MAX_RECENT = 10;

/** Default KB root: `~/Documents/StashBase/`. All spaces must live
 *  under this folder. Persisted in `config.json` so a future "change
 *  library location" UI can edit it; for now it's just the constant. */
const DEFAULT_KB_ROOT = path.join(os.homedir(), 'Documents', 'StashBase');
export const WINDOW_ID_HEADER = 'x-stashbase-window-id';

export interface RecentSpace {
  path: string;
  openedAt: string;
}

export type EmbedderProvider = 'onnx' | 'openai';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface SpaceConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
  skillsDirs?: string[];
}

interface ConfigFile extends SpaceConfigFile {
  /** Absolute path of the library root. All spaces must live under it.
   *  Defaults to `~/Documents/StashBase/`; persisted so a future UI
   *  can rebase it without changing code. */
  kbRoot?: string;
  recentSpaces?: RecentSpace[];
  /** Legacy field from when the concept was called "vault". Read for
   *  back-compat (existing users keep their recents) and rewritten as
   *  `recentSpaces` on the next write. */
  recentVaults?: RecentSpace[];
  apiKey?: string;
  /** Embedder provider is library-wide (one collection family per
   *  provider on the daemon). `openaiKey` is a leftover from the very
   *  first global-config schema — its content moved into the top-level
   *  `apiKey` on read; we keep the type loose so legacy reads don't
   *  trip the parser. */
  embedder?: { provider?: EmbedderProvider; openaiKey?: string };
  /** Currently selected CLI for the right-side terminal panel. The
   *  server knows the canonical registry; this just records which
   *  entry the user last picked. Defaults to 'claude'. */
  terminalCli?: string;
}

const DEFAULT_WINDOW_ID = 'default';
const requestWindow = new AsyncLocalStorage<string>();
const currentSpaces = new Map<string, string>();
const switchListeners: Array<(newRoot: string, windowId: string) => void> = [];
const closeListeners: Array<(oldRoot: string, windowId: string) => void> = [];
const kbRootListeners: Array<(newRoot: string) => void | Promise<void>> = [];

export function runWithWindowId<T>(windowId: string | null | undefined, fn: () => T): T {
  return requestWindow.run(normalizeWindowId(windowId), fn);
}

export function currentWindowId(): string {
  return requestWindow.getStore() ?? DEFAULT_WINDOW_ID;
}

function normalizeWindowId(windowId: string | null | undefined): string {
  const raw = typeof windowId === 'string' ? windowId.trim() : '';
  return raw ? raw.slice(0, 128) : DEFAULT_WINDOW_ID;
}

// ---------- KB root (library folder) ----------

/** Absolute path of the KB root folder. Reads from config if set,
 *  otherwise the default `~/Documents/StashBase/`. Always returns a
 *  normalised path — caller can compare directly. */
export function getKbRoot(): string {
  const raw = readConfig().kbRoot;
  const p = typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_KB_ROOT;
  return path.resolve(p);
}

export function needsKbRootPicker(): boolean {
  const raw = readConfig().kbRoot;
  if (typeof raw === 'string' && raw.trim()) return false;
  return listAvailableSpaceNames().length === 0;
}

export async function setKbRoot(absPath: string, opts: { allowNonEmpty?: boolean } = {}): Promise<void> {
  if (typeof absPath !== 'string' || !absPath.trim()) throw new Error('path required');
  let expanded = absPath.trim();
  if (expanded === '~' || expanded.startsWith('~/')) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  if (!path.isAbsolute(expanded)) throw new Error('path must be absolute');
  const root = path.resolve(expanded);
  if (fs.existsSync(root) && !opts.allowNonEmpty) {
    if (!fs.statSync(root).isDirectory()) throw new Error('path is not a directory');
    const entries = fs.readdirSync(root);
    const selfEntries = new Set(['.DS_Store', '.stashbase', 'STASHBASE.md', 'AGENT.md', 'space-metadata.md']);
    if (entries.some((name) => !selfEntries.has(name))) {
      const err = new Error('directory is not empty');
      (err as any).code = 'NON_EMPTY';
      throw err;
    }
  }
  fs.mkdirSync(root, { recursive: true });
  if (!fs.statSync(root).isDirectory()) throw new Error('path is not a directory');
  ensureKbMetadata(root);
  const cfg = readConfig();
  cfg.kbRoot = root;
  cfg.recentSpaces = [];
  delete cfg.recentVaults;
  writeConfig(cfg);
  for (const [windowId, oldRoot] of currentSpaces.entries()) {
    for (const fn of closeListeners) {
      try { fn(oldRoot, windowId); } catch (err) {
        log.warn(`close listener threw: ${(err as any)?.message ?? err}`);
      }
    }
  }
  currentSpaces.clear();
  await Promise.all(kbRootListeners.map(async (fn) => {
    try { await fn(root); } catch (err) {
      log.warn(`kbRoot listener threw: ${(err as any)?.message ?? err}`);
    }
  }));
}

/** True if `absPath` is a **direct child** of the KB root. Spaces are
 *  flat: nesting isn't allowed, so `<root>/foo` is valid but
 *  `<root>/foo/bar` and the root itself are not. */
export function isUnderRoot(absPath: string): boolean {
  const root = getKbRoot();
  const target = path.resolve(absPath);
  if (target === root) return false;
  const rel = path.relative(root, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  // Reject anything deeper than one segment — spaces are flat under
  // the library root. Caller silently filters; the daemon/indexer
  // depend on the one-segment invariant for O(1) routing.
  if (rel.includes(path.sep)) return false;
  return true;
}

/** True if `absPath` lives anywhere inside the KB root (any depth).
 *  Use this for file-level operations on kbRoot-relative paths like
 *  `cs183b/lecture-01.md` — `isUnderRoot` rejects them because it
 *  enforces the one-segment space-boundary invariant. The kbRoot
 *  itself doesn't qualify (it's the container, not "inside" it). */
export function isInsideKbRoot(absPath: string): boolean {
  const root = getKbRoot();
  const target = path.resolve(absPath);
  if (target === root) return false;
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Validate a user-supplied space name. Names must be a single
 *  filesystem-safe segment (no slashes, no dots-only, no leading dot,
 *  no NUL). Returns null when valid, error message otherwise. */
export function validateSpaceName(name: string): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'name required';
  const n = name.trim();
  if (n === '.' || n === '..') return 'name cannot be "." or ".."';
  if (n.startsWith('.')) return 'name cannot start with "."';
  if (n.includes('/') || n.includes('\\')) return 'name cannot contain slashes';
  if (n.includes('\0')) return 'name cannot contain NUL';
  if (n.length > 64) return 'name too long (max 64 chars)';
  return null;
}

/** Internal entries under `.stashbase/` that **must** be wiped when a
 *  space arrives from elsewhere — a git clone or a folder import.
 *  These are per-machine state (embedder routing, the local vector store,
 *  the storage-state DB, the cache) and never portable. Everything else
 *  stays; `snapshot.parquet` lives here intentionally and is preserved.
 *  Shared by the clone and import-folder flows so a rename here only
 *  happens once. (`mfs` is the pre-rename store dir, kept until legacy
 *  spaces age out.) */
export const STASHBASE_PER_MACHINE_ENTRIES = ['config.json', 'store', 'mfs', 'cache', 'state.db'];

/** Selectively delete per-machine internal state out of a space's
 *  `.stashbase/` directory, leaving portable artefacts (notably
 *  `snapshot.parquet`) intact. No-op if the directory doesn't exist. */
export function pruneStashbasePerMachineState(stashbaseDir: string): void {
  if (!fs.existsSync(stashbaseDir)) return;
  for (const entry of STASHBASE_PER_MACHINE_ENTRIES) {
    fs.rmSync(path.join(stashbaseDir, entry), { recursive: true, force: true });
  }
}

/** Direct child directories of the KB root, sorted alphabetically.
 *  Powers the "Open space" dropdown — every entry is a candidate the
 *  server will accept as a space name. Dot-dirs are skipped (`.git`,
 *  `.stashbase`, etc.). Errors (root missing, permission) return []. */
export function listAvailableSpaceNames(): string[] {
  const root = getKbRoot();
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/** Current space's name, expressed as a kbRoot-relative POSIX path.
 *  E.g. `cs183b` or `work/research`. null if no space open.
 *
 *  This is the bridge between the rest of the server (which operates
 *  in space-relative paths) and the indexer (which uses kbRoot-relative
 *  paths so it can route to per-provider collections). See `toKbRel`
 *  / `fromKbRel`. */
export function getCurrentSpaceName(): string | null {
  const cs = getCurrentSpace();
  if (!cs) return null;
  const root = getKbRoot();
  if (cs === root) return null;
  const rel = path.relative(root, cs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** Convert a space-relative path (`topic/note.md`) to a kbRoot-relative
 *  one (`cs183b/topic/note.md`). Throws if no space is open — every
 *  call site should already be inside a request that has space context. */
export function toKbRel(spaceRel: string): string {
  const name = getCurrentSpaceName();
  if (!name) throw new Error('no space open');
  return spaceRel ? `${name}/${spaceRel}` : name;
}

/** Convert a kbRoot-relative path to a space-relative one, or null if
 *  the path doesn't fall under the current space. Used to translate
 *  daemon-returned paths (search hits, status lists) back into the
 *  space-relative form the UI expects. */
export function fromKbRel(kbRel: string): string | null {
  const name = getCurrentSpaceName();
  if (!name) return null;
  if (kbRel === name) return '';
  const prefix = `${name}/`;
  if (!kbRel.startsWith(prefix)) return null;
  return kbRel.slice(prefix.length);
}

/** Direct-child spaces of the KB root that have been opened before
 *  (their directory contains a `.stashbase/` subdir). Returns
 *  kbRoot-relative names. Used at server boot to bind every known
 *  space so MCP cross-space search has them all available. */
export function listKnownSpaces(): string[] {
  const root = getKbRoot();
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const inner = path.join(root, e.name, '.stashbase');
    try {
      if (fs.statSync(inner).isDirectory()) out.push(e.name);
    } catch { /* not yet opened — skip */ }
  }
  out.sort();
  return out;
}

/** Idempotent startup hook:
 *   1. Ensure the KB root exists (mkdir -p).
 *   2. Prune `recentSpaces` entries that are outside the root —
 *      enforces the new invariant ("all spaces must live under the
 *      root") so old recents from the unrestricted era don't keep
 *      offering invalid one-click opens. Persists the trimmed list. */
export function ensureKbRoot(): void {
  const root = getKbRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
    ensureKbMetadata(root);
  } catch (err: any) {
    log.warn(`failed to create kbRoot ${root}: ${errorMessage(err)}`);
  }
  const cfg = readConfig();
  let dirty = false;
  if (typeof cfg.kbRoot !== 'string' || !cfg.kbRoot.trim()) {
    cfg.kbRoot = root;
    dirty = true;
  }
  const before = cfg.recentSpaces ?? [];
  const after = before.filter((r) => isUnderRoot(r.path));
  if (after.length !== before.length) {
    cfg.recentSpaces = after;
    dirty = true;
    log.info(`pruned ${before.length - after.length} out-of-root recent(s) (kbRoot=${root})`);
  }
  if (dirty) writeConfig(cfg);
}

export function getSpaceRootPath(spaceName: string): string {
  const bad = validateSpaceName(spaceName);
  if (bad) throw new Error(bad);
  return path.join(getKbRoot(), spaceName);
}

export function spaceExists(spaceName: string): boolean {
  try {
    return fs.statSync(getSpaceRootPath(spaceName)).isDirectory();
  } catch {
    return false;
  }
}

export function requireSpaceExistsByName(spaceName: string): string {
  const root = getSpaceRootPath(spaceName);
  try {
    if (fs.statSync(root).isDirectory()) return root;
  } catch {
    /* fall through */
  }
  const err = new Error('space not found');
  (err as any).code = 'SPACE_NOT_FOUND';
  throw err;
}

/** Absolute path of the currently open space, or null if none. */
export function getCurrentSpace(): string | null {
  return currentSpaces.get(currentWindowId()) ?? null;
}

/** Throws if no space is open — call this from request handlers that
 *  need space state. The thrown error carries a `code` so the route
 *  layer can map it to HTTP 412. */
export function requireCurrentSpace(): string {
  const currentSpace = getCurrentSpace();
  if (!currentSpace) {
    const err = new Error('no space open');
    (err as any).code = 'NO_SPACE';
    throw err;
  }
  return currentSpace;
}

/** Open a space at the given absolute path. Creates the directory if
 *  needed. Pushes to the recents list. Notifies switch listeners so
 *  cached resources can be reset. */
export function setCurrentSpace(absPath: string): void {
  if (typeof absPath !== 'string' || !absPath) throw new Error('path required');
  // Expand a leading `~` so the welcome screen can accept `~/Notes`
  // without forcing the user to spell out their home directory.
  let expanded = absPath;
  if (expanded === '~' || expanded.startsWith('~/')) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  if (!path.isAbsolute(expanded)) throw new Error('path must be absolute');
  const normalized = path.resolve(expanded);
  // Spaces are strictly constrained to live under the KB root. The
  // SpacePicker UI only surfaces in-root folders, but this check is
  // defence-in-depth for direct API hits / stale recent entries that
  // slipped through the boot prune.
  if (!isUnderRoot(normalized)) {
    throw new Error(`space must live under ${getKbRoot()}`);
  }
  // Opening a brand-new folder is a valid flow (user picked a fresh
  // location for a new knowledge base), but silently mkdir-ing an
  // arbitrary path turns "I typo'd ~/Notess" into a ghost directory.
  // Warn loudly when we create from scratch so it shows up in logs;
  // existing dirs pass through silently.
  const existed = fs.existsSync(normalized);
  if (!existed) {
    fs.mkdirSync(normalized, { recursive: true });
    log.warn(`created new space directory: ${normalized}`);
  }
  const st = fs.statSync(normalized);
  if (!st.isDirectory()) throw new Error('path is not a directory');

  ensureSpaceMetadata(normalized);
  const windowId = currentWindowId();
  const prev = currentSpaces.get(windowId) ?? null;
  const changed = prev !== normalized;
  currentSpaces.set(windowId, normalized);
  pushRecent(normalized);
  if (changed) {
    for (const fn of switchListeners) {
      try { fn(normalized, windowId); } catch (err) {
        log.warn(`switch listener threw: ${(err as any)?.message ?? err}`);
      }
    }
  }
}

export function clearCurrentSpace(windowId = currentWindowId()): void {
  const id = normalizeWindowId(windowId);
  const oldRoot = currentSpaces.get(id);
  currentSpaces.delete(id);
  if (oldRoot) {
    for (const fn of closeListeners) {
      try { fn(oldRoot, id); } catch (err) {
        log.warn(`close listener threw: ${(err as any)?.message ?? err}`);
      }
    }
  }
}

export function clearSpacePath(absPath: string): void {
  for (const [windowId, value] of [...currentSpaces.entries()]) {
    if (value === absPath) clearCurrentSpace(windowId);
  }
}

export function replaceCurrentSpacePath(oldPath: string, newPath: string): void {
  for (const [windowId, value] of currentSpaces.entries()) {
    if (value === oldPath) {
      currentSpaces.set(windowId, newPath);
      for (const fn of switchListeners) {
        try { fn(newPath, windowId); } catch (err) {
          log.warn(`switch listener threw: ${(err as any)?.message ?? err}`);
        }
      }
    }
  }
  const cfg = readConfig();
  if (cfg.recentSpaces?.length) {
    cfg.recentSpaces = cfg.recentSpaces.map((r) => (
      r.path === oldPath ? { ...r, path: newPath } : r
    ));
    writeConfig(cfg);
  }
}

/** Subscribe to space switches. The listener receives the absolute path
 *  of the newly-current space; fires after the switch is in place. */
export function onSwitch(fn: (newRoot: string, windowId: string) => void): void {
  switchListeners.push(fn);
}

export function onClose(fn: (oldRoot: string, windowId: string) => void): void {
  closeListeners.push(fn);
}

export function onKbRootChange(fn: (newRoot: string) => void | Promise<void>): void {
  kbRootListeners.push(fn);
}

export function getActiveSpaces(): { windowId: string; path: string }[] {
  return [...currentSpaces.entries()].map(([windowId, path]) => ({ windowId, path }));
}

/** Returns recent spaces, most-recent first. Filters out paths that no
 *  longer exist on disk OR have drifted outside the KB root (e.g. a
 *  user moved the library folder externally) so the Welcome list only
 *  shows one-click-openable spaces. */
export function getRecentSpaces(): RecentSpace[] {
  const all = readConfig().recentSpaces ?? [];
  return all.filter((v) => {
    if (!isUnderRoot(v.path)) return false;
    try { return fs.statSync(v.path).isDirectory(); } catch { return false; }
  });
}

function pushRecent(absPath: string): void {
  const cfg = readConfig();
  const list = cfg.recentSpaces ?? [];
  // Filter out the entry we're about to re-add (avoid dupes) AND
  // entries whose target folder no longer exists — keeps the persisted
  // recents from accumulating dead tmp dirs / deleted folders over
  // time. Opportunistic cleanup on every write.
  const filtered = list.filter((v) => {
    if (v.path === absPath) return false;
    try { return fs.statSync(v.path).isDirectory(); } catch { return false; }
  });
  filtered.unshift({ path: absPath, openedAt: new Date().toISOString() });
  cfg.recentSpaces = filtered.slice(0, MAX_RECENT);
  // Drop the legacy field once we've migrated its content forward.
  delete cfg.recentVaults;
  writeConfig(cfg);
}

function readConfig(): ConfigFile {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    // Migrate `recentVaults` → `recentSpaces` on read so legacy users
    // don't lose their list when the rename rolls out.
    if (parsed.recentVaults && !parsed.recentSpaces) {
      parsed.recentSpaces = parsed.recentVaults;
    }
    return parsed as ConfigFile;
  } catch {
    return {};
  }
}

function writeConfig(cfg: ConfigFile): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const tmp = CONFIG_FILE + '.tmp';
    // 0600 — config may carry the OpenAI key; keep it owner-only.
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (err: any) {
    log.warn(`failed to persist config: ${errorMessage(err)}`);
  }
}

export function getSpaceConfigPath(spaceName: string): string {
  const bad = validateSpaceName(spaceName);
  if (bad) throw new Error(bad);
  return path.join(getKbRoot(), spaceName, '.stashbase', 'config.json');
}

export function readSpaceConfig(spaceName: string): SpaceConfigFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSpaceConfigPath(spaceName), 'utf8'));
    return sanitizeSpaceConfig(parsed);
  } catch {
    return {};
  }
}

export function writeSpaceConfig(spaceName: string, cfg: SpaceConfigFile): void {
  const file = getSpaceConfigPath(spaceName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(sanitizeSpaceConfig(cfg), null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export interface ResolvedSpaceConfig {
  mcpServers: Record<string, McpServerConfig>;
  skillsDirs: string[];
}

export function resolveSpaceConfig(spaceName: string): ResolvedSpaceConfig {
  const base = sanitizeSpaceConfig(readConfig());
  const local = readSpaceConfig(spaceName);
  return {
    mcpServers: { ...(base.mcpServers ?? {}), ...(local.mcpServers ?? {}) },
    skillsDirs: mergeSkillsDirs(base.skillsDirs, local.skillsDirs),
  };
}

function mergeSkillsDirs(base: string[] | undefined, local: string[] | undefined): string[] {
  const out: string[] = [];
  const push = (value: string) => {
    const v = value.trim();
    if (!v || path.isAbsolute(v) || v.includes('\0')) return;
    if (!out.includes(v)) out.push(v);
  };
  for (const v of base ?? []) push(v);
  for (const v of local ?? []) push(v);
  if (out.length === 0) out.push('skills');
  return out;
}

function sanitizeSpaceConfig(raw: unknown): SpaceConfigFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: SpaceConfigFile = {};
  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, value] of Object.entries(obj.mcpServers as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const v = value as Record<string, unknown>;
      if (typeof v.command !== 'string' || !v.command.trim()) continue;
      servers[name] = {
        command: v.command.trim(),
        ...(Array.isArray(v.args) ? { args: v.args.filter((a): a is string => typeof a === 'string') } : {}),
        ...(v.env && typeof v.env === 'object' && !Array.isArray(v.env)
          ? { env: Object.fromEntries(
              Object.entries(v.env as Record<string, unknown>)
                .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
            ) }
          : {}),
      };
    }
    out.mcpServers = servers;
  }
  if (Array.isArray(obj.skillsDirs)) {
    out.skillsDirs = obj.skillsDirs.filter((v): v is string => typeof v === 'string');
  }
  return out;
}

function ensureSpaceMetadata(spaceRoot: string): void {
  const stash = path.join(spaceRoot, '.stashbase');
  fs.mkdirSync(stash, { recursive: true });
  const config = path.join(stash, 'config.json');
  if (!fs.existsSync(config)) {
    fs.writeFileSync(config, JSON.stringify({ mcpServers: {}, skillsDirs: ['skills'] }, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
  // Auto-create an **empty** `<spaceRoot>/STASHBASE.md` by default
  // (user request, reversing the earlier "opt-in only" stance). Empty =
  // 0-byte on purpose: zero-byte notes are never indexed (see
  // `files.ts` FileEntry.size), so this adds no search noise and writes
  // no content the user didn't ask for — it's just a placeholder the
  // user or an agent fills in when the space needs its own rules. It's
  // reachable from the LibraryPanel per-space row and shows in the tree
  // as an empty file. Mirrors `ensureKbMetadata` for the KB root.
  const rules = path.join(spaceRoot, 'STASHBASE.md');
  if (!fs.existsSync(rules)) {
    fs.writeFileSync(rules, '', 'utf8');
  }
}

function ensureKbMetadata(root: string): void {
  const stash = path.join(root, '.stashbase');
  fs.mkdirSync(stash, { recursive: true });
  const ignore = path.join(stash, '.gitignore');
  const ignoreEntries = [
    'store/',
    'mfs/',
    'cache/',
    'state.db',
    'state.db-*',
    'pdf-status.json',
    'pdf-status.json.migrated',
  ];
  const existing = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = ignoreEntries.filter((entry) => !existingLines.has(entry));
  if (missing.length) {
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(ignore, `${existing}${prefix}${missing.join('\n')}\n`, 'utf8');
  }
  const rules = path.join(root, 'STASHBASE.md');
  if (!fs.existsSync(rules)) {
    fs.writeFileSync(rules, '# KB Rules\n\n', 'utf8');
  }
}

// ---------- API key (global) ----------

/** Returns the user's stored OpenAI key, or undefined if none. */
export function getApiKey(): string | undefined {
  const k = readConfig().apiKey;
  return k && typeof k === 'string' && k.trim() ? k : undefined;
}

/** Persist (or clear, when `key` is falsy) the user's OpenAI key. */
export function setApiKey(key: string | undefined): void {
  const cfg = readConfig();
  if (key && key.trim()) cfg.apiKey = key.trim();
  else delete cfg.apiKey;
  writeConfig(cfg);
}

/** Currently selected CLI for the terminal panel. Defaults to
 *  'claude' so a fresh install opens the most popular option. */
export function getTerminalCli(): string {
  const v = readConfig().terminalCli;
  return typeof v === 'string' && v ? v : 'claude';
}

export function setTerminalCli(id: string): void {
  if (typeof id !== 'string' || !id) throw new Error('cli id required');
  const cfg = readConfig();
  cfg.terminalCli = id;
  writeConfig(cfg);
}

// ---------- Embedder provider (global) ----------

/** Library-wide embedder provider. Defaults to `openai` when unset —
 *  Local is an explicit fallback the user has to pick, OpenAI is the
 *  default goal. When the user has no key, `resolveEmbedder` silently
 *  degrades to `onnx` and the UI pops a modal asking them to add one. */
export function getEmbedderProvider(): EmbedderProvider {
  const p = readConfig().embedder?.provider;
  if (p === 'onnx' || p === 'openai') return p;
  return 'openai';
}

/** Persist the library-wide provider. Callers are responsible for
 *  re-binding spaces + scheduling re-embeds — the file write itself
 *  doesn't touch Milvus. */
export function setEmbedderProvider(provider: EmbedderProvider): void {
  if (provider !== 'onnx' && provider !== 'openai') {
    throw new Error(`unsupported provider: ${provider}`);
  }
  const cfg = readConfig();
  cfg.embedder = { ...(cfg.embedder ?? {}), provider };
  writeConfig(cfg);
}

// ---------- Legacy migration ----------

/** One-time upgrade from the very first global-embedder schema, when
 *  the OpenAI key lived under `embedder.openaiKey` instead of the
 *  top-level `apiKey`. Migrates that key forward and drops the
 *  sub-field. The `embedder.provider` field is preserved — it's the
 *  canonical store again. Safe to call repeatedly. */
export function migrateLegacyEmbedderConfig(): void {
  const cfg = readConfig();
  if (!cfg.embedder?.openaiKey) return;
  const oldKey = cfg.embedder.openaiKey;
  if (typeof oldKey === 'string' && oldKey.trim() && !cfg.apiKey) {
    cfg.apiKey = oldKey.trim();
  }
  delete cfg.embedder.openaiKey;
  writeConfig(cfg);
  log.info('migrated legacy embedder.openaiKey into top-level apiKey');
}
