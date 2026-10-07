import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { createDocumentTabsRuntime } from '@/features/documents/application/tabs-runtime';
import { documentTabsRuntimeOptions, sourceApi, textSource } from '@/test/fakes/documents';

import { useRevisionPreview } from './use-revision-preview';

const folderPath = '/project/notes';
const BASE = '# Plan\n';
const PROPOSAL = '# Revised plan\n';

const runtimes: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

async function openDocument() {
  const documents = createDocumentTabsRuntime(
    documentTabsRuntimeOptions({ api: sourceApi(), folderPath }),
  );
  runtimes.push(documents);
  const document = await documents.open({ folderPath, path: 'plan.md' });
  if (!document) throw new Error('Expected the document to open.');
  document.reconcile(textSource({ content: BASE, version: 'sha256:v1' }));
  return { document, documents };
}

describe('the developer revision trigger', () => {
  it('does nothing in a build where it is disabled', async () => {
    const { document, documents } = await openDocument();
    const { result } = renderHook(() => useRevisionPreview(false, documents));

    act(() => result.current.start(PROPOSAL));

    expect(document.store.getState().revision).toEqual({ kind: 'idle' });
    expect(result.current.refusal).toBeNull();
  });

  it('opens a review on the document in front of the reader', async () => {
    const { document, documents } = await openDocument();
    const { result } = renderHook(() => useRevisionPreview(true, documents));

    act(() => result.current.start(`---\ntitle: Plan\n---\n${PROPOSAL}`));

    const revision = document.store.getState().revision;
    expect(revision.kind).toBe('starting');
    expect(revision.kind === 'idle' ? null : revision.review.before).toBe(PROPOSAL);
    expect(result.current.refusal).toBeNull();
  });

  it('says why a proposal was refused rather than failing silently', async () => {
    const { documents } = await openDocument();
    const { result } = renderHook(() => useRevisionPreview(true, documents));

    act(() => result.current.start(BASE));

    expect(result.current.refusal).toBe(
      'The earlier text matches the document already, so there is nothing to review.',
    );
  });

  it('asks for a document when nothing is open', () => {
    const { result } = renderHook(() => useRevisionPreview(true, null));
    act(() => result.current.start(PROPOSAL));
    expect(result.current.refusal).toBeNull();

    const documents = createDocumentTabsRuntime(documentTabsRuntimeOptions({ folderPath }));
    runtimes.push(documents);
    const open = renderHook(() => useRevisionPreview(true, documents));
    act(() => open.result.current.start(PROPOSAL));

    expect(open.result.current.refusal).toBe('Open a Markdown document first.');
  });
});
