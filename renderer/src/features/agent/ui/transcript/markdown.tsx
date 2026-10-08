import { memo, type ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import 'katex/dist/katex.min.css';
import { parseCitationHref } from '@/features/agent/domain/citation';
import type { SourceReference } from '@/shared/domain/source-reference';
import { MARKDOWN_PROSE_CLASS } from '@/shared/ui/markdown-prose';

function isHttpUrl(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
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
  return (
    <div className={MARKDOWN_PROSE_CLASS}>
      <ReactMarkdown
        components={markdownComponents({ onOpenExternal, onOpenSource, sourceFor })}
        // Single-dollar text math would swallow ordinary prices ("$4 ... $5");
        // math still opens with two dollars or a ```math fence.
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
        rehypePlugins={[
          [rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 }],
        ]}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
});
