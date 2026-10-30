import { describe, expect, it } from 'vite-plus/test';

import {
  clearTreeCreate,
  createWorkspaceState,
  collapseAllTreeFolders,
  expandTreeFolder,
  forgetTreePath,
  renameTreePath,
  requestTreeCreate,
  selectTreePath,
  toggleTreeFolder,
} from './workspace';

describe('workspace tree state', () => {
  it('keeps expansion and selection serializable and folder-scoped', () => {
    const initial = createWorkspaceState({
      folder: { name: 'Notes', path: '/project/notes' },
      generation: 3,
    });
    const expanded = toggleTreeFolder(initial, 'drafts');
    const selected = selectTreePath(expanded, 'drafts/plan.md');

    expect(selected).toMatchObject({
      expanded: { drafts: true },
      selectedPath: 'drafts/plan.md',
      scope: { folder: { path: '/project/notes' }, generation: 3 },
    });
    expect(toggleTreeFolder(selected, 'drafts').expanded).toEqual({});
    expect(initial).toMatchObject({ expanded: {}, selectedPath: null });
  });

  it('hydrates only approved tree state into a fresh runtime scope', () => {
    const restored = createWorkspaceState(
      {
        folder: { name: 'Notes', path: '/project/notes' },
        generation: 9,
      },
      {
        activeTabId: 'tab-1',
        expandedPaths: ['drafts'],
        folderPath: '/project/notes',
        mathMode: false,
        selectedPath: 'drafts/plan.md',
        tabs: [{ id: 'tab-1', path: 'drafts/plan.md' }],
      },
    );

    expect(restored).toEqual({
      expanded: { drafts: true },
      lifecycle: 'active',
      pendingCreate: null,
      scope: {
        folder: { name: 'Notes', path: '/project/notes' },
        generation: 9,
      },
      selectedPath: 'drafts/plan.md',
    });
  });

  it('moves expansion and selection with a renamed entry and drops them with a deleted one', () => {
    const scope = {
      folder: { name: 'Notes', path: '/project/notes' },
      generation: 1,
    };
    let state = createWorkspaceState(scope);
    state = expandTreeFolder(expandTreeFolder(state, 'drafts'), 'drafts/2026');
    expect(expandTreeFolder(state, 'drafts')).toBe(state);
    // Collapse all folds everything at once, and folding an already flat
    // tree changes nothing.
    const flat = collapseAllTreeFolders(state);
    expect(flat.expanded).toEqual({});
    expect(collapseAllTreeFolders(flat)).toBe(flat);
    state = selectTreePath(state, 'drafts/2026/plan.md');

    const renamed = renameTreePath(state, 'drafts', 'archive');
    expect(renamed.expanded).toEqual({ archive: true, 'archive/2026': true });
    expect(renamed.selectedPath).toBe('archive/2026/plan.md');
    expect(renameTreePath(state, 'drafts', 'drafts')).toBe(state);
    expect(renameTreePath(state, 'drafts-old', 'x')).toMatchObject({
      expanded: { drafts: true, 'drafts/2026': true },
      selectedPath: 'drafts/2026/plan.md',
    });

    const forgotten = forgetTreePath(state, 'drafts/2026');
    expect(forgotten.expanded).toEqual({ drafts: true });
    expect(forgotten.selectedPath).toBeNull();
    expect(forgetTreePath(state, 'other')).toMatchObject({
      expanded: { drafts: true, 'drafts/2026': true },
      selectedPath: 'drafts/2026/plan.md',
    });
  });
});

describe('workspace create requests', () => {
  it('holds one create request at a time and clears it once the tree takes it up', () => {
    const state = createWorkspaceState({
      folder: { name: 'Notes', path: '/project/notes' },
      generation: 1,
    });
    expect(state.pendingCreate).toBeNull();

    const asked = requestTreeCreate(state, 'draft');
    expect(asked.pendingCreate).toEqual({ kind: 'draft', revision: 1 });
    // Asking again is a new request even though nothing else changed.
    expect(requestTreeCreate(asked, 'draft').pendingCreate?.revision).toBe(2);

    expect(clearTreeCreate(asked).pendingCreate).toBeNull();
    expect(clearTreeCreate(state)).toBe(state);
  });
});
