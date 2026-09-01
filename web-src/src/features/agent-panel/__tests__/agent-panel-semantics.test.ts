/**
 * Agent panel accessibility semantics asserted through rendered output.
 * `ChatPane.tsx` is still on a later phase's split list and the transcript
 * now spans several modules, so these mount the surfaces rather than
 * reading their source.
 */
import '@/common/__tests__/domEnvironment';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';
import { appState, mountApp, withDom } from '@/common/__tests__/renderHarness';
import { MessageList } from '@/features/agent-panel/components/AgentMessages';
import ChatPane from '@/features/agent-panel/components/ChatPane';
import { api } from '@/common/api/api';
import { makeChatTab, type Action } from '@/store/state/state';

const originalGetAgentInstructions = api.getAgentInstructions;
test.before(() => {
  api.getAgentInstructions = async (scope) => ({ scope, text: 'Customized guidance', customized: true });
});
test.after(() => {
  api.getAgentInstructions = originalGetAgentInstructions;
});

const emptyList = {
  blocks: [],
  queuedTurns: [],
  turnActive: false,
  turnMeta: {},
  phase: 'live' as const,
  fatal: null,
  fatalRecoveryLabel: 'Retry' as const,
  scopeRetired: null,
  agentKind: 'codex' as const,
  agentShortName: 'Codex',
  onPermission: () => {},
  onSteerQueued: () => {},
  onDeleteQueued: () => {},
  onCopyUserMessage: () => {},
  onResendUserMessage: () => {},
  onRetry: () => {},
  onStartLibraryChat: () => {},
  onOpenArtifact: () => {},
  onTurnFailureAction: () => {},
};

test('a waiting queued turn can be deleted before it is sent', async () => {
  await withDom(async (dom) => {
    const deleted: string[] = [];
    await dom.render(h(MessageList, {
      ...emptyList,
      queuedTurns: [{ id: 'queued-1', text: 'Build a structured Wiki', status: 'waiting' }],
      onDeleteQueued: (id: string) => deleted.push(id),
    }));

    const remove = dom.query('button[aria-label="Delete queued message"]');
    assert.ok(remove, 'a waiting queued turn exposes a delete action');
    await dom.fire(remove, new MouseEvent('click', { bubbles: true }));
    assert.deepEqual(deleted, ['queued-1']);
  });
});

test('chat sessions are a named tab list whose tabs and panels reference each other', async () => {
  const first = { ...makeChatTab('codex', []), title: 'Chat 1' };
  const second = { ...makeChatTab('codex', [first]), title: 'Chat 2' };

  await withDom(async (dom) => {
    const dispatched: Action[] = [];
    await mountApp(dom, h(ChatPane), {
      state: appState({
        workspace: { folderPath: '/Users/me/Projects/Research' },
        chat: { chatOpen: true, chatTabs: [first, second], activeChatTabId: first.id },
      }),
      dispatch: (action) => dispatched.push(action),
    });

    const [tablist] = dom.byRole('tablist');
    assert.ok(tablist, 'the chat strip is a tab list');
    assert.equal(tablist.getAttribute('aria-label'), 'Chat sessions');

    const tabs = dom.byRole('tab');
    assert.equal(tabs.length, 2);
    assert.deepEqual(tabs.map((tab) => tab.getAttribute('aria-selected')), ['true', 'false']);
    // Roving tabindex: one stop for the whole strip.
    assert.deepEqual(tabs.map((tab) => tab.tabIndex), [0, -1]);

    // Every tab must point at its OWN panel, and that panel back at the tab
    // — a shared id would leave a screen reader on the wrong session.
    const panels = dom.byRole('tabpanel');
    assert.equal(panels.length, 2);
    for (const [index, tab] of tabs.entries()) {
      const controlled = tab.getAttribute('aria-controls');
      assert.ok(controlled);
      assert.equal(panels[index].id, controlled);
      assert.equal(panels[index].getAttribute('aria-labelledby'), tab.id);
    }
    assert.notEqual(panels[0].id, panels[1].id, 'chat panels are per session');

    const instructions = dom.query('button[title^="Agent Instructions for "]');
    assert.ok(instructions, 'the active Agent panel exposes persistent Instructions');
    assert.equal(instructions.closest('[role="tablist"]'), null, 'the panel action is not a tab');
    await dom.flush();
    assert.equal(instructions.dataset.customized, 'true');

    await dom.fire(tabs[1], new MouseEvent('click', { bubbles: true }));
    assert.deepEqual(dispatched.at(-1), { type: 'CHAT_TAB_ACTIVATE', id: second.id });
  });
});

test('Library-wide chats do not expose a working-directory Instructions editor', async () => {
  const libraryTab = {
    ...makeChatTab('codex', []),
    title: 'Library Chat',
    boundFolder: null,
  };

  await withDom(async (dom) => {
    await mountApp(dom, h(ChatPane), {
      state: appState({
        workspace: { folderPath: '/Users/me/Projects/Research' },
        chat: { chatOpen: true, chatTabs: [libraryTab], activeChatTabId: libraryTab.id },
      }),
    });

    assert.equal(
      dom.query('button[title^="Agent Instructions for "]'),
      null,
      'Library retrieval scope must not masquerade as a working directory',
    );
  });
});

test('closing a chat tab needs no focusable invisible control', async () => {
  const tab = { ...makeChatTab('codex', []), title: 'Release notes' };
  await withDom(async (dom) => {
    const dispatched: Action[] = [];
    await mountApp(dom, h(ChatPane), {
      state: appState({ chat: { chatOpen: true, chatTabs: [tab], activeChatTabId: tab.id } }),
      dispatch: (action) => dispatched.push(action),
    });

    // The visual × is pointer-only: out of the accessibility tree and out
    // of the tab order, so Tab never lands on an invisible control and the
    // tab carries no interactive descendant (APG tabs pattern).
    const close = dom.query('[title="Close tab"]');
    assert.ok(close, 'the pointer close affordance renders');
    assert.equal(close.getAttribute('aria-hidden'), 'true');
    assert.equal(close.tabIndex, -1);

    // Keyboard close: Delete on the focused tab.
    const [tabEl] = dom.byRole('tab');
    await dom.fire(tabEl, new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    assert.deepEqual(dispatched.at(-1), { type: 'CHAT_TAB_CLOSE', id: tab.id });

    // The pointer path still closes (and never activates on the way).
    await dom.fire(close, new MouseEvent('click', { bubbles: true }));
    assert.deepEqual(dispatched.at(-1), { type: 'CHAT_TAB_CLOSE', id: tab.id });
  });
});

test('the transcript is a polite live log with an accessible name', async () => {
  await withDom(async (dom) => {
    await dom.render(h(MessageList, emptyList));
    const [log] = dom.byRole('log');
    assert.ok(log, 'the transcript announces itself as a log');
    assert.equal(log.getAttribute('aria-label'), 'Agent conversation');
    assert.equal(log.getAttribute('aria-live'), 'polite');
    // Busy rides the one streaming turn (next test), never the whole log —
    // a log-wide busy would hold back every settled announcement too.
    assert.equal(log.getAttribute('aria-busy'), null);
  });
});

test('only the streaming turn is held out of live announcement', async () => {
  const blocks = [
    { kind: 'user' as const, id: 'user-1', text: 'hello' },
    { kind: 'assistant' as const, id: 'assistant-1', text: 'streaming reply' },
  ];
  await withDom(async (dom) => {
    await dom.render(h(MessageList, { ...emptyList, blocks, turnActive: true }));
    assert.equal(dom.byRole('log')[0].getAttribute('aria-busy'), null);
    const busy = dom.queryAll('[aria-busy="true"]');
    assert.equal(busy.length, 1, 'exactly the in-flight turn is busy');
    assert.ok(busy[0].className.includes('agent-turn'), 'busy sits on the turn container');

    // Settling drops the flag, so the finished reply announces once.
    await dom.render(h(MessageList, { ...emptyList, blocks, turnActive: false }));
    assert.equal(dom.queryAll('[aria-busy="true"]').length, 0);
  });
});

test('a non-fatal runtime notice is polite status, not an alert', async () => {
  await withDom(async (dom) => {
    await dom.render(h(MessageList, {
      ...emptyList,
      blocks: [{ kind: 'notice', id: 'notice-1', text: 'Skill descriptions were shortened.' }],
      turnActive: true,
    }));

    const [status] = dom.byRole('status');
    assert.ok(status, 'the notice is exposed as status');
    assert.equal(status.getAttribute('aria-live'), 'polite');
    assert.equal(dom.byRole('alert').length, 0);
  });
});
