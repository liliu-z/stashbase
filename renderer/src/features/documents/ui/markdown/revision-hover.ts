/**
 * Which change the pointer is on.
 *
 * A change and its Undo/Keep card are two separate widgets, and a
 * deletion that spans several paragraphs marks every one of them while the
 * card follows the last. CSS can only reach the element directly before the
 * card, so hovering any earlier paragraph of such a change revealed nothing
 * and the controls looked broken. This walks the run instead and marks the
 * one card the pointer's change owns. The stylesheet reads the attribute;
 * nothing here decides how a marked card looks.
 */
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';

const HOVER_ATTRIBUTE = 'data-revision-hover';
const CONTROLS = '.milkdown-diff-controls';
const CONTROLS_BLOCK = '.milkdown-diff-controls-block';
/** Every element the diff plugin draws for a change itself. A block-level
 *  insertion carries both its own class and the inline one. */
const CHANGE = [
  '.milkdown-diff-added',
  '.milkdown-diff-removed',
  '.milkdown-diff-added-block',
  '.milkdown-diff-removed-block',
].join(',');

const hoverKey = new PluginKey('STASHBASE_REVISION_HOVER');

/**
 * The card belonging to the change under `element`, or null when it is on no
 * change at all. Pointing at a card answers that card, so moving onto one
 * keeps it up.
 *
 * The card sits in one of three places, and the plugin renders whichever the
 * change's shape calls for. A deleted paragraph is followed by its card. A
 * replaced block is followed by the proposed block and then the card. A list
 * with one item deleted marks the whole list and puts the card inside it,
 * which is the shape that made deletions look broken while insertions worked.
 */
export function revisionCardFor(element: Element): HTMLElement | null {
  const card = element.closest<HTMLElement>(CONTROLS);
  if (card) return card;
  const change = element.closest<HTMLElement>(CHANGE);
  if (!change) return null;
  const inside =
    change.querySelector<HTMLElement>(CONTROLS_BLOCK) ??
    change.querySelector<HTMLElement>(CONTROLS);
  if (inside) return inside;
  for (let next = change.nextElementSibling; next; next = next.nextElementSibling) {
    if (next.matches(CONTROLS)) return next as HTMLElement;
    // The run ends at the first element that is not part of this change, so a
    // paragraph between two changes never hands over the wrong card.
    if (!next.matches(CHANGE)) return null;
    const nested = next.querySelector<HTMLElement>(CONTROLS);
    if (nested) return nested;
  }
  return null;
}

export function revisionHoverPlugin() {
  return $prose(
    () =>
      new Plugin({
        key: hoverKey,
        view: (view) => {
          let marked: HTMLElement | null = null;
          let pointer: { x: number; y: number } | null = null;
          const mark = (card: HTMLElement | null) => {
            // Re-marks the same card when a widget rebuild dropped the
            // attribute off the node the view replaced.
            if (card === marked && (card === null || card.hasAttribute(HOVER_ATTRIBUTE))) return;
            marked?.removeAttribute(HOVER_ATTRIBUTE);
            card?.setAttribute(HOVER_ATTRIBUTE, '');
            marked = card;
          };
          // Resolved from where the pointer is rather than from the element an
          // event carried. The plugin rebuilds its widgets on any transaction,
          // and a card marked before that rebuild is a node the view has since
          // thrown away, so the card under a still pointer would vanish and
          // only come back when the reader moved the mouse.
          const resolve = () => {
            if (!pointer) return mark(null);
            const under = view.dom.ownerDocument.elementFromPoint(pointer.x, pointer.y);
            mark(under && view.dom.contains(under) ? revisionCardFor(under) : null);
          };
          const onMove = (event: MouseEvent) => {
            pointer = { x: event.clientX, y: event.clientY };
            resolve();
          };
          const onLeave = () => {
            pointer = null;
            mark(null);
          };
          view.dom.addEventListener('mousemove', onMove);
          view.dom.addEventListener('mouseleave', onLeave);
          return {
            update: resolve,
            destroy: () => {
              view.dom.removeEventListener('mousemove', onMove);
              view.dom.removeEventListener('mouseleave', onLeave);
              mark(null);
            },
          };
        },
      }),
  );
}
