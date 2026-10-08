/**
 * Folder registry, window context, and folder-home management.
 *
 * Persistence reuses `app-config.ts`'s `~/.stashbase/config.json`
 * primitives for project membership; credentials and user preferences
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
import { logger, errorMessage } from './log.ts';
import { filesystemPath } from './filesystem-path.ts';
import { projectRegistrySnapshotSchema, type ProjectRegistrySnapshotWire } from '../shared/protocols/http/project.ts';
import { validateFolderName as validatePortableFolderName } from '../shared/folder-name.ts';
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

export const WINDOW_ID_HEADER = 'x-stashbase-window-id';

const DEFAULT_WINDOW_ID = 'default';
const MAX_RETIRED_WINDOW_IDS = 2048;
const requestWindow = new AsyncLocalStorage<string>();
const currentFolders = new Map<string, string>();
// Binding revisions protect reads; open intents separately order pending writes.
const windowFolderVersions = new Map<string, object>();
const windowOpenIntents = new Map<string, object>();
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
export function registeredFolderRoots(): string[] {
  return getRecentFolders().map((r) => filesystemPath.absolute(r.path));
}

export async function registeredFolderRootsAsync(): Promise<string[]> {
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

/** Return the retained spelling of an available exact project member. */
export async function exactRegisteredFolderRootAsync(abs: string): Promise<string | null> {
  const target = filesystemPath.absolute(abs);
  for (const root of await registeredFolderRootsAsync()) {
    if (await filesystemPath.equalAsync(root, target)) return root;
  }
  return null;
}

/** Return the stored spelling of an exact configured member even when its
 * source directory is currently missing. Removal uses this durable view so a
 * moved or deleted folder can still be deliberately forgotten without first
 * recreating it on disk. */
export async function exactConfiguredProjectRootAsync(abs: string): Promise<string | null> {
  const target = filesystemPath.absolute(abs);
  const configured = (readConfigStrict().recentFolders ?? []).map(currentRecentFolder);
  for (const member of configured) {
    if (await storedFolderPathEqualsAsync(member.path, target)) {
      return filesystemPath.absolute(member.path);
    }
  }
  return null;
}

/** Retained nested members keep their own preparation when a parent leaves.
 * Use configured membership, including temporarily missing source folders. */
export async function configuredDescendantProjectRootsAsync(parent: string): Promise<string[]> {
  const roots = (readConfigStrict().recentFolders ?? []).map((member) => filesystemPath.absolute(member.path));
  const nested = await Promise.all(roots.map(async (root) =>
    !await filesystemPath.equalAsync(parent, root) && await filesystemPath.containsAsync(parent, root)));
  return roots.filter((_, index) => nested[index]);
}

/** The member folder (longest-prefix) that contains `abs`, or null when
 *  the path isn't inside any member folder. The longest-prefix rule keeps
 *  nested members (`<root>/foo` and `<root>/foo/bar` both opened) correct. */
export function registeredRootForAbs(abs: string): string | null {
  const target = filesystemPath.absolute(abs);
  let best: string | null = null;
  for (const root of registeredFolderRoots()) {
    if (filesystemPath.contains(root, target)) {
      if (!best || filesystemPath.identity(root).length > filesystemPath.identity(best).length) best = root;
    }
  }
  return best;
}

/** Async request-path equivalent of `registeredRootForAbs()`. */
export async function registeredRootForAbsAsync(abs: string): Promise<string | null> {
  const target = filesystemPath.absolute(abs);
  let best: string | null = null;
  for (const root of await registeredFolderRootsAsync()) {
    if (await filesystemPath.containsAsync(root, target)) {
      if (!best || (await filesystemPath.identityAsync(root)).length > (await filesystemPath.identityAsync(best)).length) {
        best = root;
      }
    }
  }
  return best;
}

/** Resolve a folder reference asynchronously and require an existing directory.
 * Relative references are interpreted beneath the default folder home. */
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
 *  "new folder by name" is created. It is
 *  NOT a configurable root, an isolation boundary, or an index scope: each
 *  Folder has its own MFS namespace derived from its comparison identity, and
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
  return validatePortableFolderName(name);
}

/** Human-facing label for the open folder: relative display text when under
 *  the default home, else the folder basename. null if no folder is open. */
export function getCurrentFolderLabel(): string | null {
  const cs = getCurrentFolder();
  if (!cs) return null;
  const root = getFolderHome();
  const rel = filesystemPath.relative(root, cs);
  if (rel != null && rel !== '') return rel;
  return path.basename(cs) || cs;
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

/** Establish the default folder home without adding projects or source files.
 *  Disk availability never changes durable project membership. */
export function ensureFolderHome(): void {
  const root = getFolderHome();
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    log.warn(`failed to create folder home ${root}: ${errorMessage(err)}`);
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

function normalizeOpenFolderPath(absPath: string): string {
  if (typeof absPath !== 'string' || !absPath.trim()) throw new Error('path required');
  let expanded = absPath;
  if (expanded === '~') expanded = filesystemPath.absolute(os.homedir());
  else if (expanded.startsWith('~/')) {
    expanded = filesystemPath.join(filesystemPath.absolute(os.homedir()), expanded.slice(2));
  }
  if (!filesystemPath.isAbsolute(expanded)) throw new Error('path must be absolute');
  return filesystemPath.absolute(expanded);
}

function assertWindowOpen(windowId: string): void {
  if (retiredWindowIds.has(windowId)) {
    throw Object.assign(new Error('window is closed'), { code: 'WINDOW_CLOSED', status: 410 });
  }
}

function folderChangedError(): Error {
  return Object.assign(new Error('window folder changed; try again'), { code: 'FOLDER_CHANGED', status: 409 });
}

async function activeProjectFolder(root: string) {
  const relative = await filesystemPath.relativeAsync(getFolderHome(), root);
  return { path: root, name: relative || path.basename(root) || root };
}

/** Read a coherent window snapshot. An old disk result never retires a newer
 * binding, including close-and-reopen of the same path. */
export async function getProjectRegistrySnapshot(): Promise<ProjectRegistrySnapshotWire> {
  const windowId = currentWindowId();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const version = windowFolderVersions.get(windowId);
    const current = getCurrentFolder();
    let available = false;
    if (current) {
      try { available = (await fs.promises.stat(current)).isDirectory(); }
      catch { /* The snapshot exposes unavailable folders as unselected. */ }
    }
    const snapshot = projectRegistrySnapshotSchema.parse({
      current: current && available ? await activeProjectFolder(current) : null,
      homeDir: os.homedir(),
      recent: readConfigStrict().recentFolders ?? [],
    });
    if (windowFolderVersions.get(windowId) !== version) continue;
    if (current && !available) clearFolderBinding(windowId);
    return snapshot;
  }
  throw folderChangedError();
}

/** Prepare every fallible read and response check before the atomic config
 * write and window binding. No asynchronous work follows that commit. */
export async function openProjectFolder(absPath: string, signal?: AbortSignal): Promise<{
  changed: boolean;
  snapshot: ProjectRegistrySnapshotWire;
}> {
  signal?.throwIfAborted();
  const windowId = currentWindowId();
  assertWindowOpen(windowId);
  const normalized = normalizeOpenFolderPath(absPath);
  const version = {};
  windowOpenIntents.set(windowId, version);
  try {
    if (!(await fs.promises.stat(normalized)).isDirectory()) throw new Error('path is not a directory');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const registration = await prepareProjectRegistration(normalized);
      const current = await activeProjectFolder(registration.root);
      const recent = registration.config.recentFolders!;
      if (!recent.some((member) => member.path === current.path)) {
        throw new Error('folder is no longer available');
      }
      const snapshot = projectRegistrySnapshotSchema.parse({
        current,
        homeDir: os.homedir(),
        recent,
      });
      const previousVersion = windowFolderVersions.get(windowId);
      const previous = getCurrentFolder();
      const changed = !previous || !await filesystemPath.equalAsync(previous, current.path);
      await assertProjectFolderAvailableAsync(normalized);
      if (!(await fs.promises.stat(normalized)).isDirectory()) throw new Error('path is not a directory');
      await fs.promises.access(normalized, fs.constants.R_OK | fs.constants.X_OK);
      assertWindowOpen(windowId);
      if (windowOpenIntents.get(windowId) !== version) throw folderChangedError();
      if (windowFolderVersions.get(windowId) !== previousVersion) continue;
      if (JSON.stringify(readConfigStrict()) !== registration.revision) continue;
      signal?.throwIfAborted();
      writeConfigStrict(registration.config);
      windowFolderVersions.set(windowId, {});
      currentFolders.set(windowId, current.path);
      return { changed, snapshot };
    }
    throw Object.assign(new Error('project membership changed repeatedly; try again'), { code: 'CONFIG_BUSY', status: 409 });
  } finally {
    if (windowOpenIntents.get(windowId) === version) windowOpenIntents.delete(windowId);
  }
}

export function clearCurrentFolder(windowId = currentWindowId()): void {
  const id = normalizeWindowId(windowId);
  windowOpenIntents.delete(id);
  clearFolderBinding(id);
}

function clearFolderBinding(id: string): void {
  const oldRoot = currentFolders.get(id);
  windowFolderVersions.delete(id);
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

/** Release window bindings for a removed project. */
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
  return availableRecentFolders(all);
}

async function availableRecentFolders(all: RecentFolder[]): Promise<RecentFolder[]> {
  const checks = await Promise.all(all.map(async (value) => {
    try { return (await fs.promises.stat(value.path)).isDirectory(); }
    catch { return false; }
  }));
  return all.filter((_, index) => checks[index]);
}

async function prepareProjectRegistration(normalized: string) {
  const config = readConfigStrict();
  const revision = JSON.stringify(config);
  const list = (config.recentFolders ?? []).map(currentRecentFolder);
  const matches = await Promise.all(list.map((value) => storedFolderPathEqualsAsync(value.path, normalized)));
  const existing = list[matches.findIndex(Boolean)];
  const root = existing ? filesystemPath.absolute(existing.path) : normalized;
  config.recentFolders = [
    { path: root, openedAt: new Date().toISOString(), ...(existing?.favorite === true ? { favorite: true } : {}) },
    ...list.filter((_, index) => !matches[index]),
  ];
  return { config, revision, root };
}

/** Async project-creation registration, preserving concurrent config writes. */
export async function registerProjectFolderAsync(absPath: string, options: { signal?: AbortSignal } = {}): Promise<void> {
  const normalized = filesystemPath.absolute(absPath);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    options.signal?.throwIfAborted();
    const registration = await prepareProjectRegistration(normalized);
    await assertProjectFolderAvailableAsync(normalized);
    if (JSON.stringify(readConfigStrict()) !== registration.revision) continue;
    options.signal?.throwIfAborted();
    writeConfigStrict(registration.config);
    return;
  }
  throw Object.assign(new Error('project membership changed repeatedly; try again'), { code: 'CONFIG_BUSY', status: 409 });
}

/** Hold a removal intent until cleanup and membership removal finish. */
export async function beginProjectFolderRemovalAsync(absPath: string): Promise<() => void> {
  const source = filesystemPath.absolute(absPath);
  const key = await filesystemPath.identityAsync(source);
  if ([...removingFolders.keys()].some((root) => filesystemPath.contains(root, key) || filesystemPath.contains(key, root))) {
    const err = new Error('folder removal is already in progress');
    (err as any).code = 'FOLDER_REMOVING';
    (err as any).status = 409;
    throw err;
  }
  removingFolders.set(key, source);
  return () => { removingFolders.delete(key); };
}

/** Read-only removal gate for background owners. A reconcile scheduled from a
 * stale project snapshot must not restart work after removal has begun. */
export function isProjectFolderRemovalInProgress(absPath: string): boolean {
  return removingFolders.has(filesystemPath.identity(filesystemPath.absolute(absPath)));
}

/** Refuse entry into a project while its removal is in progress. */
export async function assertProjectFolderAvailableAsync(absPath: string): Promise<void> {
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

/** Forget membership and its app-owned Agent preferences without deleting source files. */
export async function removeRecentAsync(absPath: string): Promise<void> {
  const target = filesystemPath.absolute(absPath);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const snapshot = readConfigStrict();
    const revision = JSON.stringify(snapshot);
    const list = (snapshot.recentFolders ?? []).map(currentRecentFolder);
    const matches = await Promise.all(list.map((value) => storedFolderPathEqualsAsync(value.path, target)));
    const preferenceMatches = await Promise.all((snapshot.agentPreferences ?? []).map(entry =>
      storedFolderPathEqualsAsync(entry.scope, target)));
    const current = readConfigStrict();
    if (JSON.stringify(current) !== revision) continue;
    const filtered = list.filter((_, index) => !matches[index]);
    if (filtered.length === list.length && !preferenceMatches.some(Boolean)) return;
    current.recentFolders = filtered;
    if (preferenceMatches.some(Boolean)) current.agentPreferences = current.agentPreferences!.filter((_, index) => !preferenceMatches[index]);
    writeConfigStrict(current);
    return;
  }
  const err = new Error('project membership changed repeatedly; try again');
  (err as any).code = 'CONFIG_BUSY';
  (err as any).status = 409;
  throw err;
}

/** Star / unstar a member folder in the project list. Returns false when
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
