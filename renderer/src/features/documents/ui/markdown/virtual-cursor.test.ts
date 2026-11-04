import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { EditorView } from '@milkdown/kit/prose/view';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { createVirtualCursor } from './virtual-cursor';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0] },
    text: {},
  },
  marks: { strong: { toDOM: () => ['strong', 0] } },
});

const views: EditorView[] = [];

/** "ab" in bold followed by "cd", caret at the end of the bold run. */
function boldEdgeView() {
  const strong = schema.mark('strong');
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('ab', [strong]), schema.text('cd')]),
  ]);
  const host = document.createElement('div');
  document.body.append(host);
  const view = new EditorView(host, {
    state: EditorState.create({
      doc,
      plugins: [createVirtualCursor()],
      selection: TextSelection.create(doc, 3),
    }),
  });
  views.push(view);
  return view;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe('virtual cursor', () => {
  it('steps out of a mark with → before moving the caret', () => {
    const view = boldEdgeView();
    const press = (key: string) =>
      view.someProp('handleKeyDown', (handle) =>
        handle(view, new KeyboardEvent('keydown', { key })),
      );

    expect(view.state.storedMarks ?? view.state.selection.$head.marks()).toHaveLength(1);
    expect(press('ArrowRight')).toBe(true);
    expect(view.state.selection.head).toBe(3);
    expect(view.state.storedMarks).toEqual([]);
    expect(press('ArrowLeft')).toBe(true);
    expect(view.state.storedMarks).toHaveLength(1);
  });

  it('does not measure the editor while the selection is elsewhere in the window', () => {
    const view = boldEdgeView();
    const measure = vi.spyOn(view.dom, 'getBoundingClientRect');
    const chat = document.createElement('div');
    chat.textContent = 'chat';
    document.body.append(chat);

    document.getSelection()?.selectAllChildren(chat);
    document.dispatchEvent(new Event('selectionchange'));
    view.dispatch(view.state.tr.insertText('!', 5));
    expect(measure).not.toHaveBeenCalled();

    document.getSelection()?.collapse(view.dom.querySelector('strong')?.firstChild ?? null, 2);
    document.dispatchEvent(new Event('selectionchange'));
    expect(measure).toHaveBeenCalled();
  });
});
