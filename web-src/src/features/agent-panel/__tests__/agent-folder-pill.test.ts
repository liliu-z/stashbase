import assert from 'node:assert/strict';
import test from 'node:test';
import { agentConnectionUrl } from '@/features/agent-panel/lib/connectionUrl.ts';
import { basename, shortenFolderPath } from '@/common/lib/paths.ts';
import {
  chatScopePill,
  folderMenuLocked,
  isBlankChatTab,
  mentionListingPlan,
  newChatScope,
  nextSessionScope,
  shouldFollowWindowFolder,
  shouldOpenInitialChatOnWindowEntry,
  switchWelcomeTabPlan,
  windowFolderSwitchPlan,
} from '@/features/agent-panel/lib/folderState.ts';
import { blankTabToReuse, newChatPlan } from '@/store/lib/chatTabPlan.ts';
import {
  folderMenuEntries,
  folderScope,
  LIBRARY_SCOPE,
  libraryScopesEqual,
  scopeChangedScope,
  scopeDisplayName,
  scopePillAriaLabel,
  scopeRequestParams,
} from '@/common/lib/libraryScope.ts';

const recent = [
  { path: '/Users/me/Documents/StashBase/Notes', openedAt: '2026-08-01', favorite: false },
  { path: '/Users/me/Projects/Research', openedAt: '2026-08-02', favorite: true },
  { path: '/tmp/scratch', openedAt: '2026-08-03' },
];
const members = recent.map((entry) => entry.path);

test('folder menu lists library membership with favorites pinned and the window folder ensured', () => {
  const entries = folderMenuEntries(recent, '/Users/me/Documents/StashBase/Notes');
  assert.deepEqual(entries.map((entry) => entry.path), [
    '/Users/me/Projects/Research',
    '/Users/me/Documents/StashBase/Notes',
    '/tmp/scratch',
  ]);

  const withMissingCurrent = folderMenuEntries(recent, '/Users/me/Elsewhere');
  assert.equal(withMissingCurrent[0].path, '/Users/me/Elsewhere');
});

test('scope resolution: explicit pick wins, else window folder, else library', () => {
  // No pick → the window's current folder.
  assert.deepEqual(
    nextSessionScope(undefined, '/Users/me/Documents/StashBase/Notes', members),
    folderScope('/Users/me/Documents/StashBase/Notes'),
  );
  // Explicit folder pick wins over the window folder.
  assert.deepEqual(
    nextSessionScope(folderScope('/tmp/scratch'), '/Users/me/Documents/StashBase/Notes', members),
    folderScope('/tmp/scratch'),
  );
  // Explicit Library pick wins even with a folder open.
  assert.deepEqual(
    nextSessionScope(LIBRARY_SCOPE, '/Users/me/Documents/StashBase/Notes', members),
    LIBRARY_SCOPE,
  );
  // No pick, no window folder → library-wide.
  assert.deepEqual(nextSessionScope(undefined, '', members), LIBRARY_SCOPE);
  // A window switch moves the default with it when nothing was picked.
  assert.deepEqual(
    nextSessionScope(undefined, '/Users/me/Projects/Research', members),
    folderScope('/Users/me/Projects/Research'),
  );
  // New Chat entry point resolves the same defaults.
  assert.deepEqual(newChatScope('/tmp/scratch'), folderScope('/tmp/scratch'));
  assert.deepEqual(newChatScope(''), LIBRARY_SCOPE);
});

test('a folder pick that left library membership falls back to the window default', () => {
  assert.deepEqual(
    nextSessionScope(folderScope('/gone/removed-folder'), '/Users/me/Projects/Research', members),
    folderScope('/Users/me/Projects/Research'),
  );
  assert.deepEqual(nextSessionScope(folderScope('/gone/removed-folder'), '', members), LIBRARY_SCOPE);
});

test('a connected session keeps its binding regardless of later window switches', () => {
  const bound = chatScopePill({
    connectedScope: folderScope('/tmp/scratch'),
    picked: undefined,
    windowFolder: '/Users/me/Projects/Research',
    memberPaths: members,
  });
  assert.deepEqual(bound, folderScope('/tmp/scratch'));

  const libraryBound = chatScopePill({
    connectedScope: LIBRARY_SCOPE,
    picked: undefined,
    windowFolder: '/Users/me/Projects/Research',
    memberPaths: members,
  });
  assert.deepEqual(libraryBound, LIBRARY_SCOPE);

  const unbound = chatScopePill({
    connectedScope: null,
    picked: undefined,
    windowFolder: '/Users/me/Projects/Research',
    memberPaths: members,
  });
  assert.deepEqual(unbound, folderScope('/Users/me/Projects/Research'));
});

test('the pill locks once the conversation has content, a turn runs, or the session is resumed', () => {
  assert.equal(folderMenuLocked(false, false, false), false);
  assert.equal(folderMenuLocked(true, false, false), true);
  assert.equal(folderMenuLocked(false, true, false), true);
  assert.equal(folderMenuLocked(false, false, true), true);
});

test('only an unbound, empty, idle, draft-free tab follows a window folder switch', () => {
  const base = {
    connectedScope: folderScope('/tmp/scratch'),
    picked: undefined,
    resumedSession: false,
    hasContent: false,
    turnActive: false,
    hasDraft: false,
    windowFolder: '/Users/me/Projects/Research',
  };
  assert.equal(shouldFollowWindowFolder(base), true);
  assert.equal(windowFolderSwitchPlan(base), 'follow');
  // A library-connected unpicked blank tab follows too once a folder opens.
  assert.equal(windowFolderSwitchPlan({ ...base, connectedScope: LIBRARY_SCOPE }), 'follow');
  // Same folder → nothing to follow.
  assert.equal(windowFolderSwitchPlan({ ...base, windowFolder: '/tmp/scratch' }), 'keep');
  // A conversation with content, a running turn, an explicit pick, or a
  // resumed session never rebinds.
  assert.equal(windowFolderSwitchPlan({ ...base, hasContent: true }), 'keep');
  assert.equal(windowFolderSwitchPlan({ ...base, turnActive: true }), 'keep');
  assert.equal(windowFolderSwitchPlan({ ...base, picked: folderScope('/tmp/scratch') }), 'keep');
  assert.equal(windowFolderSwitchPlan({ ...base, picked: LIBRARY_SCOPE }), 'keep');
  assert.equal(windowFolderSwitchPlan({ ...base, resumedSession: true }), 'keep');
  // No live binding yet, or no window folder → the next connect handles it.
  assert.equal(windowFolderSwitchPlan({ ...base, connectedScope: null }), 'keep');
  assert.equal(windowFolderSwitchPlan({ ...base, windowFolder: '' }), 'keep');
});

test('a draft freezes the tab scope instead of following the window', () => {
  const base = {
    connectedScope: folderScope('/tmp/scratch'),
    picked: undefined,
    resumedSession: false,
    hasContent: false,
    turnActive: false,
    hasDraft: true,
    windowFolder: '/Users/me/Projects/Research',
  };
  // Draft text or attachments: never silently rebind — freeze instead.
  assert.equal(windowFolderSwitchPlan(base), 'freeze');
  assert.equal(shouldFollowWindowFolder(base), false);
  // A drafted library chat freezes at Library the same way.
  assert.equal(windowFolderSwitchPlan({ ...base, connectedScope: LIBRARY_SCOPE }), 'freeze');
  // A draft on an already-matching binding has nothing to freeze.
  assert.equal(windowFolderSwitchPlan({ ...base, windowFolder: '/tmp/scratch' }), 'keep');
});

test('a tab is blank only with no content, turn, resume, pick, draft, or attachments', () => {
  const blank = {
    hasContent: false,
    turnActive: false,
    resumedSession: false,
    picked: undefined,
    hasDraftText: false,
    attachmentCount: 0,
  };
  assert.equal(isBlankChatTab(blank), true);
  assert.equal(isBlankChatTab({ ...blank, hasContent: true }), false);
  assert.equal(isBlankChatTab({ ...blank, turnActive: true }), false);
  assert.equal(isBlankChatTab({ ...blank, resumedSession: true }), false);
  assert.equal(isBlankChatTab({ ...blank, picked: LIBRARY_SCOPE }), false);
  assert.equal(isBlankChatTab({ ...blank, picked: folderScope('/tmp/scratch') }), false);
  // Unsent draft text or attachments are user work — never blank.
  assert.equal(isBlankChatTab({ ...blank, hasDraftText: true }), false);
  assert.equal(isBlankChatTab({ ...blank, attachmentCount: 1 }), false);
});

test('blank-tab reuse prefers the preferred agent and never picks non-blank tabs', () => {
  const tabs = [
    { id: 'a', agent: 'claude', blank: false },
    { id: 'b', agent: 'codex', blank: true },
    { id: 'c', agent: 'claude', blank: true },
  ];
  assert.equal(blankTabToReuse(tabs, 'claude'), 'c');
  assert.equal(blankTabToReuse(tabs, 'codex'), 'b');
  // No blank tab of the preferred agent → any blank tab.
  assert.equal(blankTabToReuse(tabs.filter((tab) => tab.id !== 'c'), 'claude'), 'b');
  // No blank tabs at all → create a new one.
  assert.equal(blankTabToReuse(tabs.filter((tab) => tab.blank !== true), 'claude'), null);
  assert.equal(blankTabToReuse([], 'claude'), null);
});

test('newChatPlan reuses any blank tab, switching its agent when it differs', () => {
  // The preferred agent's own blank tab: plain reuse, no switch.
  assert.deepEqual(
    newChatPlan([
      { id: 'a', agent: 'claude', blank: false },
      { id: 'b', agent: 'claude', blank: true },
    ], 'claude'),
    { kind: 'reuse', id: 'b', switchAgent: false },
  );
  // A blank tab of the OTHER agent is still the reusable welcome tab —
  // its agent switches in place instead of stacking a second empty tab.
  assert.deepEqual(
    newChatPlan([{ id: 'b', agent: 'codex', blank: true }], 'claude'),
    { kind: 'reuse', id: 'b', switchAgent: true },
  );
  // With multiple Agents' blanks present, the requested Agent's wins (no switch).
  assert.deepEqual(
    newChatPlan([
      { id: 'b', agent: 'codex', blank: true },
      { id: 'c', agent: 'claude', blank: true },
    ], 'claude'),
    { kind: 'reuse', id: 'c', switchAgent: false },
  );
});

test('newChatPlan creates a fresh tab when no completely blank tab exists', () => {
  // Content, drafts, attachments, and resumes all clear `blank`
  // (isBlankChatTab) — those tabs are user work, never reused.
  assert.deepEqual(
    newChatPlan([
      { id: 'a', agent: 'claude', blank: false },
      { id: 'b', agent: 'codex', blank: false },
    ], 'claude'),
    { kind: 'new' },
  );
  assert.deepEqual(newChatPlan([], 'codex'), { kind: 'new' });
});

test('mention/attachment scoping follows the session scope', () => {
  // Every folder-bound session gets its own explicit server-filtered listing,
  // so Workbench hidden visibility cannot widen Agent discovery.
  assert.deepEqual(
    mentionListingPlan(folderScope('/tmp/scratch')),
    { kind: 'folder', root: '/tmp/scratch' },
  );
  // Library chats have no single folder listing — mentions disabled.
  assert.deepEqual(mentionListingPlan(LIBRARY_SCOPE), { kind: 'disabled' });
});

test('connection URL carries the scope: folder=<abs> vs scope=library', () => {
  const base = {
    protocol: 'http:',
    host: '127.0.0.1:4989',
    endpoint: '/ws/agent',
    windowId: 'w1',
    access: 'default',
    agent: 'claude',
  };
  const folderUrl = new URL(agentConnectionUrl({ ...base, ...scopeRequestParams(folderScope('/tmp/scratch')) }));
  assert.equal(folderUrl.searchParams.get('folder'), '/tmp/scratch');
  assert.equal(folderUrl.searchParams.get('scope'), null);

  const libraryUrl = new URL(agentConnectionUrl({ ...base, ...scopeRequestParams(LIBRARY_SCOPE) }));
  assert.equal(libraryUrl.searchParams.get('scope'), 'library');
  assert.equal(libraryUrl.searchParams.get('folder'), null);

  // History requests ride the same params.
  assert.deepEqual(scopeRequestParams(folderScope('/tmp/scratch')), { folder: '/tmp/scratch' });
  assert.deepEqual(scopeRequestParams(LIBRARY_SCOPE), { scope: 'library' });
});

test('a server scope-changed event validates into a folder scope, malformed payloads are ignored', () => {
  const project = '/Users/me/Documents/StashBase/New Project';
  assert.deepEqual(scopeChangedScope({ kind: 'folder', path: project }), folderScope(project));
  // Malformed payloads must never corrupt the pill state.
  assert.equal(scopeChangedScope(null), null);
  assert.equal(scopeChangedScope('folder'), null);
  assert.equal(scopeChangedScope({ kind: 'library' }), null);
  assert.equal(scopeChangedScope({ kind: 'folder' }), null);
  assert.equal(scopeChangedScope({ kind: 'folder', path: '' }), null);
  assert.equal(scopeChangedScope({ kind: 'folder', path: '   ' }), null);
  assert.equal(scopeChangedScope({ kind: 'folder', path: 42 }), null);
});

test('create_project rebind: the pill flips from Library to the project and the note clears once the window follows', () => {
  const project = '/Users/me/Documents/StashBase/New Project';
  // Before: a library-scoped chat in a window with no folder selected.
  const before = chatScopePill({ connectedScope: LIBRARY_SCOPE, picked: undefined, windowFolder: '', memberPaths: members });
  assert.deepEqual(before, LIBRARY_SCOPE);
  assert.equal(scopeDisplayName(before), 'Library');

  // The scope-changed event replaces the connected scope with the project.
  const rebound = scopeChangedScope({ kind: 'folder', path: project });
  assert.ok(rebound);
  const after = chatScopePill({ connectedScope: rebound, picked: undefined, windowFolder: '', memberPaths: members });
  assert.deepEqual(after, folderScope(project));
  assert.equal(scopeDisplayName(after), 'New Project');
  // Until the owning window finishes opening the project, the header marks
  // the cross-scope binding; once the sidebar selection lands, it clears.
});

test('scope labels: the library scope is called "Library", never "Global"', () => {
  assert.equal(scopeDisplayName(LIBRARY_SCOPE), 'Library');
  assert.equal(scopeDisplayName(folderScope('/Users/me/Projects/Research')), 'Research');
  assert.equal(basename('/Users/me/Projects/Research'), 'Research');
  assert.equal(shortenFolderPath('/Users/me/Projects/Research', '/Users/me'), '~/Projects/Research');
  assert.equal(shortenFolderPath('/srv/data', '/Users/me'), '/srv/data');
  assert.equal(scopePillAriaLabel(folderScope('/x/Research'), false), 'Session folder: Research');
  assert.equal(
    scopePillAriaLabel(folderScope('/x/Research'), true),
    'Session folder: Research — set for this conversation',
  );
  assert.equal(scopePillAriaLabel(LIBRARY_SCOPE, false), 'Session scope: Library');
});


test('scope equality treats library and folder scopes distinctly', () => {
  assert.equal(libraryScopesEqual(LIBRARY_SCOPE, { kind: 'library' }), true);
  assert.equal(libraryScopesEqual(folderScope('/a'), folderScope('/a')), true);
  assert.equal(libraryScopesEqual(folderScope('/a'), folderScope('/b')), false);
  assert.equal(libraryScopesEqual(folderScope('/a'), LIBRARY_SCOPE), false);
  assert.equal(libraryScopesEqual(undefined, undefined), true);
  assert.equal(libraryScopesEqual(LIBRARY_SCOPE, undefined), false);
});

test('switchWelcomeTabPlan: an active tab already bound to the new folder means no welcome tab', () => {
  const tabs = [
    { id: 't1', agent: 'claude', blank: false, boundFolder: '/lib/proj' },
    { id: 't2', agent: 'claude', blank: true },
  ];
  assert.deepEqual(switchWelcomeTabPlan(tabs, 't1', '/lib/proj', 'claude'), { kind: 'none' });
});

test('a new window opens one blank Chat entry without waiting for a folder', () => {
  assert.equal(shouldOpenInitialChatOnWindowEntry(false, '', 0, null), false);
  assert.equal(shouldOpenInitialChatOnWindowEntry(true, '', 0, null), true);
  assert.equal(shouldOpenInitialChatOnWindowEntry(false, '/lib/proj', 0, null), true);
  assert.equal(shouldOpenInitialChatOnWindowEntry(true, '/lib/proj', 1, null), false);
  // Closing the last tab must not make the entry effect immediately recreate
  // it in the same scope; a later folder entry may open one again.
  assert.equal(shouldOpenInitialChatOnWindowEntry(true, '', 0, ''), false);
  assert.equal(shouldOpenInitialChatOnWindowEntry(true, '', 0, '/lib/proj'), true);
});

test('switchWelcomeTabPlan: otherwise reuse a blank tab, else create', () => {
  const tabs = [
    { id: 't1', agent: 'claude', blank: false, boundFolder: '/lib/other' },
    { id: 't2', agent: 'claude', blank: true },
  ];
  assert.deepEqual(switchWelcomeTabPlan(tabs, 't1', '/lib/proj', 'claude'), { kind: 'activate', id: 't2' });
  assert.deepEqual(
    switchWelcomeTabPlan([{ id: 't1', agent: 'claude', blank: false, boundFolder: '/lib/other' }], 't1', '/lib/proj', 'claude'),
    { kind: 'new' },
  );
});
