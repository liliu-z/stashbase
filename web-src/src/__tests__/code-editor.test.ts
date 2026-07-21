import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { search } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import { applyEditorQuery } from '../components/CodeEditor.tsx';
import {
  describeLiveMarkdownProjection,
  hiddenMarkdownMarkupRanges,
  toggleMarkdownEmphasis,
  toggleMarkdownStrong,
} from '../components/liveMarkdown.ts';

test('restoring an open find query preserves a saved editor selection', () => {
  let state = EditorState.create({
    doc: 'needle alpha needle',
    extensions: [search()],
  });
  state = state.update({ selection: { anchor: 12 } }).state;
  const view = {
    get state() { return state; },
    dispatch(spec: Parameters<EditorState['update']>[0]) {
      state = state.update(spec).state;
    },
  } as unknown as EditorView;

  const result = applyEditorQuery(view, 'needle', false, false, false);

  assert.equal(state.selection.main.anchor, 12);
  assert.deepEqual(result, { current: 0, total: 2 });
});

function markdownState(doc: string, selection?: { anchor: number; head?: number }) {
  return EditorState.create({
    doc,
    selection,
    extensions: [markdown({ base: markdownLanguage }), history()],
  });
}

function testView(state: EditorState) {
  let current = state;
  return {
    get state() { return current; },
    dispatch(spec: Parameters<EditorState['update']>[0]) {
      current = current.update(spec).state;
    },
  } as unknown as EditorView;
}

test('inactive Markdown constructs hide only recognized syntax and reveal every intersected construct', () => {
  const doc = '# Heading *em* **strong** ~~strike~~ `code`\n\n---\n\n**open';
  const inactive = describeLiveMarkdownProjection(markdownState(doc, { anchor: doc.length }));

  assert.deepEqual(
    inactive.map(({ kind, from, to, active }) => ({ kind, from, to, active })),
    [
      { kind: 'heading', from: 0, to: 43, active: false },
      { kind: 'emphasis', from: 10, to: 14, active: false },
      { kind: 'strong', from: 15, to: 25, active: false },
      { kind: 'strikethrough', from: 26, to: 36, active: false },
      { kind: 'inline-code', from: 37, to: 43, active: false },
      { kind: 'horizontal-rule', from: 45, to: 48, active: false },
    ],
  );

  const selected = describeLiveMarkdownProjection(markdownState(doc, { anchor: 12, head: 48 }));
  assert.ok(selected.every(({ active }) => active));
  assert.equal(markdownState(doc, { anchor: doc.length }).doc.toString(), doc);

  const atx = '# Heading\n\nbody';
  assert.deepEqual(hiddenMarkdownMarkupRanges(markdownState(atx, { anchor: atx.length })), [{ from: 0, to: 2 }]);
  const closingAtx = '# Heading #\n\nbody';
  assert.deepEqual(hiddenMarkdownMarkupRanges(markdownState(closingAtx, { anchor: closingAtx.length })), [
    { from: 0, to: 2 },
    { from: 9, to: 11 },
  ]);

  const setext = 'Setext heading\n===\n\nLower\n---';
  assert.deepEqual(
    describeLiveMarkdownProjection(markdownState(setext, { anchor: 19 })),
    [
      { kind: 'heading', from: 0, to: 18, active: false },
      { kind: 'heading', from: 20, to: 29, active: false },
    ],
  );
  assert.deepEqual(hiddenMarkdownMarkupRanges(markdownState(setext, { anchor: 19 })), [
    { from: 14, to: 18 },
    { from: 25, to: 29 },
  ]);
});

test('Markdown strong and emphasis commands wrap, toggle, insert pairs, and undo as one edit', () => {
  const strongView = testView(markdownState('alpha', { anchor: 0, head: 5 }));
  assert.equal(toggleMarkdownStrong(strongView), true);
  assert.equal(strongView.state.doc.toString(), '**alpha**');
  assert.equal(strongView.state.selection.main.from, 2);
  assert.equal(strongView.state.selection.main.to, 7);
  assert.equal(undo(strongView), true);
  assert.equal(strongView.state.doc.toString(), 'alpha');

  const toggleView = testView(markdownState('**alpha**', { anchor: 3, head: 6 }));
  assert.equal(toggleMarkdownStrong(toggleView), true);
  assert.equal(toggleView.state.doc.toString(), 'alpha');
  assert.equal(toggleView.state.selection.main.from, 1);
  assert.equal(toggleView.state.selection.main.to, 4);

  const underscoreView = testView(markdownState('__alpha__', { anchor: 3, head: 6 }));
  assert.equal(toggleMarkdownStrong(underscoreView), true);
  assert.equal(underscoreView.state.doc.toString(), 'alpha');

  const underscoreEmphasisView = testView(markdownState('_alpha_', { anchor: 2, head: 5 }));
  assert.equal(toggleMarkdownEmphasis(underscoreEmphasisView), true);
  assert.equal(underscoreEmphasisView.state.doc.toString(), 'alpha');

  const insertView = testView(markdownState('', { anchor: 0 }));
  assert.equal(toggleMarkdownEmphasis(insertView), true);
  assert.equal(insertView.state.doc.toString(), '**');
  assert.equal(insertView.state.selection.main.anchor, 1);
});
