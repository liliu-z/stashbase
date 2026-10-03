/**
 * The writing settings' editor side, against the real Milkdown build: the
 * word count follows the document, and the block holding the caret is the one
 * focus mode leaves undimmed.
 */
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { attachWritingAids, countWords } from './writing-aids';

const opened: CrepeBuilder[] = [];

afterEach(async () => {
  for (const editor of opened.splice(0)) await editor.destroy();
});

async function open(source: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new CrepeBuilder({ root: host, defaultValue: source });
  const counts: number[] = [];
  attachWritingAids(editor, (count) => counts.push(count));
  await editor.create();
  opened.push(editor);
  return { counts, editor, host };
}

describe('countWords', () => {
  it('counts words, not punctuation or syntax', () => {
    expect(countWords('')).toBe(0);
    expect(countWords("It's a well-known fact — 42 of them, don't you think?")).toBe(10);
    expect(countWords('# Title\n\n- one\n- two **bold**')).toBe(4);
  });
});

describe('attachWritingAids', () => {
  it('reports the count at open and after every edit', async () => {
    const { counts, editor } = await open('One two three.\n\nFour.');
    expect(counts.at(-1)).toBe(4);

    editor.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insertText(' five six', view.state.doc.content.size - 1));
    });
    expect(counts.at(-1)).toBe(6);
  });

  it('marks only the block that holds the caret', async () => {
    const { editor, host } = await open('First paragraph.\n\nSecond paragraph.');
    editor.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const inSecond = view.state.doc.content.size - 3;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, inSecond)));
    });

    const marked = host.querySelectorAll('.ProseMirror > .is-current-block'); // dom-contract: focus mode's stylesheet keys on this class
    expect([...marked].map((block) => block.textContent)).toEqual(['Second paragraph.']);
  });
});
