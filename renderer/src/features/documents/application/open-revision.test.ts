import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  documentTabsRuntimeOptions,
  sourceApi,
  textSource,
  turnChangesApi,
} from '@/test/fakes/documents';

import { openTurnChangeReview } from './open-revision';
import { DocumentTurnChangesError } from './ports';
import { createDocumentTabsRuntime } from './tabs-runtime';

const folderPath = '/project/notes';
const BASE = '# Plan\n';
const BASE_VERSION = 'sha256:v1';

const open: Array<{ dispose(): void }> = [];

afterEach(() => {
  vi.useRealTimers();
  for (const runtime of open.splice(0)) runtime.dispose();
});

interface ReviewText {
  id: string;
  baseVersion: string;
  content: string;
}

function proposal(overrides: Partial<ReviewText> = {}): ReviewText {
  return {
    id: 'review-1',
    baseVersion: BASE_VERSION,
    content: '# Revised plan\n',

    ...overrides,
  };
}

async function openDocument() {
  const documents = createDocumentTabsRuntime(
    documentTabsRuntimeOptions({ api: sourceApi(), folderPath }),
  );
  open.push(documents);
  const document = await documents.open({ folderPath, path: 'plan.md' });
  if (!document) throw new Error('Expected the document to open.');
  return document;
}

function loadReview(
  document: Awaited<ReturnType<typeof openDocument>>,
  review: ReviewText,
  sourcePort: ReturnType<typeof sourceApi>,
) {
  return openTurnChangeReview(document, 'turn-1', {
    source: sourcePort,
    turnChanges: turnChangesApi({
      load: vi.fn(async ({ source, turnId }) => ({
        afterVersion: review.baseVersion,
        before: review.content,
        source,
        turnId,
      })),
    }),
  });
}

function openRevision(document: Awaited<ReturnType<typeof openDocument>>, proposed = proposal()) {
  return loadReview(
    document,
    proposed,
    sourceApi({
      load: vi.fn(async () =>
        textSource({
          content: document.store.getState().editor?.value ?? BASE,
          version: document.store.getState().editor?.version ?? BASE_VERSION,
        }),
      ),
    }),
  );
}

describe('opening a turn review on a document', () => {
  it('starts the review once the tab reports text, however late that is', async () => {
    const document = await openDocument();
    const started = openRevision(document);

    document.reconcile(textSource({ content: BASE, version: BASE_VERSION }));

    await expect(started).resolves.toBeNull();
    const revision = document.store.getState().revision;
    expect(revision.kind === 'idle' ? null : revision.review.id).toBe('turn:turn-1:plan.md');
  });

  it('strips frontmatter from both sides, so the parser never sees a delimiter', async () => {
    const document = await openDocument();
    document.reconcile(textSource({ content: `---\ntitle: Plan\n---\n${BASE}`, version: 'v2' }));

    await expect(
      openRevision(
        document,
        proposal({ baseVersion: 'v2', content: `---\ntitle: Plan\n---\n# Revised\n` }),
      ),
    ).resolves.toBeNull();

    const revision = document.store.getState().revision;
    expect(revision.kind === 'idle' ? null : revision.review.before).toBe('# Revised\n');
  });

  it('refuses frontmatter edits rather than silently dropping them', async () => {
    const document = await openDocument();
    document.reconcile(textSource({ content: `---\ntitle: Plan\n---\n${BASE}`, version: 'v2' }));

    await expect(
      openRevision(
        document,
        proposal({ baseVersion: 'v2', content: '---\ntitle: Revised\n---\n# Revised\n' }),
      ),
    ).resolves.toBe('frontmatter-changed');
    expect(document.store.getState().revision).toEqual({ kind: 'idle' });
  });

  it('gives up on a tab whose text never arrives', async () => {
    vi.useFakeTimers();
    const document = await openDocument();
    const started = openRevision(document);

    await vi.advanceTimersByTimeAsync(20_000);

    await expect(started).resolves.toBe('not-opened');
    expect(document.store.getState().revision).toEqual({ kind: 'idle' });
  });

  it('gives up when the document is torn down while the text is still loading', async () => {
    const document = await openDocument();
    const started = openRevision(document);

    document.dispose();

    await expect(started).resolves.toBe('not-opened');
  });

  it('gives up immediately on a document that was already disposed', async () => {
    const document = await openDocument();
    document.dispose();

    await expect(openRevision(document)).resolves.toBe('not-opened');
  });

  it('reports the domain refusal rather than opening a second review', async () => {
    const document = await openDocument();
    document.reconcile(textSource({ content: BASE, version: BASE_VERSION }));

    await expect(openRevision(document)).resolves.toBeNull();
    await expect(openRevision(document)).resolves.toBe('review-in-progress');
  });

  it('reports a review computed against text the document has moved past', async () => {
    const document = await openDocument();
    document.reconcile(textSource({ content: BASE, version: 'sha256:v9' }));

    await expect(openRevision(document)).resolves.toBe('stale-version');
  });

  it('refuses when the source moved on disk while the editor still shows its old version', async () => {
    const document = await openDocument();
    document.reconcile(textSource({ content: BASE, version: BASE_VERSION }));
    const current = sourceApi({
      load: vi.fn(async () => textSource({ content: '# Newer on disk\n', version: 'sha256:v9' })),
    });

    await expect(loadReview(document, proposal(), current)).resolves.toBe('stale-version');
    expect(document.store.getState().revision).toEqual({ kind: 'idle' });
  });

  it('reports uncertainty when the current source cannot be checked', async () => {
    const document = await openDocument();
    document.reconcile(textSource({ content: BASE, version: BASE_VERSION }));
    const unavailable = sourceApi({
      load: vi.fn(async () => {
        throw new Error('offline');
      }),
    });

    await expect(loadReview(document, proposal(), unavailable)).resolves.toBe('not-verified');
    expect(document.store.getState().revision).toEqual({ kind: 'idle' });
  });
});

describe('opening what an Agent turn changed as a reversed review', () => {
  const AFTER = '# Plan\n\nWritten by the turn.\n';
  const AFTER_VERSION = 'sha256:after';

  async function turnDocument(content = AFTER) {
    const document = await openDocument();
    document.reconcile(textSource({ content, version: AFTER_VERSION }));
    return document;
  }

  function ports(
    before: string,
    disk = { content: AFTER, version: AFTER_VERSION },
    load?: () => Promise<never>,
  ) {
    return {
      source: sourceApi({ load: vi.fn(async () => textSource(disk)) }),
      turnChanges: turnChangesApi({
        load:
          load ??
          vi.fn(async ({ source, turnId }) => ({
            afterVersion: AFTER_VERSION,
            before,
            source,
            turnId,
          })),
      }),
    };
  }

  it('offers the text from before the turn against what the turn left', async () => {
    const document = await turnDocument();

    await expect(openTurnChangeReview(document, 'turn-1', ports(BASE))).resolves.toBeNull();

    const revision = document.store.getState().revision;
    expect(revision.kind === 'idle' ? null : revision.review).toMatchObject({
      baseVersion: AFTER_VERSION,

      before: BASE,
    });
  });

  it('refuses a file that changed after the turn ended', async () => {
    const document = await turnDocument();

    await expect(
      openTurnChangeReview(
        document,
        'turn-1',
        ports(BASE, { content: '# Edited later\n', version: 'sha256:later' }),
      ),
    ).resolves.toBe('stale-version');
    expect(document.store.getState().revision).toEqual({ kind: 'idle' });
  });

  it('reports a turn the host no longer holds as expired', async () => {
    const document = await turnDocument();
    const expired = vi.fn(async () => {
      throw new DocumentTurnChangesError('expired', 'gone');
    });

    await expect(
      openTurnChangeReview(document, 'turn-1', ports(BASE, undefined, expired)),
    ).resolves.toBe('expired');
  });

  it('refuses a turn that changed the frontmatter', async () => {
    const document = await turnDocument(`---\ntitle: New\n---\n${AFTER}`);

    await expect(
      openTurnChangeReview(
        document,
        'turn-1',
        ports(`---\ntitle: Old\n---\n${BASE}`, {
          content: `---\ntitle: New\n---\n${AFTER}`,
          version: AFTER_VERSION,
        }),
      ),
    ).resolves.toBe('frontmatter-changed');
  });
});
