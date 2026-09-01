import fs from 'node:fs';
import { embeddingAvailability } from './embedding-availability.ts';
import { getConversionSchedulerSnapshot, getInFlightConversions } from './conversion.ts';
import { clearRecord, listPreparationProblems, readProgress, type ConversionProgress } from './conversion-status.ts';
import { blockedAudioSourcesForFolder } from './audio-transcription.ts';
import { filesystemPath } from './filesystem-path.ts';
import { isLibraryFolderRemovalInProgress } from './folder.ts';
import { hasNoExtractableText, shouldIndexFilePath } from './indexable.ts';
import { displayPathForHit } from './pdf.ts';
import { getFsChangeCounter } from './watcher.ts';
import { getIndexWarning, getSemanticIndexingState, indexer } from './state.ts';
import type { IndexStatus, PreparationFailure, SemanticIndexingState } from '../shared/index-status.ts';
import type { IndexerStatus } from './indexer.ts';

/** The `/api/index-status` wire contract lives in `shared/index-status.ts` so
 * the renderer can import it without pulling this module's server-only graph
 * (`node:fs`, the conversion scheduler, the indexer) into the browser bundle.
 * Re-exported here so server-side callers keep one import site. */
export type {
  IndexStatus,
  IndexWarning,
  PreparationFailure,
  SemanticIndexingState,
  SemanticIndexingStatus,
} from '../shared/index-status.ts';

type SchedulerSnapshot = ReturnType<typeof getConversionSchedulerSnapshot>;

export function semanticIndexingState(input: {
  enabled: boolean;
  decision: 'awaiting-decision' | 'paused' | null;
  indexed: number;
  pending: number;
  failed: boolean;
  quotaExhausted?: boolean;
}): SemanticIndexingState {
  if (!input.enabled) return 'disabled';
  if (input.quotaExhausted) return input.indexed > 0 ? 'partial-quota-exhausted' : 'quota-exhausted';
  if (input.decision === 'awaiting-decision') return 'awaiting-decision';
  if (input.decision === 'paused') return input.indexed > 0 ? 'partial-paused' : 'paused';
  if (input.failed) return 'failed';
  if (input.pending > 0) return input.indexed > 0 ? 'partial-indexing' : 'indexing';
  return 'ready';
}

const RETIRING_FOLDER_INDEX_STATUS: IndexerStatus = {
  total: 0,
  indexed: 0,
  pendingCount: 0,
  pending: [],
  orphanedCount: 0,
  orphaned: [],
  upToDate: false,
  indexReady: false,
};

/** Status polls can already be queued behind a long daemon scan when folder
 * removal closes that daemon to interrupt the scan. During that short
 * retirement window, return a neutral transitional snapshot instead of
 * turning the expected rejected daemon call into a renderer-visible 500. */
export async function readIndexerStatusForFolder(
  folderRoot: string,
  readStatus: () => Promise<IndexerStatus> = () => indexer.status(folderRoot),
): Promise<IndexerStatus> {
  if (isLibraryFolderRemovalInProgress(folderRoot)) {
    return { ...RETIRING_FOLDER_INDEX_STATUS };
  }
  try {
    return await readStatus();
  } catch (err: unknown) {
    if (!isLibraryFolderRemovalInProgress(folderRoot)) throw err;
    return { ...RETIRING_FOLDER_INDEX_STATUS };
  }
}

export async function buildIndexStatus(folderRoot: string): Promise<IndexStatus> {
  const curRoot = filesystemPath.absolute(folderRoot);
  const status = await readIndexerStatusForFolder(curRoot);
  const treeVersion = getFsChangeCounter();
  const availability = embeddingAvailability();
  const semanticEnabled = availability.configured;
  const semanticAvailable = availability.available;
  const unavailableReason = availability.available ? null : availability.reason;
  const pending = semanticAvailable ? pendingVisibleFiles(status.pending, curRoot, folderRoot) : [];
  const orphaned = status.orphaned
    .map((p) => filesystemPath.relative(curRoot, p))
    .filter((p): p is string => p != null);
  const schedulerSnapshot = getConversionSchedulerSnapshot();
  const semanticDecision = semanticAvailable ? getSemanticIndexingState(curRoot) : null;
  const indexWarning = getIndexWarning(curRoot);
  const semanticState = semanticIndexingState({
    enabled: semanticEnabled,
    decision: semanticDecision?.decision ?? null,
    indexed: status.indexed,
    pending: pending.length,
    failed: indexWarning != null,
    quotaExhausted: unavailableReason === 'hosted-quota-exhausted',
  });

  return {
    folder: curRoot,
    ...status,
    semanticEnabled,
    semanticAvailable,
    ...(!semanticAvailable ? {
      semanticDisabledReason: unavailableReason === 'hosted-quota-exhausted'
        ? 'Hosted allowance exhausted; Exact Search remains available'
        : 'Embedding source required',
    } : {}),
    pending,
    pendingCount: pending.length,
    orphaned,
    orphanedCount: orphaned.length,
    visibleIndexingSettled: !semanticAvailable || semanticDecision != null || pending.length === 0,
    semanticIndexing: {
      state: semanticState,
      ...(semanticDecision ? {
        sourceCount: semanticDecision.sourceCount,
        estimatedBytes: semanticDecision.estimatedBytes,
      } : {}),
    },
    pendingConversions: getInFlightConversions(curRoot),
    blockedConversions: await blockedAudioSourcesForFolder(curRoot, treeVersion),
    conversionProgress: conversionProgressForFolder(curRoot, schedulerSnapshot),
    conversionRevision: schedulerSnapshot.revision,
    conversionVersions: conversionVersionsForFolder(curRoot, schedulerSnapshot),
    preparationFailures: preparationFailuresForFolder(curRoot),
    treeVersion,
    indexWarning,
  };
}

function pendingVisibleFiles(sourcePaths: string[], folderRootAbs: string, folderRoot: string): string[] {
  const pendingSet = new Set<string>();
  for (const sourcePath of sourcePaths) {
    const rel = filesystemPath.relative(folderRootAbs, sourcePath);
    if (rel == null) continue;
    if (!shouldIndexFilePath(rel)) continue;
    if (hasNoExtractableText(filesystemPath.join(folderRoot, rel))) continue;
    const visible = displayPathForHit(rel, folderRoot);
    if (visible) pendingSet.add(visible);
  }
  return [...pendingSet].sort();
}

export function preparationFailuresForFolder(folderRoot: string): PreparationFailure[] {
  const root = filesystemPath.absolute(folderRoot);
  const out: PreparationFailure[] = [];
  for (const { path: sourcePath, entry } of listPreparationProblems()) {
    const rel = filesystemPath.relative(root, sourcePath);
    if (rel == null) continue;
    if (!fs.existsSync(sourcePath)) {
      clearRecord(sourcePath);
      continue;
    }
    out.push({
      path: rel,
      lastError: entry.lastError ?? '',
      attempts: entry.attempts,
      status: entry.status === 'cancelled' ? 'cancelled' : 'failed',
    });
  }
  return out;
}

export function conversionProgressForFolder(
  folderRoot: string,
  snapshot: SchedulerSnapshot = getConversionSchedulerSnapshot(),
): Record<string, ConversionProgress> {
  const root = filesystemPath.absolute(folderRoot);
  const out: Record<string, ConversionProgress> = {};
  for (const task of snapshot.tasks) {
    const rel = filesystemPath.relative(root, task.key);
    if (rel == null) continue;
    if (task.state === 'queued' || task.state === 'yielded') {
      out[rel] = { phase: task.state, lane: task.lane, tasksAhead: task.tasksAhead ?? 0 };
      continue;
    }
    const progress = readProgress(task.key);
    if (progress) out[rel] = progress;
  }
  return out;
}

export function conversionVersionsForFolder(
  folderRoot: string,
  snapshot: SchedulerSnapshot = getConversionSchedulerSnapshot(),
): Record<string, number> {
  const root = filesystemPath.absolute(folderRoot);
  const out: Record<string, number> = {};
  for (const [sourcePath, version] of Object.entries(snapshot.versions)) {
    const rel = filesystemPath.relative(root, sourcePath);
    if (rel != null) out[rel] = version;
  }
  return out;
}
