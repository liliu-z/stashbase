/**
 * File preparation status — split by durability:
 *
 *   - **queued/running: process memory only.** `conversion-scheduler.ts`
 *     owns queued tasks; this module tracks extractor progress after a task
 *     starts. A conversion's subprocess is
 *     our child; if this process dies, the conversion dies with it, so
 *     persisting "in-flight" only ever produced corpses that needed a
 *     reclaim pass on every reconcile. Memory state can't outlive the
 *     truth it describes. After a crash, an unconverted source is simply
 *     rediscovered ("source exists, derived note doesn't, no failure
 *     record → queue") — conversions are idempotent.
 *
 *   - **failures: persisted** (per-machine app-data `state.db`,
 *     `conversions` table) — recovery affordances need the reason and
 *     attempt count to survive restarts, and a persistent failure must
 *     NOT be silently re-queued by the next discovery walk.
 *
 * "Done" is not a state we record: the derived note on disk IS the
 * record (discovery skips sources whose note exists).
 */
import {
  clearConversionStatus,
  clearConversionStatusUnder,
  getConversionStatus,
  listConversionStatus,
  readConversionStatusMap,
  setConversionStatus,
  type ConversionStatus,
  type ConversionStatusEntry,
} from './state-db.ts';
import { filesystemPath } from './filesystem-path.ts';

export type { ConversionStatus, ConversionStatusEntry };
export type ConversionStatusMap = Record<string, ConversionStatusEntry>;
export type { ConversionProgress } from '../shared/conversion.ts';
import type { ConversionProgress } from '../shared/conversion.ts';

const inFlight = new Set<string>();
const progress = new Map<string, ConversionProgress>();

/** Persisted failures only (the Retry surface). */
export function readAll(): ConversionStatusMap {
  return readConversionStatusMap();
}


/** True when this source needs no (re)queue decision: either a
 *  conversion is running right now, or a persisted failure says a human
 *  must press Retry first. */
export function isPendingOrFailed(sourcePath: string): boolean {
  return inFlight.has(filesystemPath.identity(sourcePath)) || getConversionStatus(sourcePath) !== undefined;
}

export function hasFailed(sourcePath: string): boolean {
  return getConversionStatus(sourcePath)?.status === 'failed';
}

export function markInFlight(sourcePath: string): void {
  const key = filesystemPath.identity(sourcePath);
  inFlight.add(key);
  progress.set(key, { phase: 'extracting' });
}

/** Success: drop the in-flight marker and clear any stale failure row
 *  from a previous attempt. */
export function markDone(sourcePath: string): void {
  const key = filesystemPath.identity(sourcePath);
  inFlight.delete(key);
  progress.delete(key);
  clearConversionStatus(sourcePath);
}

export function markFailed(sourcePath: string, errorMsg: string): void {
  const key = filesystemPath.identity(sourcePath);
  inFlight.delete(key);
  progress.delete(key);
  setConversionStatus(sourcePath, 'failed', { error: errorMsg, incrementAttempts: true });
}

/** Explicit user cancellation is durable so reconcile does not immediately
 * restart the work. It is not counted as a failed inference attempt and is
 * cleared by the same manual Reprocess boundary as a real failure. */
export function markCancelled(sourcePath: string): void {
  const key = filesystemPath.identity(sourcePath);
  inFlight.delete(key);
  progress.delete(key);
  setConversionStatus(sourcePath, 'cancelled', { error: 'Cancelled by user' });
}

export function clearRecord(sourcePath: string): void {
  const key = filesystemPath.identity(sourcePath);
  inFlight.delete(key);
  progress.delete(key);
  clearConversionStatus(sourcePath);
}

export function clearRecordsUnder(sourcePathPrefix: string): void {
  for (const key of [...inFlight]) {
    if (filesystemPath.contains(sourcePathPrefix, key)) {
      inFlight.delete(key);
      progress.delete(key);
    }
  }
  clearConversionStatusUnder(sourcePathPrefix);
}

export function listFailed(): Array<{ path: string; entry: ConversionStatusEntry }> {
  return listConversionStatus('failed');
}

export function listPreparationProblems(): Array<{ path: string; entry: ConversionStatusEntry }> {
  return [...listConversionStatus('failed'), ...listConversionStatus('cancelled')]
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function setProgress(sourcePath: string, next: ConversionProgress): void {
  const key = filesystemPath.identity(sourcePath);
  if (!inFlight.has(key)) return;
  progress.set(key, next);
}

export function readProgress(sourcePath: string): ConversionProgress | undefined {
  return progress.get(filesystemPath.identity(sourcePath));
}
