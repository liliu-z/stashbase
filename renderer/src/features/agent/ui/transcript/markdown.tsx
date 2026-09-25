import { memo, type ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import 'katex/dist/katex.min.css';
import { parseCitationHref } from '@/features/agent/domain/citation';
import type { SourceReference } from '@/shared/domain/source-reference';

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
    <div
      className={[
        'min-w-0 text-[14px] leading-[1.6] whitespace-normal text-foreground',
        '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        '[&_p]:my-3 [&_p]:whitespace-normal',
        '[&_h1]:mt-6 [&_h1]:mb-2 [&_h1]:text-[18px] [&_h1]:leading-tight [&_h1]:font-semibold',
        '[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-[16px] [&_h2]:leading-tight [&_h2]:font-semibold',
        '[&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-[14px] [&_h3]:font-semibold',
        '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5',
        '[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5',
        '[&_li]:pl-0.5 [&_li>p]:my-0',
        '[&_a]:text-working [&_a]:underline [&_a]:decoration-working/35 [&_a]:underline-offset-[0.18em] hover:[&_a]:decoration-working',
        '[&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-working/40 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
        '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.88em]',
        // shape-literal: a descendant variant cannot carry a class variable.
        '[&_pre]:my-4 [&_pre]:max-w-full [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-surface-1 [&_pre]:p-3',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_hr]:my-5 [&_hr]:border-border',
        '[&_table]:my-4 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse',
        '[&_th]:border-b [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-[12px] [&_th]:font-medium',
        '[&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:align-top',
      ].join(' ')}
    >
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
