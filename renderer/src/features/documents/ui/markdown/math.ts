/**
 * Math for the Markdown surface.
 *
 * A `$$` block, a `\( … \)` span, a `\[ … \]` block and a ```math / ```latex
 * fence open a formula in every project: remark-math reads those, the source
 * that produced them is what saves back, and the project's switch does not
 * touch them.
 *
 * Single dollars are the project's choice. Crepe's own LaTeX feature reads them
 * as math and offers no switch, so ordinary prices ("$0.10–$0.50") lost their
 * dollar signs and turned italic; the default here leaves `$…$` as text.
 * Switching a project's Math mode on adds a decoration layer that hides the
 * `$…$` source and shows KaTeX in its place: the document, its undo history,
 * the reader's selection and the saved Markdown are all untouched, so turning
 * the mode on and off cannot dirty a file or rewrite a price. Touching a
 * formula brings its source back, because the reader edits what they see.
 */
import type { CrepeBuilder } from '@milkdown/crepe/builder';
import { codeBlockConfig } from '@milkdown/kit/component/code-block';
import { editorViewCtx, type Editor } from '@milkdown/kit/core';
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { $nodeSchema, $prose, $remark, $view } from '@milkdown/kit/utils';
import { renderToString } from 'katex';
import remarkMath from 'remark-math';

/** Crepe's theme styles inline math by this node name. */
const MATH_INLINE = 'math_inline';
const MATH_LANGUAGES = new Set(['latex', 'math']);

const KATEX_OPTIONS = { throwOnError: false, trust: false, maxExpand: 1000, maxSize: 20 };

interface MarkdownNode {
  type: string;
  value?: string;
  lang?: string | null;
  children?: MarkdownNode[];
}

const remarkDoubleDollarMath = $remark('remarkDoubleDollarMath', () => remarkMath, {
  singleDollarTextMath: false,
});

/** A `$$` block arrives as a LaTeX code block, so it edits and previews like
 *  one and saves back as `$$`. */
function mathBlocksToCode(node: MarkdownNode): void {
  node.children?.forEach((child, index, siblings) => {
    if (child.type === 'math') {
      siblings[index] = { type: 'code', lang: 'LaTeX', value: child.value ?? '' };
    } else {
      mathBlocksToCode(child);
    }
  });
}

const remarkMathBlockAsCode = $remark('remarkMathBlockAsCode', () => () => (tree) => {
  mathBlocksToCode(tree as MarkdownNode);
});

const mathInlineSchema = $nodeSchema(MATH_INLINE, () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: { value: { default: '' } },
  parseDOM: [
    {
      tag: `span[data-type="${MATH_INLINE}"]`,
      getAttrs: (dom) => ({ value: (dom as HTMLElement).dataset.value ?? '' }),
    },
  ],
  toDOM: (node) => ['span', { 'data-type': MATH_INLINE, 'data-value': node.attrs.value as string }],
  parseMarkdown: {
    match: (node) => node.type === 'inlineMath',
    runner: (state, node, type) => {
      state.addNode(type, { value: node.value as string });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === MATH_INLINE,
    runner: (state, node) => {
      state.addNode('inlineMath', undefined, node.attrs.value as string);
    },
  },
}));

/** Shows the formula; the source stays in `data-value` for copy and parse. */
const mathInlineView = $view(mathInlineSchema.node, () => (node, view) => {
  const value = node.attrs.value as string;
  const dom = view.dom.ownerDocument.createElement('span');
  dom.dataset.type = MATH_INLINE;
  dom.dataset.value = value;
  dom.innerHTML = renderToString(value, KATEX_OPTIONS);
  return { dom };
});

const mathBlockSchema = codeBlockSchema.extendSchema((previous) => (context) => {
  const base = previous(context);
  return {
    ...base,
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        // Only blocks that arrived as `$$` carry exactly this language, so a
        // ```latex fence keeps its fence.
        if (node.attrs.language !== 'LaTeX') {
          return base.toMarkdown.runner(state, node);
        }
        state.addNode('math', undefined, node.content.firstChild?.text ?? '');
      },
    },
  };
});

/** One `$…$` span, at offsets inside the run of text it was found in. */
interface DollarSpan {
  from: number;
  to: number;
  value: string;
}

/**
 * Whether `index` holds a `$`, in a text run.
 */
function dollarAt(text: string, index: number): boolean {
  return index >= 0 && index < text.length && text[index] === '$';
}

/**
 * The `$…$` spans in one run of text, by remark-math's own rules, so the editor
 * and the Chat tell a price and a formula apart the same way: an opener is
 * followed by a non-space, a closer follows a non-space and is not followed by a
 * digit (`$5 and $6` stays prose), and a `$` that is escaped or part of a `$$`
 * delimiter belongs to neither. A rejected closer starts a new search from
 * itself, so the first real pair after a price still reads as a formula.
 */
function dollarSpans(text: string): DollarSpan[] {
  const spans: DollarSpan[] = [];
  let open = -1;
  for (let index = 0; index < text.length; index++) {
    if (!dollarAt(text, index)) continue;
    // `\$` is a literal dollar, and `$$` is the pipeline's own delimiter.
    if (text[index - 1] === '\\' || dollarAt(text, index - 1) || dollarAt(text, index + 1)) {
      open = -1;
      continue;
    }
    if (open < 0) {
      const next = text[index + 1];
      if (next === undefined || /\s/.test(next)) continue;
      open = index;
      continue;
    }
    const previous = text[index - 1];
    const next = text[index + 1];
    if (previous === undefined || /\s/.test(previous) || (next !== undefined && /\d/.test(next))) {
      // Not a closer. It may still open the next span.
      open = /\s/.test(next ?? '') || next === undefined ? -1 : index;
      continue;
    }
    spans.push({ from: open, to: index + 1, value: text.slice(open + 1, index) });
    open = -1;
  }
  return spans;
}

/** The rendered formula, in place of the source it hides. */
function formulaElement(host: Document, value: string): HTMLElement {
  const dom = host.createElement('span');
  dom.dataset.type = 'math_dollar_inline';
  dom.dataset.value = value;
  dom.innerHTML = renderToString(value, KATEX_OPTIONS);
  return dom;
}

/** A text run inside a code span or a code block holds no formula: the reader
 *  means the characters. */
function isCode(node: ProseMirrorNode): boolean {
  return node.marks.some((mark) => mark.type.spec.code === true);
}

/**
 * The source `$…$` hides and its formula shows, plus an escaped `\$` drawn as a
 * plain `$`. A span the selection reaches into keeps its source on screen, so
 * the reader edits the text they wrote rather than a picture of it.
 */
function dollarMathDecorations(state: EditorState): DecorationSet {
  const decorations: Decoration[] = [];
  const ranges = state.selection.ranges.map((range) => ({
    from: range.$from.pos,
    to: range.$to.pos,
  }));
  const touched = (from: number, to: number): boolean =>
    ranges.some((range) => range.from < to && range.to > from);
  state.doc.descendants((node, position) => {
    if (!node.isTextblock || node.type.spec.code === true) return true;
    node.descendants((child, offset) => {
      if (!child.isText) return true;
      if (isCode(child)) return false;
      const text = child.text ?? '';
      const start = position + offset + 1;
      for (const span of dollarSpans(text)) {
        const from = start + span.from;
        const to = start + span.to;
        if (touched(from, to)) continue;
        decorations.push(
          Decoration.inline(from, to, { style: 'display:none' }),
          Decoration.widget(from, (view) => formulaElement(view.dom.ownerDocument, span.value), {
            key: `math-dollar-${from}-${span.value}`,
            side: -1,
          }),
        );
      }
      // `\$` asked for a dollar sign and got one; the backslash was never
      // part of what the reader meant to see.
      for (let index = text.indexOf('\\$'); index >= 0; index = text.indexOf('\\$', index + 1)) {
        const from = start + index;
        if (touched(from, from + 1)) continue;
        decorations.push(Decoration.inline(from, from + 1, { style: 'display:none' }));
      }
      return false;
    });
    return false;
  });
  return DecorationSet.create(state.doc, decorations);
}

const dollarMathKey = new PluginKey<boolean>('markdown-dollar-math');

/** Off until the project asks otherwise — the writing default. */
const dollarMathPlugin = $prose(
  () =>
    new Plugin<boolean>({
      key: dollarMathKey,
      state: {
        init: () => false,
        apply(tr, mode) {
          const next: unknown = tr.getMeta(dollarMathKey);
          return typeof next === 'boolean' ? next : mode;
        },
      },
      props: {
        decorations(state) {
          return dollarMathKey.getState(state) ? dollarMathDecorations(state) : DecorationSet.empty;
        },
      },
    }),
);

/** Applies a project's Math mode to an open document. The transaction carries
 *  only a meta, so nothing in the document changes: the save stays clean, the
 *  undo stack keeps the reader's own steps, and the scroll holds. */
export function setDollarMathMode(editor: CrepeBuilder | null, enabled: boolean): void {
  editor?.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (dollarMathKey.getState(view.state) === enabled) return;
    view.dispatch(view.state.tr.setMeta(dollarMathKey, enabled));
  });
}

/** Add after `codeMirror`, whose preview hook this wraps. */
export function math(editor: Editor): void {
  editor
    .config((context) => {
      context.update(codeBlockConfig.key, (previous) => ({
        ...previous,
        renderPreview: (language, content, applyPreview) =>
          MATH_LANGUAGES.has(language.toLowerCase()) && content.length > 0
            ? renderToString(content, { ...KATEX_OPTIONS, displayMode: true })
            : previous.renderPreview(language, content, applyPreview),
      }));
    })
    .use(remarkDoubleDollarMath)
    .use(remarkMathBlockAsCode)
    .use(mathInlineSchema)
    .use(mathInlineView)
    .use(mathBlockSchema)
    .use(dollarMathPlugin);
}
