/**
 * The Markdown surface's half of an inline revision review: it opens the
 * review the document runtime holds, reports the pending count back, and
 * renders the header bar while one is open.
 *
 * The runtime drives this rather than the component deciding for itself, so
 * the developer harness and a turn review reach the editor through one
 * entry. A rebuilt editor holds no review, so a review the document still has
 * is reopened on the new one.
 */
import type { CrepeBuilder } from '@milkdown/crepe/builder';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';

import { splitLeadingYamlFrontmatter } from '@/features/documents/domain/markdown';
import type { DocumentRevision } from '@/features/documents/domain/revision';

import { MarkdownReviewBar } from './review-bar';
import { attachRevisionReview, type RevisionSurface } from './revision-adapter';

/** What the surface needs from the document runtime, and what it reports back
 *  to it. One bundle rather than separate props, so the surface between the
 *  runtime and the editor is named in one place. */
export interface RevisionBinding {
  /** How many changes the diff plugin still has pending, reported upward from
   *  the one place that knows. */
  onPending(reviewId: string, pending: number): void;
  /** The review to open, driven from the document runtime so the developer
   *  harness and a turn review reach the editor through one entry. */
  state: DocumentRevision;
}

export interface RevisionReviewBinding {
  /** True while a review holds the document, which is also what stops a
   *  background reconcile replacing the text that review describes. */
  active: boolean;
  /** True while a turn review is open. It runs the plugin in reverse, so the
   *  turn's own text is what the plugin marks as a deletion, and the surface
   *  swaps the two colours back. */
  reversed: boolean;
  /** Registers the review plugins on a freshly built editor, before it is
   *  created. Answers the release to run when that editor goes away. Stable
   *  across renders, so the effect that builds the editor can depend on it
   *  without rebuilding one. */
  attach(editor: CrepeBuilder): () => void;
  bar: ReactNode;
}

export function useRevisionReview({
  creationState,
  revision,
}: {
  creationState: 'creating' | 'failed' | 'ready';
  revision: RevisionBinding;
}): RevisionReviewBinding {
  const surfaceRef = useRef<RevisionSurface | null>(null);
  const openIdRef = useRef<string | null>(null);
  // Held in refs so a caller building a fresh bundle every render does not
  // rebuild the editor or restart the review it holds.
  const reportRef = useRef(revision.onPending);
  reportRef.current = revision.onPending;
  const state = revision.state;

  const attach = useCallback((editor: CrepeBuilder) => {
    openIdRef.current = null;
    const surface = attachRevisionReview(editor, (pending) => {
      const reviewId = openIdRef.current;
      if (reviewId !== null) reportRef.current(reviewId, pending);
    });
    surfaceRef.current = surface;
    return () => {
      if (surfaceRef.current !== surface) return;
      surfaceRef.current = null;
    };
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || creationState !== 'ready') return;
    if (state.kind === 'idle') {
      if (openIdRef.current === null) return;
      openIdRef.current = null;
      surface.clear();
      return;
    }
    if (openIdRef.current === state.review.id) return;
    openIdRef.current = state.review.id;
    surface.start(splitLeadingYamlFrontmatter(state.review.before).body);
  }, [creationState, state]);

  return {
    active: state.kind !== 'idle',
    attach,
    bar:
      state.kind === 'reviewing' ? (
        <MarkdownReviewBar
          onUndoAll={() => surfaceRef.current?.undoAll()}
          onKeepAll={() => surfaceRef.current?.clear()}
          pending={state.pending}
        />
      ) : null,
    reversed: state.kind !== 'idle',
  };
}
