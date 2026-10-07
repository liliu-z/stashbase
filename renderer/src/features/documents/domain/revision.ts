/** The review of an Agent turn's changes. The document already holds the
 * turn's result; offering its earlier text makes taking a diff undo that
 * change. Keeping every diff leaves the source byte-identical. Review state
 * belongs to the document and is never persisted separately. */
import type { DocumentState } from './document';

export interface RevisionReview {
  /** The `sha256:` token the turn left on disk. A review whose
   *  base has moved is refused rather than applied to newer text. */
  readonly baseVersion: string;
  readonly id: string;
  /** The document body before the turn, with any leading frontmatter already
   *  stripped: raw frontmatter handed to the parser lands in the document as
   *  a thematic break and a heading. */
  readonly before: string;
}

export type DocumentRevision =
  | { kind: 'idle' }
  | { kind: 'starting'; review: RevisionReview }
  | { kind: 'reviewing'; pending: number; review: RevisionReview };

/** Why a review was not opened. A refusal is a value the caller reports,
 *  not an unchanged state it has to notice. */
export type RevisionRefusal =
  | 'frontmatter-changed'
  | 'not-editable'
  | 'no-changes'
  | 'review-in-progress'
  | 'stale-version';

export type RevisionStart =
  | { kind: 'started'; state: DocumentState }
  | { kind: 'refused'; reason: RevisionRefusal };

export function documentRevisionActive(state: DocumentState): boolean {
  return state.revision.kind !== 'idle';
}

/**
 * Opens `review` against the document's current body.
 *
 * A review identical to what is already there is refused, because the diff
 * plugin stays active with no change to resolve and its transaction filter
 * then blocks every edit: the editor would be locked with nothing in the
 * document to click.
 */
export function startDocumentRevision(
  state: DocumentState,
  review: RevisionReview,
  currentBody: string,
): RevisionStart {
  const editor = state.editor;
  if (state.lifecycle === 'disposed' || state.access !== 'editable' || !editor) {
    return { kind: 'refused', reason: 'not-editable' };
  }
  if (state.revision.kind !== 'idle') return { kind: 'refused', reason: 'review-in-progress' };
  if (editor.version !== review.baseVersion) {
    return { kind: 'refused', reason: 'stale-version' };
  }
  if (review.before === currentBody) return { kind: 'refused', reason: 'no-changes' };
  return { kind: 'started', state: { ...state, revision: { kind: 'starting', review } } };
}

/**
 * Records what the editor reports is still pending.
 *
 * The diff plugin is the only thing that knows this number, and it
 * deactivates itself once every change has been resolved, so a count of zero
 * is the review ending rather than a review with nothing in it. A count for a
 * review that is no longer open is dropped.
 */
export function publishDocumentRevisionCount(
  state: DocumentState,
  reviewId: string,
  pending: number,
): DocumentState {
  const revision = state.revision;
  if (revision.kind === 'idle' || revision.review.id !== reviewId) return state;
  if (pending <= 0) return clearDocumentRevision(state);
  if (revision.kind === 'reviewing' && revision.pending === pending) return state;
  return { ...state, revision: { kind: 'reviewing', pending, review: revision.review } };
}

/** Ends the review. Clearing twice is as safe as clearing once, because a
 *  tab close, a folder change and a shell remount can all reach it. */
export function clearDocumentRevision(state: DocumentState): DocumentState {
  return state.revision.kind === 'idle' ? state : { ...state, revision: { kind: 'idle' } };
}
