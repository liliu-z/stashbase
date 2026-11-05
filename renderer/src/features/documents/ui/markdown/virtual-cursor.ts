/**
 * Crepe's virtual cursor, vendored from prosemirror-virtual-cursor 0.4.2 with
 * one change: it measures only when the window's selection is inside this
 * editor. The original measures on every `selectionchange` in the window, on
 * resize and on each editor update, so typing in the chat laid out the
 * Markdown document per keystroke. Registered after Crepe's features, so their
 * ←/→ handlers at textblock edges run first; this one acts inside a textblock.
 *
 * The plugin also owns typing affinity at mark boundaries: at the edge of
 * bold, code or a link, ←/→ first chooses whether the next character joins
 * the mark. The skipped measurement is invisible because Crepe's theme colors
 * the cursor only inside `.ProseMirror-focused`.
 */
/*
 * MIT License
 *
 * Copyright (c) 2022 ocavue
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { Mark, type ResolvedPos } from '@milkdown/kit/prose/model';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Selection,
} from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';

const key = new PluginKey('prosemirror-virtual-cursor');

export function createVirtualCursor(): Plugin {
  let cursor: HTMLElement | null = null;
  const cursorFor = (view: EditorView) => (cursor ??= view.dom.ownerDocument.createElement('div'));
  return new Plugin({
    key,
    view: (view) => {
      const ownerDocument = view.dom.ownerDocument;
      const update = () => updateCursor(view, cursorFor(view));
      const Observer = ownerDocument.defaultView?.ResizeObserver;
      const observer = Observer ? new Observer(update) : null;
      observer?.observe(view.dom);
      ownerDocument.addEventListener('selectionchange', update);
      return {
        update,
        destroy: () => {
          ownerDocument.removeEventListener('selectionchange', update);
          observer?.disconnect();
        },
      };
    },
    props: {
      handleKeyDown: (view, event) => {
        const { selection } = view.state;
        if (
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.isComposing ||
          (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') ||
          !isTextSelection(selection) ||
          !selection.empty
        ) {
          return false;
        }
        const $pos = selection.$head;
        const [marksBefore, marksAfter] = marksAround($pos);
        const marks = view.state.storedMarks ?? $pos.marks();
        if (marksBefore && marksAfter && !Mark.sameSet(marksBefore, marksAfter)) {
          if (event.key === 'ArrowLeft' && !Mark.sameSet(marksBefore, marks)) {
            view.dispatch(view.state.tr.setStoredMarks(marksBefore));
            return true;
          }
          if (event.key === 'ArrowRight' && !Mark.sameSet(marksAfter, marks)) {
            view.dispatch(view.state.tr.setStoredMarks(marksAfter));
            return true;
          }
        }
        if (event.key === 'ArrowLeft' && $pos.textOffset === 1) {
          view.dispatch(
            view.state.tr
              .setSelection(TextSelection.create(view.state.doc, $pos.pos - 1))
              .setStoredMarks($pos.marks()),
          );
          return true;
        }
        if (
          event.key === 'ArrowRight' &&
          $pos.textOffset + 1 === $pos.parent.maybeChild($pos.index())?.nodeSize
        ) {
          view.dispatch(
            view.state.tr
              .setSelection(TextSelection.create(view.state.doc, $pos.pos + 1))
              .setStoredMarks($pos.marks()),
          );
          return true;
        }
        return false;
      },
      decorations: (state: EditorState) => {
        if (!isTextSelection(state.selection) || !state.selection.empty) return null;
        return DecorationSet.create(state.doc, [
          Decoration.widget(0, cursorFor, { key: 'prosemirror-virtual-cursor' }),
        ]);
      },
      attributes: { class: 'virtual-cursor-enabled' },
    },
  });
}

function isTextSelection(selection: Selection): selection is TextSelection {
  return '$cursor' in selection;
}

function marksAround(
  $pos: ResolvedPos,
): [readonly Mark[] | undefined, readonly Mark[] | undefined] {
  const index = $pos.index();
  const after = $pos.parent.maybeChild(index);
  let before = $pos.textOffset ? after : null;
  if (!before && index > 0) before = $pos.parent.maybeChild(index - 1);
  return [before?.marks, after?.marks];
}

function cursorRect(view: EditorView, toStart: boolean) {
  const selection = view.dom.ownerDocument.getSelection();
  if (!selection?.rangeCount) return null;
  // The one change from upstream: a selection elsewhere in the window (the
  // chat, another editor) is not this editor's caret, so nothing is measured.
  const anchor = selection.anchorNode;
  if (!anchor || !view.dom.contains(anchor)) return null;
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(toStart);
  const rects = range.getClientRects();
  const rect = rects.length ? rects[rects.length - 1] : null;
  if (rect?.height) return rect;
  return view.coordsAtPos(view.state.selection.head);
}

function updateCursor(view: EditorView, cursor: HTMLElement) {
  if (view.isDestroyed) return;
  const { selection, storedMarks } = view.state;
  if (!isTextSelection(selection)) return;
  const rect = cursorRect(view, selection.$head === selection.$from);
  if (!rect) return;
  const editorRect = view.dom.getBoundingClientRect();
  let className = 'prosemirror-virtual-cursor';
  const $pos = selection.$head;
  const [marksBefore, marksAfter] = marksAround($pos);
  const marks = storedMarks ?? $pos.marks();
  if (selection.$cursor && marksBefore && marksAfter && !Mark.sameSet(marksBefore, marksAfter)) {
    if (Mark.sameSet(marksBefore, marks)) className += ' prosemirror-virtual-cursor-left';
    else if (Mark.sameSet(marksAfter, marks)) className += ' prosemirror-virtual-cursor-right';
  }
  cursor.className = className;
  cursor.classList.remove('prosemirror-virtual-cursor-animation');
  void cursor.offsetWidth;
  cursor.classList.add('prosemirror-virtual-cursor-animation');
  cursor.style.height = `${rect.bottom - rect.top}px`;
  cursor.style.left = `${rect.left - editorRect.left}px`;
  cursor.style.top = `${rect.top - editorRect.top}px`;
}
