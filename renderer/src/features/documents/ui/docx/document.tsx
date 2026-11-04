/**
 * DOCX previews: the converted HTML is rendered as an article with a derived
 * heading outline and a Find controller, falling back to the prepared version
 * when direct conversion cannot run.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';

import type { DocumentRuntime } from '@/features/documents/application/document-runtime';
import {
  documentFailure,
  DOCX_PREVIEW_MESSAGES,
} from '@/features/documents/application/failure-messages';
import type { DocumentNavigationRuntime } from '@/features/documents/application/navigation-runtime';
import type { DocxDocumentAsset, DocxPreviewPort } from '@/features/documents/application/ports';
import { docxPreviewQuery } from '@/features/documents/application/queries';
import { resolveDocumentLink } from '@/features/documents/domain/link-target';
import { headingSlug, type DocumentHeading } from '@/features/documents/domain/outline';
import { SandboxedHtmlFrame } from '@/features/documents/ui/html/document';
import { LinkFailureNotice } from '@/features/documents/ui/link-failure-notice';
import { createMarkdownFindController } from '@/features/documents/ui/markdown/find-controller';
import type { SourceReference } from '@/shared/domain/source-reference';
import { NoticeStrip } from '@/shared/ui/notice';

function documentHeadings(root: HTMLElement): DocumentHeading[] {
  const used = new Map<string, number>();
  return Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).map(
    (element, position) => {
      const base = headingSlug(element.textContent ?? '');
      const count = used.get(base) ?? 0;
      used.set(base, count + 1);
      const id = count === 0 ? base : `${base}-${count}`;
      element.id = id;
      return {
        id,
        level: Number(element.tagName.slice(1)) || 1,
        position,
        text: element.textContent?.trim() || 'Untitled section',
      };
    },
  );
}

function DirectDocxDocument({
  active,
  html,
  name,
  navigation,
  onNavigate,
  onOpenExternal,
  runtime,
}: {
  active: boolean;
  html: string;
  name: string;
  navigation: DocumentNavigationRuntime;
  onNavigate(target: { anchor?: string | undefined; source: SourceReference }): void;
  onOpenExternal(href: string): Promise<boolean>;
  runtime: DocumentRuntime;
}) {
  const articleRef = useRef<HTMLElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // A link the host refuses to open says so, exactly as the HTML and Markdown
  // viewers do; a swallowed rejection left the click looking like it worked.
  const [linkFailed, setLinkFailed] = useState(false);
  const ownerRef = useRef(Symbol(runtime.scope.id));
  const pendingAnchor = useStore(navigation.store, (state) =>
    state.pendingAnchor?.tabId === runtime.scope.id ? state.pendingAnchor.id : null,
  );

  useEffect(() => {
    const article = articleRef.current;
    const scroller = scrollerRef.current;
    if (!active || !article || !scroller) return;
    const headings = documentHeadings(article);
    const find = createMarkdownFindController(article, scroller);
    const releaseFind = navigation.claimFind(runtime.scope.id, ownerRef.current, find);
    const releaseOutline = navigation.claimOutline(runtime.scope.id, ownerRef.current);
    navigation.publishOutline(
      runtime.scope.id,
      ownerRef.current,
      { activeId: null, headings },
      (heading) =>
        article.querySelector<HTMLElement>(`#${CSS.escape(heading.id)}`)?.scrollIntoView(),
    );
    return () => {
      releaseFind();
      releaseOutline();
      find.dispose();
    };
  }, [active, html, navigation, runtime.scope.id]);

  useEffect(() => {
    if (!active || !pendingAnchor) return;
    const target = articleRef.current?.querySelector<HTMLElement>(`#${CSS.escape(pendingAnchor)}`);
    if (!target) return;
    target.scrollIntoView({ block: 'start' });
    navigation.consumeAnchor(runtime.scope.id, pendingAnchor);
  }, [active, navigation, pendingAnchor, runtime.scope.id]);

  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    const route = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a');
      if (!anchor) return;
      event.preventDefault();
      const target = resolveDocumentLink(anchor.getAttribute('href') ?? '', runtime.scope.source);
      if (target.kind === 'anchor') {
        onNavigate({ anchor: target.id, source: runtime.scope.source });
      } else if (target.kind === 'source') {
        onNavigate({ anchor: target.anchor, source: target.source });
      } else if (target.kind === 'external') {
        setLinkFailed(false);
        void onOpenExternal(target.href)
          .then((opened) => setLinkFailed(!opened))
          .catch(() => setLinkFailed(true));
      }
    };
    article.addEventListener('click', route);
    return () => article.removeEventListener('click', route);
  }, [onNavigate, onOpenExternal, runtime.scope.source]);

  // The link notice floats over the pane, outside the scroller, so a reader
  // scrolled down still sees it.
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <LinkFailureNotice failed={linkFailed} onDismiss={() => setLinkFailed(false)} />
      <div
        className="relative min-h-0 flex-1 overflow-auto bg-surface-2 p-5 max-sm:p-0"
        data-document-scroller
        ref={scrollerRef}
      >
        {/* Off-screen prose blocks skip layout and paint, as in Markdown. */}
        <article
          aria-label={`${name} document content`}
          className="overflow-wrap-anywhere mx-auto min-h-full max-w-[56rem] bg-white px-[clamp(1.5rem,6vw,5rem)] py-[clamp(2rem,5vw,4.5rem)] font-sans text-base leading-[1.6] text-neutral-800 shadow-surface-3 max-sm:shadow-none [&_a]:text-inherit [&_a]:underline [&_a]:decoration-neutral-400 [&_a]:underline-offset-[0.18em] [&_a:hover]:decoration-current [&_blockquote]:my-3 [&_blockquote]:ml-0 [&_blockquote]:border-l-[3px] [&_blockquote]:border-neutral-300 [&_blockquote]:pl-4 [&_blockquote]:text-neutral-600 [&_code]:font-mono [&_code]:text-[0.9em] [&_h1]:mt-[1.6em] [&_h1]:mb-[0.55em] [&_h1]:text-[2rem] [&_h1]:leading-tight [&_h1]:font-semibold [&_h1]:tracking-[-0.035em] [&_h2]:mt-[1.6em] [&_h2]:mb-[0.55em] [&_h2]:text-2xl [&_h2]:leading-tight [&_h2]:font-semibold [&_h2]:tracking-[-0.025em] [&_h3]:mt-[1.6em] [&_h3]:mb-[0.55em] [&_h3]:text-lg [&_h3]:leading-tight [&_h3]:font-semibold [&_h4]:mt-[1.6em] [&_h4]:mb-[0.55em] [&_h4]:text-lg [&_h4]:leading-tight [&_h4]:font-semibold [&_h5]:mt-[1.6em] [&_h5]:mb-[0.55em] [&_h5]:text-lg [&_h5]:leading-tight [&_h5]:font-semibold [&_h6]:mt-[1.6em] [&_h6]:mb-[0.55em] [&_h6]:text-lg [&_h6]:leading-tight [&_h6]:font-semibold [&_img]:h-auto [&_img]:max-w-full [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_pre]:my-3 [&_pre]:overflow-auto [&_pre]:bg-neutral-100 [&_pre]:p-4 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-neutral-300 [&_td]:p-2 [&_td]:text-left [&_td]:align-top [&_th]:border [&_th]:border-neutral-300 [&_th]:p-2 [&_th]:text-left [&_th]:align-top [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&>:where(p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote)]:[contain-intrinsic-size:auto_2lh] [&>:where(p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote)]:[content-visibility:auto]"
          dangerouslySetInnerHTML={{ __html: html }}
          ref={articleRef}
        />
      </div>
    </div>
  );
}

export function DocxDocument({
  active,
  api,
  name,
  navigation,
  onNavigate,
  onOpenExternal,
  resource,
  runtime,
}: {
  active: boolean;
  api: DocxPreviewPort;
  name: string;
  navigation: DocumentNavigationRuntime;
  onNavigate(target: { anchor?: string | undefined; source: SourceReference }): void;
  onOpenExternal(href: string): Promise<boolean>;
  resource: DocxDocumentAsset;
  runtime: DocumentRuntime;
}) {
  const preview = useQuery({
    ...docxPreviewQuery(api, runtime.scope, resource),
    enabled: active,
  });

  if (preview.isPending) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center text-caption text-muted-foreground"
        role="status"
      >
        Opening {name}
      </div>
    );
  }

  if (!preview.data || preview.isError) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <NoticeStrip action={{ label: 'Retry', onAct: () => void preview.refetch() }} role="alert">
          {documentFailure(preview.error, 'DocxPreviewError', DOCX_PREVIEW_MESSAGES).message}
        </NoticeStrip>
        <SandboxedHtmlFrame
          active={active}
          name={name}
          navigation={navigation}
          onNavigate={onNavigate}
          onOpenExternal={onOpenExternal}
          source={runtime.scope.source}
          tabId={runtime.scope.id}
          trustedLinks
          url={resource.fallbackUrl}
        />
      </div>
    );
  }

  return (
    <DirectDocxDocument
      active={active}
      html={preview.data.html}
      name={name}
      navigation={navigation}
      onNavigate={onNavigate}
      onOpenExternal={onOpenExternal}
      runtime={runtime}
    />
  );
}
