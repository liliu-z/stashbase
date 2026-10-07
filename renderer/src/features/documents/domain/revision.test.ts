import { describe, expect, it } from 'vite-plus/test';

import { textSource } from '@/test/fakes/documents';

import {
  createDocumentState,
  disposeDocumentState,
  reconcileDocumentSource,
  type DocumentState,
} from './document';
import {
  clearDocumentRevision,
  documentRevisionActive,
  publishDocumentRevisionCount,
  startDocumentRevision,
  type RevisionReview,
} from './revision';

const scope = {
  generation: 1,
  id: 'tab-1',
  source: { folderPath: '/project/notes', path: 'plan.md' },
};

const review: RevisionReview = {
  baseVersion: 'sha256:v1',
  id: 'review-1',

  before: '# Revised plan',
};

function loaded(version = 'sha256:v1'): DocumentState {
  return reconcileDocumentSource(
    createDocumentState(scope, 'editable'),
    textSource({ content: '# Plan', version }),
  );
}

function reviewing(pending = 2): DocumentState {
  const started = startDocumentRevision(loaded(), review, '# Plan');
  if (started.kind !== 'started') throw new Error(`Expected a started review, got ${started.kind}`);
  return publishDocumentRevisionCount(started.state, review.id, pending);
}

describe('starting a revision review', () => {
  it('opens against the loaded body and leaves the editor text alone', () => {
    const started = startDocumentRevision(loaded(), review, '# Plan');

    expect(started).toEqual({
      kind: 'started',
      state: expect.objectContaining({ revision: { kind: 'starting', review } }),
    });
    if (started.kind !== 'started') return;
    expect(started.state.editor?.value).toBe('# Plan');
    expect(documentRevisionActive(started.state)).toBe(true);
  });

  it('refuses a document nothing can be written to', () => {
    const readOnly = createDocumentState(scope, 'read-only');
    const unloaded = createDocumentState(scope, 'editable');

    expect(startDocumentRevision(readOnly, review, '# Plan').kind).toBe('refused');
    expect(startDocumentRevision(unloaded, review, '# Plan')).toEqual({
      kind: 'refused',
      reason: 'not-editable',
    });
    expect(startDocumentRevision(disposeDocumentState(loaded()), review, '# Plan')).toEqual({
      kind: 'refused',
      reason: 'not-editable',
    });
  });

  it('refuses a second review while one is open', () => {
    expect(startDocumentRevision(reviewing(), { ...review, id: 'review-2' }, '# Plan')).toEqual({
      kind: 'refused',
      reason: 'review-in-progress',
    });
  });

  it('refuses a proposal computed against a version the document has moved past', () => {
    expect(startDocumentRevision(loaded('sha256:v2'), review, '# Plan')).toEqual({
      kind: 'refused',
      reason: 'stale-version',
    });
  });

  it('refuses a proposal that changes nothing, which would lock the editor', () => {
    expect(startDocumentRevision(loaded(), { ...review, before: '# Plan' }, '# Plan')).toEqual({
      kind: 'refused',
      reason: 'no-changes',
    });
  });
});

describe('the pending count the editor publishes', () => {
  it('records what the editor reports and holds the state when it repeats', () => {
    const open = reviewing(2);

    expect(open.revision).toEqual({ kind: 'reviewing', pending: 2, review });
    expect(publishDocumentRevisionCount(open, review.id, 2)).toBe(open);
    expect(publishDocumentRevisionCount(open, review.id, 1).revision).toEqual({
      kind: 'reviewing',
      pending: 1,
      review,
    });
  });

  it('ends the review when the last change is resolved', () => {
    const ended = publishDocumentRevisionCount(reviewing(1), review.id, 0);

    expect(ended.revision).toEqual({ kind: 'idle' });
    expect(documentRevisionActive(ended)).toBe(false);
  });

  it('drops a count for a review that is no longer the open one', () => {
    const open = reviewing(2);
    const idle = clearDocumentRevision(open);

    expect(publishDocumentRevisionCount(open, 'review-2', 9)).toBe(open);
    expect(publishDocumentRevisionCount(idle, review.id, 9)).toBe(idle);
  });
});

describe('ending a revision review', () => {
  it('clears once and stays cleared', () => {
    const cleared = clearDocumentRevision(reviewing());

    expect(cleared.revision).toEqual({ kind: 'idle' });
    expect(clearDocumentRevision(cleared)).toBe(cleared);
  });

  it('goes with the document when it is disposed', () => {
    expect(disposeDocumentState(reviewing()).revision).toEqual({ kind: 'idle' });
  });

  it('holds a background reconcile off the text the review describes', () => {
    const open = reviewing();
    const newer = reconcileDocumentSource(open, textSource({ content: '# Other', version: 'v9' }));

    expect(newer).toBe(open);
    expect(
      reconcileDocumentSource(clearDocumentRevision(open), textSource({ content: '# Other' }))
        .editor?.value,
    ).toBe('# Other');
  });
});
