/**
 * One reader-facing sentence per documents failure family.
 *
 * Views ask a family for the sentence a `kind` deserves instead of carrying
 * their own English. A refusal's own message never reaches the reader — a
 * transport sentence is a diagnostic, not a recovery — so the kind alone
 * selects the line, and an unrecognised rejection falls through to the family's
 * `unavailable` one. Every map covers its whole ladder, so adding a kind fails
 * the build here rather than silently showing the wrong recovery.
 */
import { JsonEditError } from '@/features/documents/domain/json-edit';
import type { RevisionRefusal } from '@/features/documents/domain/revision';
import {
  readFailure,
  type FailureView,
  type FeatureFailureKind,
} from '@/shared/domain/feature-error';

import type { TurnChangeReviewFailure } from './open-revision';
import type {
  DocumentAssetFailureKind,
  DocumentSaveFailureKind,
  DocumentSourceFailureKind,
  DocxPreviewFailureKind,
  GenericFilePreviewFailureKind,
} from './ports';

/** A family's whole ladder, mapped to the one sentence each kind reads as. */
export type FailureMessages<Extra extends string = never> = Readonly<
  Record<FeatureFailureKind<Extra>, string>
>;

export const DOCUMENT_SOURCE_MESSAGES: Readonly<Record<DocumentSourceFailureKind, string>> = {
  missing: 'The source file is missing. Open work is still available; restore the file and retry.',
  'invalid-response': 'The document could not be loaded. Your source file has not been changed.',
  'scope-lost': 'That folder is no longer available in this window.',
  unauthorized: 'This window can no longer open that document.',
  unavailable: 'The document could not be loaded. Your source file has not been changed.',
  'unsupported-encoding':
    'This file is not text StashBase can decode. Its bytes have not been changed.',
};

export const DOCUMENT_SAVE_MESSAGES: Readonly<Record<DocumentSaveFailureKind, string>> = {
  // The draft's destination is gone, which is a standing condition rather than
  // a write to repeat. The sentence names the risk and leaves the way out to
  // the action beside it.
  missing: 'The source file is gone, so this draft is not being saved.',
  conflict:
    'The file changed on disk, but its newer version could not be loaded. Retry to compare both versions.',
  'invalid-response': 'The document could not be saved. Your changes are still available.',
  'scope-lost': 'That folder is no longer available in this window, so the document was not saved.',
  unauthorized: 'This window can no longer save documents. Your changes are still available.',
  unavailable: 'The document could not be saved. Your changes are still available.',
};

/** Overwriting keeps both versions, so its wording differs from a plain save. */
export const DOCUMENT_OVERWRITE_MESSAGES: Readonly<Record<DocumentSaveFailureKind, string>> = {
  missing: 'The source file is missing. Open work is still available; restore the file and retry.',
  conflict: 'The document could not be overwritten. Both versions are still available.',
  'invalid-response': 'The document could not be overwritten. Both versions are still available.',
  'scope-lost': 'The document could not be overwritten. Both versions are still available.',
  unauthorized: 'The document could not be overwritten. Both versions are still available.',
  unavailable: 'The document could not be overwritten. Both versions are still available.',
};

export const DOCUMENT_ASSET_MESSAGES: Readonly<Record<DocumentAssetFailureKind, string>> = {
  missing: 'The source file is missing. Open work is still available; restore the file and retry.',
  'invalid-response': 'The file may have moved, changed, or become unavailable.',
  'scope-lost': 'That folder is no longer available in this window.',
  unauthorized: 'This window can no longer open that file.',
  unavailable: 'The file may have moved, changed, or become unavailable.',
};

export const DOCX_PREVIEW_MESSAGES: Readonly<Record<DocxPreviewFailureKind, string>> = {
  'invalid-response': 'Direct preview unavailable. Showing the prepared version when it is ready.',
  'scope-lost': 'Direct preview unavailable. Showing the prepared version when it is ready.',
  timeout: 'Direct preview took too long. Showing the prepared version when it is ready.',
  unauthorized: 'Direct preview unavailable. Showing the prepared version when it is ready.',
  unavailable: 'Direct preview unavailable. Showing the prepared version when it is ready.',
};

export const GENERIC_PREVIEW_MESSAGES: Readonly<Record<GenericFilePreviewFailureKind, string>> = {
  missing: 'The source file is missing. Open work is still available; restore the file and retry.',
  'invalid-response': 'The file could not be inspected. It has not been changed.',
  'not-generic': 'This document viewer is not available yet.',
  'scope-lost': 'That folder is no longer available in this window.',
  unauthorized: 'This window can no longer inspect that file.',
  unavailable: 'The file could not be inspected. It has not been changed.',
};

/** Why a turn review could not be opened on the document in front of
 *  the reader. */
export const DOCUMENT_REVISION_MESSAGES: Readonly<Record<RevisionRefusal, string>> = {
  'frontmatter-changed':
    'The earlier text has different Markdown frontmatter, which cannot be reviewed in place.',
  'no-changes': 'The earlier text matches the document already, so there is nothing to review.',
  'not-editable': 'This document cannot be revised in place.',
  'review-in-progress': 'Finish the review already open on this document first.',
  'stale-version': 'The document has changed since the turn ended.',
};

/** Why a turn's changes could not be shown inside the document the reader
 *  asked to review. The file
 *  already holds what the turn wrote. */
const TURN_CHANGE_REVIEW_MESSAGES: Readonly<
  Record<TurnChangeReviewFailure | 'outside-folder', (name: string) => string>
> = {
  expired: (name) => `The changes that turn made to ${name} are no longer available to review.`,
  'frontmatter-changed': (name) =>
    `That turn changed the frontmatter of ${name}, which cannot be reviewed in place.`,
  'no-changes': (name) =>
    `${name} matches what it held before that turn, so there is nothing to review.`,
  'not-editable': (name) => `${name} cannot be reviewed in place.`,
  'not-opened': (name) => `${name} did not open, so that turn's changes cannot be shown.`,
  'not-verified': (name) =>
    `The current text of ${name} could not be checked, so that turn's changes cannot be shown.`,
  'outside-folder': (name) => `${name} is not in the folder this window has open.`,
  'review-in-progress': (name) => `Finish the review already open on ${name} first.`,
  'stale-version': (name) =>
    `${name} changed after that turn, so its changes cannot be shown inline.`,
};

/** The sentence a reader sees when a turn review they asked for did not
 *  open. `name` is the document's own name, not a path. */
export function turnChangeReviewMessage(
  failure: TurnChangeReviewFailure | 'outside-folder',
  name: string,
): string {
  return TURN_CHANGE_REVIEW_MESSAGES[failure](name);
}

export function documentFailure<Extra extends string = never>(
  error: unknown,
  owner: string,
  messages: FailureMessages<Extra>,
): FailureView {
  return readFailure<Extra>(error, messages, { owner });
}

/**
 * The sentence a refused JSON edit shows. The JSON domain authors these for the
 * reader — they name the key or path that could not be edited, which no fixed
 * line here could — so a refusal it raised keeps its own words. A rejection
 * from anywhere else is a bug and reads as the generic line.
 */
export function jsonEditFailureMessage(error: unknown): string {
  return error instanceof JsonEditError ? error.message : 'The JSON edit could not be applied.';
}
