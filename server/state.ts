/**
 * Process-wide indexer state + folder-switch orchestration.
 *
 * One `MfsIndexer` instance lives for the lifetime of the server
 * process. The daemon underneath owns the MFS store in app data and gives
 * each Folder one Internal namespace. Boot binds every known Folder so it is
 * ready when selected, but reconciles none of them: a Folder reconciles when a
 * window opens it, and interrupted conversion work resumes on that open.
 *
 * Extracted from `server/index.ts` so route modules can import the
 * indexer without picking up the whole route registration kitchen sink.
 */
import { MfsIndexer } from './indexer.mfs.ts';
import type { Indexer, EmbedderRuntimeConfig } from './indexer.ts';
import {
  getCurrentFolder,
  getRecentFolders,
  isProjectFolderRemovalInProgress,
  onClose,
  onSwitch,
  runWithWindowId,
} from './folder.ts';
import { filesystemPath } from './filesystem-path.ts';
import { getEmbedderConfig } from './app-config.ts';
import { syncIndex, type SyncResult } from './sync.ts';
import { getDaemon, isMfsDaemonRetiringError } from './mfs-daemon.ts';
import { noteTreeChanged } from './watcher.ts';
import { logger, errorMessage } from './log.ts';

const log = logger('state');

/** Single indexer instance shared across every route. */
export const indexer: Indexer = new MfsIndexer();

export interface IndexSyncWarning {
  message: string;
  at: string;
}
const indexWarnings = new Map<string, IndexSyncWarning>();
export function getIndexWarning(folder: string): IndexSyncWarning | null {
  return indexWarnings.get(filesystemPath.identity(folder)) ?? null;
}
export function clearIndexWarning(folder: string): void {
  indexWarnings.delete(filesystemPath.identity(folder));
}
function recordIndexWarning(folder: string, message: string): void {
  indexWarnings.set(filesystemPath.identity(folder), { message, at: new Date().toISOString() });
}

function hasLostIndexerBinding(result: SyncResult): boolean {
  return result.failed.some(({ error }) => (
    /no bound root matches path .*call bind_root first/i.test(error)
  ));
}

const folderSyncGeneration = new Map<string, number>();

function currentFolderSyncGeneration(folderRoot: string): number {
  return folderSyncGeneration.get(filesystemPath.identity(folderRoot)) ?? 0;
}

function shouldContinueFolderSync(
  folderRoot: string,
  startedAt: number,
  callerShouldContinue?: () => boolean,
): boolean {
  return currentFolderSyncGeneration(folderRoot) === startedAt && (!callerShouldContinue || callerShouldContinue());
}

export async function deleteFolderRuntimeState(folderRoot: string): Promise<void> {
  const root = filesystemPath.identity(folderRoot);
  indexWarnings.delete(root);
  // Never reset this to zero while an older reconcile can still observe it:
  // doing so makes a generation-0 task look current again. Retaining the
  // monotonic value is cheap and lets a later re-add start from fresh truth.
  folderSyncGeneration.set(root, currentFolderSyncGeneration(folderRoot) + 1);
}

/** Resolve the active BYOK runtime config, or null when no key is configured. */
export function resolveEmbedderRuntime(): EmbedderRuntimeConfig | null {
  const cfg = getEmbedderConfig();
  if (!cfg.apiKey) return null;
  return {
    provider: cfg.provider,
    apiKey: cfg.apiKey,
    model: cfg.model,
    dimension: cfg.dimension,
    baseUrl: cfg.baseUrl,
  };
}

/** Collect the registered project roots for daemon binding and reconciliation.
 *  Idempotent on the bind side; safe to call once at server startup. Without
 *  an embedding key each Internal namespace is created with vector indexing
 *  off, so exact retrieval and projection maintenance stay available. */
function projectFolderRoots(): string[] {
  // Registered project folders can live anywhere
  // on disk. Bind every member's absolute root so its namespace can reconcile
  // without requiring the user to open it first.
  const members = new Map<string, string>();
  for (const recent of getRecentFolders()) {
    const source = filesystemPath.absolute(recent.path);
    if (!members.has(filesystemPath.identity(source))) {
      members.set(filesystemPath.identity(source), source);
    }
  }
  return [...members.values()];
}

export async function bootBindAllFolders(): Promise<void> {
  const roots = projectFolderRoots();
  if (roots.length === 0) {
    log.info('boot bind: no member folders');
    return;
  }
  log.info(`boot bind: ${roots.length} folder(s)`);
  const cfg = resolveEmbedderRuntime() ?? {
    provider: getEmbedderConfig().provider,
  };
  for (const root of roots) {
    try {
      await indexer.bindFolder(root, cfg);
    } catch (err: unknown) {
      log.warn(`boot bind ${root} failed: ${errorMessage(err)}`);
    }
  }
}

/** Reconcile every project member without changing the active window folder.
 *  Only the embedding-key backfill uses this: a newly saved key should embed
 *  every registered Folder, not just the open one. Boot deliberately does not
 *  call it; ordinary reconcile is folder-explicit and runs when a window opens
 *  a Folder. */
export async function reconcileProjectFolders(reason: string): Promise<void> {
  const roots = projectFolderRoots();
  if (roots.length === 0) return;
  log.info(`project reconcile: ${roots.length} folder(s) (${reason})`);
  for (const root of roots) {
    try {
      await syncFolderNow(root, { reason });
    } catch (err: unknown) {
      log.warn(`project reconcile ${root} failed: ${errorMessage(err)}`);
    }
  }
}

/** Tear down the Python daemon after global runtime config changes.
 *  `forgetBindings` is important for embedding key changes: bindings replay
 *  during daemon startup carry credentials, so stale entries could
 *  recreate the embedder with the old key before the fresh bind lands. */
export async function resetIndexerRuntime(opts: { forgetBindings?: boolean } = {}): Promise<void> {
  await indexer.close();
  if (opts.forgetBindings) getDaemon().forgetBindings();
}

/** Bind the indexer to a folder using the configured embedder. Called on
 *  every folder switch (idempotent). Doesn't trigger sync — caller's
 *  responsibility via `scheduleIndexerSync`. Without a key the folder remains
 *  bound for grep; vector indexing is disabled. */
export async function bindIndexerForFolder(folderAbs: string): Promise<void> {
  const cfg = resolveEmbedderRuntime();
  const runtime = cfg ?? { provider: getEmbedderConfig().provider };
  if (!cfg) {
    log.warn(`embedder: no provider key configured — ${folderAbs} bound for keyword search; add an OpenAI, OpenRouter, or Requesty key for search by meaning`);
  }
  await indexer.bindFolder(filesystemPath.absolute(folderAbs), runtime);
}


// Serialise indexer bind + sync so rapid folder switches don't race. The
// seq guard short-circuits a stale tail when the user has already moved
// on; the queue chains each switch after the previous one finishes.
const indexerSwitchSeq = new Map<string, number>();
const indexerSwitchQueues = new Map<string, Promise<void>>();

/** Live bookkeeping behind the gate + watchdog: one record per scheduled
 *  bind+sync segment, self-removing when the segment settles. Lets the
 *  gate filter by folder and the watchdog name what's stuck. */
interface PendingSwitch {
  promise: Promise<void>;
  folderRoot: string;
  reason: string;
  windowId: string;
  scheduledAt: number;
  warned: boolean;
}
const pendingSwitches = new Set<PendingSwitch>();

// Watchdog for the Data Correctness bounded-progress rule: every queue entry
// must settle in bounded time. A hard timeout can't work here — first-index
// of a large folder legitimately runs bind+sync for tens of minutes — so
// we supervise instead of intervene: any entry older than 15min gets one
// loud warning with enough context to find the wedge. Lazily started,
// unref'd so it never keeps the process alive.
const SWITCH_WATCHDOG_AFTER_MS = 15 * 60_000;
let switchWatchdog: NodeJS.Timeout | null = null;
function ensureSwitchWatchdog(): void {
  if (switchWatchdog) return;
  switchWatchdog = setInterval(() => {
    const now = Date.now();
    for (const p of pendingSwitches) {
      if (p.warned || now - p.scheduledAt < SWITCH_WATCHDOG_AFTER_MS) continue;
      p.warned = true;
      log.warn(
        `folder-open queue entry unsettled after ${Math.round((now - p.scheduledAt) / 60_000)}min ` +
          `(${p.reason}, folder=${p.folderRoot}, window=${p.windowId}) — bind/import/sync may be wedged ` +
          '(Data Correctness & Recovery: bounded progress)',
      );
    }
  }, 60_000);
  switchWatchdog.unref();
}

function syncFailureMessage(result: SyncResult): string {
  const sample = result.failed.slice(0, 3).map((f) => `${f.name}: ${f.error}`).join('; ');
  const suffix = result.failed.length > 3 ? `; plus ${result.failed.length - 3} more` : '';
  return `${result.failed.length} file(s) could not be indexed${sample ? ` (${sample}${suffix})` : ''}`;
}

function syncTouchedVisibleTree(result: SyncResult): boolean {
  return result.added.length > 0
    || result.modified.length > 0
    || result.removed.length > 0
    || result.failed.length > 0;
}

const folderSyncQueues = new Map<string, Promise<unknown>>();

/** Stop queued/running reconcile before removal begins index cleanup. An
 * in-flight MFS write cannot observe Node's cooperative generation flag.
 * Close the daemon to reject that request immediately; the next cleanup
 * operation respawns it and replays bindings from durable Node-owned state. */
export async function cancelFolderSyncsAndWait(
  folderRoot: string,
  interruptIndexer: () => Promise<void> = () => indexer.close(),
): Promise<void> {
  const key = filesystemPath.identity(folderRoot);
  folderSyncGeneration.set(key, currentFolderSyncGeneration(folderRoot) + 1);
  const pending = folderSyncQueues.get(key);
  if (!pending) return;
  try {
    await interruptIndexer();
  } catch (err: unknown) {
    log.warn(`folder remove: indexer interrupt failed for ${folderRoot}: ${errorMessage(err)}`);
  }
  await pending?.catch(() => undefined);
}

export function enqueueFolderSyncOperation<T>(queueKey: string, operation: () => Promise<T>): Promise<T> {
  const prev = folderSyncQueues.get(queueKey) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(operation);
  const settled = next.catch(() => undefined).finally(() => {
    if (folderSyncQueues.get(queueKey) === settled) folderSyncQueues.delete(queueKey);
  });
  folderSyncQueues.set(queueKey, settled);
  return next;
}

export async function syncFolderNow(
  folderRoot: string,
  opts: { reason?: string; shouldContinue?: () => boolean } = {},
): Promise<SyncResult> {
  const syncFolderRoot = filesystemPath.absolute(folderRoot);
  if (isProjectFolderRemovalInProgress(syncFolderRoot)) {
    return { added: [], modified: [], removed: [], failed: [], cancelled: true };
  }
  const queueKey = filesystemPath.identity(syncFolderRoot);
  const scheduledGeneration = currentFolderSyncGeneration(syncFolderRoot);
  return enqueueFolderSyncOperation(
    queueKey,
    () => runFolderSyncOperation(syncFolderRoot, opts, undefined, scheduledGeneration),
  );
}

export async function runFolderSyncOperation(
  folderRoot: string,
  opts: { reason?: string; shouldContinue?: () => boolean },
  deps: {
    indexer: Indexer;
    bind: (folderRoot: string) => Promise<void>;
    sync: typeof syncIndex;
  } = { indexer, bind: bindIndexerForFolder, sync: syncIndex },
  scheduledGeneration = currentFolderSyncGeneration(folderRoot),
): Promise<SyncResult> {
  const shouldContinue = () => shouldContinueFolderSync(folderRoot, scheduledGeneration, opts.shouldContinue);
  let daemonRecoveryRetries = 0;
  try {
    while (true) {
      try {
        if (!shouldContinue()) {
          return { added: [], modified: [], removed: [], failed: [], cancelled: true };
        }
        await deps.bind(folderRoot);
        if (!shouldContinue()) {
          return { added: [], modified: [], removed: [], failed: [], cancelled: true };
        }
        const result = await deps.sync(deps.indexer, folderRoot, {
          shouldContinue,
        });
        if (daemonRecoveryRetries === 0 && hasLostIndexerBinding(result)) {
          daemonRecoveryRetries += 1;
          log.info(`indexer binding changed during sync for ${folderRoot}; retrying from bind`);
          continue;
        }
        if (result.cancelled) {
          return result;
        }
        if (syncTouchedVisibleTree(result)) noteTreeChanged();
        if (result.failed.length) {
          recordIndexWarning(folderRoot, syncFailureMessage(result));
        } else {
          clearIndexWarning(folderRoot);
        }
        return result;
      } catch (err: unknown) {
        if (!shouldContinue()) {
          return { added: [], modified: [], removed: [], failed: [], cancelled: true };
        }
        // Folder removal must close the process-wide daemon to interrupt a
        // scan for that folder. A concurrent reconcile for another live
        // member is rejected by the same close even though its generation is
        // still valid. Re-run that authoritative diff once: bind waits for
        // daemon retirement and replays current bindings before continuing.
        if (daemonRecoveryRetries === 0 && isMfsDaemonRetiringError(err)) {
          daemonRecoveryRetries += 1;
          log.info(`daemon retired during sync for ${folderRoot}; retrying on the replacement generation`);
          continue;
        }
        throw err;
      }
    }
  } catch (err: unknown) {
    // Folder removal closes the daemon to interrupt an in-flight MFS call.
    // The rejected request belongs to an invalidated generation,
    // so surface normal cancellation instead of a stale warning/toast.
    if (!shouldContinue()) {
      return { added: [], modified: [], removed: [], failed: [], cancelled: true };
    }
    recordIndexWarning(folderRoot, errorMessage(err));
    throw err;
  }
}

export function scheduleIndexerSync(folderRoot: string, reason: string, windowId = 'default'): void {
  const seq = (indexerSwitchSeq.get(windowId) ?? 0) + 1;
  indexerSwitchSeq.set(windowId, seq);
  const prev = indexerSwitchQueues.get(windowId) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await runWithWindowId(windowId, async () => {
        const current = getCurrentFolder();
        if (!current || !filesystemPath.equal(current, folderRoot)) return;
        try {
          // One authoritative reconcile tier: enumerate admitted sources and
          // offer complete projections to MFS. MFS hashes each projection and
          // skips embedding unchanged revisions, so reopening a current Folder
          // costs no provider tokens while external direct-text edits are
          // still observed here.
          await syncFolderNow(folderRoot, {
            reason,
            shouldContinue: () => {
              const active = getCurrentFolder();
              return !!active
                && filesystemPath.equal(active, folderRoot)
                && seq === indexerSwitchSeq.get(windowId);
            },
          });
        } catch (err: unknown) {
          log.warn(`${reason}: index sync failed for ${folderRoot}: ${errorMessage(err)}`);
        }
      });
    });
  indexerSwitchQueues.set(windowId, next);
  const entry: PendingSwitch = {
    promise: next, folderRoot, reason, windowId, scheduledAt: Date.now(), warned: false,
  };
  pendingSwitches.add(entry);
  ensureSwitchWatchdog();
  void next.catch(() => undefined).finally(() => pendingSwitches.delete(entry));
}

// Fire a queued bind + sync on every folder switch. Registered at module
// load time so any importer (index.ts, tests) gets the wiring for free.
onSwitch((newRoot, windowId) => {
  scheduleIndexerSync(newRoot, 'folder switch', windowId);
});

onClose((_oldRoot, windowId) => {
  indexerSwitchSeq.set(windowId, (indexerSwitchSeq.get(windowId) ?? 0) + 1);
  indexerSwitchQueues.delete(windowId);
});
