import type { CrepeBuilder } from '@milkdown/crepe/builder';
import { inlineCodeAttr } from '@milkdown/kit/preset/commonmark';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import { Plugin, type EditorState } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { useSyncExternalStore } from 'react';

import { appliedAppearance, useAppliedAppearance } from '@/shared/runtime/appearance-surface';

/** Chinese and Japanese are written without spaces, so each ideograph or
 *  kana counts as one, as word processors count them. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;

/** Words as a reader counts them: runs of letters, digits, and joiners, so
 *  punctuation and Markdown syntax add nothing. */
export function countWords(text: string): number {
  const unspaced = text.match(UNSPACED)?.length ?? 0;
  const spaced = text.replace(UNSPACED, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
  return unspaced + (spaced?.length ?? 0);
}

/** Characters as a post limit counts them: every letter, digit, space and
 *  mark of punctuation, with an emoji or accented letter as one, but not the
 *  breaks between paragraphs. */
export function countCharacters(text: string): number {
  let count = 0;
  for (const character of text) if (character !== '\n') count += 1;
  return count;
}

export interface TextCount {
  characters: number;
  words: number;
}

/** The document's counts, and the selection's while text is selected. */
export interface WritingCount {
  document: TextCount;
  selection: TextCount | null;
}

const EMPTY: WritingCount = { document: { characters: 0, words: 0 }, selection: null };

function countBetween(doc: ProseMirrorNode, from: number, to: number): TextCount {
  // Blocks are joined by a break, so a word never runs across two
  // paragraphs and the break itself is not counted as a character.
  const text = doc.textBetween(from, to, '\n', '\n');
  return { characters: countCharacters(text), words: countWords(text) };
}

/**
 * The document's word and character counts, counted only while something
 * reads them. The editor hands over each new document and selection;
 * counting waits for the visible count to ask, so a hidden count costs
 * nothing and a shown one re-renders only itself.
 */
export interface WordCounter {
  update(doc: ProseMirrorNode, selection?: { from: number; to: number }): void;
  subscribe(listener: () => void): () => void;
  count(): WritingCount;
}

interface TextRange {
  from: number;
  to: number;
}

export function createWordCounter(): WordCounter {
  let doc: ProseMirrorNode | null = null;
  let selected: TextRange | null = null;
  let counted: { doc: ProseMirrorNode; total: TextCount } | null = null;
  let snapshot: { doc: ProseMirrorNode | null; selected: TextRange | null; value: WritingCount } = {
    doc: null,
    selected: null,
    value: EMPTY,
  };
  const listeners = new Set<() => void>();
  return {
    update(next, selection) {
      const range = selection && selection.from !== selection.to ? selection : null;
      if (doc === next && range?.from === selected?.from && range?.to === selected?.to) return;
      doc = next;
      selected = range;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    count() {
      if (!doc) return EMPTY;
      // The same answer object until something changes, so React reads a
      // stable snapshot.
      if (snapshot.doc === doc && snapshot.selected === selected) return snapshot.value;
      if (counted?.doc !== doc) counted = { doc, total: countBetween(doc, 0, doc.content.size) };
      const value = {
        document: counted.total,
        selection: selected ? countBetween(doc, selected.from, selected.to) : null,
      };
      snapshot = { doc, selected, value };
      return value;
    },
  };
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
 * without rebuilding the editor, and only for typing and keyboard moves, so a
 * click places the caret where the reader pointed; and every new document
 * and selection reaches the word counter. Inline code is paths and identifiers, so it is
 * kept out of the spellchecker, which could only underline it.
 */
export function attachWritingAids(editor: CrepeBuilder, counter: WordCounter): void {
  editor.editor.config((ctx) => ctx.set(inlineCodeAttr.key, () => ({ spellcheck: 'false' })));
  let pointerPlaced = false;
  editor.editor.use(
    $prose(
      () =>
        new Plugin({
          props: {
            decorations: currentBlock,
            handleDOMEvents: {
              keydown: () => {
                pointerPlaced = false;
                return false;
              },
              mousedown: () => {
                pointerPlaced = true;
                return false;
              },
            },
          },
          view: (view) => {
            counter.update(view.state.doc, view.state.selection);
            return {
              update(next, previous) {
                const edited = previous.doc !== next.state.doc;
                const moved = edited || !previous.selection.eq(next.state.selection);
                if (moved) counter.update(next.state.doc, next.state.selection);
                if (
                  moved &&
                  (edited || !pointerPlaced) &&
                  next.hasFocus() &&
                  appliedAppearance()?.typewriterScrolling
                ) {
                  centerCaret(next);
                }
              },
            };
          },
        }),
    ),
  );
}

/** The document's word and character counts in the corner, while the reader
 *  has them on. While text is selected, the selection's counts lead, out of
 *  the document's. */
export function WordCount({ counter }: { counter: WordCounter }) {
  if (!useAppliedAppearance()?.wordCount) return null;
  return <WordCountLabel counter={counter} />;
}

function WordCountLabel({ counter }: { counter: WordCounter }) {
  const { document, selection } = useSyncExternalStore(
    counter.subscribe,
    counter.count,
    counter.count,
  );
  return <div className="markdown-word-count">{countLabel(document, selection)}</div>;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function countLabel(document: TextCount, selection: TextCount | null): string {
  const words = document.words.toLocaleString();
  const characters = document.characters.toLocaleString();
  if (!selection) {
    return `${words} ${plural(document.words, 'word', 'words')} · ${characters} ${plural(document.characters, 'character', 'characters')}`;
  }
  return `${selection.words.toLocaleString()} of ${words} ${plural(document.words, 'word', 'words')} · ${selection.characters.toLocaleString()} of ${characters} ${plural(document.characters, 'character', 'characters')}`;
}
