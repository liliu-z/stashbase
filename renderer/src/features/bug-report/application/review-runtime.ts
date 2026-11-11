/**
 * The review window's one runtime: the session store, and the commands the
 * form and the ready view call.
 *
 * Mutating commands run on one serialized chain so a selection and a
 * description commit never interleave on main.
 * Each command captures the session generation before its first await and
 * stamps its events with it; the reducer drops whatever a reopen made stale.
 * Preview reads stay off the chain: they change nothing on main.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';

import {
  initialReviewSession,
  reduceReviewSession,
  type ReviewDescription,
  type ReviewEvent,
  type ReviewFailure,
  type ReviewFailureExtra,
  type ReviewSession,
} from '@/features/bug-report/domain/review-session';
import { isFeatureError } from '@/shared/domain/feature-error';
import { createSerialQueue } from '@/shared/runtime/serial-queue';

import type { BugReportReviewPort } from './ports';

export interface BugReportReviewRuntime {
  readonly store: StoreApi<ReviewSession>;
  /** Discards the draft while it is still under review, then closes the
   *  window. Once approved, main retires the draft on close by itself. */
  close(): Promise<void>;
  commitDescription(): Promise<void>;
  download(): Promise<void>;
  editDescription(description: ReviewDescription): void;
  load(): Promise<void>;
  openGitHub(): Promise<void>;
  /** Commits a dirty description first, so what main approves is what the
   *  reader sees. */
  prepare(): Promise<void>;
  reopen(): Promise<void>;
  retryPrepare(): Promise<void>;
  setIncluded(artifactId: string, included: boolean): Promise<void>;
  /** Opens or closes one artifact's preview. The first open loads it; the
   *  result is kept until a reopen clears every preview. */
  togglePreview(artifactId: string): Promise<void>;
}

export interface BugReportReviewRuntimeOptions {
  closeWindow(): void;
}

/** Reads a thrown value as its kind on this feature's ladder. Anything else —
 *  a bridge that threw, a bug — reads as the review being unavailable. */
export function toReviewFailure(error: unknown): ReviewFailure {
  return {
    kind: isFeatureError<ReviewFailureExtra>(error, 'BugReportError') ? error.kind : 'unavailable',
  };
}

export function createBugReportReviewRuntime(
  port: BugReportReviewPort,
  { closeWindow }: BugReportReviewRuntimeOptions,
): BugReportReviewRuntime {
  const store = createStore<ReviewSession>(() => initialReviewSession);
  // Replace, never merge: the session's states carry different fields, and a
  // merged `closed` would keep the draft it is supposed to have left behind.
  const dispatch = (event: ReviewEvent) =>
    store.setState((state) => reduceReviewSession(state, event), true);
  const current = () => store.getState();
  const enqueue = createSerialQueue();

  /** Sends a dirty description to main. Answers whether the field is
   *  confirmed, so a prepare can stop before approving unconfirmed text. */
  async function commit(generation: number): Promise<boolean> {
    const state = current();
    if (
      (state.kind !== 'reviewing' && state.kind !== 'preparing') ||
      state.generation !== generation
    )
      return false;
    if (!state.dirty) return true;
    dispatch({ generation, type: 'description-commit-started' });
    try {
      const draft = await port.updateDescription(state.draft.description);
      dispatch({ draft, generation, type: 'description-committed' });
      return true;
    } catch (error) {
      dispatch({ failure: toReviewFailure(error), generation, type: 'command-failed' });
      return false;
    }
  }

  async function handoff(
    action: 'open-github' | 'download',
    request: () => Promise<number>,
  ): Promise<void> {
    const state = current();
    if (state.kind !== 'ready' || state.pending !== null) return;
    const { generation } = state;
    dispatch({ action, generation, type: 'handoff-started' });
    try {
      await request();
      dispatch({
        generation,
        type: 'handoff-completed',
        via: action === 'download' ? 'download' : 'github',
      });
    } catch (error) {
      dispatch({ failure: toReviewFailure(error), generation, type: 'command-failed' });
    }
  }

  return {
    store,
    close() {
      return enqueue(async () => {
        const state = current();
        if (state.kind === 'closed') return;
        if (state.kind === 'reviewing') {
          try {
            await port.discard();
          } catch {
            // Main retires a bound draft when its window closes, so a refused
            // discard leaves nothing behind that closing would not also clear.
          }
        }
        dispatch({ type: 'closed' });
        closeWindow();
      });
    },
    commitDescription() {
      return enqueue(async () => {
        const state = current();
        if (state.kind !== 'reviewing') return;
        await commit(state.generation);
      });
    },
    download() {
      return enqueue(() => handoff('download', () => port.saveArtifacts()));
    },
    editDescription(description) {
      const state = current();
      if (state.kind !== 'reviewing') return;
      dispatch({ description, generation: state.generation, type: 'description-edited' });
    },
    load() {
      return enqueue(async () => {
        if (current().kind !== 'loading') return;
        try {
          const snapshot = await port.get();
          dispatch(
            snapshot.kind === 'approved'
              ? { report: snapshot.report, type: 'loaded-approved' }
              : { draft: snapshot.draft, type: 'loaded' },
          );
        } catch (error) {
          dispatch({ failure: toReviewFailure(error), type: 'load-failed' });
        }
      });
    },
    openGitHub() {
      return enqueue(() => handoff('open-github', () => port.openGitHub()));
    },
    prepare() {
      return enqueue(async () => {
        const state = current();
        if (state.kind !== 'reviewing') return;
        const { generation } = state;
        // Lock before the final save, including its IPC round trip.
        dispatch({ generation, type: 'prepare-started' });
        if (!(await commit(generation))) return;
        try {
          const outcome = await port.prepare();
          dispatch(
            outcome.kind === 'prepared'
              ? { generation, report: outcome.report, type: 'prepared' }
              : {
                  failure: outcome.failure,
                  generation,
                  report: outcome.report,
                  type: 'approved-unprepared',
                },
          );
        } catch (error) {
          dispatch({ failure: toReviewFailure(error), generation, type: 'prepare-failed' });
        }
      });
    },
    reopen() {
      return enqueue(async () => {
        const state = current();
        if (state.kind !== 'ready' || state.pending !== null) return;
        const { generation } = state;
        dispatch({ action: 'reopen', generation, type: 'handoff-started' });
        try {
          const draft = await port.reopen();
          dispatch({ draft, generation, type: 'reopened' });
        } catch (error) {
          dispatch({ failure: toReviewFailure(error), generation, type: 'command-failed' });
        }
      });
    },
    retryPrepare() {
      return enqueue(async () => {
        const state = current();
        if (state.kind !== 'ready' || state.pending !== null) return;
        const { generation } = state;
        dispatch({ action: 'retry', generation, type: 'handoff-started' });
        try {
          const outcome = await port.prepare();
          dispatch(
            outcome.kind === 'prepared'
              ? { generation, type: 'retry-prepared' }
              : { failure: outcome.failure, generation, type: 'retry-failed' },
          );
        } catch (error) {
          dispatch({ failure: toReviewFailure(error), generation, type: 'retry-failed' });
        }
      });
    },
    setIncluded(artifactId, included) {
      return enqueue(async () => {
        const state = current();
        if (state.kind !== 'reviewing') return;
        const artifact = state.draft.artifacts.find((candidate) => candidate.id === artifactId);
        if (!artifact || artifact.availability.kind !== 'available') return;
        if (artifact.availability.included === included) return;
        const { generation } = state;
        dispatch({ artifactId, generation, included, type: 'selection-started' });
        try {
          const draft = await (included
            ? port.includeArtifact(artifactId)
            : port.excludeArtifact(artifactId));
          dispatch({
            artifact: artifact.kind,
            draft,
            generation,
            included,
            type: 'selection-applied',
          });
        } catch (error) {
          dispatch({ failure: toReviewFailure(error), generation, type: 'command-failed' });
        }
      });
    },
    async togglePreview(artifactId) {
      const state = current();
      if (state.kind !== 'reviewing') return;
      const { generation } = state;
      const opening = state.openPreviewId !== artifactId;
      const cached = artifactId in state.previews;
      dispatch({ artifactId, generation, type: 'preview-toggled' });
      if (!opening || cached) return;
      try {
        const preview = await port.getArtifactPreview(artifactId);
        dispatch({ artifactId, generation, preview, type: 'preview-loaded' });
      } catch (error) {
        dispatch({
          artifactId,
          failure: toReviewFailure(error),
          generation,
          type: 'preview-failed',
        });
      }
    },
  };
}
