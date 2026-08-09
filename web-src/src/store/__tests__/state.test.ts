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

test('document activation maintains folder-local file recency separately from tab order', () => {
  let state = freshState({ folderPath: '/folder' });
  state = reducer(state, { type: 'FILE_OPEN', body: { name: 'one.md', format: 'md', content: '' } });
  const oneId = state.activeTabId!;
  state = reducer(state, { type: 'NEW_TAB' });
  state = reducer(state, { type: 'FILE_OPEN', body: { name: 'two.md', format: 'md', content: '' } });
  assert.deepEqual(state.recentFilePaths, ['two.md', 'one.md']);

  state = reducer(state, { type: 'ACTIVATE_TAB', id: oneId });
  assert.deepEqual(state.recentFilePaths, ['one.md', 'two.md']);

  state = reducer(state, {
    type: 'FILES_LOADED', files: [], folders: [], folder: 'other', folderPath: '/other',
  });
  assert.deepEqual(state.recentFilePaths, []);
});

test('Editor History tracks tab-id MRU order independent of tab-strip order and prunes closed tabs', () => {
  let state = reducer(freshState(), {
    type: 'FILE_OPEN',
    body: { name: 'one.md', format: 'md', content: '' },
  });
  const oneId = state.activeTabId!;
  state = reducer(state, { type: 'NEW_TAB' });
  const blankId = state.activeTabId!;
  state = reducer(state, {
    type: 'FILE_OPEN',
    body: { name: 'two.md', format: 'md', content: '' },
  });
  // FILE_OPEN without newTab replaces the active (blank) tab's file — the
  // MRU entry is the blank tab's id, not a fresh id.
  assert.deepEqual(state.editorHistory, [blankId, oneId]);

  // Reordering the tab strip must not perturb Editor History.
  state = reducer(state, { type: 'TABS_REORDER', id: oneId, beforeId: null });
  assert.deepEqual(state.editorHistory, [blankId, oneId]);

  state = reducer(state, { type: 'ACTIVATE_TAB', id: oneId });
  assert.deepEqual(state.editorHistory, [oneId, blankId]);

  // Closing a tab drops it from history even though it isn't the most
  // recent entry.
  state = reducer(state, { type: 'CLOSE_TAB', id: blankId });
  assert.deepEqual(state.editorHistory, [oneId]);

  state = reducer(state, {
    type: 'FILES_LOADED', files: [], folders: [], folder: 'other', folderPath: '/other',
  });
  assert.deepEqual(state.editorHistory, []);
});

test('Editor History survives sidebar pruning of missing file tabs', () => {
  let state = reducer(freshState(), {
    type: 'FILE_OPEN',
    body: { name: 'keep.md', format: 'md', content: '' },
  });
  const keepId = state.activeTabId!;
  state = reducer(state, { type: 'NEW_TAB' });
  state = reducer(state, {
    type: 'FILE_OPEN',
    body: { name: 'gone.md', format: 'md', content: '' },
  });
  assert.equal(state.editorHistory.length, 2);

  state = reducer(state, { type: 'PRUNE_MISSING_FILE_TABS', names: ['keep.md'] });
  assert.deepEqual(state.editorHistory, [keepId]);
});

test('a save acknowledgement advances the version without replacing the live document source', () => {
  const state = reducer(freshState(), {
    type: 'FILE_OPEN',
    body: { name: 'note.md', format: 'md', content: '```ts\nconst live = true\n```', version: 'before' },
  });
  const next = reducer(state, { type: 'FILE_PATCH', patch: { version: 'after' } });

  assert.equal(next.tabs[0].file?.content, '```ts\nconst live = true\n```');
  assert.equal(next.tabs[0].file?.version, 'after');
});

test('replacing a PDF source version clears its saved page', () => {
  let state = reducer(freshState(), {
    type: 'FILE_OPEN',
    body: { name: 'paper.pdf', format: 'pdf', content: '', version: 'before' },
  });
  const tabId = state.activeTabId!;
  state = reducer(state, { type: 'TAB_PDF_PAGE', id: tabId, page: 10 });

  const unchanged = reducer(state, { type: 'FILE_PATCH', patch: { version: 'before' } });
  assert.equal(unchanged.tabs[0].pdfPage, 10);

  const replaced = reducer(state, { type: 'FILE_PATCH', patch: { version: 'after' } });
  assert.equal(replaced.tabs[0].file?.version, 'after');
  assert.equal(replaced.tabs[0].pdfPage, undefined);
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


test('folder path remap updates files, tabs, expansion, focus, and manual order together', () => {
  const state = freshState({
    files: [{ name: 'docs/a.md', format: 'md', heading: 'A', snippet: '' }],
    folders: [{ path: 'docs' }, { path: 'docs/sub' }],
    tabs: [documentTab('tab-a', 'docs/a.md')],
    recentFilePaths: ['docs/a.md'],
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
  assert.deepEqual(next.recentFilePaths, ['archive/a.md']);
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
    searchScope: 'notes/archive',
    searchTypes: ['pdf'],
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
  assert.equal(next.searchScope, null);
  assert.deepEqual(next.searchTypes, []);
});

test('scope and type filter changes clear both modes\' results', () => {
  const hits = [{ fileName: 'a.md', chunkIndex: 0, content: 'x', heading: '', score: 1 }];
  const keyword = { query: 'x', folder: 'f', files: [], totalMatches: 0, truncated: false };

  const scoped = reducer(
    freshState({ searchHits: hits, keywordResult: keyword }),
    { type: 'SEARCH_SCOPE', scope: 'notes' },
  );
  assert.equal(scoped.searchScope, 'notes');
  assert.equal(scoped.searchHits, null);
  assert.equal(scoped.keywordResult, null);

  const typed = reducer(
    freshState({ searchHits: hits, keywordResult: keyword }),
    { type: 'SEARCH_TYPES', types: ['pdf', 'docx'] },
  );
  assert.deepEqual(typed.searchTypes, ['pdf', 'docx']);
  assert.equal(typed.searchHits, null);
  assert.equal(typed.keywordResult, null);

  const cleared = reducer(scoped, { type: 'SEARCH_SCOPE', scope: null });
  assert.equal(cleared.searchScope, null);
});

test('PDF page numbers are isolated per tab and reset when replacing a file', () => {
  let state = reducer(freshState(), {
    type: 'FILE_OPEN',
    body: { name: 'doc1.pdf', format: 'pdf', content: '' },
    preview: true,
  });
  const tabId = state.activeTabId!;
  assert.equal(state.tabs[0].pdfPage, undefined);

  // Set the PDF page
  state = reducer(state, { type: 'TAB_PDF_PAGE', id: tabId, page: 4 });
  assert.equal(state.tabs[0].pdfPage, 4);

  // Open a new tab (not replacing preview)
  state = reducer(state, {
    type: 'FILE_OPEN',
    body: { name: 'doc2.pdf', format: 'pdf', content: '' },
    newTab: true,
  });
  const secondTabId = state.activeTabId!;
  assert.equal(state.tabs.length, 2);
  assert.equal(state.tabs[0].pdfPage, 4); // retained on the first tab
  assert.equal(state.tabs[1].pdfPage, undefined); // undefined on the second tab

  state = reducer(state, { type: 'TAB_PDF_PAGE', id: secondTabId, page: 2 });
  state = reducer(state, { type: 'ACTIVATE_TAB', id: tabId });
  assert.equal(state.tabs.find((tab) => tab.id === tabId)?.pdfPage, 4);
  state = reducer(state, { type: 'ACTIVATE_TAB', id: secondTabId });
  assert.equal(state.tabs.find((tab) => tab.id === secondTabId)?.pdfPage, 2);

  // Reuse preview tab to open another file (doc3.pdf) -> should clear the pdfPage
  state = reducer(state, { type: 'ACTIVATE_TAB', id: tabId });
  state = reducer(state, {
    type: 'FILE_OPEN',
    body: { name: 'doc3.pdf', format: 'pdf', content: '' },
    preview: true,
  });
  assert.equal(state.tabs[0].pdfPage, undefined); // reset / not leaked from doc1.pdf
});

test('FILES_LOADED captures unsupportedFiles and folder change resets modal state', () => {
  const summary = {
    sourceCode: 3,
    other: 1,
    otherExtensions: [{ extension: '.zip', count: 1 }],
  };

  let state = reducer(freshState({ unsupportedModal: { sourceCode: true, other: true } }), {
    type: 'FILES_LOADED',
    files: [],
    folders: [],
    folder: 'notes',
    folderPath: '/notes',
    unsupportedFiles: summary,
  });

  assert.deepEqual(state.unsupportedFiles, summary);

  state = reducer(state, {
    type: 'FILES_LOADED',
    files: [],
    folders: [],
    folder: 'other',
    folderPath: '/other',
    unsupportedFiles: undefined,
  });

  assert.equal(state.unsupportedFiles, undefined);
  assert.equal(state.unsupportedModal, null);
});

test('unsupported modal tracks the categories being explained', () => {
  let state = reducer(freshState(), {
    type: 'UNSUPPORTED_MODAL_OPEN',
    categories: { sourceCode: false, other: true },
  });
  assert.deepEqual(state.unsupportedModal, { sourceCode: false, other: true });

  state = reducer(state, { type: 'UNSUPPORTED_MODAL_CLOSE' });
  assert.equal(state.unsupportedModal, null);
});

test('FILES_LOADED closes or narrows an open unsupported notice as counts change', () => {
  let state = freshState({
    folder: 'notes',
    folderPath: '/notes',
    unsupportedModal: { sourceCode: true, other: true },
  });

  state = reducer(state, {
    type: 'FILES_LOADED',
    files: [],
    folders: [],
    folder: 'notes',
    folderPath: '/notes',
    unsupportedFiles: {
      sourceCode: 0,
      other: 1,
      otherExtensions: [{ extension: '.zip', count: 1 }],
    },
  });
  assert.deepEqual(state.unsupportedModal, { sourceCode: false, other: true });

  state = reducer(state, {
    type: 'FILES_LOADED',
    files: [],
    folders: [],
    folder: 'notes',
    folderPath: '/notes',
    unsupportedFiles: undefined,
  });
  assert.equal(state.unsupportedModal, null);
});
