import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { DocumentTabsRuntime } from '@/features/documents/public';
import { createDocumentTabsRuntime } from '@/features/documents/public';
import { DocumentTurnChangesError } from '@/features/documents/test-support';
import { createWorkspaceRuntime } from '@/features/workspace/test-support';
import {
  documentTabsRuntimeOptions,
  sourceApi,
  textSource,
  turnChangesApi,
} from '@/test/fakes/documents';

import { useTurnReview } from './use-turn-review';

const folderPath = '/project/notes';
const BASE = '# Plan\n';
const BASE_VERSION = 'sha256:v1';
const currentSource = sourceApi({
  load: vi.fn(async () => textSource({ content: BASE, version: BASE_VERSION })),
});

const open: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const runtime of open.splice(0)) runtime.dispose();
});

function createWorkspace() {
  const workspace = createWorkspaceRuntime({
    folder: { name: 'Notes', path: folderPath },
    generation: 1,
    queries: { cancel: vi.fn(async () => undefined), remove: vi.fn() },
  });
  open.push(workspace);
  return workspace;
}

/** Stands in for the React tree, which is what loads a tab's text in the
 *  running window. Without it every opened tab stays editor-less. */
function loadEveryTab(documents: DocumentTabsRuntime) {
  const load = () => {
    for (const tab of documents.store.getState().tabs) {
      documents
        .getDocument(tab.id)
        ?.reconcile(textSource({ content: BASE, version: BASE_VERSION }));
    }
  };
  open.push({ dispose: documents.subscribe(load) });
  load();
}

function createDocuments() {
  const documents = createDocumentTabsRuntime(
    documentTabsRuntimeOptions({ api: sourceApi(), folderPath }),
  );
  open.push(documents);
  loadEveryTab(documents);
  return documents;
}

function mountPickup(turns = turnChangesApi()) {
  const documents = createDocuments();
  const workspace = createWorkspace();
  const view = renderHook(() =>
    useTurnReview({
      documents,
      sourceApi: currentSource,
      turnChangesApi: turns,
      workspace,
    }),
  );
  return { ...view, documents, workspace };
}

function reviewOn(documents: DocumentTabsRuntime, path: string) {
  const tab = documents.store.getState().tabs.find((entry) => entry.source.path === path);
  return tab ? (documents.getDocument(tab.id)?.store.getState().revision ?? null) : null;
}

describe('reviewing what an Agent turn changed', () => {
  const source = { folderPath, path: 'plan.md' };

  it('opens the document as a kept tab and starts the reversed review', async () => {
    const turns = turnChangesApi({
      load: vi.fn(async (request) => ({
        afterVersion: BASE_VERSION,
        before: '# Earlier plan\n',
        source: request.source,
        turnId: request.turnId,
      })),
    });
    const { documents, result } = mountPickup(turns);

    result.current.reviewTurnChange({ source, turnId: 'turn-1' });

    await waitFor(() => expect(reviewOn(documents, 'plan.md')?.kind).toBe('starting'));
    const revision = reviewOn(documents, 'plan.md');
    expect(revision?.kind === 'idle' ? null : revision?.review.before).toBe('# Earlier plan\n');
    expect(documents.store.getState().tabs.map((tab) => tab.preview)).toEqual([false]);
    expect(result.current.failures).toEqual([]);
  });

  it('says so on the notice strip when the turn has expired', async () => {
    const turns = turnChangesApi({
      load: vi.fn(async () => {
        throw new DocumentTurnChangesError('expired', 'gone');
      }),
    });
    const { result } = mountPickup(turns);

    result.current.reviewTurnChange({ source, turnId: 'turn-1' });

    await waitFor(() =>
      expect(result.current.failures).toEqual([
        'The changes that turn made to plan.md are no longer available to review.',
      ]),
    );
  });

  it('serializes competing reviews and keeps the first document review intact', async () => {
    const turns = turnChangesApi({
      load: vi.fn(async (request) => ({
        afterVersion: BASE_VERSION,
        before: '# Earlier plan\n',
        ...request,
      })),
    });
    const { documents, result } = mountPickup(turns);
    result.current.reviewTurnChange({ source, turnId: 'first' });
    result.current.reviewTurnChange({ source, turnId: 'second' });
    await waitFor(() =>
      expect(result.current.failures).toEqual(['Finish the review already open on plan.md first.']),
    );
    const review = reviewOn(documents, 'plan.md');
    expect(review?.kind === 'idle' ? null : review?.review.id).toContain('turn:first:');
    act(() => result.current.dismiss(result.current.failures[0] ?? ''));
    expect(result.current.failures).toEqual([]);
  });

  it('refuses a source outside the current project without loading its turn', async () => {
    const turns = turnChangesApi();
    const { documents, result } = mountPickup(turns);
    result.current.reviewTurnChange({
      source: { ...source, folderPath: '/elsewhere' },
      turnId: 'first',
    });
    await waitFor(() =>
      expect(result.current.failures).toEqual([
        'plan.md is not in the folder this window has open.',
      ]),
    );
    expect(turns.load).not.toHaveBeenCalled();
    expect(documents.store.getState().tabs).toEqual([]);
  });

  it('drops a queued review and late failure after its workspace unmounts', async () => {
    let reject: ((error: Error) => void) | undefined;
    const pending = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const turns = turnChangesApi({ load: vi.fn(() => pending) });
    const { result, unmount } = mountPickup(turns);
    result.current.reviewTurnChange({ source, turnId: 'first' });
    result.current.reviewTurnChange({ source, turnId: 'queued' });
    await waitFor(() => expect(turns.load).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      reject?.(new DocumentTurnChangesError('expired', 'gone'));
      await pending.catch(() => undefined);
    });
    expect(turns.load).toHaveBeenCalledTimes(1);
    expect(result.current.failures).toEqual([]);
  });
});
