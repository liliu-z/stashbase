/** Source-backed math protects TeX before Markdown decoding, while the
 * presentation-only toggle preserves editing state and Undo/Redo. */
import { codeBlockConfig } from '@milkdown/kit/component/code-block';
import { remarkStringifyOptionsCtx, type Editor } from '@milkdown/kit/core';
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import { $markSchema, $remark } from '@milkdown/kit/utils';

import { remarkMathSyntax } from '@/shared/runtime/markdown-math';

import { mathSourceCommands } from './math-commands';
import { configureMathSourceLinks, mathSourceLinks } from './math-links';
import { mathPresentation, proseParser, renderMath, type MathModeRef } from './math-presentation';
import type { RemarkParser } from './math-prose';

export { refreshMath, type MathModeRef } from './math-presentation';

const MATH_SOURCE = 'math_source';
const MATH_LANGUAGES = new Set(['latex', 'math']);

interface MarkdownNode {
  type: string;
  value?: string;
  lang?: string | null;
  children?: MarkdownNode[];
}

const mathSourceSchema = $markSchema(MATH_SOURCE, () => ({
  inclusive: false,
  attrs: { prose: { default: false }, references: { default: '' } },
  toDOM: (mark) => [
    'span',
    {
      'data-math-source-text': '',
      'data-math-prose': String(mark.attrs.prose),
      'data-math-references': String(mark.attrs.references),
    },
    0,
  ],
  parseDOM: [
    {
      tag: 'span[data-math-source-text]',
      getAttrs: (element) => ({
        prose: element.getAttribute('data-math-prose') === 'true',
        references: element.getAttribute('data-math-references') ?? '',
      }),
    },
  ],
  parseMarkdown: {
    match: (node) => node.type === 'mathSource',
    runner: (state, node, type) => {
      state.openMark(type, {
        prose: node.prose === true,
        references: typeof node.references === 'string' ? node.references : '',
      });
      state.addText(typeof node.value === 'string' ? node.value : '');
      state.closeMark(type);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === MATH_SOURCE,
    runner: (state, mark, node) => {
      state.withMark(mark, 'mathSource', node.text ?? '');
      return true;
    },
  },
}));

function mathBlocksToCode(node: MarkdownNode): void {
  node.children?.forEach((child, index, siblings) => {
    if (child.type === 'math') {
      siblings[index] = { ...child, type: 'code', lang: 'LaTeX', value: child.value ?? '' };
    } else {
      mathBlocksToCode(child);
    }
  });
}

const remarkMathBlockAsCode = $remark('remarkMathBlockAsCode', () => () => (tree) => {
  mathBlocksToCode(tree as MarkdownNode);
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
export function math(editor: Editor, mode: boolean | MathModeRef = false): void {
  let parser: RemarkParser | undefined;
  const getParser = (context: import('@milkdown/kit/ctx').Ctx) =>
    (parser ??= proseParser(context, false));
  editor
    .config((context) => {
      configureMathSourceLinks(context, getParser);
      context.update(codeBlockConfig.key, (previous) => ({
        ...previous,
        renderPreview: (language, content, applyPreview) =>
          MATH_LANGUAGES.has(language.toLowerCase()) && content.length > 0
            ? renderMath(content, true)
            : previous.renderPreview(language, content, applyPreview),
      }));
      context.update(remarkStringifyOptionsCtx, (previous) => ({
        ...previous,
        handlers: {
          ...previous.handlers,
          mathSource: (node: { type: string; value?: unknown }) =>
            typeof node.value === 'string' ? node.value : '',
        },
      }));
    })
    .use($remark('remarkMathSource', () => remarkMathSyntax, { sourceText: true }))
    .use(remarkMathBlockAsCode)
    .use(mathSourceSchema)
    .use(mathPresentation(mode, getParser))
    .use(mathSourceCommands(getParser))
    .use(mathSourceLinks(getParser))
    .use(mathBlockSchema);
}
