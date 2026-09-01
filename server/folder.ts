/**
 * Folder registry, window context, and folder-home management.
 *
 * Persistence reuses `app-config.ts`'s `~/.stashbase/config.json`
 * primitives for library membership; credentials and user preferences
 * (API keys, terminal CLI) live in app-config.ts entirely.
 *
 * The currently-open folder is in-memory only — server restart goes
 * back to the welcome screen. Other modules subscribe to switches via
 * `onSwitch()`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { logger, errorMessage } from './log.ts';
import { copyDirectoryDereferenced } from './fs-move.ts';
import { isIndexExcludedDirName } from './indexable.ts';
import { filesystemPath } from './filesystem-path.ts';
import {
  readAppConfig as readConfig,
  readAppConfigAsync as readConfigAsync,
  readAppConfigStrict as readConfigStrict,
  writeAppConfigStrict as writeConfigStrict,
  type AppConfigFile,
  type RecentFolder,
} from './app-config.ts';

// Type re-exports so existing `from './folder.ts'` type imports keep
// working; the values live in app-config.ts.
export type { EmbedderProvider, RecentFolder } from './app-config.ts';

const log = logger('folder');

const MAX_RECENT = 50;

export const WINDOW_ID_HEADER = 'x-stashbase-window-id';

/** Folder name of the bundled product introduction, seeded into a brand-new
 *  default folder home and added to library membership without selecting it.
 *  Doubles as the disk directory name and the library label. */
const BUILTIN_FOLDER_NAME = '👋 Start Here';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Where bundled assets live. Packaged: `extraResources` under
 *  `process.resourcesPath` (injected via `STASHBASE_RESOURCES_PATH`).
 *  Dev: the project root. Mirrors `mfs-daemon.ts`'s resolution. */
const RESOURCES_ROOT = process.env.STASHBASE_RESOURCES_PATH
  ? path.resolve(process.env.STASHBASE_RESOURCES_PATH)
  : process.env.STASHBASE_APP_ROOT
    ? path.resolve(process.env.STASHBASE_APP_ROOT)
    : path.resolve(__dirname, '..');

const DEFAULT_WINDOW_ID = 'default';
const MAX_RETIRED_WINDOW_IDS = 2048;
const requestWindow = new AsyncLocalStorage<string>();
const currentFolders = new Map<string, string>();
const retiredWindowIds = new Map<string, number>();
const removingFolders = new Map<string, string>();
const switchListeners: Array<(newRoot: string, windowId: string) => void> = [];
const closeListeners: Array<(oldRoot: string, windowId: string) => void> = [];

export function runWithWindowId<T>(windowId: string | null | undefined, fn: () => T): T {
  return requestWindow.run(normalizeWindowId(windowId), fn);
}

function notifySwitchListeners(newRoot: string, windowId: string): void {
  setImmediate(() => {
    for (const fn of switchListeners) {
      try { fn(newRoot, windowId); } catch (err) {
        log.warn(`switch listener threw: ${(err as any)?.message ?? err}`);
      }
    }
  });
}

export function notifyFolderSwitch(newRoot: string, windowId = currentWindowId()): void {
  notifySwitchListeners(newRoot, normalizeWindowId(windowId));
}

/** Run a backend operation against an arbitrary **absolute** folder root
 *  (a member of "Your Folders", which can live anywhere on disk), without
 *  changing any user window. The MCP file layer uses this so its host-side
 *  file ops resolve against the right member folder — the filesystem layer
 *  (`files.ts`) is already rooted at `getCurrentFolder()`, so setting the
 *  window's current folder to `absRoot` is all that's needed. */
/** In-flight request count per synthetic `__folder:` binding. The binding's
 *  value is fully determined by its id, so concurrent requests share one
 *  entry — an early finisher must not delete it out from under a sibling
 *  (an iframe's parallel asset fetches hit exactly that). */
const syntheticFolderRefs = new Map<string, number>();

export async function runWithFolderRoot<T>(
  absRoot: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const root = await resolveFolderRootAsync(absRoot);
  return runWithWindowId(`__folder:${root}`, async () => {
    const windowId = currentWindowId();
    syntheticFolderRefs.set(windowId, (syntheticFolderRefs.get(windowId) ?? 0) + 1);
    currentFolders.set(windowId, root);
    try {
      return await fn();
    } finally {
      const remaining = (syntheticFolderRefs.get(windowId) ?? 1) - 1;
      if (remaining <= 0) {
        syntheticFolderRefs.delete(windowId);
        currentFolders.delete(windowId);
      } else {
        syntheticFolderRefs.set(windowId, remaining);
      }
    }
  });
}

export function currentWindowId(): string {
  return requestWindow.getStore() ?? DEFAULT_WINDOW_ID;
}

/** Absolute POSIX roots of every member folder ("Your Folders"). The MCP
 *  layer scopes file/search ops to these — a path must live under one. */
export function memberFolderRoots(): string[] {
  return getRecentFolders().map((r) => filesystemPath.absolute(r.path));
}

export async function memberFolderRootsAsync(): Promise<string[]> {
  return (await getRecentFoldersAsync()).map((r) => filesystemPath.absolute(r.path));
}

/** Config JSON is external durable input. Keep malformed/legacy empty path
 * values from reaching the strict filesystem-path API; valid path semantics
 * still come exclusively from that module. */
function storedFolderPathEquals(value: unknown, target: string): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try { return filesystemPath.equal(value, target); } catch { return false; }
}

async function storedFolderPathEqualsAsync(value: unknown, target: string): Promise<boolean> {
  if (typeof value !== 'string' || !value.trim()) return false;
  try { return await filesystemPath.equalAsync(value, target); } catch { return false; }
}

/** Return the stored spelling of an exact library-member root. Windows callers
 * may supply drive, separator, or component case variants; downstream path-
 * keyed stores must continue from the one spelling kept in membership. */
export function exactMemberFolderRoot(abs: string): string | null {
  const target = filesystemPath.absolute(abs);
  return memberFolderRoots().find((root) => filesystemPath.equal(root, target)) ?? null;
}

/** Async request-path equivalent of `exactMemberFolderRoot()`. */
export async function exactMemberFolderRootAsync(abs: string): Promise<string | null> {
  const target = filesystemPath.absolute(abs);
  for (const root of await memberFolderRootsAsync()) {
    if (await filesystemPath.equalAsync(root, target)) return root;
  }
  return null;
}

/** The member folder (longest-prefix) that contains `abs`, or null when
 *  the path isn't inside any member folder. The longest-prefix rule keeps
 *  nested members (`<root>/foo` and `<root>/foo/bar` both opened) correct. */
export function memberRootForAbs(abs: string): string | null {
  const target = filesystemPath.absolute(abs);
  let best: string | null = null;
  for (const root of memberFolderRoots()) {
    if (filesystemPath.contains(root, target)) {
      if (!best || filesystemPath.identity(root).length > filesystemPath.identity(best).length) best = root;
    }
  }
  return best;
}

/** Async request-path equivalent of `memberRootForAbs()`. */
export async function memberRootForAbsAsync(abs: string): Promise<string | null> {
  const target = filesystemPath.absolute(abs);
  let best: string | null = null;
  for (const root of await memberFolderRootsAsync()) {
    if (await filesystemPath.containsAsync(root, target)) {
      if (!best || (await filesystemPath.identityAsync(root)).length > (await filesystemPath.identityAsync(best)).length) {
        best = root;
      }
    }
  }
  return best;
}

/** Resolve a folder reference to its absolute POSIX root, validating it is a
 *  real directory. Absolute paths are the normal API. A non-absolute ref is
 *  accepted only as a compatibility path under the default folder home.
 *  Throws with `code = FOLDER_NOT_FOUND` otherwise. */
export function resolveFolderRoot(ref: string): string {
  if (typeof ref !== 'string' || !ref.trim()) {
    const err = new Error('folder reference required');
    (err as any).code = 'FOLDER_NOT_FOUND';
    throw err;
  }
  const root = filesystemPath.absolute(ref, getFolderHome());
  try {
    if (fs.statSync(root).isDirectory()) return root;
  } catch {
    /* fall through to the not-found error */
  }
  const err = new Error('folder not found');
  (err as any).code = 'FOLDER_NOT_FOUND';
  throw err;
}

/** Async request-path equivalent of `resolveFolderRoot()`. */
export async function resolveFolderRootAsync(ref: string): Promise<string> {
  if (typeof ref !== 'string' || !ref.trim()) {
    const err = new Error('folder reference required');
    (err as any).code = 'FOLDER_NOT_FOUND';
    throw err;
  }
  const root = filesystemPath.absolute(ref, getFolderHome());
  try {
    if ((await fs.promises.stat(root)).isDirectory()) return root;
  } catch {
    /* fall through to the not-found error */
  }
  const err = new Error('folder not found');
  (err as any).code = 'FOLDER_NOT_FOUND';
  throw err;
}

function normalizeWindowId(windowId: string | null | undefined): string {
  const raw = typeof windowId === 'string' ? windowId.trim() : '';
  return raw ? raw.slice(0, 128) : DEFAULT_WINDOW_ID;
}

// ---------- Default folder home ----------

/** Absolute path of the **default folder home** — the fixed directory where
 *  "new folder by name" is created and the built-in manual is seeded. It is
 *  NOT a configurable root, an isolation boundary, or an index scope: the
 *  daemon keys the active provider/dimension collection by absolute path, and
 *  folders are opened in place from anywhere on disk. There is no UI to change it.
 *  `STASHBASE_FOLDER_HOME` overrides it for tests / power users. */
export function getFolderHome(): string {
  const env = process.env.STASHBASE_FOLDER_HOME;
  if (typeof env === 'string' && env.trim()) return filesystemPath.absolute(env.trim());
  return filesystemPath.join(filesystemPath.absolute(os.homedir()), 'Documents/StashBase');
}

/** Validate a user-supplied folder name. Names must be a single,
 *  cross-platform-safe filename segment: no slashes, no dots-only, no
 *  leading/trailing dot, none of the Windows/FAT-reserved chars
 *  (`< > : " | ? *`), no control chars. Rejecting these here (not just
 *  the macOS-illegal `/`) keeps folders portable to Windows / git /
 *  cloud sync — symmetric with `sanitizeFilename` on the upload path.
 *  Returns null when valid, error message otherwise. */
export function validateFolderName(name: string): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'name required';
  const n = name.trim();
  if (n === '.' || n === '..') return 'name cannot be "." or ".."';
  if (n.startsWith('.')) return 'name cannot start with "."';
  if (n.endsWith('.')) return 'name cannot end with "."';
  if (n.includes('/') || n.includes('\\')) return 'name cannot contain slashes';
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\u0000-\u001f]/.test(n)) return 'name cannot contain < > : " | ? * or control characters';
  if (n.length > 64) return 'name too long (max 64 chars)';
  return null;
}

/** Direct-child directory names under the default folder home. This is
 *  used only to decide whether first-launch seeding should run; it is
 *  not the library membership list. */
function listFolderNamesUnder(root: string): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) =>
      e.isDirectory() &&
      !e.name.startsWith('.') &&
      !isIndexExcludedDirName(e.name) &&
      validateFolderName(e.name) == null)
    .map((e) => e.name)
    .sort();
}

function listDefaultHomeFolderNames(): string[] {
  return listFolderNamesUnder(getFolderHome());
}

/** Human-facing label for the open folder: relative display text when under
 *  the default home, else the folder basename. null if no folder is open. */
export function getCurrentFolderLabel(): string | null {
  const cs = getCurrentFolder();
  if (!cs) return null;
  const root = getFolderHome();
  const rel = filesystemPath.relative(root, cs);
  if (rel != null && rel !== '') return rel;
  return path.basename(cs);
}

/** Convert a folder-relative path (`topic/note.md`) to the **absolute
 *  POSIX-spelled source path the indexer/daemon use, rooted at the
 *  currently-open folder (`getCurrentFolder()`), which may live anywhere on
 *  disk. Throws if no folder is open — every call site should already be
 *  inside a request that has folder context. (Name kept for call-site
 *  stability; the daemon speaks absolute paths, see `indexer.mfs.ts`.) */
export function toSourcePath(folderRel: string): string {
  const cs = getCurrentFolder();
  if (!cs) throw new Error('no folder open');
  return filesystemPath.join(cs, folderRel);
}

/** Convert an absolute path (a daemon reply) back to a path relative to
 *  the currently-open folder, or null if it doesn't fall under it. */
export function fromSourcePath(sourcePath: string): string | null {
  const cs = getCurrentFolder();
  return cs ? filesystemPath.relative(cs, sourcePath) : null;
}

/** Idempotent startup hook:
 *   1. Ensure the default folder home exists (mkdir -p) + seed the manual.
 *   2. Prune `recentFolders` entries whose folder no longer exists on disk
 *      (members can live anywhere; the only requirement is existence). */
export function ensureFolderHome(): void {
  const root = getFolderHome();
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err: any) {
    log.warn(`failed to create folder home ${root}: ${errorMessage(err)}`);
  }
  try {
    const cfg = readConfigStrict();
    const before = cfg.recentFolders ?? [];
    // Recents can live anywhere on disk (a Folder is openable from any
    // location); only drop entries whose folder no longer exists.
    const after = before.filter((r) => {
      try { return fs.statSync(r.path).isDirectory(); } catch { return false; }
    });
    if (after.length !== before.length) {
      cfg.recentFolders = after;
      writeConfigStrict(cfg);
      log.info(`pruned ${before.length - after.length} stale recent(s)`);
    }
  } catch (err) {
    log.warn(`skipped recent-folder maintenance: ${errorMessage(err)}`);
  }
  // Seed the built-in manual here — `ensureFolderHome` is THE idempotent
  // "folder home is established" hook, hit on every boot.
  seedBuiltinFolder();
}

/** Absolute path of the bundled built-in folder's source content, or null
 *  if it isn't shipped with this build. */
function builtinFolderSource(): string | null {
  const src = path.join(RESOURCES_ROOT, 'assets', 'builtin-library');
  try {
    return fs.statSync(src).isDirectory() ? src : null;
  } catch {
    return null;
  }
}

/** First-launch onboarding: copy the bundled product-introduction folder into
 *  the default folder home and surface it in library membership. Window entry
 *  remains unselected; the user chooses when to open the folder.
 *
 *  Two distinct jobs, in order:
 *
 *   1. **Surface** — if the introduction is already on disk (`<root>/<name>`),
 *      make sure it's reachable from library membership. This is independent
 *      of the `builtinSeeded` latch: surfacing isn't re-seeding. It
 *      covers the "config/recents wiped but the folder is still there"
 *      case (e.g. the user deletes `~/.stashbase`) — otherwise the folder
 *      exists but never shows. Only re-adds when it has fallen off recents,
 *      so a normal boot doesn't keep bumping it to the top.
 *
 *   2. **Seed** — otherwise, copy the bundled content in, but only into a
 *      brand-new empty library. The `builtinSeeded` latch means "we did
 *      the initial copy already": once set, a user who *deletes the
 *      folder* won't get it resurrected (delete the folder to be rid of
 *      it). An existing folder home is latched and left untouched.
 *
 *  Idempotent and failure-tolerant: any error is logged and swallowed —
 *  onboarding content must never block boot. Call before binding folders
 *  so the seeded folder is picked up by `bootBindAllFolders`. */
export function seedBuiltinFolder(): void {
  const root = getFolderHome();
  const dest = path.join(root, BUILTIN_FOLDER_NAME);

  const latch = () => {
    const c = readConfigStrict();
    if (!c.builtinSeeded) { c.builtinSeeded = true; writeConfigStrict(c); }
  };

  // (1) Already on disk → ensure it's in recents, regardless of the latch.
  if (fs.existsSync(dest)) {
    try {
      const inRecents = (readConfigStrict().recentFolders ?? []).some((r) => storedFolderPathEquals(r.path, dest));
      if (!inRecents) pushRecent(dest);
      latch();
    } catch (err) {
      log.warn(`failed to surface built-in folder: ${errorMessage(err)}`);
    }
    return;
  }

  // (2) Not on disk. If we already seeded once, the user deleted the
  // folder — don't resurrect it.
  let seeded: boolean;
  try {
    seeded = !!readConfigStrict().builtinSeeded;
  } catch (err) {
    log.warn(`failed to read built-in folder state: ${errorMessage(err)}`);
    return;
  }
  if (seeded) return;

  // Only seed a brand-new, empty folder home — never inject into an existing
  // user directory. Latch either way so this runs only once.
  if (listDefaultHomeFolderNames().length > 0) {
    try { latch(); }
    catch (err) { log.warn(`failed to latch built-in folder state: ${errorMessage(err)}`); }
    return;
  }

  const src = builtinFolderSource();
  if (!src) return; // not bundled in this build — try again next boot

  try {
    fs.mkdirSync(root, { recursive: true });
    copyDirectoryDereferenced(src, dest);
    pushRecent(dest);          // add it to library membership
    latch();
    log.info(`seeded built-in folder at ${dest}`);
  } catch (err) {
    log.warn(`failed to seed built-in folder: ${errorMessage(err)}`);
  }
}

/** Absolute path of the currently open folder, or null if none. */
export function getCurrentFolder(): string | null {
  return currentFolders.get(currentWindowId()) ?? null;
}

/** Throws if no folder is open — call this from request handlers that
 *  need folder state. The thrown error carries a `code` so the route
 *  layer can map it to HTTP 412. */
export function requireCurrentFolder(): string {
  const currentFolder = getCurrentFolder();
  if (!currentFolder) {
    const err = new Error('no folder open');
    (err as any).code = 'NO_FOLDER';
    throw err;
  }
  return currentFolder;
}

/** Open a folder at the given absolute path. Creates the directory if
 *  needed. Pushes to the recents list. Returns true when the active
 *  folder changed. Callers decide when to notify switch listeners so an
 *  HTTP route can respond before background index / Agent cleanup starts. */
export function setCurrentFolder(absPath: string, opts?: { create?: boolean; exclusiveCreate?: boolean }): boolean {
  if (typeof absPath !== 'string' || !absPath) throw new Error('path required');
  const windowId = currentWindowId();
  if (retiredWindowIds.has(windowId)) {
    const err = new Error('window is closed');
    (err as any).code = 'WINDOW_CLOSED';
    throw err;
  }
  // Expand a leading `~` so the welcome screen can accept `~/Notes`
  // without forcing the user to spell out their home directory.
  let expanded = absPath;
  if (expanded === '~') expanded = filesystemPath.absolute(os.homedir());
  else if (expanded.startsWith('~/')) {
    expanded = filesystemPath.join(filesystemPath.absolute(os.homedir()), expanded.slice(2));
  }
  if (!filesystemPath.isAbsolute(expanded)) throw new Error('path must be absolute');
  const normalized = filesystemPath.absolute(expanded);
  assertLibraryFolderAvailable(normalized);
  // A Folder can be opened from anywhere on disk — there is no unified root
  // constraint. The folder home is only the default location for the built-in
  // folder and new-folder-by-name; opening an arbitrary folder is the
  // norm (the daemon keys its active collection by absolute path, so a
  // folder outside the root indexes just fine).
  // Creating a folder only happens on the explicit New-folder flow
  // (`opts.create`). Open / recent flows must NOT mkdir: a missing
  // folder there means the folder was deleted/moved out from under us,
  // and silently re-creating it would resurrect an empty ghost folder
  // (and turn a typo'd `~/Notess` into a stray dir). Error instead.
  const existed = fs.existsSync(normalized);
  if (existed && opts?.create && opts.exclusiveCreate) {
    const err = new Error(`folder "${path.basename(normalized)}" already exists`);
    (err as any).code = 'FOLDER_EXISTS';
    throw err;
  }
  if (!existed) {
    if (!opts?.create) throw new Error('folder does not exist (it may have been moved or deleted)');
    fs.mkdirSync(normalized, { recursive: true });
    log.warn(`created new folder directory: ${normalized}`);
  }
  const st = fs.statSync(normalized);
  if (!st.isDirectory()) throw new Error('path is not a directory');

  pushRecent(normalized);
  const prev = currentFolders.get(windowId) ?? null;
  const changed = prev == null || !filesystemPath.equal(prev, normalized);
  currentFolders.set(windowId, normalized);
  return changed;
}

export function clearCurrentFolder(windowId = currentWindowId()): void {
  const id = normalizeWindowId(windowId);
  const oldRoot = currentFolders.get(id);
  currentFolders.delete(id);
  if (oldRoot) {
    for (const fn of closeListeners) {
      try { fn(oldRoot, id); } catch (err) {
        log.warn(`close listener threw: ${(err as any)?.message ?? err}`);
      }
    }
  }
}

/** Permanently retire one native window identity for this app-server process.
 * Late HTTP requests from Chromium may outlive BrowserWindow.close(); keeping a
 * bounded tombstone prevents those requests from recreating folder/Agent state. */
export function retireWindow(windowId = currentWindowId()): void {
  const id = normalizeWindowId(windowId);
  clearCurrentFolder(id);
  retiredWindowIds.delete(id);
  retiredWindowIds.set(id, Date.now());
  while (retiredWindowIds.size > MAX_RETIRED_WINDOW_IDS) {
    const oldest = retiredWindowIds.keys().next().value;
    if (typeof oldest !== 'string') break;
    retiredWindowIds.delete(oldest);
  }
}

export function clearFolderPath(absPath: string): void {
  for (const [windowId, value] of [...currentFolders.entries()]) {
    if (filesystemPath.equal(value, absPath)) clearCurrentFolder(windowId);
  }
}

/** Async request-path equivalent of `clearFolderPath()`. */
export async function clearFolderPathAsync(absPath: string): Promise<void> {
  for (const [windowId, value] of [...currentFolders.entries()]) {
    if (await filesystemPath.equalAsync(value, absPath)) clearCurrentFolder(windowId);
  }
}

/** Subscribe to folder switches. The listener receives the absolute path
 *  of the newly-current folder; fires after the switch is in place. */
export function onSwitch(fn: (newRoot: string, windowId: string) => void): void {
  switchListeners.push(fn);
}

export function onClose(fn: (oldRoot: string, windowId: string) => void): void {
  closeListeners.push(fn);
}

export function getActiveFolders(): { windowId: string; path: string }[] {
  return [...currentFolders.entries()].map(([windowId, path]) => ({ windowId, path }));
}

/** Returns recent folders, most-recent first. Filters out paths that no
 *  longer exist on disk so the Welcome list only shows one-click-openable
 *  folders. */
function currentRecentFolder(value: RecentFolder): RecentFolder {
  return {
    path: value.path,
    openedAt: value.openedAt,
    ...(value.favorite === true ? { favorite: true } : {}),
  };
}

export function getRecentFolders(): RecentFolder[] {
  const all = (readConfig().recentFolders ?? []).map(currentRecentFolder);
  // A Folder is openable from anywhere, so the only requirement is that it
  // still exists as a directory (handles a moved/deleted folder).
  return all.filter((v) => {
    try { return fs.statSync(v.path).isDirectory(); } catch { return false; }
  });
}

export async function getRecentFoldersAsync(): Promise<RecentFolder[]> {
  const all = ((await readConfigAsync()).recentFolders ?? []).map(currentRecentFolder);
  const checks = await Promise.all(all.map(async (value) => {
    try { return (await fs.promises.stat(value.path)).isDirectory(); }
    catch { return false; }
  }));
  return all.filter((_, index) => checks[index]);
}

function pushRecent(absPath: string): void {
  const cfg = readConfigStrict();
  const list = (cfg.recentFolders ?? []).map(currentRecentFolder);
  // Filter out the entry we're about to re-add (avoid dupes) AND
  // entries whose target folder no longer exists — keeps the persisted
  // recents from accumulating dead tmp dirs / deleted folders over
  // time. Opportunistic cleanup on every write.
  const existing = list.find((v) => storedFolderPathEquals(v.path, absPath));
  const filtered = list.filter((v) => {
    if (storedFolderPathEquals(v.path, absPath)) return false;
    try { return fs.statSync(v.path).isDirectory(); } catch { return false; }
  });
  // Reopening the same folder through an equivalent filesystem spelling must
  // not rewrite the durable source spelling: index rows, derived keys, and
  // daemon replay all continue from the first established root.
  const retainedPath = existing
    ? filesystemPath.absolute(existing.path)
    : filesystemPath.absolute(absPath);
  filtered.unshift({
    path: retainedPath,
    openedAt: new Date().toISOString(),
    ...(existing?.favorite === true ? { favorite: true } : {}),
  });
  // No cap: this list IS the knowledge-base membership ("Your Folders"),
  // not a transient recency log. Opening a folder joins it; the only way
  // out is an explicit remove (`removeRecent`). A hard cap would silently
  // evict the oldest member's searchability — see the library-membership
  // ownership contract in code-review/data-lifecycle.md.
  cfg.recentFolders = filtered;
  // Drop the legacy field once we've migrated its content forward.
  delete cfg.recentVaults;
  writeConfigStrict(cfg);
}

/** Register a folder into library membership ("Your Folders") WITHOUT
 *  changing any window's current folder. This is the same registration
 *  path opening a folder uses (`pushRecent`), minus the window binding —
 *  used by `create_project`, which must make the new folder appear in
 *  every window's sidebar list while only the owning window navigates. */
export function registerLibraryFolder(absPath: string): void {
  const normalized = filesystemPath.absolute(absPath);
  assertLibraryFolderAvailable(normalized);
  pushRecent(normalized);
}

/** Async project-creation registration path. Identity and directory probes
 * yield before the final synchronous config commit. */
export async function registerLibraryFolderAsync(absPath: string): Promise<void> {
  const normalized = filesystemPath.absolute(absPath);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const snapshot = readConfigStrict();
    const revision = JSON.stringify(snapshot);
    const list = (snapshot.recentFolders ?? []).map(currentRecentFolder);
    const matches = await Promise.all(list.map((value) => storedFolderPathEqualsAsync(value.path, normalized)));
    const directoryChecks = await Promise.all(list.map(async (value) => {
      try { return (await fs.promises.stat(value.path)).isDirectory(); }
      catch { return false; }
    }));
    const existingIndex = matches.findIndex(Boolean);
    const retainedPath = existingIndex >= 0
      ? filesystemPath.absolute(list[existingIndex].path)
      : normalized;
    const filtered = list.filter((_, index) => !matches[index] && directoryChecks[index]);
    filtered.unshift({
      path: retainedPath,
      openedAt: new Date().toISOString(),
      ...(existingIndex >= 0 && list[existingIndex].favorite === true ? { favorite: true } : {}),
    });
    // Re-check removal and config truth after every awaited probe. The final
    // read/compare/write sequence has no yield, so concurrent settings or
    // membership mutations make this operation retry instead of losing data.
    await assertLibraryFolderAvailableAsync(normalized);
    const current = readConfigStrict();
    if (JSON.stringify(current) !== revision) continue;
    current.recentFolders = filtered;
    delete current.recentVaults;
    writeConfigStrict(current);
    return;
  }
  const err = new Error('library membership changed repeatedly; try again');
  (err as any).code = 'CONFIG_BUSY';
  (err as any).status = 409;
  throw err;
}

/** Hold a process-local removal intent while a member's conversions, derived
 * artifacts, index rows, and runtime state are retired. Open/register calls
 * fail during the interval so a concurrent request cannot resurrect
 * membership halfway through cleanup. The caller commits membership last. */
export function beginLibraryFolderRemoval(absPath: string): () => void {
  const source = filesystemPath.absolute(absPath);
  const key = filesystemPath.identity(source);
  if (removingFolders.has(key)) {
    const err = new Error('folder removal is already in progress');
    (err as any).code = 'FOLDER_REMOVING';
    (err as any).status = 409;
    throw err;
  }
  removingFolders.set(key, source);
  return () => { removingFolders.delete(key); };
}

/** Async request-path equivalent of `beginLibraryFolderRemoval()`. */
export async function beginLibraryFolderRemovalAsync(absPath: string): Promise<() => void> {
  const source = filesystemPath.absolute(absPath);
  const key = await filesystemPath.identityAsync(source);
  if (removingFolders.has(key)) {
    const err = new Error('folder removal is already in progress');
    (err as any).code = 'FOLDER_REMOVING';
    (err as any).status = 409;
    throw err;
  }
  removingFolders.set(key, source);
  return () => { removingFolders.delete(key); };
}

/** Read-only removal gate for background owners. A reconcile scheduled from a
 * stale library snapshot must not restart work after removal has begun. */
export function isLibraryFolderRemovalInProgress(absPath: string): boolean {
  return removingFolders.has(filesystemPath.identity(filesystemPath.absolute(absPath)));
}

export function assertLibraryFolderAvailable(absPath: string): void {
  const requested = filesystemPath.absolute(absPath);
  const blocked = [...removingFolders.values()].some((root) => (
    filesystemPath.equal(root, requested) || filesystemPath.contains(root, requested)
  ));
  if (!blocked) return;
  const err = new Error('folder removal is in progress');
  (err as any).code = 'FOLDER_REMOVING';
  (err as any).status = 409;
  throw err;
}

/** Async request-path equivalent of `assertLibraryFolderAvailable()`. */
export async function assertLibraryFolderAvailableAsync(absPath: string): Promise<void> {
  const requested = filesystemPath.absolute(absPath);
  for (const root of removingFolders.values()) {
    if (await filesystemPath.containsAsync(root, requested)) {
      const err = new Error('folder removal is in progress');
      (err as any).code = 'FOLDER_REMOVING';
      (err as any).status = 409;
      throw err;
    }
  }
}

/** Remove a folder from the membership list ("Your Folders"). Does NOT
 *  touch the folder on disk — removal only forgets it from the knowledge
 *  base; the caller clears its index rows separately. StashBase-owned Agent
 *  Instructions for that membership leave with it; user files do not. */
export function removeRecent(absPath: string): void {
  const target = filesystemPath.absolute(absPath);
  const cfg = readConfigStrict();
  const list = (cfg.recentFolders ?? []).map(currentRecentFolder);
  const filtered = list.filter((v) => !storedFolderPathEquals(v.path, target));
  const instructionsChanged = removeFolderInstructions(cfg, target);
  if (filtered.length === list.length && !instructionsChanged) return;
  cfg.recentFolders = filtered;
  writeConfigStrict(cfg);
}

/** Async request-path equivalent of `removeRecent()`. */
export async function removeRecentAsync(absPath: string): Promise<void> {
  const target = filesystemPath.absolute(absPath);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const snapshot = readConfigStrict();
    const revision = JSON.stringify(snapshot);
    const list = (snapshot.recentFolders ?? []).map(currentRecentFolder);
    const matches = await Promise.all(list.map((value) => storedFolderPathEqualsAsync(value.path, target)));
    const instructionFolders = Array.isArray(snapshot.agentInstructions?.folders)
      ? snapshot.agentInstructions.folders
      : [];
    const instructionMatches = await Promise.all(
      instructionFolders.map((value) => storedFolderPathEqualsAsync(value?.path, target)),
    );
    const current = readConfigStrict();
    if (JSON.stringify(current) !== revision) continue;
    const filtered = list.filter((_, index) => !matches[index]);
    const retainedInstructions = instructionFolders.filter((_, index) => !instructionMatches[index]);
    const instructionsChanged = retainedInstructions.length !== instructionFolders.length;
    if (filtered.length === list.length && !instructionsChanged) return;
    current.recentFolders = filtered;
    if (instructionsChanged) {
      if (retainedInstructions.length) current.agentInstructions!.folders = retainedInstructions;
      else delete current.agentInstructions!.folders;
      compactAgentInstructions(current);
    }
    writeConfigStrict(current);
    return;
  }
  const err = new Error('library membership changed repeatedly; try again');
  (err as any).code = 'CONFIG_BUSY';
  (err as any).status = 409;
  throw err;
}

function removeFolderInstructions(config: AppConfigFile, target: string): boolean {
  const folders = Array.isArray(config.agentInstructions?.folders)
    ? config.agentInstructions.folders
    : [];
  const retained = folders.filter((entry) => !storedFolderPathEquals(entry?.path, target));
  if (retained.length === folders.length) return false;
  if (retained.length) config.agentInstructions!.folders = retained;
  else delete config.agentInstructions!.folders;
  compactAgentInstructions(config);
  return true;
}

function compactAgentInstructions(config: AppConfigFile): void {
  if (!config.agentInstructions?.folders?.length) {
    delete config.agentInstructions;
  }
}

/** Star / unstar a member folder in the library list. Returns false when
 *  the path is not a member (nothing persisted). Clearing removes the
 *  field so config.json stays free of `favorite: false` noise. */
export function setRecentFavorite(absPath: string, favorite: boolean): boolean {
  const target = filesystemPath.absolute(absPath);
  const cfg = readConfigStrict();
  const list = (cfg.recentFolders ?? []).map(currentRecentFolder);
  const entry = list.find((v) => storedFolderPathEquals(v.path, target));
  if (!entry) return false;
  if (favorite) entry.favorite = true;
  else delete entry.favorite;
  cfg.recentFolders = list;
  writeConfigStrict(cfg);
  return true;
}

// ---------- API key (global) ----------

/** Returns the user's stored embedding key, or undefined if none. */
