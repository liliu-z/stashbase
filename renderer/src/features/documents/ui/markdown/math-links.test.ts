import { CrepeBuilder } from '@milkdown/crepe/builder';
import { codeMirror } from '@milkdown/crepe/feature/code-mirror';
import { linkTooltip } from '@milkdown/crepe/feature/link-tooltip';
import { linkTooltipAPI, toggleLinkCommand } from '@milkdown/kit/component/link-tooltip';
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core';
import { isMarkSelectedCommand, updateLinkCommand } from '@milkdown/kit/preset/commonmark';
import { redo, undo } from '@milkdown/kit/prose/history';
import { TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { watchMarkdownChanges } from './changes';
import { math } from './math';

const live: CrepeBuilder[] = [];
afterEach(async () => {
  for (const editor of live.splice(0)) await editor.destroy();
});

async function open(source: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new CrepeBuilder({ root: host, defaultValue: source })
    .addFeature(linkTooltip)
    .addFeature(codeMirror)
    .addFeature(math, false);
  const saved: string[] = [];
  const changes = watchMarkdownChanges(editor, {
    accepts: () => true,
    report: (value) => saved.push(value),
  });
  live.push(editor);
  await editor.create();
  changes.rebase(source);
  const context = editor.editor.action((ctx) => ctx);
  const view = context.get(editorViewCtx);
  const commands = context.get(commandsCtx);
  const select = (text: string) => {
    const from = view.state.doc.textContent.indexOf(text) + 1;
    expect(from).toBeGreaterThan(0);
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + text.length)),
    );
  };
  return {
    host,
    view,
    commands,
    select,
    changes,
    saved,
    api: context.get(linkTooltipAPI.key),
    markdown: () => editor.getMarkdown(),
  };
}

async function confirm(href: string) {
  // dom-contract: exercise the shipped Milkdown link editor, whose input and
  // confirmation are the existing user action rather than a test substitute.
  const input = document.querySelector<HTMLInputElement>('.milkdown-link-edit input'); // dom-contract: the shipped Milkdown tooltip owns this control.
  if (!input) throw new Error('Expected the existing link editor');
  input.value = href;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await Promise.resolve();
}

describe('editing links in protected prose', () => {
  it('updates the existing destination through the standard command with undo and reopen', async () => {
    const source = 'Cost $5 and $10: [**guide**](old.md "Guide").\n';
    const { commands, select, markdown, view } = await open(source);
    select('guide');
    expect(commands.call(isMarkSelectedCommand.key, view.state.schema.marks.link)).toBe(true);
    expect(commands.call(updateLinkCommand.key, { href: 'new guide.md#part' })).toBe(true);
    expect(markdown()).toBe('Cost $5 and $10: [**guide**](<new guide.md#part> "Guide").\n');
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(markdown()).toBe(source);
    expect(redo(view.state, view.dispatch)).toBe(true);
    const reopened = await open(markdown());
    expect(reopened.host.querySelector('a')?.getAttribute('href')).toBe('new guide.md#part'); // dom-contract: the source link must expose the native navigation target.
  });

  it('opens the existing hover editor and replaces the raw target on confirmation', async () => {
    const source = 'Cost $5 and $10: [guide](old.md).\n';
    const { host, view, markdown, api } = await open(source);
    const edit = vi.spyOn(api, 'editLink');
    view.focus();
    const anchor = host.querySelector('a'); // dom-contract: the source link must expose the native navigation target.
    if (!anchor) throw new Error('Expected the source-backed link');
    anchor.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    await vi.waitFor(() => {
      const preview = document.querySelector('.milkdown-link-preview .link-display'); // dom-contract: the shipped Milkdown tooltip owns this display.
      expect(preview?.textContent).toBe('old.md');
    });
    document
      .querySelector('.milkdown-link-preview .link-edit-button') // dom-contract: the shipped Milkdown tooltip owns this control.
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(edit).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLInputElement>('.milkdown-link-edit input')?.value).toBe(
        // dom-contract: the shipped Milkdown tooltip owns this control.
        'old.md',
      ),
    );
    await confirm('new.md');
    expect(markdown()).toBe('Cost $5 and $10: [guide](new.md).\n');
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(markdown()).toBe(source);
  });

  it('edits a reference target locally and preserves definitions through the save boundary', async () => {
    const source = 'Cost $5 and $10: [guide][manual].\n\n[manual]: old.md "Guide"\n';
    const { select, commands, changes, saved } = await open(source);
    select('guide');
    commands.call(updateLinkCommand.key, { href: 'new.md' });
    changes.flush();
    expect(saved.at(-1)).toBe(
      'Cost $5 and $10: [guide](new.md "Guide").\n\n[manual]: old.md "Guide"\n',
    );
  });

  it('uses the current add and remove actions without nesting raw link syntax', async () => {
    const { select, commands, view, markdown } = await open('Cost $5 and $10: guide.\n');
    select('guide');
    commands.call(toggleLinkCommand.key);
    await confirm('guide.md');
    expect(markdown()).toBe('Cost $5 and $10: [guide](guide.md).\n');
    select('guide');
    commands.call(toggleLinkCommand.key);
    expect(markdown()).toBe('Cost $5 and $10: guide.\n');
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(markdown()).toBe('Cost $5 and $10: [guide](guide.md).\n');
  });

  it('retains native link commands in ordinary paragraphs', async () => {
    const { select, commands, markdown } = await open('Ordinary [guide](old.md).\n');
    select('guide');
    commands.call(updateLinkCommand.key, { href: 'new.md' });
    expect(markdown()).toBe('Ordinary [guide](new.md).\n');
  });

  it.each([
    { selected: 'guide](old.md) and note', result: '[guide and note](new.md)' },
    { selected: 'ide](old.md) and note', result: '[gu](old.md)[ide and note](new.md)' },
  ])(
    'applies a new link across existing source and prose: $selected',
    async ({ selected, result }) => {
      const source = 'Cost $5 and $10: [guide](old.md) and note.\n';
      const { select, commands, markdown, view } = await open(source);
      select(selected);
      commands.call(toggleLinkCommand.key);
      await confirm('new.md');
      expect(markdown()).toBe(`Cost $5 and $10: ${result}.\n`);
      const reopened = await open(markdown());
      const anchor = reopened.host.querySelector('a[href="new.md"]'); // dom-contract: the source link must expose the native navigation target.
      expect(anchor?.textContent).toBe(
        selected.startsWith('guide') ? 'guide and note' : 'ide and note',
      );
      expect(undo(view.state, view.dispatch)).toBe(true);
      expect(markdown()).toBe(source);
    },
  );
});
