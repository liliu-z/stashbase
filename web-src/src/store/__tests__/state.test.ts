import assert from 'node:assert/strict';
import test from 'node:test';
import {
  initialState,
  makeChatTab,
  reducer,
  type ChatTab,
  type State,
  type Tab,
} from '../state.ts';
import { folderScopedResetActions } from '../folderScopedReset.ts';

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

function documentTab(id: string, name: string | null): Tab {
  return {
    id,
    file: name ? { name, format: 'md', content: name } : null,
    editMode: false,
    dirty: false,
    pendingAnchor: null,
    pendingHighlight: null,
    saveStatus: { text: '', cls: '' },
  };
}

test('Chat is expanded from the first renderer state', () => {
  assert.equal(initialState.chatOpen, true);
});

test('document tab lifecycle reuses a blank tab and selects a neighbor on close', () => {
  let state = reducer(freshState(), {
    type: 'FILE_OPEN',
    body: { name: 'one.md', format: 'md', content: 'one' },
  });
  const firstId = state.activeTabId!;
  assert.equal(state.tabs.length, 1);
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

  const json = reducer(freshState(), {
    type: 'FILE_OPEN',
    body: { name: 'data.json', format: 'json', content: '{ invalid' },
  });
  assert.equal(json.tabs[0].editMode, false);

  const csv = reducer(freshState(), {
    type: 'FILE_OPEN',
    body: { name: 'data.csv', format: 'csv', content: 'a,b\n1,2' },
  });
  assert.equal(csv.tabs[0].editMode, true);
});

test('JSON persistent tabs, dirty retention, replacement, and folder isolation use the shared tab lifecycle', () => {
  let state = reducer(freshState({ folderPath: '/one' }), {
    type: 'FILE_OPEN', body: { name: 'one.json', format: 'json', content: '{ one' },
  });
  assert.equal(state.tabs[0].editMode, false);
  state = reducer(state, { type: 'EDIT_MODE', on: true });
  state = reducer(state, { type: 'DOCUMENT_DIRTY', dirty: true });
  assert.equal(state.tabs[0].dirty, true);
  state = reducer(state, { type: 'PRUNE_MISSING_FILE_TABS', names: [] });
  assert.equal(state.tabs.length, 1, 'dirty JSON survives external deletion pruning');

  state = reducer(state, { type: 'DOCUMENT_DIRTY', dirty: false });
  state = reducer(state, { type: 'FILE_OPEN', body: { name: 'two.JSON', format: 'json', content: '{ two' } });
  assert.equal(state.tabs[0].file?.name, 'two.JSON');
  assert.equal(state.tabs[0].editMode, false);
  for (const action of folderScopedResetActions('switch')) state = reducer(state, action);
  state = reducer(state, { type: 'FOLDER_CONTEXT', folder: 'Two', folderPath: '/two' });
  assert.equal(state.tabs.length, 0, 'folder switches cannot retain a JSON editor from another folder');
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

test('chat tab recency survives panel toggles and is cleaned as tabs close', () => {
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
  state = reducer(state, { type: 'CHAT_TOGGLE' });
  assert.equal(state.chatOpen, false);
  // CHAT_AGENT_OPEN (New Chat / MainPane's Start chat) reveals the
  // agent's most recent tab and reopens the hidden panel.
  state = reducer(state, { type: 'CHAT_AGENT_OPEN', agent: 'codex' });
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

test('CHAT_TAB_SET_AGENT switches only blank tabs and migrates recency', () => {
  const blank: ChatTab = { id: 'chat-a', agent: 'codex', title: 'New Chat', blank: true };
  const started: ChatTab = { id: 'chat-b', agent: 'codex', title: 'Refactor plan', blank: false };
  let state = freshState({
    chatTabs: [blank, started],
    activeChatTabId: blank.id,
    chatTabRecencyByAgent: { codex: [started.id, blank.id] },
  });

  // Blank tab: agent switches in place and its recency entry moves to
  // the new agent's list.
  state = reducer(state, { type: 'CHAT_TAB_SET_AGENT', id: blank.id, agent: 'claude' });
  assert.equal(state.chatTabs[0].agent, 'claude');
  assert.equal(state.chatTabs[0].title, 'New Chat');
  assert.deepEqual(state.chatTabRecencyByAgent.codex, [started.id]);
  assert.deepEqual(state.chatTabRecencyByAgent.claude, [blank.id]);

  // Guard: a tab with content (blank === false) never switches agent.
  const before = state;
  state = reducer(state, { type: 'CHAT_TAB_SET_AGENT', id: started.id, agent: 'claude' });
  assert.equal(state, before);
  assert.equal(state.chatTabs[1].agent, 'codex');

  // Same agent and unknown ids are no-ops.
  assert.equal(reducer(state, { type: 'CHAT_TAB_SET_AGENT', id: blank.id, agent: 'claude' }), state);
  assert.equal(reducer(state, { type: 'CHAT_TAB_SET_AGENT', id: 'missing', agent: 'claude' }), state);
});

test('CHAT_TAB_SET_AGENT renumbers the placeholder title for the new agent', () => {
  const claudeTab: ChatTab = { id: 'chat-a', agent: 'claude', title: 'New Chat', blank: false };
  const blank: ChatTab = { id: 'chat-b', agent: 'codex', title: 'New Chat', blank: true };
  let state = freshState({ chatTabs: [claudeTab, blank], activeChatTabId: blank.id });
  state = reducer(state, { type: 'CHAT_TAB_SET_AGENT', id: blank.id, agent: 'claude' });
  // A second claude tab picks up the "New Chat 2" numbering, matching
  // makeChatTab's per-agent placeholder scheme.
  assert.equal(state.chatTabs[1].agent, 'claude');
  assert.equal(state.chatTabs[1].title, 'New Chat 2');
});

test('new chat tabs start blank and AgentView updates keep the flag current', () => {
  const tab = makeChatTab('codex', []);
  assert.equal(tab.blank, true);
  let state = freshState({ chatTabs: [tab], activeChatTabId: tab.id });
  state = reducer(state, { type: 'CHAT_TAB_SET_BLANK', id: tab.id, blank: false });
  assert.equal(state.chatTabs[0].blank, false);
  state = reducer(state, { type: 'CHAT_TAB_SET_BLANK', id: tab.id, blank: true });
  assert.equal(state.chatTabs[0].blank, true);
});

test('pendingResume channel: request replaces, consume clears, folder-context loss clears', () => {
  const tab = makeChatTab('claude', []);
  let state = freshState({ chatTabs: [tab], activeChatTabId: tab.id });
  assert.equal(state.pendingResume, null);

  state = reducer(state, {
    type: 'CHAT_RESUME_REQUEST',
    resume: { agent: 'claude', sessionId: 's1', folder: '/lib/notes' },
  });
  assert.deepEqual(state.pendingResume, { agent: 'claude', sessionId: 's1', folder: '/lib/notes' });

  // A newer request replaces an unconsumed one (`folder: null` = the
  // library scope, matching the boundFolder convention).
  state = reducer(state, {
    type: 'CHAT_RESUME_REQUEST',
    resume: { agent: 'codex', sessionId: 's2', folder: null },
  });
  assert.deepEqual(state.pendingResume, { agent: 'codex', sessionId: 's2', folder: null });

  // Consuming clears it; a second consume is a no-op (same state object).
  state = reducer(state, { type: 'CHAT_RESUME_CONSUMED' });
  assert.equal(state.pendingResume, null);
  assert.equal(reducer(state, { type: 'CHAT_RESUME_CONSUMED' }), state);

  // Losing the window's folder context clears an in-flight request too —
  // the sessions it pointed at were just torn down.
  state = reducer(state, {
    type: 'CHAT_RESUME_REQUEST',
    resume: { agent: 'claude', sessionId: 's3', folder: null },
  });
  state = reducer(state, { type: 'CHAT_TABS_RESET' });
  assert.equal(state.pendingResume, null);
});

test('out-of-folder tabs stay read-only and outside folder-local flows', () => {
  let state = reducer(freshState({ folder: 'A', folderPath: '/a' }), {
    type: 'FILE_OPEN',
    body: { name: 'notes/远方.md', format: 'md', content: '# hi' },
    libraryFolder: '/b',
  });
  const tab = state.tabs[state.tabs.length - 1];
  assert.equal(tab.file?.folder, '/b');
  // Never Live Editing: the save path would write into the ACTIVE folder.
  assert.equal(tab.editMode, false);
  // Never the tree's focused row or the folder-local Quick Open recents.
  assert.equal(state.selectedPath, '');
  assert.deepEqual(state.recentFilePaths, []);

  // The active-folder listing prune must not close it…
  state = reducer(state, { type: 'PRUNE_MISSING_FILE_TABS', names: [] });
  assert.ok(state.tabs.some((t) => t.id === tab.id));

  // …an active-folder rename must not remap its (other-folder) path…
  state = reducer(state, { type: 'REMAP_PATHS', from: 'notes', to: 'docs', kind: 'folder' });
  assert.equal(state.tabs.find((t) => t.id === tab.id)?.file?.name, 'notes/远方.md');

  // …and entering edit mode is refused outright.
  assert.equal(reducer(state, { type: 'EDIT_MODE', on: true }), state);
});

test('loading a different folder clears per-folder session state', () => {
  // Search state deliberately does NOT live in the reducer (the library
  // search popup keeps it in module memory so it survives this switch —
  // see librarySearch.ts); what resets here is the per-folder session
  // state that would otherwise leak across folders.
  const state = freshState({
    folder: 'Old',
    folderPath: '/old',
    recentFilePaths: ['old.md'],
    editorHistory: ['old.md'],
    unsupportedModalOpen: true,
  });
  const next = reducer(state, {
    type: 'FILES_LOADED',
    files: [],
    folders: [],
    folder: 'New',
    folderPath: '/new',
  });
  assert.deepEqual(next.recentFilePaths, []);
  assert.deepEqual(next.editorHistory, []);
  assert.equal(next.unsupportedModalOpen, false);
});

test('PDF page numbers are isolated per tab and reset when replacing a file', () => {
  let state = reducer(freshState(), {
    type: 'FILE_OPEN',
    body: { name: 'doc1.pdf', format: 'pdf', content: '' },
  });
  const tabId = state.activeTabId!;
  assert.equal(state.tabs[0].pdfPage, undefined);

  // Set the PDF page
  state = reducer(state, { type: 'TAB_PDF_PAGE', id: tabId, page: 4 });
  assert.equal(state.tabs[0].pdfPage, 4);

  // Open a new tab (not replacing the active tab)
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

  // Replace the active tab's file (doc3.pdf) -> should clear the pdfPage
  state = reducer(state, { type: 'ACTIVATE_TAB', id: tabId });
  state = reducer(state, {
    type: 'FILE_OPEN',
    body: { name: 'doc3.pdf', format: 'pdf', content: '' },
  });
  assert.equal(state.tabs[0].pdfPage, undefined); // reset / not leaked from doc1.pdf
});

test('FILES_LOADED captures unsupportedFiles and folder change resets modal state', () => {
  const summary = {
    sourceCode: 3,
    other: 1,
    otherExtensions: [{ extension: '.zip', count: 1 }],
  };

  let state = reducer(freshState({ unsupportedModalOpen: true }), {
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
  assert.equal(state.unsupportedModalOpen, false);
});

test('UNSUPPORTED_MODAL toggle action updates state', () => {
  let state = reducer(freshState(), { type: 'UNSUPPORTED_MODAL', open: true });
  assert.equal(state.unsupportedModalOpen, true);

  state = reducer(state, { type: 'UNSUPPORTED_MODAL', open: false });
  assert.equal(state.unsupportedModalOpen, false);
});
