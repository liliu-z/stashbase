import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { EditorState } from '@codemirror/state';
import {
  createCsvEditor,
  fromCsvEditorText,
  makeCsvTableFindController,
  textMatches,
  toCsvEditorText,
} from '../components/CsvDocument';

test('CSV Find supports case and whole-word matching without parsing source', () => {
  const malformed = 'name,score\nAlpha,10\nalpha_beta,20\nalpha,30';
  assert.deepEqual(textMatches(malformed, 'alpha', { caseSensitive: false, wholeWord: false }), [
    { from: 11, to: 16 },
    { from: 20, to: 25 },
    { from: 34, to: 39 },
  ]);
  assert.deepEqual(textMatches(malformed, 'alpha', { caseSensitive: false, wholeWord: true }), [
    { from: 11, to: 16 },
    { from: 34, to: 39 },
  ]);
});

test('CSV editor boundary preserves the source line-ending convention', () => {
  const crlf = '\uFEFFname,score\r\nAlice,100\r\n';
  const editorText = toCsvEditorText(crlf);
  assert.equal(editorText, '\uFEFFname,score\nAlice,100\n');
  assert.equal(fromCsvEditorText(editorText.replace('100', '105'), '\r\n'), '\uFEFFname,score\r\nAlice,105\r\n');
  assert.equal(fromCsvEditorText(editorText.replace('100', '105'), '\r'), '\uFEFFname,score\rAlice,105\r');
});

test('CSV Table Find searches cells and exposes the selected cell coordinates', () => {
  let source = 'name,city\nAlice,Paris\nBob,London';
  let session: import('../components/csv/CsvTableView').CsvTableSessionState = { selectedCell: undefined };
  const controller = makeCsvTableFindController(() => source, () => session, (next) => { session = next; });

  assert.deepEqual(controller.setQuery('London', { caseSensitive: false, wholeWord: true }), { current: 1, total: 1 });
  assert.deepEqual(session.selectedCell, [1, 2]);

  source = 'name,city\nAlice,Paris\nBob,Berlin';
  assert.deepEqual(controller.next(), { current: 0, total: 0 }, 'Find updates when cells change');
  controller.close();
  assert.equal(session.selectedCell, undefined);
});

test('real CSV CodeMirror session handles source editing, readOnly toggling, and teardown', async () => {
  const window = new Window({ url: 'http://localhost/' });
  const previous = installDomGlobals(window);
  try {
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    let changes = 0;
    const findUpdates: Array<{ current: number; total: number }> = [];
    const original = '\uFEFFname,score\r\nAlice,100\r\nBob,95\r\n';

    const session = createCsvEditor(host as unknown as HTMLElement, {
      content: original,
      readOnly: true,
      onUserChange: () => { changes++; },
      onFindInfo: (info) => { findUpdates.push(info); },
    });

    assert.equal(session.view.state.doc.toString(), original.replace(/\r\n/g, '\n'));
    assert.equal(session.view.state.facet(EditorState.readOnly), true);

    session.setReadOnly(false);
    assert.equal(session.view.state.facet(EditorState.readOnly), false);

    session.destroy();
  } finally {
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
