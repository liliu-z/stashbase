import type { CrepeBuilder } from '@milkdown/crepe/builder';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import { Plugin, type EditorState } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

import { appliedAppearance, useAppliedAppearance } from '@/shared/runtime/appearance-surface';

/** Words as a reader counts them: runs of letters, digits, and joiners, so
 *  punctuation and Markdown syntax add nothing. */
export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
}

function documentWords(doc: ProseMirrorNode): number {
  return countWords(doc.textBetween(0, doc.content.size, ' ', ' '));
}

/** The top-level block the caret is in, marked for focus mode's dimming. */
function currentBlock(state: EditorState): DecorationSet {
  const { $head } = state.selection;
  if ($head.depth < 1) return DecorationSet.empty;
  const from = $head.before(1);
  const node = state.doc.nodeAt(from);
  if (!node) return DecorationSet.empty;
  return DecorationSet.create(state.doc, [
    Decoration.node(from, from + node.nodeSize, { class: 'is-current-block' }),
  ]);
}

/** Holds the caret's line at the middle of the scroller while typing. */
function centerCaret(view: EditorView): void {
  const scroller = view.dom.closest<HTMLElement>('.milkdown');
  if (!scroller) return;
  const caret = view.coordsAtPos(view.state.selection.head);
  const frame = scroller.getBoundingClientRect();
  const offset = (caret.top + caret.bottom) / 2 - (frame.top + frame.height / 2);
  if (Math.abs(offset) > 2) scroller.scrollBy({ top: offset });
}

/**
 * The editor's side of three writing settings. The current-block mark is
 * always kept so focus mode is a stylesheet switch; the caret is centered only
 * while typewriter scrolling is on, asked at each move so the setting applies
 * without rebuilding the editor; and the word count is reported on every
 * document change for the surface to show or not.
 */
export function attachWritingAids(
  editor: CrepeBuilder,
  onWordCount: (count: number) => void,
): void {
  editor.editor.use(
    $prose(
      () =>
        new Plugin({
          props: { decorations: currentBlock },
          view: (view) => {
            onWordCount(documentWords(view.state.doc));
            return {
              update(next, previous) {
                const edited = !previous.doc.eq(next.state.doc);
                if (edited) onWordCount(documentWords(next.state.doc));
                const moved = edited || !previous.selection.eq(next.state.selection);
                if (moved && next.hasFocus() && appliedAppearance()?.typewriterScrolling) {
                  centerCaret(next);
                }
              },
            };
          },
        }),
    ),
  );
}

/** The document's word count in the corner, while the reader has it on. */
export function WordCount({ count }: { count: number }) {
  if (!useAppliedAppearance()?.wordCount) return null;
  return (
    <div className="markdown-word-count">
      {count === 1 ? '1 word' : `${count.toLocaleString()} words`}
    </div>
  );
}
