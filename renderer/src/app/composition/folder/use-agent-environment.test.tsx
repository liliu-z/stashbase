import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { createDocumentTabsRuntime, type DocumentTabsRuntime } from '@/features/documents/public';
import type { FolderIndexStatus } from '@/features/preparation/public';
import { documentTabsRuntimeOptions } from '@/test/fakes/documents';
import { folderIndexStatus } from '@/test/fakes/preparation';
import { listing, listingFile, listingFolder, RESEARCH_FOLDER } from '@/test/fakes/workspace';

import { useAgentEnvironment } from './use-agent-environment';

afterEach(cleanup);

const folderPath = RESEARCH_FOLDER.path;

const folderListing = listing(
  [
    listingFile({ format: 'md', path: 'notes.md' }),
    listingFile({ format: 'pdf', path: 'papers/study.pdf' }),
  ],
  [listingFolder({ path: 'papers' }), listingFolder({ kind: 'excluded', path: '.stashbase' })],
);

function pendingStatus(): FolderIndexStatus {
  return folderIndexStatus({
    conversionVersions: { 'papers/study.pdf': 3 },
    pendingConversions: ['papers/study.pdf'],
  });
}

function mount(
  status: FolderIndexStatus | null = null,
  documents: DocumentTabsRuntime | null = null,
  documentsShown = true,
) {
  return renderHook(
    ({ shown }) =>
      useAgentEnvironment(folderListing, status, documents, folderPath, folderPath, shown),
    { initialProps: { shown: documentsShown } },
  );
}

function openNotes(): DocumentTabsRuntime {
  return createDocumentTabsRuntime(
    documentTabsRuntimeOptions({
      folderPath,
      restored: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1', source: { folderPath, path: 'notes.md' } }],
      },
    }),
  );
}

describe('useAgentEnvironment', () => {
  it("publishes nothing until the folder's listing has arrived", () => {
    const { result } = renderHook(() =>
      useAgentEnvironment(undefined, null, null, folderPath, folderPath, true),
    );

    expect(result.current).toEqual({
      environment: null,
      scope: { kind: 'folder', path: folderPath },
    });
  });

  it('has no environment while no folder is open', () => {
    const { result } = renderHook(() =>
      useAgentEnvironment(folderListing, null, null, null, null, true),
    );

    expect(result.current.environment).toBeNull();
    // Welcome has no conversation scope.
    expect(result.current.scope).toBeNull();
  });

  it('hides derived folders from what the Agent can see', () => {
    const { result } = mount();

    expect(result.current.environment?.listing.folders).toEqual(['papers']);
    expect(result.current.environment?.listing.files.map((file) => file.path)).toEqual([
      'notes.md',
      'papers/study.pdf',
    ]);
  });

  it('reports only the sources that are not already current', () => {
    const { result } = mount(pendingStatus());

    expect(result.current.environment?.readiness).toEqual({ 'papers/study.pdf': 'pending' });
    expect(result.current.environment?.versions).toEqual({ 'papers/study.pdf': 3 });
  });

  it('leads with the documents open beside the chat', async () => {
    const documents = openNotes();
    const { result } = mount(null, documents);
    expect(result.current.environment?.openPaths).toEqual(['notes.md']);

    await act(() => documents.close('tab-1'));

    expect(result.current.environment?.openPaths).toEqual([]);
    documents.dispose();
  });

  it('offers the document in front only while Documents is on screen', async () => {
    const documents = openNotes();
    const { rerender, result } = mount(null, documents);
    expect(result.current.environment?.activeSource).toEqual({ folderPath, path: 'notes.md' });

    rerender({ shown: false });
    expect(result.current.environment?.activeSource).toBeNull();

    rerender({ shown: true });
    await act(() => documents.close('tab-1'));
    expect(result.current.environment?.activeSource).toBeNull();
    documents.dispose();
  });

  it('hands back the same environment while nothing it reads has changed', () => {
    const { rerender, result } = mount();
    const first = result.current.environment;

    rerender({ shown: true });

    expect(result.current.environment).toBe(first);
  });
});
