import { describe, expect, it } from 'vite-plus/test';

import {
  activateDocumentTab,
  adjacentDocumentTab,
  closeDocumentTab,
  createDocumentTabsState,
  keepDocumentTab,
  openDocumentTab,
  previewDocumentTab,
  type DocumentTabsState,
} from './tabs';

const notes = { folderPath: '/project/notes', path: 'plan.md' };
const other = { folderPath: '/project/notes', path: 'other.md' };

/** The invariant every transition below has to leave standing. */
const isConsistent = (state: DocumentTabsState) =>
  state.activeTabId === null || state.tabs.some((tab) => tab.id === state.activeTabId);

const shape = (state: DocumentTabsState) =>
  state.tabs.map((tab) => `${tab.id}${tab.preview ? '*' : ''}`);

describe('document tabs', () => {
  it('restores only one tab per exact source, all kept, and retains distinct folders', () => {
    const state = createDocumentTabsState({
      activeTabId: 'duplicate',
      tabs: [
        { id: 'notes', source: notes },
        { id: 'duplicate', source: { ...notes } },
        {
          id: 'archive',
          source: { folderPath: '/project/archive', path: 'plan.md' },
        },
      ],
    });

    expect(shape(state)).toEqual(['notes', 'archive']);
    expect(state.activeTabId).toBe('notes');
    expect(previewDocumentTab(state)).toBeNull();
  });

  it('opens an existing source by activation instead of duplicating it', () => {
    let state = createDocumentTabsState();
    state = openDocumentTab(state, { id: 'first', source: notes }, false);
    state = openDocumentTab(state, { id: 'second', source: other }, false);
    state = openDocumentTab(state, { id: 'duplicate', source: { ...notes } }, false);

    expect(shape(state)).toEqual(['first', 'second']);
    expect(state.activeTabId).toBe('first');
  });

  it('gives the one preview tab to each new browse and keeps it on request', () => {
    const third = { folderPath: '/project/notes', path: 'third.md' };
    let state = createDocumentTabsState();
    state = openDocumentTab(state, { id: 'kept', source: notes }, false);
    state = openDocumentTab(state, { id: 'look', source: other }, true);
    expect(shape(state)).toEqual(['kept', 'look*']);

    // The next browse takes the preview's slot rather than a slot of its own.
    state = openDocumentTab(state, { id: 'next-look', source: third }, true);
    expect(shape(state)).toEqual(['kept', 'next-look*']);
    expect(state.activeTabId).toBe('next-look');
    expect(previewDocumentTab(state)?.id).toBe('next-look');

    // Browsing back to a kept source activates it and leaves the preview be.
    state = openDocumentTab(state, { id: 'unused', source: notes }, true);
    expect(shape(state)).toEqual(['kept', 'next-look*']);
    expect(state.activeTabId).toBe('kept');

    // Asking keeps the preview; opening its source as kept does the same.
    const kept = keepDocumentTab(state, 'next-look');
    expect(shape(kept)).toEqual(['kept', 'next-look']);
    expect(keepDocumentTab(kept, 'next-look')).toBe(kept);
    expect(keepDocumentTab(state, 'missing')).toBe(state);
    const reopened = openDocumentTab(state, { id: 'unused', source: third }, false);
    expect(shape(reopened)).toEqual(['kept', 'next-look']);

    // With no preview standing, a browse gets a preview of its own beside it.
    state = openDocumentTab(kept, { id: 'fresh-look', source: other }, true);
    expect(shape(state)).toEqual(['kept', 'next-look', 'fresh-look*']);
    expect(isConsistent(state)).toBe(true);
  });

  it('activates known tabs and selects the adjacent tab after close', () => {
    let state = createDocumentTabsState({
      activeTabId: 'one',
      tabs: [
        { id: 'one', source: notes },
        {
          id: 'two',
          source: { folderPath: '/project/notes', path: 'two.md' },
        },
        {
          id: 'three',
          source: { folderPath: '/project/notes', path: 'three.md' },
        },
      ],
    });

    state = activateDocumentTab(state, 'two');
    state = closeDocumentTab(state, 'two');
    expect(state.activeTabId).toBe('three');
    state = closeDocumentTab(state, 'three');
    expect(state.activeTabId).toBe('one');
  });

  it('keeps the active tab a member of the tab set through every transition', () => {
    const two = { folderPath: '/project/notes', path: 'two.md' };
    // A restored active id that names no surviving tab is dropped, not kept.
    let state = createDocumentTabsState({
      activeTabId: 'missing',
      tabs: [{ id: 'one', source: notes }],
    });
    expect(state.activeTabId).toBeNull();
    expect(isConsistent(state)).toBe(true);

    // Activating an unknown tab leaves the previous member active.
    state = openDocumentTab(state, { id: 'two', source: two }, false);
    state = activateDocumentTab(state, 'unknown');
    expect(state.activeTabId).toBe('two');
    expect(isConsistent(state)).toBe(true);

    // Closing the last tab leaves no dangling active id behind.
    state = closeDocumentTab(state, 'two');
    state = closeDocumentTab(state, 'one');
    expect(state.tabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
    expect(isConsistent(state)).toBe(true);
  });

  it('names the neighbouring tab, wrapping at the ends, and none for a lone tab', () => {
    const three = createDocumentTabsState({
      activeTabId: 'a',
      tabs: ['a', 'b', 'c'].map((id) => ({ id, source: { ...notes, path: `${id}.md` } })),
    });
    expect(adjacentDocumentTab(three, 1)?.id).toBe('b');
    expect(adjacentDocumentTab(three, -1)?.id).toBe('c');
    expect(adjacentDocumentTab(activateDocumentTab(three, 'c'), 1)?.id).toBe('a');
    const lone = createDocumentTabsState({ activeTabId: 'a', tabs: [{ id: 'a', source: notes }] });
    expect(adjacentDocumentTab(lone, 1)).toBeNull();
  });
});
