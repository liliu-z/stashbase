import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { createDocumentTabsRuntime, type DocumentTabsRuntime } from '@/features/documents/public';
import type { WorkspaceRuntime } from '@/features/workspace/public';
import { createWorkspaceRuntime } from '@/features/workspace/test-support';
import { documentTabsRuntimeOptions, sourceApi } from '@/test/fakes/documents';
import { RESEARCH_FOLDER, folderSession, workspaceRuntimeOptions } from '@/test/fakes/workspace';

import { useTreeFollowsDocument } from './use-tree-follows-document';

afterEach(cleanup);

const folderPath = RESEARCH_FOLDER.path;
const notes = { folderPath, path: 'notes.md' };
const plan = { folderPath, path: 'drafts/plan.md' };

function documentsRuntime(): DocumentTabsRuntime {
  return createDocumentTabsRuntime(
    documentTabsRuntimeOptions({ api: sourceApi(), folderPath, generation: 1 }),
  );
}

function mount(workspace: WorkspaceRuntime, documents: DocumentTabsRuntime) {
  return renderHook(() => useTreeFollowsDocument(workspace, documents));
}

const selectionOf = (workspace: WorkspaceRuntime) => workspace.store.getState().selectedPath;

describe('useTreeFollowsDocument', () => {
  it('moves the tree onto whichever document comes in front', async () => {
    const workspace = createWorkspaceRuntime(workspaceRuntimeOptions());
    const documents = documentsRuntime();
    mount(workspace, documents);

    await documents.open(notes, { preview: false });
    expect(selectionOf(workspace)).toBe('notes.md');

    // A browse reuses the standing preview, so the row it replaces must not
    // stay highlighted behind it. A document inside a folder opens the folder,
    // so its row can be seen as well as selected.
    await documents.open(plan, { preview: true });
    expect(selectionOf(workspace)).toBe('drafts/plan.md');
    expect(workspace.store.getState()).toMatchObject({
      expanded: { drafts: true },
      pendingReveal: { opened: ['drafts'], path: 'drafts/plan.md' },
    });

    // Switching tabs in the strip never touches the tree, which is the whole
    // reason the tree has to follow the open set rather than the last click.
    const notesTab = documents.store.getState().tabs.find((tab) => tab.source.path === 'notes.md');
    expect(notesTab).toBeDefined();
    await documents.activate(notesTab?.id ?? '');
    expect(selectionOf(workspace)).toBe('notes.md');

    documents.dispose();
    workspace.dispose();
  });

  it('leaves no row selected once the last document closes', async () => {
    const workspace = createWorkspaceRuntime(workspaceRuntimeOptions());
    const documents = documentsRuntime();
    mount(workspace, documents);

    await documents.open(notes, { preview: false });
    await documents.closeActive();

    expect(selectionOf(workspace)).toBeNull();
    documents.dispose();
    workspace.dispose();
  });

  it('keeps a row the reader pointed at themselves', async () => {
    const workspace = createWorkspaceRuntime(workspaceRuntimeOptions());
    const documents = documentsRuntime();
    mount(workspace, documents);

    await documents.open(notes, { preview: false });
    // A folder expanded while the document stays open: the tree's own cursor,
    // which the closing document has no claim on.
    workspace.selectPath('drafts');
    await documents.closeActive();

    expect(selectionOf(workspace)).toBe('drafts');
    documents.dispose();
    workspace.dispose();
  });

  it('selects nothing for a document from another folder', async () => {
    const workspace = createWorkspaceRuntime(workspaceRuntimeOptions());
    const documents = documentsRuntime();
    mount(workspace, documents);

    await documents.open({ folderPath: '/project/archive', path: 'old.md' }, { preview: false });

    expect(selectionOf(workspace)).toBeNull();
    documents.dispose();
    workspace.dispose();
  });

  it('leaves the restored arrangement as it was saved', () => {
    const workspace = createWorkspaceRuntime(
      workspaceRuntimeOptions({
        restored: folderSession({
          activeTabId: 'restored-tab',
          selectedPath: 'drafts',
          tabs: [{ id: 'restored-tab', path: 'notes.md' }],
        }),
      }),
    );
    const documents = createDocumentTabsRuntime(
      documentTabsRuntimeOptions({
        api: sourceApi(),
        folderPath,
        generation: 1,
        restored: { activeTabId: 'restored-tab', tabs: [{ id: 'restored-tab', source: notes }] },
      }),
    );
    mount(workspace, documents);

    expect(selectionOf(workspace)).toBe('drafts');
    documents.dispose();
    workspace.dispose();
  });
});
