/**
 * `create_project` — host-side project creation for Agent callers.
 *
 * During a library-scoped chat the built-in agent can call the
 * `create_project` MCP tool to get a fresh working context. This module owns
 * the semantics: validate the name, create the directory (under the default
 * folder home unless an explicit valid location is given), register it into
 * library membership so every window's sidebar lists it, and — ONLY when the
 * calling live session is library-scoped — migrate that session's binding to
 * the new project and persist the history override that moves its native
 * session record from the library listing to the project's.
 *
 * A chat already bound to a folder is NEVER rebound: the tool still creates
 * and registers the project, and the result tells the agent the chat stays
 * bound. Calls without session attribution (external MCP clients) create and
 * register only.
 */
import fs from 'node:fs';
import {
  ensureFolderHome,
  assertLibraryFolderAvailableAsync,
  getFolderHome,
  memberFolderRootsAsync,
  registerLibraryFolderAsync,
  validateFolderName,
} from './folder.ts';
import { filesystemPath } from './filesystem-path.ts';
import { noteTreeChanged } from './watcher.ts';
import { syncFolderNow } from './state.ts';
import { logger, errorMessage } from './log.ts';
import {
  attributedAgentSession,
  attributedSessionForWindow,
  attributedTurnActiveSession,
  createProjectRebindPlan,
  type AttributedAgentSession,
} from './agent-session-registry.ts';
import {
  setAgentSessionFolderOverride,
  clearAgentSessionFolderOverride,
} from './agent-session-folders.ts';
import path from 'node:path';

const log = logger('agent-projects');

export interface CreateProjectInput {
  name: unknown;
  location?: unknown;
  /** Request attribution from the `x-stashbase-agent-session-id` header —
   * never a tool argument, so a model cannot claim another session. */
  agentSessionId?: string;
  /** Owning-window fallback when the MCP host didn't forward the session
   * header — resolved to the window's one turn-active session. */
  windowId?: string;
}

export interface CreateProjectResult {
  path: string;
  name: string;
  registered: true;
  /** True when the CALLING chat session migrated its binding to the new
   * project (library-scoped callers only). */
  rebound: boolean;
  note: string;
}

export type CreateProjectTargetResolution =
  | { ok: true; parent: string; target: string; name: string }
  | { ok: false; message: string };

function operationError(message: string, status: number, code?: string): Error {
  const err = new Error(message) as Error & { status: number; code?: string };
  err.status = status;
  if (code) err.code = code;
  return err;
}

/** Pure target resolution: a validated cross-platform-safe name, and a
 * parent that is the default folder home unless an explicit valid location
 * is given. A valid location is an absolute directory path that stays
 * within surfaces StashBase already owns — the folder home (or inside it)
 * or a registered member folder (or inside one). Arbitrary host paths are
 * rejected: an agent must not be able to register folders anywhere on
 * disk. */
export function resolveCreateProjectTarget(
  name: unknown,
  location: unknown,
  deps: { folderHome: string; memberRoots: readonly string[] },
): CreateProjectTargetResolution {
  if (typeof name !== 'string' || !name.trim()) return { ok: false, message: '`name` is required' };
  const trimmed = name.trim();
  const bad = validateFolderName(trimmed);
  if (bad) return { ok: false, message: `invalid project name: ${bad}` };

  let parent = deps.folderHome;
  if (location != null && `${location}`.trim() !== '') {
    if (typeof location !== 'string') return { ok: false, message: '`location` must be an absolute directory path' };
    const raw = location.trim();
    if (!filesystemPath.isAbsolute(raw)) return { ok: false, message: '`location` must be an absolute directory path' };
    const abs = filesystemPath.absolute(raw);
    const allowed = withinAnyRoot(abs, [deps.folderHome, ...deps.memberRoots]);
    if (!allowed) {
      return {
        ok: false,
        message: '`location` must be the folder home, inside it, or inside a library folder',
      };
    }
    parent = abs;
  }
  return { ok: true, parent, target: filesystemPath.join(parent, trimmed), name: trimmed };
}

/** Request-path target resolution with async mounted-volume identity checks. */
export async function resolveCreateProjectTargetAsync(
  name: unknown,
  location: unknown,
  deps: { folderHome: string; memberRoots: readonly string[] },
): Promise<CreateProjectTargetResolution> {
  if (typeof name !== 'string' || !name.trim()) return { ok: false, message: '`name` is required' };
  const trimmed = name.trim();
  const bad = validateFolderName(trimmed);
  if (bad) return { ok: false, message: `invalid project name: ${bad}` };

  let parent = deps.folderHome;
  if (location != null && `${location}`.trim() !== '') {
    if (typeof location !== 'string') return { ok: false, message: '`location` must be an absolute directory path' };
    const raw = location.trim();
    if (!filesystemPath.isAbsolute(raw)) return { ok: false, message: '`location` must be an absolute directory path' };
    const abs = filesystemPath.absolute(raw);
    const allowed = await withinAnyRootAsync(abs, [deps.folderHome, ...deps.memberRoots]);
    if (!allowed) {
      return {
        ok: false,
        message: '`location` must be the folder home, inside it, or inside a library folder',
      };
    }
    parent = abs;
  }
  return { ok: true, parent, target: filesystemPath.join(parent, trimmed), name: trimmed };
}

function withinAnyRoot(abs: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    try {
      if (filesystemPath.equal(root, abs) || filesystemPath.contains(root, abs)) return true;
    } catch {
      // A malformed root cannot contain the candidate; keep checking.
    }
  }
  return false;
}

function owningRoot(abs: string, roots: readonly string[]): string | null {
  let owner: string | null = null;
  for (const root of roots) {
    try {
      if (!filesystemPath.equal(root, abs) && !filesystemPath.contains(root, abs)) continue;
      if (!owner || filesystemPath.contains(owner, root)) owner = filesystemPath.absolute(root);
    } catch {
      // A malformed persisted root cannot authorize filesystem access.
    }
  }
  return owner;
}

async function withinAnyRootAsync(abs: string, roots: readonly string[]): Promise<boolean> {
  for (const root of roots) {
    try {
      if (await filesystemPath.containsAsync(root, abs)) return true;
    } catch {
      // A malformed root cannot contain the candidate; keep checking.
    }
  }
  return false;
}

async function owningRootAsync(abs: string, roots: readonly string[]): Promise<string | null> {
  let owner: string | null = null;
  for (const root of roots) {
    try {
      if (!(await filesystemPath.containsAsync(root, abs))) continue;
      if (!owner || await filesystemPath.containsAsync(owner, root)) owner = filesystemPath.absolute(root);
    } catch {
      // A malformed persisted root cannot authorize filesystem access.
    }
  }
  return owner;
}

export interface CreateProjectDeps {
  folderHome(): string;
  memberRoots(): string[] | Promise<string[]>;
  /** Register into library membership (the sidebar list source). */
  register(abs: string): void | Promise<void>;
  noteTreeChanged(): void;
  /** Bind + reconcile the new folder in the background. */
  syncFolder(abs: string): Promise<unknown>;
  session(attributionId: string | undefined): AttributedAgentSession | null;
  /** Window-fallback attribution for MCP hosts that don't forward the
   * session header (stale installed binaries) — the window's one session
   * with a turn in flight. */
  sessionForWindow(windowId: string | undefined): AttributedAgentSession | null;
  /** Last-resort attribution when no identity survived the MCP spawn
   * chain (Codex sanitizes the env): the app-wide single turn-active
   * session, or null on any ambiguity. */
  turnActiveSession(): AttributedAgentSession | null;
  setOverride(agent: AttributedAgentSession['agentId'], nativeSessionId: string, folderAbs: string): void;
  clearOverride(agent: AttributedAgentSession['agentId'], nativeSessionId: string): void;
  assertAvailable(abs: string): void | Promise<void>;
}

const productionDeps: CreateProjectDeps = {
  folderHome: () => {
    ensureFolderHome();
    return getFolderHome();
  },
  memberRoots: memberFolderRootsAsync,
  register: registerLibraryFolderAsync,
  noteTreeChanged,
  syncFolder: (abs) => syncFolderNow(abs, { reason: 'create_project' }),
  session: (attributionId) => attributedAgentSession(attributionId),
  sessionForWindow: (windowId) => attributedSessionForWindow(windowId),
  turnActiveSession: () => attributedTurnActiveSession(),
  setOverride: setAgentSessionFolderOverride,
  clearOverride: clearAgentSessionFolderOverride,
  assertAvailable: assertLibraryFolderAvailableAsync,
};

export async function createProjectFolder(
  input: CreateProjectInput,
  deps: CreateProjectDeps = productionDeps,
): Promise<CreateProjectResult> {
  const initialMemberRoots = await deps.memberRoots();
  const resolved = await resolveCreateProjectTargetAsync(input.name, input.location, {
    folderHome: deps.folderHome(),
    memberRoots: initialMemberRoots,
  });
  if (!resolved.ok) throw operationError(resolved.message, 400, 'INVALID_PROJECT');

  const roots = [deps.folderHome(), ...(await deps.memberRoots())];
  const owner = await owningRootAsync(resolved.parent, roots);
  if (!owner) throw operationError('`location` is outside the owned folder scope', 400, 'INVALID_PROJECT');

  let parentStat: fs.Stats;
  let target: string;
  try {
    const parentRel = await filesystemPath.relativeAsync(owner, resolved.parent);
    const targetRel = await filesystemPath.relativeAsync(owner, resolved.target);
    if (parentRel == null || targetRel == null) throw new Error('path is outside the owned folder scope');
    const parent = await filesystemPath.resolveUnderAsync(owner, parentRel, { access: 'existing', label: 'location' });
    target = await filesystemPath.resolveUnderAsync(owner, targetRel, { access: 'creatable', label: 'project path' });
    parentStat = await fs.promises.stat(parent);
  } catch {
    throw operationError('`location` does not exist or escapes its owned folder through a symlink', 400, 'INVALID_PROJECT');
  }
  if (!parentStat.isDirectory()) throw operationError('`location` is not a directory', 400, 'INVALID_PROJECT');
  await deps.assertAvailable(target);

  try {
    await fs.promises.mkdir(target);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw operationError(`a folder named "${resolved.name}" already exists at that location`, 409, 'FOLDER_EXISTS');
    }
    throw operationError(`could not create the project folder: ${errorMessage(err)}`, 500);
  }

  // Membership is the commit record. Persist it before starting background
  // work so a config/removal failure can retire the still-empty directory.
  try {
    await deps.register(target);
  } catch (err) {
    try { await fs.promises.rmdir(target); } catch { /* keep a raced/non-empty folder */ }
    throw err;
  }
  // Agent Instructions are app metadata edited from the Agent-panel toolbar, so
  // project creation never writes an instruction file into the user's folder.
  deps.noteTreeChanged();
  void Promise.resolve()
    .then(() => deps.syncFolder(target))
    .catch((err: unknown) => log.warn(`create_project: background bind/sync failed for ${target}: ${errorMessage(err)}`));

  const { rebound, note } = applyRebind(input, target, deps);
  return { path: target, name: resolved.name, registered: true, rebound, note };
}

function applyRebind(
  input: Pick<CreateProjectInput, 'agentSessionId' | 'windowId'>,
  target: string,
  deps: CreateProjectDeps,
): { rebound: boolean; note: string } {
  const session = deps.session(input.agentSessionId)
    ?? deps.sessionForWindow(typeof input.windowId === 'string' ? input.windowId : undefined)
    ?? deps.turnActiveSession();
  const plan = createProjectRebindPlan(session);
  if (plan.kind === 'none') {
    if (plan.reason === 'folder-bound') {
      return {
        rebound: false,
        note: `The project was created and added to the library. This chat stays bound to its folder "${path.basename(plan.folder)}" — open a new chat in the project to work inside it.`,
      };
    }
    return {
      rebound: false,
      note: 'The project was created and added to the library. No calling chat session was rebound.',
    };
  }
  // Persist the history override BEFORE flipping the live binding: the
  // renderer reacts to `scope-changed` by opening the project and reading
  // its History, which must already include this session.
  const nativeId = session!.nativeSessionId();
  if (nativeId) deps.setOverride(session!.agentId, nativeId, target);
  const flipped = session!.rebindToFolder(target);
  if (!flipped) {
    // Raced with session close/teardown — undo the override; the record
    // stays a library session.
    if (nativeId) deps.clearOverride(session!.agentId, nativeId);
    return {
      rebound: false,
      note: 'The project was created and added to the library, but the calling chat session had ended and was not rebound.',
    };
  }
  if (!nativeId) {
    log.warn(`create_project: session rebound to ${target} before a native session id existed — history stays under the library listing`);
  }
  return {
    rebound: true,
    note: 'The project was created, added to the library, and this chat is now bound to it. Work with files inside the project from here on.',
  };
}
