/**
 * The writing settings' editor side, against the real Milkdown build: the
 * word count follows the document, and the block holding the caret is the one
 * focus mode leaves undimmed.
 */
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
  attachWritingAids,
  countCharacters,
  countLabel,
  countWords,
  createWordCounter,
} from './writing-aids';

const opened: CrepeBuilder[] = [];

afterEach(async () => {
  for (const editor of opened.splice(0)) await editor.destroy();
});

async function open(source: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new CrepeBuilder({ root: host, defaultValue: source });
  const counter = createWordCounter();
  attachWritingAids(editor, counter);
  await editor.create();
  opened.push(editor);
  return { counter, editor, host };
}

describe('countWords', () => {
  it('counts words, not punctuation or syntax', () => {
    expect(countWords('')).toBe(0);
    expect(countWords("It's a well-known fact — 42 of them, don't you think?")).toBe(10);
    expect(countWords('# Title\n\n- one\n- two **bold**')).toBe(4);
  });

  it('counts each Chinese or Japanese character, which are written without spaces', () => {
    expect(countWords('今天写了三段。')).toBe(6);
    expect(countWords('用 StashBase 写作')).toBe(4);
    expect(countWords('ひらがなとカタカナ')).toBe(9);
  });
});

describe('countCharacters', () => {
  it('counts what a post limit counts: spaces and punctuation, an emoji as one, not breaks', () => {
    expect(countCharacters('')).toBe(0);
    expect(countCharacters('Hi, you!')).toBe(8);
    expect(countCharacters('café 👍')).toBe(6);
    expect(countCharacters('one\ntwo')).toBe(6);
  });
});

describe('countLabel', () => {
  it('names the document, then the selection out of it while text is selected', () => {
    expect(countLabel({ characters: 1, words: 1 }, null)).toBe('1 word · 1 character');
    expect(countLabel({ characters: 12_345, words: 2000 }, null)).toBe(
      `${(2000).toLocaleString()} words · ${(12_345).toLocaleString()} characters`,
    );
    expect(countLabel({ characters: 40, words: 8 }, { characters: 9, words: 2 })).toBe(
      '2 of 8 words · 9 of 40 characters',
    );
  });
});

describe('attachWritingAids', () => {
  it('counts the document at open and after every edit', async () => {
    const { counter, editor } = await open('One two three.\n\nFour.');
    expect(counter.count().document).toEqual({ characters: 19, words: 4 });

    editor.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insertText(' five six', view.state.doc.content.size - 1));
    });
    expect(counter.count().document).toEqual({ characters: 28, words: 6 });
  });

  it('counts the selected text while there is a selection, with one answer per state', async () => {
    const { counter, editor } = await open('One two three.\n\nFour.');
    const before = counter.count();
    expect(before.selection).toBeNull();

    editor.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      // "two three": the first paragraph's text starts at position 1.
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5, 14)));
    });
    expect(counter.count().selection).toEqual({ characters: 9, words: 2 });
    // A stable snapshot for React, and the document is not counted again.
    expect(counter.count()).toBe(counter.count());
    expect(counter.count().document).toBe(before.document);

    editor.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
    });
    expect(counter.count().selection).toBeNull();
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
