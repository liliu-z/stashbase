/**
 * What preparation has done to one source, and what the user may do about it.
 *
 * `SourceReadiness` is the only vocabulary the Preparation views speak, and
 * every projection off it — the status line, the tree marker, the offered
 * actions — is total over its kinds. A new kind therefore fails the build
 * here instead of silently rendering nothing.
 */
import type { FolderIndexStatus, PreparationProgress } from '@/shared/domain/folder-index-status';

export type SourceReadiness =
  | { readonly kind: 'current' }
  | { readonly kind: 'pending'; readonly progress: PreparationProgress | null }
  /** `detail` is the daemon's own sentence about this file. It names the step
   *  that stopped, which no fixed line here could, so it is carried as a
   *  sentence rather than read off a thrown error. */
  | { readonly kind: 'failed'; readonly attempts: number; readonly detail: string }
  | { readonly kind: 'cancelled' };

export type SourceReadinessKind = SourceReadiness['kind'];

export type PreparedFormat = 'pdf' | 'docx';

/** The explicit controls a source's state can offer. The server stays the
 *  authority: offering an action is not a promise that it will succeed. */
export type PreparationAction = 'cancel' | 'reprocess';

export interface FolderPreparationSummary {
  readonly cancelled: number;
  readonly failed: number;
  /** A failure, a blocked source, or an index warning needs the user. */
  readonly needsAttention: boolean;
  readonly pending: number;
}

const CURRENT: SourceReadiness = { kind: 'current' };
const CANCELLED: SourceReadiness = { kind: 'cancelled' };

const POLL_BUSY_MS = 1_500;
const POLL_IDLE_MS = 8_000;

export function sourceReadiness(
  status: FolderIndexStatus | null | undefined,
  sourcePath: string,
): SourceReadiness {
  if (!status) return CURRENT;
  const failure = status.preparationFailures.find((entry) => entry.path === sourcePath);
  if (failure) {
    return failure.status === 'cancelled'
      ? CANCELLED
      : { attempts: failure.attempts, detail: failure.lastError, kind: 'failed' };
  }
  const progress = status.conversionProgress[sourcePath];
  if (progress) return { kind: 'pending', progress };
  if (status.pendingConversions.includes(sourcePath)) return { kind: 'pending', progress: null };
  return CURRENT;
}

/** Every visible source the status says something about. A path can appear in
 *  more than one list — a conversion that failed and was queued again — and it
 *  is still one source, so the readiness it resolves to buckets it once. */
function reportedPaths(status: FolderIndexStatus): Set<string> {
  return new Set([
    ...status.preparationFailures.map((failure) => failure.path),
    ...status.pendingConversions,
  ]);
}

/** One counter per readiness kind. Written as a total record so a new kind has
 *  to be answered here rather than silently counting as nothing. */
function readinessCounts(status: FolderIndexStatus): Record<SourceReadinessKind, number> {
  const counts: Record<SourceReadinessKind, number> = {
    cancelled: 0,
    current: 0,
    failed: 0,
    pending: 0,
  };
  for (const path of reportedPaths(status)) counts[sourceReadiness(status, path).kind] += 1;
  return counts;
}

export function folderPreparationSummary(
  status: FolderIndexStatus | null | undefined,
): FolderPreparationSummary {
  if (!status) return { cancelled: 0, failed: 0, needsAttention: false, pending: 0 };
  const counts = readinessCounts(status);
  return {
    cancelled: counts.cancelled,
    failed: counts.failed,
    needsAttention: counts.failed > 0 || status.indexWarning !== null,
    pending: counts.pending,
  };
}

/** Poll quickly while preparation or embedding work is moving, slowly when idle. */
export function preparationPollInterval(status: FolderIndexStatus | null | undefined): number {
  if (!status) return POLL_BUSY_MS;
  const busy = status.pendingConversions.length > 0 || !status.indexSettled;
  return busy ? POLL_BUSY_MS : POLL_IDLE_MS;
}

function progressCopy(progress: PreparationProgress | null, format: PreparedFormat): string {
  if (!progress) return 'Waiting to prepare searchable text…';
  switch (progress.phase) {
    case 'queued':
    case 'yielded':
      return progress.tasksAhead > 0
        ? 'Waiting for other file preparation to finish…'
        : 'Waiting to prepare searchable text…';
    case 'indexing':
      return 'Indexing searchable text…';
    case 'extracting':
      if (format === 'pdf' && progress.currentPage !== undefined) {
        return `Reading page ${progress.currentPage}…`;
      }
      return 'Preparing searchable text…';
  }
}

/** One line for a viewer status row; null when nothing needs saying. */
export function readinessStatusLine(
  readiness: SourceReadiness,
  format: PreparedFormat,
): string | null {
  switch (readiness.kind) {
    case 'current':
      return null;
    case 'pending':
      return progressCopy(readiness.progress, format);
    case 'cancelled':
      return 'Preparation was cancelled. Reprocess it when you want searchable text.';
    case 'failed':
      switch (format) {
        case 'pdf':
          return 'This PDF is not searchable. Reprocess it to try again.';
        case 'docx':
          return 'The document is visible, but its searchable text is unavailable.';
        default:
          return exhausted(format);
      }
    default:
      return exhausted(readiness);
  }
}

export interface TreeMarker {
  readonly kind: 'cancelled' | 'failed';
  readonly title: string;
}

/** Tree rows mark only states that need the user; pending and current stay
 *  quiet, but they say so here rather than falling through a default. */
export function treeMarker(readiness: SourceReadiness): TreeMarker | null {
  switch (readiness.kind) {
    case 'failed':
      return { kind: 'failed', title: 'File preparation failed; this file may not be searchable.' };
    case 'cancelled':
      return {
        kind: 'cancelled',
        title: 'File preparation was cancelled. Reprocess it when you want searchable text.',
      };
    case 'current':
    case 'pending':
      return null;
    default:
      return exhausted(readiness);
  }
}

const NO_ACTIONS: ReadonlySet<PreparationAction> = new Set();
const CANCEL_ONLY: ReadonlySet<PreparationAction> = new Set(['cancel']);
const REPROCESS_ONLY: ReadonlySet<PreparationAction> = new Set(['reprocess']);

/** One action set per readiness kind. Written as a total map so a new kind
 *  cannot inherit an empty set by accident: it has to be answered here. */
const ACTIONS: Record<SourceReadinessKind, ReadonlySet<PreparationAction>> = {
  cancelled: REPROCESS_ONLY,
  current: NO_ACTIONS,
  failed: REPROCESS_ONLY,
  pending: CANCEL_ONLY,
};

/** Which explicit controls a source's state offers. */
export function availableActions(readiness: SourceReadiness): ReadonlySet<PreparationAction> {
  return ACTIONS[readiness.kind];
}

/** How loudly a state is said: `attention` is something the reader can act on,
 *  `quiet` is progress. Written as a total map for the same reason the action
 *  sets are — a new kind is answered here, not defaulted. */
const TONES: Record<SourceReadinessKind, 'attention' | 'quiet'> = {
  cancelled: 'quiet',
  current: 'quiet',
  failed: 'attention',
  pending: 'quiet',
};

export function readinessTone(readiness: SourceReadiness): 'attention' | 'quiet' {
  return TONES[readiness.kind];
}

/** The compiler proves this call cannot happen: a new variant fails to compile
 *  at the call site instead of falling through to a blank. */
function exhausted(value: never): never {
  return value;
}
