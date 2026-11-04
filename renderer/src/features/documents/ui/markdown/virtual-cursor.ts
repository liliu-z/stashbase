/**
 * Crepe's virtual cursor, vendored from prosemirror-virtual-cursor 0.4.2
 * (MIT, Copyright (c) 2022 ocavue) with one change: it measures only when the
 * window's selection is inside this editor. The original listens to
 * `selectionchange` on the whole document and lays out on each one, so typing
 * in the chat measured the Markdown document on every keystroke.
 *
 * The plugin also owns typing affinity at mark boundaries: at the edge of
 * bold, code or a link, ←/→ first chooses whether the next character joins
 * the mark. The skipped measurement is invisible because Crepe's theme colors
 * the cursor only inside `.ProseMirror-focused`.
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
      const onSelectionChange = () => {
        const anchor = ownerDocument.getSelection()?.anchorNode;
        if (anchor && view.dom.contains(anchor)) update();
      };
      const Observer = ownerDocument.defaultView?.ResizeObserver;
      const observer = Observer ? new Observer(update) : null;
      observer?.observe(view.dom);
      ownerDocument.addEventListener('selectionchange', onSelectionChange);
      return {
        update,
        destroy: () => {
          ownerDocument.removeEventListener('selectionchange', onSelectionChange);
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
