import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { Window } from 'happy-dom';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { jsonLanguage } from '@codemirror/lang-json';
import {
  createJsonEditor, fromJsonEditorText, jsonTreeHighlightPath, makeJsonTreeFindController,
  textMatches, toJsonEditorText,
} from '../components/JsonDocument';
import { analyzeJsonSource } from '../components/json/sourceModel';
import { directTreeSearchPatch } from '../components/json/JsonTreeView';
import { JsonDocument } from '../components/JsonDocument';
import { AppContext, canApplyExternalTextRefresh, type AppActions } from '../store/AppContext';
import { initialState, makeTab, reducer, type Action, type State } from '../store/state';
import { createRoot } from 'react-dom/client';
import { act, createElement, useCallback, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { useDocumentActions } from '../store/useDocumentActions';
import type { EditorHandle } from '../store/actionTypes';

test('JSON Find supports case and whole-word matching without parsing source', () => {
  const malformed = '{"Alpha": 1, "alpha_beta": 2, "alpha":';
  assert.deepEqual(textMatches(malformed, 'alpha', { caseSensitive: false, wholeWord: false }), [
    { from: 2, to: 7 },
    { from: 14, to: 19 },
    { from: 31, to: 36 },
  ]);
  assert.deepEqual(textMatches(malformed, 'alpha', { caseSensitive: false, wholeWord: true }), [
    { from: 2, to: 7 },
    { from: 31, to: 36 },
  ]);
});

test('JSON tree/editor boundary preserves the source line-ending convention', () => {
  const crlf = '\uFEFF{\r\n  "value": true\r\n}\r\n';
  const editorText = toJsonEditorText(crlf);
  assert.equal(editorText, '\uFEFF{\n  "value": true\n}\n');
  assert.equal(fromJsonEditorText(editorText.replace('true', 'false'), 'crlf'), '\uFEFF{\r\n  "value": false\r\n}\r\n');
  assert.equal(fromJsonEditorText(editorText.replace('true', 'false'), 'cr'), '\uFEFF{\r  "value": false\r}\r');
});

test('JSON Tree Find searches keys and scalar lexemes and exposes the selected path', () => {
  let source = '{"users":[{"name":"Ada"},{"name":"Grace"}],"count":2}';
  let session = { expanded: new Set(['$']), selectedPath: '$' as string | null, search: '', searchOptions: { wholeWord: false, caseSensitive: false } };
  const controller = makeJsonTreeFindController(() => source, () => session, (next) => { session = next; });
  assert.deepEqual(controller.setQuery('grace', { caseSensitive: false, wholeWord: true }), { current: 1, total: 1 });
  assert.equal(session.selectedPath, '$.users[1].name');
  assert.deepEqual(session.searchOptions, { caseSensitive: false, wholeWord: true });
  assert.ok(session.expanded.has('$.users[1]'));
  source = '{"users":[{"name":"Ada"}],"count":2}';
  assert.deepEqual(controller.next(), { current: 0, total: 0 }, 'Find never retains a path removed by a source edit');
  controller.close();
  assert.equal(session.search, '');
});

test('typing in visible Tree search clears hidden global Find modes', () => {
  assert.deepEqual(directTreeSearchPatch(' Alpha '), {
    search: ' Alpha ', selectedPath: null, searchOptions: { caseSensitive: false, wholeWord: false },
  });
});

test('JSON search-result highlights resolve to visible tree paths or request Source fallback', () => {
  const analysis = analyzeJsonSource('{"nested":{"message":"visible highlight"}}');
  assert.equal(jsonTreeHighlightPath(analysis, 'visible highlight'), '$.nested.message');
  assert.equal(jsonTreeHighlightPath(analysis, 'spans unrelated syntax'), null);
});

test('real JSON CodeMirror session handles malformed source, editing, live Find remapping, external refresh, and teardown', async () => {
  const window = new Window({ url: 'http://localhost/' });
  const previous = installDomGlobals(window);
  try {
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    let changes = 0;
    const findUpdates: Array<{ current: number; total: number }> = [];
    const original = '\uFEFF{\r\n  "needle": 1,\r\n  "other": "needle"\r\n';
    const session = createJsonEditor(host as unknown as HTMLElement, {
      content: original,
      readOnly: true,
      onUserChange: () => { changes++; },
      onFindInfo: (info) => { findUpdates.push(info); },
    });

    assert.equal(session.view.state.doc.toString(), original.replace(/\r\n/g, '\n'));
    assert.equal(session.view.state.facet(EditorState.readOnly), true);
    assert.match(jsonLanguage.parser.parse(original).toString(), /⚠/u, 'malformed JSON stays in JSON syntax mode');
    const highlightHost = window.document.createElement('div');
    window.document.body.appendChild(highlightHost);
    const highlighted = createJsonEditor(highlightHost as unknown as HTMLElement, {
      content: '{"property": "string", "boolean": true, "number": 42}', readOnly: true,
      onUserChange: () => undefined, onFindInfo: () => undefined,
    });
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    for (const role of ['property', 'string', 'boolean', 'number', 'punctuation']) {
      assert.ok(
        highlightHost.querySelector(`.cm-json-${role}`),
        `rendered JSON ${role} tokens receive the StashBase highlight class`,
      );
    }
    const invalidHost = window.document.createElement('div');
    window.document.body.appendChild(invalidHost);
    const invalid = createJsonEditor(invalidHost as unknown as HTMLElement, {
      content: '{"bad": tru}', readOnly: true,
      onUserChange: () => undefined, onFindInfo: () => undefined,
    });
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    assert.ok(invalidHost.querySelector('.cm-json-invalid'), 'malformed JSON receives the invalid syntax role');

    const style = window.document.createElement('style');
    style.textContent = fs.readFileSync('web-src/src/styles/globals.css', 'utf8');
    window.document.head.appendChild(style);
    const syntaxRoles = ['property', 'string', 'boolean', 'number', 'punctuation', 'invalid'];
    const light = Object.fromEntries(syntaxRoles.map((role) => [
      role, window.getComputedStyle(window.document.documentElement).getPropertyValue(`--syntax-json-${role}`).trim(),
    ]));
    const lightSurface = window.getComputedStyle(window.document.documentElement).getPropertyValue('--surface-base').trim();
    window.document.documentElement.dataset.theme = 'dark';
    const dark = Object.fromEntries(syntaxRoles.map((role) => [
      role, window.getComputedStyle(window.document.documentElement).getPropertyValue(`--syntax-json-${role}`).trim(),
    ]));
    const darkSurface = window.getComputedStyle(window.document.documentElement).getPropertyValue('--surface-base').trim();
    for (const role of syntaxRoles) {
      assert.ok(light[role], `light theme defines --syntax-json-${role}`);
      assert.ok(dark[role], `dark theme defines --syntax-json-${role}`);
      assert.notEqual(light[role], dark[role], `${role} is calibrated independently for dark theme`);
      assert.ok(contrastRatio(light[role], lightSurface) >= 4.5, `${role} meets AA contrast in light theme`);
      assert.ok(contrastRatio(dark[role], darkSurface) >= 4.5, `${role} meets AA contrast in dark theme`);
    }
    invalid.destroy();
    highlighted.destroy();
    assert.deepEqual(session.find.setQuery('needle', { caseSensitive: true, wholeWord: true }), { current: 1, total: 2 });

    session.setReadOnly(false);
    assert.equal(session.view.state.facet(EditorState.readOnly), false);
    const firstNeedle = session.view.state.doc.toString().indexOf('needle');
    session.view.dispatch({ changes: { from: 0, to: firstNeedle + 'needle'.length, insert: '{"changed"' } });
    await Promise.resolve();
    assert.equal(changes, 1);
    assert.deepEqual(findUpdates.at(-1), { current: 1, total: 1 });
    assert.doesNotThrow(() => session.find.next());
    assert.ok(session.view.state.selection.main.to <= session.view.state.doc.length);

    const diskReplacement = '\uFEFF{\r\n"raw": "still malformed"\r\n';
    session.replaceFromDisk(diskReplacement);
    await Promise.resolve();
    assert.equal(changes, 1, 'external refresh must not become a user edit');
    assert.equal(session.view.state.doc.toString(), diskReplacement.replace(/\r\n/g, '\n'));
    assert.deepEqual(findUpdates.at(-1), { current: 0, total: 0 });

    // Re-delivering identical CRLF disk content must be a no-op: the guard
    // compares in the editor's LF space, so no transaction is dispatched
    // (previously this replaced the whole document on every clean save).
    const stateBeforeIdenticalRefresh = session.view.state;
    session.replaceFromDisk(diskReplacement);
    await Promise.resolve();
    assert.equal(session.view.state, stateBeforeIdenticalRefresh, 'identical disk content dispatches nothing');

    session.destroy();
    assert.equal(host.querySelector('.cm-editor'), null);
  } finally {
    restoreDomGlobals(previous);
    window.close();
  }
});

test('JsonDocument registers editor and Find handlers only while its tab is active and releases them on teardown', async () => {
  const window = new Window({ url: 'http://localhost/' });
  const previous = installDomGlobals(window);
  try {
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    const editors: unknown[] = [];
    const finds: unknown[] = [];
    const actions = {
      scheduleSave: () => undefined,
      registerEditor: (value: unknown) => { editors.push(value); },
      registerFindController: (value: unknown) => { finds.push(value); },
      consumePendingHighlight: () => undefined,
    } as unknown as AppActions;
    const tab = makeTab();
    tab.file = { name: 'data.json', format: 'json', content: '{ malformed' };
    const state = { ...initialState, tabs: [tab], activeTabId: tab.id } as State;
    const root = createRoot(host as unknown as Element);
    const render = async (readOnly: boolean, active: boolean) => {
      await act(async () => {
        root.render(createElement(AppContext.Provider, {
          value: { state, actions, dispatch: () => undefined },
          children: createElement(JsonDocument, {
            tabId: tab.id, content: tab.file!.content, readOnly, active,
          }),
        }));
      });
    };

    await render(true, true);
    const jsonRegion = host.querySelector('.json-document');
    assert.equal(jsonRegion?.getAttribute('role'), 'region');
    assert.equal(jsonRegion?.getAttribute('aria-label'), 'JSON document');
    assert.ok(finds.at(-1), 'active read-only JSON registers Find');
    assert.equal(editors.at(-1), null, 'read-only JSON does not register a save editor');
    await render(false, true);
    assert.ok(editors.at(-1), 'edit mode registers the live CodeMirror value');
    await render(false, false);
    assert.equal(editors.at(-1), null);
    assert.equal(finds.at(-1), null);
    await act(async () => root.unmount());
    assert.equal(editors.at(-1), null);
    assert.equal(finds.at(-1), null);
  } finally {
    restoreDomGlobals(previous);
    window.close();
  }
});

interface PersistenceControl {
  state: { current: State };
  actions: ReturnType<typeof useDocumentActions>;
  dispatch: (action: Action) => void;
  saveTimer: { current: ReturnType<typeof setTimeout> | null };
  runScheduledSave: () => Promise<boolean>;
}

function JsonPersistenceHarness({ control }: { control: { current: PersistenceControl | null } }) {
  const initial = useMemo(() => {
    const tab = makeTab();
    tab.file = {
      name: 'data.json', format: 'json', content: '\uFEFF{\r\n  "value": 1\r\n}\r\n', version: 'v1',
    };
    tab.editMode = true;
    return { ...initialState, folderPath: '/library', tabs: [tab], activeTabId: tab.id } as State;
  }, []);
  const [renderedState, setRenderedState] = useState(initial);
  const state = useRef(renderedState);
  state.current = renderedState;
  const editor = useRef<EditorHandle | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlight = useRef<Promise<boolean> | null>(null);
  const scheduledSave = useRef<(() => void) | null>(null);
  const scheduleAfter = useCallback((callback: () => void) => {
    scheduledSave.current = callback;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }, []);
  const cancelScheduled = useCallback(() => { scheduledSave.current = null; }, []);
  const dispatch = useCallback((action: Action) => {
    const next = reducer(state.current, action);
    state.current = next;
    setRenderedState(next);
  }, []);
  const actions = useDocumentActions(
    { state, editor, saveTimer, saveInFlight },
    {
      loadFiles: async () => [], refreshIndexState: async () => undefined,
      toast: () => 'toast', primeFind: () => undefined,
      askConfirm: async () => true,
      scheduleAfter, cancelScheduled,
    },
    dispatch,
  );
  control.current = {
    state, actions, dispatch, saveTimer,
    runScheduledSave: async () => {
      const pending = scheduledSave.current;
      scheduledSave.current = null;
      pending?.();
      return actions.flushSave();
    },
  };
  const tab = state.current.tabs.find((candidate) => candidate.id === state.current.activeTabId);
  const contextActions = {
    ...actions,
    registerFindController: () => undefined,
  } as unknown as AppActions;
  return createElement(AppContext.Provider, {
    value: { state: renderedState, actions: contextActions, dispatch },
    children: tab?.file ? createElement(JsonDocument, {
      tabId: tab.id, content: tab.file.content, readOnly: !tab.editMode, active: true,
    }) : null,
  });
}

test('mounted JSON uses production dirty, debounce, conflict, in-flight, and close-save actions', async () => {
  const window = new Window({ url: 'http://localhost/' });
  const previous = installDomGlobals(window);
  const originalPutFile = api.putFile;
  const originalGetFile = api.getFile;
  try {
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    const root = createRoot(host as unknown as Element);
    const control: { current: PersistenceControl | null } = { current: null };
    const calls: Array<{ content: string; version?: string }> = [];
    api.putFile = async (_name, content, version) => {
      calls.push({ content, version });
      return { content, version: `v${calls.length + 1}` };
    };
    await act(async () => root.render(createElement(JsonPersistenceHarness, { control })));
    let cm = EditorView.findFromDOM(host.querySelector('.cm-editor') as unknown as HTMLElement);
    let saved = false;
    assert.ok(cm);

    await act(async () => {
      cm!.dispatch({ changes: { from: cm!.state.doc.length - 2, insert: ',\n  "added": true' } });
      await Promise.resolve();
    });
    assert.equal(control.current!.state.current.tabs[0].dirty, true);
    assert.equal(control.current!.state.current.tabs[0].saveStatus.text, 'Unsaved');
    assert.equal(
      canApplyExternalTextRefresh(control.current!.state.current, '/library', 'data.json'),
      false,
      'watcher refresh cannot replace a dirty JSON buffer',
    );
    await act(async () => { saved = await control.current!.runScheduledSave(); });
    assert.equal(saved, true);
    assert.equal(calls.length, 1, 'debounced edit reaches api.putFile');
    assert.equal(calls[0].version, 'v1');
    assert.match(calls[0].content, /^\uFEFF\{/u, 'raw source and BOM reach the API without JSON serialization');
    assert.equal(control.current!.state.current.tabs[0].dirty, false);
    assert.equal(control.current!.state.current.tabs[0].saveStatus.text, 'Saved');

    await act(async () => {
      cm!.dispatch({ changes: { from: cm!.state.doc.length, insert: ' ' } });
      control.current!.dispatch({ type: 'DOCUMENT_DIRTY', dirty: false });
      await Promise.resolve();
      saved = await control.current!.actions.flushSave();
    });
    assert.equal(saved, true);
    assert.equal(calls.length, 2, 'live editor content remains save authority before dirty state commits');
    assert.equal(calls[1].version, 'v2');

    api.putFile = async () => { throw new Error('disk unavailable'); };
    await act(async () => {
      cm!.dispatch({ changes: { from: cm!.state.doc.length, insert: '\n' } });
      await Promise.resolve();
    });
    await act(async () => { saved = await control.current!.actions.flushSave(); });
    assert.equal(saved, false);
    assert.equal(control.current!.state.current.tabs[0].dirty, true);
    assert.match(control.current!.state.current.tabs[0].saveStatus.text, /Save failed: disk unavailable/u);

    let conflictAttempt = 0;
    let rejectConflict!: (reason: unknown) => void;
    const conflictSave = new Promise<never>((_resolve, reject) => { rejectConflict = reject; });
    api.putFile = async (_name, content) => {
      conflictAttempt++;
      if (conflictAttempt === 1) return conflictSave;
      return { content, version: 'after-conflict' };
    };
    api.getFile = async (_name) => {
      return { name: 'data.json', format: 'json', content: '{"disk": true}', version: 'version-disk' };
    };
    let conflictPending!: Promise<boolean>;
    await act(async () => {
      conflictPending = control.current!.actions.flushSave();
      await Promise.resolve();
    });
    const lateConflictEdit = ' typed while conflict request was in flight';
    await act(async () => {
      cm!.dispatch({ changes: { from: cm!.state.doc.length, insert: lateConflictEdit } });
      await Promise.resolve();
    });
    const conflictError = new ApiError('changed on disk', 409, 'FILE_CHANGED');
    await act(async () => {
      rejectConflict(conflictError);
      saved = await conflictPending;
    });
    assert.equal(saved, false);
    assert.equal(conflictAttempt, 1, 'should not retry automatically');
    assert.ok(control.current!.state.current.tabs[0].conflict, 'transitions to conflict state');
    assert.equal(control.current!.state.current.tabs[0].conflict?.diskContent, '{"disk": true}');
    assert.match(
      control.current!.state.current.tabs[0].conflict?.editorContent ?? '',
      new RegExp(lateConflictEdit),
      'the conflict snapshot includes edits typed while the stale save was in flight',
    );
    assert.equal(
      control.current!.state.current.tabs[0].conflict?.diskVersion,
      'version-disk',
      'content and version come from the same post-conflict disk read',
    );

    await act(async () => {
      control.current!.actions.registerEditor(null);
      saved = await control.current!.actions.flushSave();
    });
    assert.equal(saved, false, 'an unresolved conflict blocks context release after the editor unmounts');
    await act(async () => {
      await control.current!.actions.resolveConflictReload(control.current!.state.current.activeTabId!);
      await Promise.resolve();
    });

    let releaseFirst!: (value: { content: string; version: string }) => void;
    const firstSave = new Promise<{ content: string; version: string }>((resolve) => { releaseFirst = resolve; });
    let inFlightCalls = 0;
    api.putFile = async (_name, content) => {
      inFlightCalls++;
      return inFlightCalls === 1 ? firstSave : { content, version: 'after-second-edit' };
    };
    await act(async () => {
      cm!.dispatch({ changes: { from: cm!.state.doc.length, insert: ' ' } });
      await Promise.resolve();
    });
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = control.current!.actions.flushSave();
      await Promise.resolve();
    });
    await act(async () => {
      cm!.dispatch({ changes: { from: cm!.state.doc.length, insert: 'x' } });
      await Promise.resolve();
    });
    let firstSaved = false;
    await act(async () => {
      releaseFirst({ content: '', version: 'first-in-flight' });
      firstSaved = await pending;
    });
    assert.equal(firstSaved, true);
    assert.equal(control.current!.state.current.tabs[0].dirty, true, 'a newer edit survives an older save acknowledgement');
    await act(async () => { saved = await control.current!.actions.flushSave(); });
    assert.equal(saved, true);
    assert.equal(inFlightCalls, 2);

    const firstTabId = control.current!.state.current.activeTabId!;
    await act(async () => {
      control.current!.dispatch({ type: 'NEW_TAB' });
      control.current!.dispatch({
        type: 'FILE_OPEN',
        body: { name: 'other.json', format: 'json', content: '{"other":true}', version: 'other-v1' },
      });
    });
    const secondTabId = control.current!.state.current.activeTabId!;
    await act(async () => { await control.current!.actions.activateTab(firstTabId); });
    cm = EditorView.findFromDOM(host.querySelector('.cm-editor') as unknown as HTMLElement);
    await act(async () => {
      cm!.dispatch({ changes: { from: cm!.state.doc.length, insert: '?' } });
      await Promise.resolve();
    });
    const firstTabSourceBeforeSwitch = cm!.state.doc.toString();
    const callsBeforeSwitch = inFlightCalls;
    await act(async () => { await control.current!.actions.activateTab(secondTabId); });
    assert.equal(inFlightCalls, callsBeforeSwitch + 1, 'tab switching flushes the live JSON editor first');
    assert.equal(control.current!.state.current.activeTabId, secondTabId);
    assert.equal(
      control.current!.state.current.tabs.find((tab) => tab.id === firstTabId)?.file?.content,
      fromJsonEditorText(firstTabSourceBeforeSwitch, 'crlf'),
      'a successful save retains the submitted source for later tab reactivation',
    );
    await act(async () => { await control.current!.actions.activateTab(firstTabId); });
    cm = EditorView.findFromDOM(host.querySelector('.cm-editor') as unknown as HTMLElement);

    await act(async () => {
      cm!.dispatch({ changes: { from: cm!.state.doc.length, insert: '!' } });
      await Promise.resolve();
    });
    await act(async () => { await control.current!.actions.closeTab(control.current!.state.current.tabs[0].id); });
    assert.equal(control.current!.state.current.tabs.length, 1, 'closing waits for the final JSON save');
    assert.equal(control.current!.state.current.tabs[0].id, secondTabId);
    await act(async () => root.unmount());
  } finally {
    api.putFile = originalPutFile;
    api.getFile = originalGetFile;
    restoreDomGlobals(previous);
    window.close();
  }
});

test('conflict resolution callbacks apply correct edits and state transitions', async () => {
  const window = new Window({ url: 'http://localhost/' });
  const previous = installDomGlobals(window);
  const originalPutFile = api.putFile;
  const originalGetFile = api.getFile;
  try {
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    const root = createRoot(host as unknown as Element);
    const control: { current: PersistenceControl | null } = { current: null };
    const calls: Array<{ content: string; version?: string }> = [];
    api.putFile = async (_name, content, version) => {
      calls.push({ content, version });
      return { content, version: 'overwritten-version' };
    };

    await act(async () => {
      root.render(createElement(JsonPersistenceHarness, { control }));
      await Promise.resolve();
    });

    const tabId = control.current!.state.current.activeTabId!;

    control.current!.actions.registerEditor({
      getValue: () => '{"mountNormalized": true}',
      focus: () => undefined,
    });
    let untouchedFlush = false;
    await act(async () => {
      untouchedFlush = await control.current!.actions.flushSave();
    });
    assert.equal(untouchedFlush, true);
    assert.equal(calls.length, 0, 'mount-time editor normalization is not a user edit or save authority');

    // 1. Setup tab conflict state manually in reducer to test resolution callbacks
    await act(async () => {
      control.current!.dispatch({
        type: 'SET_CONFLICT',
        id: tabId,
        conflict: {
          diskContent: '{"disk": true}',
          diskVersion: 'v-disk',
          editorContent: '{"editor": true}',
        },
      });
    });

    // Verify setup
    assert.ok(control.current!.state.current.tabs[0].conflict);

    // 2. Test reload
    await act(async () => {
      await control.current!.actions.resolveConflictReload(tabId);
    });
    assert.equal(control.current!.state.current.tabs[0].conflict, null);
    assert.equal(control.current!.state.current.tabs[0].dirty, false);
    assert.equal(control.current!.state.current.tabs[0].file?.content, '{"disk": true}');
    assert.equal(control.current!.state.current.tabs[0].file?.version, 'v-disk');

    // 3. Reset conflict state and test overwrite
    await act(async () => {
      control.current!.dispatch({
        type: 'SET_CONFLICT',
        id: tabId,
        conflict: {
          diskContent: '{"disk": true}',
          diskVersion: 'v-disk',
          editorContent: '{"editor": true}',
        },
      });
    });

    let finishOverwrite!: (value: { content: string; version: string }) => void;
    const overwriteResult = new Promise<{ content: string; version: string }>((resolve) => {
      finishOverwrite = resolve;
    });
    api.putFile = async (_name, content, version) => {
      calls.push({ content, version });
      return overwriteResult;
    };
    let overwritePending!: Promise<void>;
    await act(async () => {
      overwritePending = control.current!.actions.resolveConflictOverwrite(tabId);
      await Promise.resolve();
    });
    const resolvingConflict = control.current!.state.current.tabs[0].conflict as State['tabs'][number]['conflict'];
    assert.equal(resolvingConflict?.resolving, true);
    await act(async () => {
      await Promise.all([
        control.current!.actions.resolveConflictReload(tabId),
        control.current!.actions.resolveConflictMerge(tabId),
        control.current!.actions.resolveConflictOverwrite(tabId),
        control.current!.actions.closeTab(tabId),
      ]);
    });
    assert.ok(control.current!.state.current.tabs[0].conflict, 'the first decision owns the unresolved UI');
    assert.equal(control.current!.state.current.tabs.length, 1, 'tab discard cannot overtake the owning decision');
    assert.equal(calls.length, 1, 'competing conflict decisions cannot start another disk mutation');
    await act(async () => {
      finishOverwrite({ content: '{"editor": true}', version: 'overwritten-version' });
      await overwritePending;
    });
    assert.equal(control.current!.state.current.tabs[0].conflict, null);
    assert.equal(control.current!.state.current.tabs[0].dirty, false);
    assert.equal(control.current!.state.current.tabs[0].file?.content, '{"editor": true}');
    assert.equal(control.current!.state.current.tabs[0].file?.version, 'overwritten-version');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].version, undefined, 'overwrite uses undefined base version to bypass mismatch checks');

    // 4. A failed owner releases the conflict so another decision can proceed.
    await act(async () => {
      control.current!.dispatch({
        type: 'SET_CONFLICT',
        id: tabId,
        conflict: {
          diskContent: '{"diskAfterFailure": true}',
          diskVersion: 'v-disk-after-failure',
          editorContent: '{"editorAfterFailure": true}',
        },
      });
    });
    api.putFile = async () => { throw new Error('overwrite unavailable'); };
    await act(async () => {
      await control.current!.actions.resolveConflictOverwrite(tabId);
    });
    const failedConflict = control.current!.state.current.tabs[0].conflict as State['tabs'][number]['conflict'];
    assert.ok(failedConflict, 'failed overwrite keeps both versions recoverable');
    assert.equal(failedConflict?.resolving, false, 'failed overwrite releases the decision owner');
    await act(async () => {
      await control.current!.actions.resolveConflictReload(tabId);
    });
    assert.equal(control.current!.state.current.tabs[0].conflict, null, 'a later resolution can claim the conflict');
    assert.equal(control.current!.state.current.tabs[0].file?.content, '{"diskAfterFailure": true}');

    // 5. Reset conflict state and test merge
    await act(async () => {
      control.current!.dispatch({
        type: 'SET_CONFLICT',
        id: tabId,
        conflict: {
          diskContent: 'line1\ndisk\nline3',
          diskVersion: 'v-disk',
          editorContent: 'line1\neditor\nline3',
        },
      });
    });

    await act(async () => {
      await control.current!.actions.resolveConflictMerge(tabId);
    });
    assert.equal(control.current!.state.current.tabs[0].conflict, null);
    assert.equal(control.current!.state.current.tabs[0].dirty, true, 'merged state remains dirty');
    const content: string = control.current!.state.current.tabs[0].file?.content ?? '';
    assert.ok(content.includes('<<<<<<< Editor Version'));
    assert.ok(content.includes('======='));
    assert.ok(content.includes('>>>>>>> Disk Version'));

    api.putFile = async (_name, savedContent, version) => {
      calls.push({ content: savedContent, version });
      return { content: savedContent, version: 'merged-version' };
    };
    control.current!.actions.registerEditor({
      getValue: () => content,
      focus: () => undefined,
    });
    let mergedSaved = false;
    await act(async () => {
      mergedSaved = await control.current!.actions.flushSave();
    });
    assert.equal(mergedSaved, true);
    assert.equal(calls.at(-1)?.content, content, 'merged draft reaches the durable file');
    assert.equal(calls.at(-1)?.version, 'v-disk', 'merge saves against the disk snapshot');

    await act(async () => root.unmount());
  } finally {
    api.putFile = originalPutFile;
    api.getFile = originalGetFile;
    restoreDomGlobals(previous);
    window.close();
  }
});

type DomGlobals = Record<string, PropertyDescriptor | undefined>;

function installDomGlobals(window: Window): DomGlobals {
  const names = ['window', 'document', 'navigator', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous: DomGlobals = {};
  const values: Record<(typeof names)[number], unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of names) {
    previous[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  }
  return previous;
}

function restoreDomGlobals(previous: DomGlobals): void {
  for (const [name, descriptor] of Object.entries(previous)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/.{2}/g)!.map((part) => parseInt(part, 16) / 255);
    const linear = channels.map((channel) => (
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    ));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
