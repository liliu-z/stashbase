import { memo, type ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import 'katex/dist/katex.min.css';
import { parseCitationHref } from '@/features/agent/domain/citation';
import type { SourceReference } from '@/shared/domain/source-reference';
import { MARKDOWN_PROSE_CLASS } from '@/shared/ui/markdown-prose';
import { useMathMode } from '@/shared/ui/math-mode';

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
