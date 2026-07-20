import assert from 'node:assert/strict';
import test from 'node:test';
import {
  initialState,
  reducer,
  type ChatTab,
  type State,
  type Tab,
} from '../state.ts';

function freshState(overrides: Partial<State> = {}): State {
  return {
    ...initialState,
    tabs: [],
    chatTabs: [],
    chatTabRecencyByAgent: {},
    expanded: new Set(),
    pendingSemanticNames: new Set(),
    fileOrder: {},
    ...overrides,
  };
}

function documentTab(id: string, name: string | null, preview = false): Tab {
  return {
    id,
    file: name ? { name, format: 'md', content: name } : null,
    editMode: false,
    dirty: false,
    editorSessionVersion: 0,
    preview,
    pendingAnchor: null,
    pendingHighlight: null,
    saveStatus: { text: '', cls: '' },
  };
}

test('document tab lifecycle reuses a blank tab and selects a neighbor on close', () => {
  let state = reducer(freshState(), {
    type: 'FILE_OPEN',
    body: { name: 'one.md', format: 'md', content: 'one' },
    preview: true,
  });
  const firstId = state.activeTabId!;
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].preview, true);
  assert.equal(state.selectedPath, 'one.md');
  assert.equal(state.tabs[0].editMode, true);

  state = reducer(state, { type: 'NEW_TAB' });
  const blankId = state.activeTabId!;
  state = reducer(state, {
    type: 'FILE_OPEN',
    body: { name: 'two.md', format: 'md', content: 'two' },
  });
  assert.equal(state.tabs.length, 2);
  assert.equal(state.activeTabId, blankId);
  assert.equal(state.tabs[1].file?.name, 'two.md');

  state = reducer(state, { type: 'CLOSE_TAB', id: blankId });
  assert.equal(state.activeTabId, firstId);
  assert.equal(state.selectedPath, 'one.md');
});

test('Markdown opens in Live Editing while read-only formats remain out of edit mode', () => {
  const markdown = reducer(freshState(), {
    type: 'FILE_OPEN',
    body: { name: 'note.md', format: 'md', content: '# Note' },
  });
  assert.equal(markdown.tabs[0].editMode, true);

  const html = reducer(freshState(), {
    type: 'FILE_OPEN',
    body: { name: 'page.html', format: 'html', content: '<p>Read only</p>' },
  });
  assert.equal(html.tabs[0].editMode, false);
});

test('only dirty missing document tabs survive sidebar pruning', () => {
  let state = reducer(freshState(), {
    type: 'FILE_OPEN',
    body: { name: 'deleted.md', format: 'md', content: '# Deleted' },
  });
  state = reducer(state, { type: 'PRUNE_MISSING_FILE_TABS', names: [] });
  assert.equal(state.tabs.length, 0);

  state = reducer(freshState(), {
    type: 'FILE_OPEN',
    body: { name: 'draft.md', format: 'md', content: '# Draft' },
  });
  state = reducer(state, { type: 'DOCUMENT_DIRTY', dirty: true });
  state = reducer(state, { type: 'PRUNE_MISSING_FILE_TABS', names: [] });
  assert.equal(state.tabs[0].file?.name, 'draft.md');
});

test('renames retain an editor session generation while replacements invalidate it', () => {
  let state = reducer(freshState(), {
    type: 'FILE_OPEN',
    body: { name: 'draft.md', format: 'md', content: '# Draft' },
  });
  const version = state.tabs[0].editorSessionVersion;
  state = reducer(state, { type: 'REMAP_PATHS', from: 'draft.md', to: 'renamed.md', kind: 'file' });
  assert.equal(state.tabs[0].editorSessionVersion, version);
  state = reducer(state, {
    type: 'FILE_OPEN',
    body: { name: 'replacement.md', format: 'md', content: '# Replacement' },
  });
  assert.equal(state.tabs[0].editorSessionVersion, version + 1);
});

test('external content patches invalidate an editor session', () => {
  let state = reducer(freshState(), {
    type: 'FILE_OPEN',
    body: { name: 'note.md', format: 'md', content: '# Before' },
  });
  const version = state.tabs[0].editorSessionVersion;
  state = reducer(state, {
    type: 'FILE_PATCH',
    patch: { content: '# After' },
    invalidateEditorSession: true,
  });
  assert.equal(state.tabs[0].file?.content, '# After');
  assert.equal(state.tabs[0].editorSessionVersion, version + 1);
});

test('folder path remap updates files, tabs, expansion, focus, and manual order together', () => {
  const state = freshState({
    files: [{ name: 'docs/a.md', format: 'md', heading: 'A', snippet: '' }],
    folders: [{ path: 'docs' }, { path: 'docs/sub' }],
    tabs: [documentTab('tab-a', 'docs/a.md')],
    activeTabId: 'tab-a',
    expanded: new Set(['docs', 'docs/sub']),
    activeFolder: 'docs/sub',
    selectedPath: 'docs/a.md',
    fileOrder: {
      '': ['docs'],
      docs: ['a.md', 'sub'],
      'docs/sub': ['b.md'],
    },
  });

  const next = reducer(state, { type: 'REMAP_PATHS', from: 'docs', to: 'archive', kind: 'folder' });
  assert.deepEqual(next.files.map((file) => file.name), ['archive/a.md']);
  assert.deepEqual(next.folders.map((folder) => folder.path), ['archive', 'archive/sub']);
  assert.equal(next.tabs[0].file?.name, 'archive/a.md');
  assert.deepEqual([...next.expanded], ['archive', 'archive/sub']);
  assert.equal(next.activeFolder, 'archive/sub');
  assert.equal(next.selectedPath, 'archive/a.md');
  assert.deepEqual(next.fileOrder, {
    '': ['archive'],
    archive: ['a.md', 'sub'],
    'archive/sub': ['b.md'],
  });
});

test('chat tab recency survives toggles and is cleaned as tabs close', () => {
  const first: ChatTab = { id: 'chat-a', agent: 'codex', title: 'A' };
  const second: ChatTab = { id: 'chat-b', agent: 'codex', title: 'B' };
  let state = freshState({
    chatOpen: true,
    chatTabs: [first, second],
    activeChatTabId: second.id,
    chatTabRecencyByAgent: { codex: [first.id, second.id] },
  });

  state = reducer(state, { type: 'CHAT_TAB_ACTIVATE', id: first.id });
  assert.deepEqual(state.chatTabRecencyByAgent.codex, [second.id, first.id]);
  state = reducer(state, { type: 'CHAT_AGENT_TOGGLE', agent: 'codex' });
  assert.equal(state.chatOpen, false);
  state = reducer(state, { type: 'CHAT_AGENT_TOGGLE', agent: 'codex' });
  assert.equal(state.chatOpen, true);
  assert.equal(state.activeChatTabId, first.id);

  state = reducer(state, { type: 'CHAT_TAB_CLOSE', id: first.id });
  assert.equal(state.activeChatTabId, second.id);
  assert.deepEqual(state.chatTabRecencyByAgent.codex, [second.id]);
  state = reducer(state, { type: 'CHAT_TAB_CLOSE', id: second.id });
  assert.equal(state.activeChatTabId, null);
  assert.equal(state.chatOpen, false);
  assert.deepEqual(state.chatTabRecencyByAgent, {});
});

test('loading a different folder clears stale search state', () => {
  const state = freshState({
    folder: 'Old',
    folderPath: '/old',
    activeSidebarView: 'search',
    filterQuery: 'needle',
    searching: true,
    searchHits: [{ fileName: 'old.md', chunkIndex: 0, content: 'old', heading: '', score: 1 }],
    searchError: 'stale',
  });
  const next = reducer(state, {
    type: 'FILES_LOADED',
    files: [],
    folders: [],
    folder: 'New',
    folderPath: '/new',
  });
  assert.equal(next.activeSidebarView, 'files');
  assert.equal(next.filterQuery, '');
  assert.equal(next.searching, false);
  assert.equal(next.searchHits, null);
  assert.equal(next.keywordResult, null);
  assert.equal(next.searchError, null);
});
