import { describe, expect, it } from 'vite-plus/test';

import {
  documentFailure,
  turnChangeReviewMessage,
  DOCUMENT_ASSET_MESSAGES,
  DOCUMENT_OVERWRITE_MESSAGES,
  DOCUMENT_SAVE_MESSAGES,
  DOCUMENT_SOURCE_MESSAGES,
  DOCX_PREVIEW_MESSAGES,
  GENERIC_PREVIEW_MESSAGES,
} from './failure-messages';
import type { TurnChangeReviewFailure } from './open-revision';
import { DocumentSaveError, DocumentSourceError, DocumentAssetError } from './ports';

const FAMILIES = [
  DOCUMENT_SOURCE_MESSAGES,
  DOCUMENT_SAVE_MESSAGES,
  DOCUMENT_OVERWRITE_MESSAGES,
  DOCUMENT_ASSET_MESSAGES,
  DOCX_PREVIEW_MESSAGES,
  GENERIC_PREVIEW_MESSAGES,
];

describe('documents failure messages', () => {
  it('gives every kind of every family a sentence a reader can act on', () => {
    for (const family of FAMILIES) {
      for (const sentence of Object.values(family)) {
        expect(sentence.length).toBeGreaterThan(0);
        expect(sentence.endsWith('.')).toBe(true);
      }
    }
  });

  it('says what happened to the reader’s bytes, per family', () => {
    expect(DOCUMENT_SAVE_MESSAGES.unavailable).toContain('still available');
    expect(DOCUMENT_OVERWRITE_MESSAGES.unavailable).toContain('Both versions');
    expect(DOCUMENT_SOURCE_MESSAGES.unavailable).toContain('has not been changed');
    expect(GENERIC_PREVIEW_MESSAGES.unavailable).toContain('has not been changed');
  });

  it('offers the conflict recovery only for a conflict', () => {
    expect(DOCUMENT_SAVE_MESSAGES.conflict).toContain('Retry to compare both versions');
    expect(DOCUMENT_SAVE_MESSAGES.conflict).not.toBe(DOCUMENT_SAVE_MESSAGES.unavailable);
  });

  it('reads a refusal on the named ladder by its kind', () => {
    const error = new DocumentSaveError('scope-lost', 'HTTP 409 stale version');
    expect(documentFailure(error, 'DocumentSaveError', DOCUMENT_SAVE_MESSAGES).message).toBe(
      DOCUMENT_SAVE_MESSAGES['scope-lost'],
    );
    expect(
      documentFailure<'unsupported-encoding'>(
        new DocumentSourceError('unsupported-encoding', 'binary'),
        'DocumentSourceError',
        DOCUMENT_SOURCE_MESSAGES,
      ).message,
    ).toBe(DOCUMENT_SOURCE_MESSAGES['unsupported-encoding']);
  });

  it('reads anything off the ladder as the family’s unavailable line', () => {
    expect(
      documentFailure(new Error('socket'), 'DocumentAssetError', DOCUMENT_ASSET_MESSAGES).message,
    ).toBe(DOCUMENT_ASSET_MESSAGES.unavailable);
    expect(
      documentFailure('not an error', 'DocumentAssetError', DOCUMENT_ASSET_MESSAGES).message,
    ).toBe(DOCUMENT_ASSET_MESSAGES.unavailable);
  });

  it('refuses to read another capability’s failure as its own', () => {
    const other = new DocumentAssetError('scope-lost', 'a media refusal');
    expect(documentFailure(other, 'DocumentSaveError', DOCUMENT_SAVE_MESSAGES).message).toBe(
      DOCUMENT_SAVE_MESSAGES.unavailable,
    );
  });

  it('names the document in every reason a turn review was not shown', () => {
    const failures: Array<TurnChangeReviewFailure | 'outside-folder'> = [
      'frontmatter-changed',
      'no-changes',
      'not-editable',
      'not-opened',
      'not-verified',
      'outside-folder',
      'review-in-progress',
      'stale-version',
    ];

    for (const failure of failures) {
      const sentence = turnChangeReviewMessage(failure, 'Quarterly plan.md');
      expect(sentence).toContain('Quarterly plan.md');
    }
    expect(new Set(failures.map((failure) => turnChangeReviewMessage(failure, 'a.md'))).size).toBe(
      failures.length,
    );
  });
});
