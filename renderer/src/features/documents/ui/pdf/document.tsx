/**
 * PDF viewing: pages render lazily at the current scale, the reader's page is
 * remembered on the document runtime, and Find is served by pdf.js text
 * content rather than the DOM.
 */
import { Maximize2, Minus, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DocumentRuntime } from '@/features/documents/application/document-runtime';
import type { DocumentNavigationRuntime } from '@/features/documents/application/navigation-runtime';
import type { DocumentAsset } from '@/features/documents/application/ports';

import './document.css';
import { AssetStatus } from '@/features/documents/ui/source/status';
import {
  ViewerToolbar,
  ViewerToolbarButton,
  ViewerToolbarValue,
} from '@/features/documents/ui/viewer-toolbar';
import { clamp } from '@/shared/utils/clamp';

import { createPdfFindController, type PdfFindMatch } from './find-controller';
import { openPdfDocument } from './loader';
import { PdfPage } from './page';
import { usePdfDocument } from './use-pdf-document';

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const FALLBACK_PAGE_SIZE = { height: 792, width: 612 };

function PdfViewer({
  name,
  navigation,
  onRetry,
  runtime,
  url,
}: {
  name: string;
  navigation: DocumentNavigationRuntime;
  onRetry(): void;
  runtime: DocumentRuntime;
  url: string;
}) {
  const pdf = usePdfDocument(url, openPdfDocument);
  const initialPage = runtime.store.getState().pdfPage;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const owner = useRef(Symbol('pdf-find'));
  const restoredUrl = useRef<string | null>(null);
  const frame = useRef(0);
  const [scale, setScale] = useState(1);
  const [fit, setFit] = useState(true);
  const [currentPage, setCurrentPage] = useState(initialPage);

  const pageSize = pdf.pageSize ?? FALLBACK_PAGE_SIZE;
  const fitScale = useCallback(() => {
    const width = scrollerRef.current?.clientWidth ?? 0;
    if (width <= 0) return 1;
    return clamp((width - 32) / pageSize.width, MIN_SCALE, MAX_SCALE);
  }, [pageSize.width]);

  useEffect(() => {
    setFit(true);
    setScale(1);
    const page = runtime.store.getState().pdfPage;
    setCurrentPage(page);
    restoredUrl.current = null;
  }, [runtime, url]);

  useEffect(() => {
    if (!fit || !pdf.document) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const update = () => setScale(fitScale());
    update();
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [fit, fitScale, pdf.document]);

  const scrollToPage = useCallback(
    (match: Pick<PdfFindMatch, 'page'> & { yRatio?: number }) => {
      const scroller = scrollerRef.current;
      const page = scroller?.querySelector<HTMLElement>(`[data-page="${match.page}"]`);
      if (!scroller || !page) return;
      const y = match.yRatio ?? 0;
      scroller.scrollTo({
        behavior: 'auto',
        top: Math.max(0, page.offsetTop + page.offsetHeight * y - scroller.clientHeight * 0.3),
      });
      setCurrentPage(match.page);
      runtime.setPdfPage(match.page);
    },
    [runtime],
  );

  useEffect(() => {
    if (!pdf.document || restoredUrl.current === url) return;
    restoredUrl.current = url;
    const savedPage = runtime.store.getState().pdfPage;
    const restore = () => scrollToPage({ page: Math.min(savedPage, pdf.document?.numPages ?? 1) });
    const animation = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(animation);
  }, [pdf.document, runtime, scrollToPage, url]);

  useEffect(() => {
    const document = pdf.document;
    if (!document) return;
    const controller = createPdfFindController(document, scrollToPage);
    const release = navigation.claimFind(runtime.scope.id, owner.current, controller);
    return () => {
      release();
      controller.dispose();
    };
  }, [navigation, pdf.document, runtime.scope.id, scrollToPage]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !pdf.document) return;
    const update = () => {
      frame.current = 0;
      const marker = scroller.scrollTop + Math.min(scroller.clientHeight * 0.35, 160);
      const pages = Array.from(scroller.querySelectorAll<HTMLElement>('[data-page]'));
      let closest = currentPage;
      let distance = Number.POSITIVE_INFINITY;
      for (const page of pages) {
        const pageNumber = Number(page.dataset.page);
        const nextDistance = Math.abs(page.offsetTop - marker);
        if (Number.isSafeInteger(pageNumber) && nextDistance < distance) {
          closest = pageNumber;
          distance = nextDistance;
        }
      }
      if (closest !== currentPage) {
        setCurrentPage(closest);
        runtime.setPdfPage(closest);
      }
    };
    const onScroll = () => {
      if (!frame.current) frame.current = requestAnimationFrame(update);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [currentPage, pdf.document, runtime]);

  if (pdf.loading) return <AssetStatus name={name} />;
  if (!pdf.document || pdf.error) {
    return (
      <AssetStatus
        detail={pdf.error ?? 'The PDF may have moved, changed, or be unreadable.'}
        failed
        name={name}
        retry={onRetry}
      />
    );
  }
  const document = pdf.document;

  const jump = (value: number) => {
    const page = clamp(Math.round(value), 1, document.numPages);
    scrollToPage({ page });
  };
  const zoomBy = (offset: number) => {
    setFit(false);
    setScale((value) => clamp(value + offset, MIN_SCALE, MAX_SCALE));
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-surface-2">
      <ViewerToolbar label="PDF controls">
        <div className="flex items-center gap-0.5 text-ui-12 leading-none text-muted-foreground tabular-nums">
          <ViewerToolbarValue
            align="end"
            editOnClick
            emphasis="default"
            label="Page number"
            max={document.numPages}
            min={1}
            onCommit={jump}
            style={{ width: `calc(${String(document.numPages).length}ch + 0.75rem)` }}
            title="Go to page"
            value={currentPage}
          />
          <span aria-label={`of ${document.numPages} pages`}>/ {document.numPages}</span>
        </div>
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
        <div aria-label="Zoom controls" className="flex items-center gap-0.5" role="group">
          <ViewerToolbarButton
            disabled={scale <= MIN_SCALE}
            label="Zoom out"
            onClick={() => zoomBy(-0.2)}
          >
            <Minus aria-hidden="true" />
          </ViewerToolbarButton>
          <ViewerToolbarValue
            label="Zoom percentage"
            max={MAX_SCALE * 100}
            min={MIN_SCALE * 100}
            onCommit={(value) => {
              setFit(false);
              setScale(clamp(value / 100, MIN_SCALE, MAX_SCALE));
            }}
            onSingleClick={() => {
              setFit(false);
              setScale(1);
            }}
            suffix="%"
            title="Actual size; double-click to set zoom"
            value={Math.round(scale * 100)}
            widthClass="w-12"
          />
          <ViewerToolbarButton
            disabled={scale >= MAX_SCALE}
            label="Zoom in"
            onClick={() => zoomBy(0.2)}
          >
            <Plus aria-hidden="true" />
          </ViewerToolbarButton>
          <ViewerToolbarButton
            active={fit}
            aria-pressed={fit}
            label="Fit to width"
            onClick={() => {
              setFit(true);
              setScale(fitScale());
            }}
          >
            <Maximize2 aria-hidden="true" />
          </ViewerToolbarButton>
        </div>
      </ViewerToolbar>
      <div
        aria-label={`${name} pages`}
        className="min-h-0 flex-1 overflow-auto"
        data-document-scroller
        ref={scrollerRef}
        role="region"
      >
        <div className="flex min-w-max flex-col items-center gap-4 px-4 pb-12">
          {Array.from({ length: document.numPages }, (_, index) => (
            <PdfPage
              document={document}
              key={index + 1}
              pageNumber={index + 1}
              placeholder={pageSize}
              scale={scale}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function PdfDocument({
  name,
  navigation,
  resource,
  runtime,
}: {
  name: string;
  navigation: DocumentNavigationRuntime;
  resource: DocumentAsset;
  runtime: DocumentRuntime;
}) {
  const [attempt, setAttempt] = useState(0);
  return (
    <PdfViewer
      key={`${resource.version}:${attempt}`}
      name={name}
      navigation={navigation}
      onRetry={() => setAttempt((current) => current + 1)}
      runtime={runtime}
      url={resource.url}
    />
  );
}
