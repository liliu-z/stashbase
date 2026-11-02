import { CrepeBuilder } from '@milkdown/crepe/builder';
import { codeMirror } from '@milkdown/crepe/feature/code-mirror';
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core';
import {
  isMarkSelectedCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
} from '@milkdown/kit/preset/commonmark';
import { toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';
import { redo, undo } from '@milkdown/kit/prose/history';
import { TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { math } from './math';

const live: CrepeBuilder[] = [];
afterEach(async () => {
  for (const editor of live.splice(0)) await editor.destroy();
});

async function open(source: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new CrepeBuilder({ root: host, defaultValue: source })
    .addFeature(codeMirror)
    .addFeature(math, false);
  live.push(editor);
  await editor.create();
  const view = editor.editor.action((ctx) => ctx.get(editorViewCtx));
  const commands = editor.editor.action((ctx) => ctx.get(commandsCtx));
  const select = (text: string) => {
    const from = view.state.doc.textContent.indexOf(text) + 1;
    expect(from).toBeGreaterThan(0);
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + text.length)),
    );
  };
  return { editor, view, commands, select, markdown: () => editor.getMarkdown() };
}

describe('formatting protected Markdown prose', () => {
  it.each([
    { source: '**bold**', text: 'bold', mark: 'strong', command: toggleStrongCommand },
    { source: '*italic*', text: 'italic', mark: 'emphasis', command: toggleEmphasisCommand },
    { source: '`code`', text: 'code', mark: 'inlineCode', command: toggleInlineCodeCommand },
    {
      source: '~~removed~~',
      text: 'removed',
      mark: 'strike_through',
      command: toggleStrikethroughCommand,
    },
  ])(
    'toggles existing $mark through the toolbar command with undo and reopen',
    async ({ source, text, mark, command }) => {
      const original = `Cost $5 and $10: ${source}.\n`;
      const { view, commands, select, markdown } = await open(original);
      select(text);
      expect(commands.call(isMarkSelectedCommand.key, view.state.schema.marks[mark])).toBe(true);
      expect(commands.call(command.key)).toBe(true);
      expect(markdown()).toBe(`Cost $5 and $10: ${text}.\n`);
      expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe(
        text,
      );
      expect(commands.call(isMarkSelectedCommand.key, view.state.schema.marks[mark])).toBe(false);
      expect(undo(view.state, view.dispatch)).toBe(true);
      expect(markdown()).toBe(original);
      expect(redo(view.state, view.dispatch)).toBe(true);
      expect(commands.call(command.key)).toBe(true);
      expect(markdown()).toBe(original);
      const reopened = await open(markdown());
      reopened.select(text);
      expect(reopened.commands.call(command.key)).toBe(true);
      expect(reopened.markdown()).toBe(`Cost $5 and $10: ${text}.\n`);
    },
  );

  it('uses the same source-aware command for the bold keyboard shortcut', async () => {
    const { view, select, markdown } = await open('Cost $5 and $10: **bold**.\n');
    select('bold');
    const event = new KeyboardEvent('keydown', {
      key: 'b',
      code: 'KeyB',
      ctrlKey: true,
    });
    expect(view.someProp('handleKeyDown', (handler) => handler(view, event))).toBe(true);
    expect(markdown()).toBe('Cost $5 and $10: bold.\n');
  });

  it.each(['**bold**', '__bold__'])(
    'removes bold only from the selected part of %s',
    async (source) => {
      const { commands, select, markdown } = await open(`Cost $5 and $10: ${source}.\n`);
      select('ol');
      commands.call(toggleStrongCommand.key);
      expect(markdown()).toBe('Cost $5 and $10: **b**ol**d**.\n');
      const reopened = await open(markdown());
      reopened.select('ol');
      expect(
        reopened.commands.call(isMarkSelectedCommand.key, reopened.view.state.schema.marks.strong),
      ).toBe(false);
      reopened.select('b');
      expect(
        reopened.commands.call(isMarkSelectedCommand.key, reopened.view.state.schema.marks.strong),
      ).toBe(true);
    },
  );

  it('keeps the normal stored-mark typing flow at a caret in protected prose', async () => {
    const { view, commands, select, markdown } = await open('Cost $5 and $10 today.\n');
    const position = view.state.doc.textContent.indexOf('today') + 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position)));
    const key = new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true });
    expect(view.someProp('handleKeyDown', (handler) => handler(view, key))).toBe(true);
    for (const character of 'bold') {
      const { from, to } = view.state.selection;
      const handled = view.someProp('handleTextInput', (handler) =>
        handler(view, from, to, character, () => view.state.tr.insertText(character, from, to)),
      );
      if (!handled) view.dispatch(view.state.tr.insertText(character));
    }
    expect(markdown()).toBe('Cost $5 and $10 **bold**today.\n');
    const reopened = await open(markdown());
    expect(reopened.markdown()).toBe(markdown());
    select('bold');
    expect(commands.call(isMarkSelectedCommand.key, view.state.schema.marks.strong)).toBe(true);
    expect(commands.call(toggleStrongCommand.key)).toBe(true);
    expect(markdown()).toBe('Cost $5 and $10 boldtoday.\n');
  });

  it('keeps formerly literal code punctuation literal when removing code', async () => {
    const { view, commands, select, markdown } = await open('Cost $5 and $10: `*word*`.\n');
    select('*word*');
    commands.call(toggleInlineCodeCommand.key);
    expect(markdown()).toBe('Cost $5 and $10: \\*word\\*.\n');
    expect(view.state.selection.anchor).toBeLessThan(view.state.selection.head);
    const reopened = await open(markdown());
    reopened.select('word');
    expect(
      reopened.commands.call(isMarkSelectedCommand.key, reopened.view.state.schema.marks.emphasis),
    ).toBe(false);
  });

  it('removes nested bold without leaving bold on the selection', async () => {
    const { commands, select, markdown } = await open('Cost $5 and $10: **a **bold** c**.\n');
    select('bold');
    commands.call(toggleStrongCommand.key);
    const reopened = await open(markdown());
    reopened.select('bold');
    expect(
      reopened.commands.call(isMarkSelectedCommand.key, reopened.view.state.schema.marks.strong),
    ).toBe(false);
  });

  it('converts decorated bold to code through the existing code command', async () => {
    const { commands, select, markdown } = await open('Cost $5 and $10: **bold**.\n');
    select('bold');
    commands.call(toggleInlineCodeCommand.key);
    expect(markdown()).toBe('Cost $5 and $10: `bold`.\n');
  });

  it('removes existing source bold across a selection ending in an ordinary paragraph', async () => {
    const { view, commands, markdown } = await open(
      'Cost $5 and $10: **bold**.\n\nOrdinary text.\n',
    );
    const from = view.state.doc.child(0).textContent.indexOf('bold') + 1;
    const to = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    commands.call(toggleStrongCommand.key);
    expect(markdown()).toBe('Cost $5 and $10: bold.\n\nOrdinary text.\n');
    commands.call(toggleStrongCommand.key);
    expect(markdown()).toBe('Cost $5 and $10: **bold.**\n\n**Ordinary text.**\n');
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(markdown()).toBe('Cost $5 and $10: bold.\n\nOrdinary text.\n');
  });

  it('preserves the normal command outside a source-backed paragraph', async () => {
    const { commands, select, markdown } = await open('Ordinary bold.\n');
    select('bold');
    expect(commands.call(toggleStrongCommand.key)).toBe(true);
    expect(markdown()).toBe('Ordinary **bold**.\n');
  });
});
