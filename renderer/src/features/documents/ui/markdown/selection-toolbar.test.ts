/**
 * The Heading menu on the selection toolbar, run against the real Milkdown
 * build: it leads the toolbar, opens under its item with the selection's
 * current kind checked, and a choice turns the selected blocks into that kind.
 */
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { TextSelection } from '@milkdown/kit/prose/state';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { selectionToolbar } from './selection-toolbar';

interface Item {
  active: (ctx: Ctx) => boolean;
  icon: string;
  onRun?: (ctx: Ctx) => void;
}

/** A stand-in for Crepe's group builder: Crepe's two default groups, then
 *  whatever the config adds, in the order the toolbar would draw them. */
function buildGroups(config: ReturnType<typeof selectionToolbar>) {
  const groups: Array<{ items: Array<Item & { key: string }>; key: string }> = [];
  const addGroup = (key: string) => {
    const group = { items: [] as Array<Item & { key: string }>, key };
    groups.push(group);
    const instance = {
      addItem: (itemKey: string, item: Item) => {
        group.items.push({ ...item, key: itemKey });
        return instance;
      },
    };
    return instance;
  };
  addGroup('formatting');
  addGroup('function');
  config.buildToolbar?.({ addGroup, build: () => groups } as never);
  return groups;
}

const live: CrepeBuilder[] = [];

afterEach(async () => {
  for (const editor of live.splice(0)) await editor.destroy();
  document.body.replaceChildren();
});

const choose = (name: string) =>
  screen
    .getByRole('menuitemradio', { name })
    .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));

/** A real editor with a toolbar element drawn the way Crepe draws it: the
 *  heading item's content inside a `.toolbar-item` beside the editor view. */
async function openEditor(source: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new CrepeBuilder({ root: host, defaultValue: source });
  live.push(editor);
  await editor.create();
  const [group] = buildGroups(selectionToolbar({}));
  const item = group?.items[0];
  if (!item) throw new Error('heading item missing');
  const toolbar = document.createElement('div');
  toolbar.className = 'milkdown-toolbar';
  toolbar.dataset.show = 'true';
  toolbar.innerHTML = `<button class="toolbar-item">${item.icon}</button>`;
  editor.editor.action((ctx) => ctx.get(editorViewCtx).dom.parentElement?.append(toolbar));
  const act = <T>(run: (ctx: Ctx) => T) => editor.editor.action(run);
  const select = (text: string) =>
    act((ctx) => {
      const view = ctx.get(editorViewCtx);
      let from = -1;
      view.state.doc.descendants((node, position) => {
        if (from < 0 && node.isText && node.text?.includes(text)) {
          from = position + node.text.indexOf(text);
        }
      });
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + text.length)),
      );
    });
  return { act, editor, item, select, toolbar };
}

describe('selection toolbar Heading menu', () => {
  it('leads the toolbar and keeps Humanize and Ask Agent last', () => {
    const groups = buildGroups(
      selectionToolbar({ askAgent: () => undefined, humanize: () => undefined }),
    );
    expect(groups.map((group) => group.key)).toEqual([
      'heading',
      'selection',
      'formatting',
      'function',
    ]);
    expect(groups.flatMap((group) => group.items.map((item) => item.key))).toEqual([
      'heading',
      'humanize',
      'ask-agent',
    ]);
  });

  it('turns the selected paragraph into a heading and back through the menu', async () => {
    const { act, editor, item, select } = await openEditor('Intro line.\n\nBody line.\n');

    select('Intro');
    act((ctx) => item.onRun?.(ctx));
    expect(screen.getByRole('menuitemradio', { checked: true }).textContent).toBe('Text');

    choose('Heading 2');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(editor.getMarkdown()).toBe('## Intro line.\n\nBody line.\n');
    expect(act((ctx) => item.active(ctx))).toBe(false);

    act((ctx) => item.onRun?.(ctx));
    expect(screen.getByRole('menuitemradio', { checked: true }).textContent).toBe('Heading 2');
    choose('Text');
    expect(editor.getMarkdown()).toBe('Intro line.\n\nBody line.\n');
  });

  it('closes on a second press of its item and when the toolbar hides', async () => {
    const { act, item, select, toolbar } = await openEditor('Intro line.\n');
    select('Intro');

    act((ctx) => item.onRun?.(ctx));
    act((ctx) => item.onRun?.(ctx));
    expect(screen.queryByRole('menu')).toBeNull();

    act((ctx) => item.onRun?.(ctx));
    expect(screen.getByRole('menu')).toBeTruthy();
    toolbar.dataset.show = 'false';
    await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });
});
