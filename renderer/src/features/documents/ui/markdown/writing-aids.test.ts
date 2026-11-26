/**
 * The writing settings' editor side, against the real Milkdown build: the
 * word count follows the document, and the block holding the caret is the one
 * focus mode leaves undimmed.
 */
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { table } from '@milkdown/crepe/feature/table';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';
import { CellSelection } from '@milkdown/kit/prose/tables';
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
  const editor = new CrepeBuilder({ root: host, defaultValue: source }).addFeature(table);
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
  it('counts each character as it is seen once: spaces and punctuation, not paragraph breaks', () => {
    expect(countCharacters('')).toBe(0);
    expect(countCharacters('Hi, you!')).toBe(8);
    expect(countCharacters('one\ntwo')).toBe(6);
    // A decomposed accent, a family emoji, a flag and a skin tone are each
    // several code points but one character on screen.
    expect(countCharacters('café 👍')).toBe(6);
    expect(countCharacters('👨‍👩‍👧 🇮🇳 👍🏽')).toBe(5);
    // The writer's rule, not a site's: X would count these as 4 and 23.
    expect(countCharacters('你好')).toBe(2);
    expect(countCharacters('https://example.com/a-long-path')).toBe(31);
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

  it('counts every selected table cell when the selection expands around the same head', async () => {
    const { counter, editor } = await open(
      '| alpha | beta gamma |\n| --- | --- |\n| delta | epsilon |',
    );
    editor.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const cells: number[] = [];
      view.state.doc.descendants((node, position) => {
        if (['cell', 'header_cell'].includes(node.type.spec.tableRole)) cells.push(position);
      });
      const select = (anchor: number | undefined, head: number | undefined) => {
        if (anchor === undefined || head === undefined) throw new Error('Table cell not found');
        view.dispatch(
          view.state.tr.setSelection(CellSelection.create(view.state.doc, anchor, head)),
        );
      };
      select(cells[1], cells[1]);
      expect(counter.count().selection).toEqual({ characters: 10, words: 2 });
      let updates = 0;
      const unsubscribe = counter.subscribe(() => {
        updates += 1;
      });
      select(cells[0], cells[1]);
      expect(counter.count().selection).toEqual({ characters: 15, words: 3 });
      expect(updates).toBe(1);
      select(cells[1], cells[3]);
      expect(counter.count().selection).toEqual({ characters: 17, words: 3 });
      unsubscribe();
    });
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
