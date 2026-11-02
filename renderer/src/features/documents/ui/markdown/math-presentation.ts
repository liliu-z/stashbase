/**
 * Presents source-backed inline Markdown and formulas without replacing the
 * editor document. Parsed runs are cached by immutable textblock identity;
 * mode and selection changes repaint decorations without changing history.
 */
import {
  editorViewCtx,
  editorViewOptionsCtx,
  parserCtx,
  remarkCtx,
  schemaCtx,
  serializerCtx,
} from '@milkdown/kit/core';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { renderToString } from 'katex';

import { remarkMathSyntax } from '@/shared/runtime/markdown-math';

import { pastedMathSource, pasteMathSource } from './math-clipboard';
import {
  mathProseDecorations,
  parseMathProse,
  type MarkdownNode as ProseNode,
  type RemarkParser,
} from './math-prose';
import {
  mathSourceRanges,
  sourceRanges,
  protectMathSource,
  type MathSourceRange,
} from './math-source';

const MATH_SOURCE = 'math_source';
const mathDecorationKey = new PluginKey<MathPresentation>('stashbase-math-decorations');

export function renderMath(source: string, displayMode: boolean): string {
  return renderToString(source, {
    displayMode,
    throwOnError: false,
    trust: false,
    maxExpand: 1000,
    maxSize: 20,
  });
}

export interface MathModeRef {
  current: boolean;
}
interface ProseRun {
  from: number;
  source: string;
  off: ProseNode;
  on: ProseNode;
}
interface MathPresentation {
  ranges: MathSourceRange[];
  prose: ProseRun[];
  decorations: DecorationSet;
}

function mathWidget(ownerDocument: Document, range: MathSourceRange): HTMLElement {
  const dom = ownerDocument.createElement('span');
  dom.dataset.mathSource = range.value;
  dom.dataset.mathFrom = String(range.from);
  dom.dataset.type = 'math_inline';
  dom.dataset.value = range.value;
  dom.contentEditable = 'false';
  dom.innerHTML = renderMath(range.value, range.kind === 'display');
  return dom;
}

function decorations(
  doc: ProseMirrorNode,
  ranges: MathSourceRange[],
  prose: ProseRun[],
  parser: RemarkParser,
  mode: boolean,
  from: number,
  to: number,
): DecorationSet {
  const output = prose.flatMap((run) =>
    mathProseDecorations(run.source, run.from, parser, from, to, mode ? run.on : run.off),
  );
  for (const range of ranges) {
    if (range.kind === 'single' && !mode) continue;
    // An insertion point inside a formula reveals its editable source. Range
    // selections retain their rendered text, including when copying a passage.
    if (from === to && from > range.from && from < range.to) continue;
    if (range.kind === 'dollar') {
      output.push(
        Decoration.inline(range.from, range.from + 1, { class: 'stashbase-math-source' }),
      );
      continue;
    }
    output.push(
      Decoration.inline(range.from, range.to, { class: 'stashbase-math-source' }),
      Decoration.widget(range.from, (view) => mathWidget(view.dom.ownerDocument, range), {
        key: `math:${range.from}:${range.kind}:${range.value}`,
        side: -1,
      }),
    );
  }
  return DecorationSet.create(doc, output);
}

export function mathPresentation(
  mode: boolean | MathModeRef,
  getParser: (context: import('@milkdown/kit/ctx').Ctx) => RemarkParser,
) {
  const readMode = () => (typeof mode === 'boolean' ? mode : mode.current);
  return $prose((context) => {
    const parser = getParser(context);
    const onParser = proseParser(context, true);
    context.update(editorViewOptionsCtx, (previous) => ({
      ...previous,
      handlePaste: (view, event, slice) =>
        previous.handlePaste?.(view, event, slice) ||
        pasteMathSource(
          view,
          event,
          context.get(parserCtx),
          parser,
          context.get(serializerCtx),
          readMode(),
        ),
    }));
    const cache = new WeakMap<ProseMirrorNode, Omit<ProseRun, 'from'>>();
    const presentation = (doc: ProseMirrorNode) => {
      const prose: ProseRun[] = [];
      const ranges: MathSourceRange[] = [];
      doc.descendants((node, position) => {
        if (node.type.spec.code) return false;
        if (!node.isTextblock) return;
        const sourceMark = node.firstChild?.marks.find(
          (mark) => mark.type.name === MATH_SOURCE && mark.attrs.prose,
        );
        if (
          !sourceMark ||
          Array.from({ length: node.childCount }, (_, index) => node.child(index)).some(
            (child) => !child.isText,
          )
        )
          return false;
        let run = cache.get(node);
        if (!run) {
          const source = node.textContent;
          const references = String(sourceMark.attrs.references ?? '');
          run = {
            source,
            off: parseMathProse(source, parser, references),
            on: parseMathProse(source, onParser, references),
          };
          cache.set(node, run);
        }
        prose.push({ ...run, from: position + 1 });
        const visit = (syntax: ProseNode) => {
          if (syntax.type === 'inlineMath') {
            const from = syntax.position?.start.offset;
            const to = syntax.position?.end.offset;
            if (from !== undefined && to !== undefined && to <= node.content.size) {
              const range = mathSourceRanges(run.source.slice(from, to))[0];
              if (range && range.kind !== 'dollar')
                ranges.push({ ...range, from: position + from + 1, to: position + to + 1 });
            }
          }
          syntax.children?.forEach(visit);
        };
        visit(run.on);
        return false;
      });
      // New source entered into an ordinary semantic paragraph can use the
      // smaller protected range until the paragraph is next parsed from disk.
      ranges.push(
        ...sourceRanges(doc).filter(
          (range) =>
            !prose.some(
              (run) => range.from >= run.from && range.to <= run.from + run.source.length,
            ),
        ),
      );
      const serialize = context.get(serializerCtx);
      const schema = context.get(schemaCtx);
      return {
        prose,
        ranges: ranges.map((range) => {
          if (range.kind === 'dollar') return range;
          const paragraph = schema.nodes.paragraph?.create(
            null,
            doc.slice(range.from, range.to).content,
          );
          if (!paragraph) return range;
          const source = serialize(schema.topNodeType.create(null, paragraph)).trimEnd();
          const formula = mathSourceRanges(source).find((candidate) => candidate.kind !== 'dollar');
          return formula ? Object.assign({}, range, { value: formula.value }) : range;
        }),
      };
    };
    const paint = (
      state: EditorState,
      content: Pick<MathPresentation, 'ranges' | 'prose'>,
    ): MathPresentation => ({
      ...content,
      decorations: decorations(
        state.doc,
        content.ranges,
        content.prose,
        parser,
        readMode(),
        state.selection.from,
        state.selection.to,
      ),
    });
    return new Plugin<MathPresentation>({
      key: mathDecorationKey,
      state: {
        init: (_, state) => paint(state, presentation(state.doc)),
        apply(transaction, previous, _old, state) {
          if (
            !transaction.docChanged &&
            !transaction.selectionSet &&
            !transaction.getMeta(mathDecorationKey)
          )
            return previous;
          return paint(state, transaction.docChanged ? presentation(state.doc) : previous);
        },
      },
      // Protect completed, newly typed source just as opening/pasting Markdown
      // does. This joins the user's transaction; toggling never changes marks.
      appendTransaction: (transactions, oldState, state) =>
        protectMathSource(transactions, state, oldState, context.get(serializerCtx)),
      props: {
        transformPasted: (slice, view) =>
          pastedMathSource(slice, parser, view.state, context.get(serializerCtx)),
        handleTextInput(view, from, to, text) {
          const cursor = view.state.doc.resolve(from);
          if (cursor.parent.type.spec.code || cursor.marks().some((mark) => mark.type.spec.code))
            return false;
          const before = cursor.parent.textBetween(0, cursor.parentOffset, '\n', '\ufffc') + text;
          // Let the existing block input rules consume their opening prefix.
          // The remaining inline source keeps its marks and parent semantics.
          if (/^(?:#{1,6}|>|[-+*]|\d+[.)]) $/u.test(before)) return false;
          if (
            cursor.parent.firstChild?.marks.some(
              (mark) => mark.type.name === MATH_SOURCE && mark.attrs.prose,
            )
          ) {
            view.dispatch(view.state.tr.insertText(text, from, to));
            return true;
          }
          const active = mathSourceRanges(before, true).find((range) => range.to === before.length);
          if (!active || (active.kind === 'single' && !readMode())) return false;
          view.dispatch(view.state.tr.insertText(text, from, to));
          return true;
        },
        decorations: (state) => mathDecorationKey.getState(state)?.decorations ?? null,
        handleDOMEvents: {
          mousedown(view, event) {
            const target =
              event.target instanceof Element
                ? event.target.closest<HTMLElement>('[data-math-from]')
                : null;
            if (!target || !view.editable) return false;
            const from = Number(target.dataset.mathFrom);
            view.dispatch(
              view.state.tr.setSelection(TextSelection.create(view.state.doc, from + 1)),
            );
            view.focus();
            event.preventDefault();
            return true;
          },
        },
      },
    });
  });
}

/** Repaint only: preserve document content, selection and Undo/Redo. */
export function refreshMath(editor: import('@milkdown/crepe/builder').CrepeBuilder): void {
  editor.editor.action((context) => {
    const view = context.get(editorViewCtx);
    view.dispatch(view.state.tr.setMeta(mathDecorationKey, true).setMeta('addToHistory', false));
  });
}

export function proseParser(
  context: import('@milkdown/kit/ctx').Ctx,
  singleDollarTextMath: boolean,
): RemarkParser {
  // Unified copies plugin parameter objects by reference. Reset the clone's
  // tuple before configuring it so the editor's parser keeps its own options.
  return context
    .get(remarkCtx)()
    .data({})
    .use(remarkMathSyntax, false)
    .use(remarkMathSyntax, { sourceText: false, singleDollarTextMath });
}
