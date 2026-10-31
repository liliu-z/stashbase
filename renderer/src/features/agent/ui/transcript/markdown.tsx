/** Render Agent Markdown with source citations, math, and independently copyable blocks. */
import { memo, type ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import 'katex/dist/katex.min.css';
import { parseCitationHref } from '@/features/agent/domain/citation';
import { useTouchPrimary } from '@/lib/use-touch-primary';
import { cn } from '@/lib/utils';
import type { SourceReference } from '@/shared/domain/source-reference';
import { MARKDOWN_PROSE_CLASS } from '@/shared/ui/markdown-prose';
import { useMathMode } from '@/shared/ui/math-mode';

import { CopyAction } from './copy-action';

function isHttpUrl(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Code spans and fences, then existing `$$` math, then `\[ \]` and `\( \)`.
 *  A doubled backslash (`\\[2pt]`) is a LaTeX row break, not an opener. */
const LATEX_DELIMITERS =
  /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)|\$\$[\s\S]*?\$\$|(?<!\\)\\\[([\s\S]+?)\\\]|(?<!\\)\\\(([^\n]+?)\\\)/gu;

/**
 * Many models write LaTeX between `\[ \]` and `\( \)`. Markdown reads those as
 * escaped brackets and drops the backslashes, so the formula showed as source.
 * They become the double-dollar math the transcript renders; a `\[` that owns
 * its line becomes a display block at the same indentation.
 */
function withDollarMath(markdown: string): string {
  return markdown.replace(
    LATEX_DELIMITERS,
    (match, _code, display: string | undefined, inline: string | undefined, offset: number) => {
      if (inline !== undefined) return `$$${inline}$$`;
      if (display === undefined) return match;
      const indent = markdown.slice(markdown.lastIndexOf('\n', offset - 1) + 1, offset);
      const end = offset + match.length;
      const lineEnd = markdown.indexOf('\n', end);
      const rest = markdown.slice(end, lineEnd === -1 ? undefined : lineEnd);
      return indent.trim() || rest.trim()
        ? `$$${display}$$`
        : `$$\n${indent}${display.trim()}\n${indent}$$`;
    },
  );
}

interface SyntaxNode {
  type: string;
  value?: string;
  children?: SyntaxNode[];
}

function textOf(node: SyntaxNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

/** A fenced block, such as a drafted post the reader will paste elsewhere,
 *  carries its own Copy so it leaves without the reply's surrounding words. */
function CodeBlock({
  children,
  className,
  node,
  ...props
}: ComponentProps<'pre'> & { node?: SyntaxNode | undefined }) {
  const isTouch = useTouchPrimary();
  return (
    <pre {...props} className={cn('group/code', className)}>
      {/* Floated ahead of the text, so wrapped lines run beside and below it,
       *  never behind it. Its glyph sits on the text's right edge. */}
      <span
        className={cn(
          'float-right -mr-[3px] ml-2 flex',
          !isTouch &&
            'pointer-events-none opacity-0 transition-opacity duration-base group-hover/code:pointer-events-auto group-hover/code:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
        )}
      >
        <CopyAction
          label="Copy block"
          // The fence's closing line break belongs to the Markdown, not the text.
          text={textOf(node).replace(/\n$/u, '')}
        />
      </span>
      {children}
    </pre>
  );
}

interface MarkdownLinks {
  onOpenExternal?: ((href: string) => void) | undefined;
  onOpenSource?: ((source: SourceReference, phrase: string | null) => void) | undefined;
  sourceFor?: ((path: string) => SourceReference | null) | undefined;
}

function markdownComponents({
  onOpenExternal,
  onOpenSource,
  sourceFor,
}: MarkdownLinks): Components {
  return {
    a: ({ href = '', children, ...props }: ComponentProps<'a'>) => {
      if (href.startsWith('#'))
        return (
          <a {...props} href={href}>
            {children}
          </a>
        );
      if (isHttpUrl(href)) {
        return (
          <a
            {...props}
            href={href}
            onClick={
              onOpenExternal
                ? (event) => {
                    event.preventDefault();
                    onOpenExternal(href);
                  }
                : undefined
            }
            rel="noreferrer"
            target="_blank"
          >
            {children}
          </a>
        );
      }
      const citation = parseCitationHref(href);
      const path = citation?.path ?? '';
      const source =
        path && !/^[a-z][a-z0-9+.-]*:/iu.test(path) && !path.startsWith('//')
          ? (sourceFor?.(path) ?? null)
          : null;
      if (!source || !onOpenSource) return <span>{children}</span>;
      const phrase = citation?.phrase ?? null;
      return (
        <a
          {...props}
          href={href}
          onClick={(event) => {
            event.preventDefault();
            onOpenSource(source, phrase);
          }}
          title={phrase ? `${path}: \u201c${phrase}\u201d` : props.title}
        >
          {children}
        </a>
      );
    },
    img: () => null,
    pre: CodeBlock,
  };
}

export const AgentMarkdown = memo(function AgentMarkdown({
  markdown,
  onOpenExternal,
  onOpenSource,
  sourceFor,
}: MarkdownLinks & {
  markdown: string;
}) {
  // The project's Math mode, the same switch the document beside it follows.
  const { enabled: mathMode } = useMathMode();
  return (
    <div className={MARKDOWN_PROSE_CLASS}>
      <ReactMarkdown
        components={markdownComponents({ onOpenExternal, onOpenSource, sourceFor })}
        // With the switch off, single dollars would swallow ordinary prices
        // ("$4 ... $5"); math still opens with two dollars, `\( \)` and `\[ \]`
        // either way. With it on, `$x^2$` opens a formula and `\$` stays prose.
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: mathMode }]]}
        rehypePlugins={[
          [rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 }],
        ]}
      >
        {withDollarMath(markdown)}
      </ReactMarkdown>
    </div>
  );
});
