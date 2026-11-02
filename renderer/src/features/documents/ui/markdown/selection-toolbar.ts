/**
 * StashBase's items on Crepe's selection toolbar: a Heading menu ahead of
 * Crepe's formatting, and Ask Agent after it.
 *
 * They are words, not glyphs, in one type style. Crepe's own items are
 * formatting marks every editor draws the same way; Ask Agent is a product
 * action with no self-evident glyph, and a heading glyph does not say which
 * kinds the menu holds. Crepe takes an item's content as an HTML string, so each word is
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

/** A stroked glyph from Lucide, the app's own icon set. */
function glyph(body: string, className?: string): string {
  const named = className === undefined ? '' : ` class="${className}"`;
  return `<svg${named} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** Crepe uses the icon as the button's entire content. */
const actionGlyph = (name: string, body: string) =>
  `${glyph(body)}<span class="sr-only">${name}</span>`;

/** Lucide's bold, italic, strikethrough, code, link and sigma in place of
 *  Crepe's filled glyphs, which read heavy beside every other control. */
const GLYPHS = {
  boldIcon: actionGlyph(
    'Bold',
    '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
  ),
  codeIcon: actionGlyph('Code', '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>'),
  italicIcon: actionGlyph(
    'Italic',
    '<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
  ),
  latexIcon: actionGlyph(
    'Formula',
    '<path d="M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2"/>',
  ),
  linkIcon: actionGlyph(
    'Link',
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  ),
  strikethroughIcon: actionGlyph(
    'Strikethrough',
    '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/>',
  ),
};

const chevron = glyph('<path d="m6 9 6 6 6-6"/>', 'markdown-toolbar-chevron');

const check = glyph('<path d="M20 6 9 17l-5-5"/>', 'markdown-heading-menu-check');

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

/** The toolbar with the Heading menu as its first group and Ask Agent, when
 *  present, as its last. */
export function selectionToolbar({ askAgent }: SelectionActions): ToolbarFeatureConfig {
  return {
    ...GLYPHS,
    buildToolbar: (builder) => {
      // The menu shows the current kind itself, so the trigger never wears
      // Crepe's active fill.
      builder.addGroup('heading', 'Heading').addItem('heading', {
        active: () => false,
        icon: `${label('Heading', ' data-heading-menu')}${chevron}`,
        onRun: (ctx) => toggleHeadingMenu(ctx),
      });
      // The builder only appends, and `build` hands back its own list, so the
      // heading group moves ahead of Crepe's formatting marks there.
      const groups = builder.build();
      groups.unshift(...groups.splice(groups.length - 1, 1));

      if (!askAgent) return;
      builder.addGroup('selection', 'Selection').addItem('ask-agent', {
        active: () => false,
        icon: label('Ask agent'),
        onRun: (ctx) => askAgent(ctx),
      });
    },
  };
}
