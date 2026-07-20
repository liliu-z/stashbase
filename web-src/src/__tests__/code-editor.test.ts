import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState } from '@codemirror/state';
import { search } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import { applyEditorQuery } from '../components/CodeEditor.tsx';

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
