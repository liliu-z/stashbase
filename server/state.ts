/**
 * Process-wide indexer state + folder-switch orchestration.
 *
 * One `MfsIndexer` instance lives for the lifetime of the server
 * process. The daemon underneath owns one Milvus DB in app data with a
 * single collection (V1 fixes the embedder to OpenAI — no switching).
 * Every folder is bound into that one collection. Boot binds every known
 * folder so MCP cross-folder search has them all available; boot and
 * Welcome can also reconcile known folders without opening them, so
 * interrupted conversion work is rediscovered library-wide.
 *
 * Extracted from `server/index.ts` so route modules can import the
 * indexer without picking up the whole route registration kitchen sink.
 */
import { MfsIndexer } from './indexer.mfs.ts';
import type { Indexer, EmbedderRuntimeConfig } from './indexer.ts';
import { getCurrentFolder, getRecentFolders, onClose, onSwitch, runWithWindowId } from './folder.ts';
import { filesystemPath } from './filesystem-path.ts';
import { getEmbeddingSource, getEmbedderConfig } from './app-config.ts';
import { isEmbeddingAvailable } from './embedding-availability.ts';
import { hostedEmbeddingRuntime } from './hosted-embedding-broker.ts';
import { syncIndex, type SyncResult } from './sync.ts';
import { getDaemon } from './mfs-daemon.ts';
import { clearStaleMilvusLock } from './stale-lock.ts';
import { noteTreeChanged } from './watcher.ts';
import { logger, errorMessage } from './log.ts';
import { globalVectorStoreDir } from './local-data.ts';
import {
  clearSemanticIndexingDecision,
  getSemanticIndexingDecision,
  setSemanticIndexingDecision,
  type SemanticIndexingDecision,
} from './state-db.ts';
import type { SemanticWorkloadEstimate } from './semantic-workload.ts';

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
  folderSyncGeneration.delete(root);
  clearSemanticIndexingDecision(folderRoot);
}

export function getSemanticIndexingState(folderRoot: string): SemanticIndexingDecision | null {
  return getSemanticIndexingDecision(folderRoot);
}

export function deferSemanticIndexing(folderRoot: string): void {
  const current = getSemanticIndexingDecision(folderRoot);
  if (current) setSemanticIndexingDecision(folderRoot, 'paused', current);
}

export async function startSemanticIndexing(folderRoot: string): Promise<SyncResult> {
  return syncFolderNow(folderRoot, {
    reason: 'user started semantic indexing', forceEmbedding: true, clearDecisionAtStart: true,
  });
}

export function semanticSyncPolicy(folderRoot: string, forceEmbedding = false): {
  shouldPauseEmbedding: (workload: SemanticWorkloadEstimate) => boolean;
  publishPaused: (workload: SemanticWorkloadEstimate) => boolean;
  commitEmbedding: () => boolean;
} {
  return {
    shouldPauseEmbedding: (workload) => {
      if (forceEmbedding) return false;
      const existing = getSemanticIndexingDecision(folderRoot);
      if (existing?.decision === 'paused') return true;
      return workload.large;
    },
    publishPaused: (workload) => {
      const existing = getSemanticIndexingDecision(folderRoot);
      return setSemanticIndexingDecision(
        folderRoot,
        existing?.decision === 'paused' ? 'paused' : 'awaiting-decision',
        workload,
      );
    },
    commitEmbedding: () => {
      const existing = getSemanticIndexingDecision(folderRoot);
      return !existing || clearSemanticIndexingDecision(folderRoot);
    },
  };
}

/** Resolve the active runtime embedder config. Returns null when no source is
 * configured or the hosted allowance is exhausted — the caller still binds
 * the folder, while semantic work stays paused until availability returns. */
function resolveEmbedder(): EmbedderRuntimeConfig | null {
  if (!isEmbeddingAvailable()) return null;
  if (getEmbeddingSource() === 'stashbase-account') return hostedEmbeddingRuntime();
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

/** Configure + spawn the daemon, then bind every folder in Your Folders.
 *  Idempotent on the bind side; safe to call once at server
 *  startup. With no embedding source, folders are still bound (registered) but the
 *  collection isn't created until one is supplied — semantic search just
 *  returns nothing until then. */
function libraryFolderRoots(): string[] {
  // Membership = "Your Folders" (the recents list), which can live anywhere
  // on disk. Bind every member's absolute root so MCP/Claude can search the
  // whole library without the user first opening each folder.
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
  const roots = libraryFolderRoots();
  if (roots.length === 0) {
    log.info('boot bind: no member folders');
    return;
  }
  log.info(`boot bind: ${roots.length} folder(s)`);
  const cfg = resolveEmbedder() ?? {
    provider: getEmbeddingSource() === 'stashbase-account' ? 'stashbase' : getEmbedderConfig().provider,
  };
  for (const root of roots) {
    try {
      await indexer.bindFolder(root, cfg);
    } catch (err: unknown) {
      log.warn(`boot bind ${root} failed: ${errorMessage(err)}`);
    }
  }
}

/** Reconcile every library member without changing the active window folder.
 *  This is the library-level recovery hook: after a process restart, or when
 *  the user sits on Welcome, interrupted PDF/image conversions should resume
 *  even if no folder is opened into the editor. */
export async function reconcileLibraryFolders(reason: string): Promise<void> {
  const roots = libraryFolderRoots();
  if (roots.length === 0) return;
  log.info(`library reconcile: ${roots.length} folder(s) (${reason})`);
  for (const root of roots) {
    try {
      await syncFolderNow(root, { reason });
    } catch (err: unknown) {
      log.warn(`library reconcile ${root} failed: ${errorMessage(err)}`);
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

/** Per-vector-store latch for the stale-flock sweep below. */
const staleLockSweptStores = new Set<string>();

function claimStaleLockSweep(storeRoot: string): boolean {
  const key = filesystemPath.identity(storeRoot);
  if (staleLockSweptStores.has(key)) return false;
  staleLockSweptStores.add(key);
  return true;
}

/** Bind the indexer to a folder using the configured embedder. Called on
 *  every folder switch (idempotent). Doesn't trigger sync — caller's
 *  responsibility via `scheduleIndexerSync`. With no active source the folder is
 *  still bound but indexing is disabled. */
export async function bindIndexerForFolder(folderAbs: string): Promise<void> {
  // Before the first bind of this process, sweep any stashbase daemon
  // still holding the global Milvus flock: a dirty previous exit (kill -9,
  // OS shutdown) or another session's leftover daemon would otherwise
    // wedge our bind, and the loser of a lock fight keeps "succeeding" while
    // its writes go nowhere. This call site is
  // deliberately the WEB SERVER's bind path only — the MCP host must never
  // run the sweep, since the GUI's daemon is the rightful lock owner it
  // would be killing.
  if (claimStaleLockSweep(globalVectorStoreDir())) {
    try { clearStaleMilvusLock(); } catch (err: unknown) {
      log.warn(`stale-lock sweep failed: ${errorMessage(err)}`);
    }
  }
  const cfg = resolveEmbedder();
  const runtime = cfg ?? {
    provider: getEmbeddingSource() === 'stashbase-account' ? 'stashbase' : getEmbedderConfig().provider,
  };
  if (!cfg) {
    log.warn(`embedder: no embedding source active — ${folderAbs} bound but AI Index is disabled until an account or key is selected`);
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
    || result.renamed.length > 0
    || result.failed.length > 0;
}

const folderSyncQueues = new Map<string, Promise<unknown>>();

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
  opts: { reason?: string; shouldContinue?: () => boolean; forceEmbedding?: boolean; clearDecisionAtStart?: boolean } = {},
): Promise<SyncResult> {
  const syncFolderRoot = filesystemPath.absolute(folderRoot);
  const queueKey = filesystemPath.identity(syncFolderRoot);
  return enqueueFolderSyncOperation(queueKey, () => runFolderSyncOperation(syncFolderRoot, opts));
}

export async function runFolderSyncOperation(
  folderRoot: string,
  opts: { reason?: string; shouldContinue?: () => boolean; forceEmbedding?: boolean; clearDecisionAtStart?: boolean },
  deps: {
    indexer: Indexer;
    bind: (folderRoot: string) => Promise<void>;
    sync: typeof syncIndex;
    semanticEnabled?: boolean;
  } = { indexer, bind: bindIndexerForFolder, sync: syncIndex },
): Promise<SyncResult> {
  const syncGeneration = currentFolderSyncGeneration(folderRoot);
  const shouldContinue = () => shouldContinueFolderSync(folderRoot, syncGeneration, opts.shouldContinue);
  try {
    if (opts.clearDecisionAtStart && !clearSemanticIndexingDecision(folderRoot)) {
      throw new Error('semantic indexing decision could not be cleared');
    }
    await deps.bind(folderRoot);
    if (!shouldContinue()) {
      return { added: [], modified: [], removed: [], renamed: [], failed: [], cancelled: true };
    }
    const result = await deps.sync(deps.indexer, folderRoot, {
      shouldContinue,
      semanticEnabled: deps.semanticEnabled,
      ...semanticSyncPolicy(folderRoot, opts.forceEmbedding),
    });
    if (result.cancelled) {
      return result;
    }
    if (syncTouchedVisibleTree(result)) noteTreeChanged();
    if (result.failed.length && !result.semanticPaused) {
      recordIndexWarning(folderRoot, syncFailureMessage(result));
    } else {
      clearIndexWarning(folderRoot);
    }
    return result;
  } catch (err: unknown) {
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
          // Full content-hash diff — the only reconcile tier. Hashing
          // is milliseconds for a personal library; embedding still only
          // happens for changed hashes, so reopening a fully-indexed
          // folder costs zero tokens, AND external edits made while the
          // app was closed are caught right here instead of waiting for
          // a manual sync.
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
