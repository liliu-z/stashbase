/**
 * StashBase's items on Crepe's selection toolbar: a Heading menu followed by
 * Humanize and Ask Agent, all ahead of Crepe's formatting.
 *
 * They are words, not glyphs, in one type style. Crepe's own items are
 * formatting marks every editor draws the same way; the product actions have
 * no self-evident glyphs, and a heading glyph does not say which kinds the
 * menu holds. Crepe takes an item's content as an HTML string, so each word is
 * one span `document.css` gives its width and type; the button Crepe renders
 * has no label of its own, so the word is also the control's accessible name.
 */
import type { ToolbarFeatureConfig } from '@milkdown/crepe/feature/toolbar';
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import {
  headingSchema,
  paragraphSchema,
  setBlockTypeCommand,
} from '@milkdown/kit/preset/commonmark';

/** What each action does when clicked, with the editor's context. An absent
 *  action has no item. */
export interface SelectionActions {
  askAgent?: ((ctx: Ctx) => void) | null | undefined;
  humanize?: (() => void) | undefined;
}

/** Plain text, then the heading levels a writer reaches for; deeper levels
 *  stay in the slash menu. */
const BLOCK_CHOICES = [
  { label: 'Text', level: 0 },
  { label: 'Heading 1', level: 1 },
  { label: 'Heading 2', level: 2 },
  { label: 'Heading 3', level: 3 },
] as const;

const label = (word: string, attributes = '') =>
  `<span class="markdown-toolbar-label"${attributes}>${word}</span>`;

const chevron =
  '<svg class="markdown-toolbar-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

const check =
  '<svg class="markdown-heading-menu-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

/** The block kind every text block in the selection shares: 0 for paragraphs,
 *  the level for headings, or null when they differ or are something else. */
function selectedBlockLevel(ctx: Ctx): number | null {
  const { doc, selection } = ctx.get(editorViewCtx).state;
  const heading = headingSchema.type(ctx);
  const paragraph = paragraphSchema.type(ctx);
  let level: number | null | undefined;
  doc.nodesBetween(selection.from, selection.to, (node) => {
    if (!node.isTextblock) return true;
    const next =
      node.type === heading ? (node.attrs.level as number) : node.type === paragraph ? 0 : null;
    level = level === undefined || level === next ? next : null;
    return false;
  });
  return level ?? null;
}

/** Makes the selected blocks paragraphs (level 0) or headings of `level`. */
function setBlockLevel(ctx: Ctx, level: number) {
  ctx
    .get(commandsCtx)
    .call(
      setBlockTypeCommand.key,
      level === 0
        ? { nodeType: paragraphSchema.type(ctx) }
        : { attrs: { level }, nodeType: headingSchema.type(ctx) },
    );
}

/** Closes the open Heading menu of each editor, keyed by its toolbar. */
const openMenus = new WeakMap<Element, () => void>();

/**
 * Opens the Heading menu under its toolbar item, or closes it when open.
 *
 * Crepe's toolbar draws only buttons, so the menu is a sibling of the toolbar
 * in the same positioned parent, placed under the item. Its rows act on
 * pointerdown and cancel it, as Crepe's items do, so the editor keeps focus
 * and the selection the toolbar belongs to. It closes on a choice, on any
 * press outside it, on a key, and when the toolbar itself hides.
 */
function toggleHeadingMenu(ctx: Ctx) {
  const view = ctx.get(editorViewCtx);
  const parent = view.dom.parentElement;
  const toolbar = parent?.querySelector(':scope > .milkdown-toolbar');
  const trigger = toolbar?.querySelector('[data-heading-menu]')?.closest('.toolbar-item');
  if (!parent || !(toolbar instanceof HTMLElement) || !(trigger instanceof HTMLElement)) return;
  const open = openMenus.get(toolbar);
  if (open) {
    open();
    return;
  }

  const page = parent.ownerDocument;
  const current = selectedBlockLevel(ctx);
  const menu = page.createElement('div');
  menu.className = 'markdown-heading-menu';
  menu.setAttribute('role', 'menu');
  menu.style.left = `${toolbar.offsetLeft + trigger.offsetLeft}px`;
  menu.style.top = `${toolbar.offsetTop + toolbar.offsetHeight + 4}px`;
  for (const choice of BLOCK_CHOICES) {
    const row = page.createElement('button');
    row.type = 'button';
    row.className = 'markdown-heading-menu-item';
    row.setAttribute('role', 'menuitemradio');
    row.setAttribute('aria-checked', String(choice.level === current));
    row.innerHTML = `${label(choice.label)}${choice.level === current ? check : ''}`;
    row.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      close();
      setBlockLevel(ctx, choice.level);
    });
    menu.append(row);
  }

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (target && (menu.contains(target) || trigger.contains(target))) return;
    close();
  };
  const onKeyDown = () => close();
  const hidden = new MutationObserver(() => {
    if (toolbar.dataset.show === 'false' || !toolbar.isConnected) close();
  });
  function close() {
    openMenus.delete(toolbar as HTMLElement);
    menu.remove();
    hidden.disconnect();
    page.removeEventListener('pointerdown', onPointerDown, true);
    page.removeEventListener('keydown', onKeyDown, true);
  }

  openMenus.set(toolbar, close);
  parent.append(menu);
  hidden.observe(toolbar, { attributeFilter: ['data-show'] });
  page.addEventListener('pointerdown', onPointerDown, true);
  page.addEventListener('keydown', onKeyDown, true);
}

/** The toolbar with the Heading menu as its first group and the present
 *  product actions immediately after it, before Crepe's generic formatting. */
export function selectionToolbar({ askAgent, humanize }: SelectionActions): ToolbarFeatureConfig {
  return {
    buildToolbar: (builder) => {
      // The menu shows the current kind itself, so the trigger never wears
      // Crepe's active fill.
      builder.addGroup('heading', 'Heading').addItem('heading', {
        active: () => false,
        icon: `${label('Heading', ' data-heading-menu')}${chevron}`,
        onRun: (ctx) => toggleHeadingMenu(ctx),
      });
      const hasActions = Boolean(askAgent || humanize);
      if (hasActions) {
        const selection = builder.addGroup('selection', 'Selection');
        if (humanize) {
          selection.addItem('humanize', {
            active: () => false,
            icon: label('Humanize'),
            onRun: () => humanize(),
          });
        }
        if (askAgent) {
          selection.addItem('ask-agent', {
            active: () => false,
            icon: label('Ask Agent'),
            onRun: (ctx) => askAgent(ctx),
          });
        }
      }

      // The builder only appends, and `build` hands back its own list. Move
      // StashBase's one or two appended groups to the front so narrow split
      // panes never clip the product actions behind generic formatting marks.
      const groups = builder.build();
      const productGroupCount = hasActions ? 2 : 1;
      groups.unshift(...groups.splice(groups.length - productGroupCount, productGroupCount));
    },
  };
}
