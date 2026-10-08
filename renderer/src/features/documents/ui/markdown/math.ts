/**
 * Math for the Markdown surface, opened only by two dollars or a ```math /
 * ```latex fence — the rule the agent transcript follows.
 *
 * Crepe's own LaTeX feature reads single dollars as math and offers no switch,
 * so ordinary prices ("$0.10–$0.50") lost their dollar signs and turned
 * italic. Single dollars stay text here; a note written with `$x$` shows its
 * source instead of a formula.
 */
import { codeBlockConfig } from '@milkdown/kit/component/code-block';
import type { Editor } from '@milkdown/kit/core';
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import { $nodeSchema, $remark, $view } from '@milkdown/kit/utils';
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
    .use(mathBlockSchema);
}
