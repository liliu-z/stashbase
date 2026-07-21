import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  PDFWorker,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist';
// Load the worker via Vite's `?worker` so we can wrap it with the
// Map-upsert polyfill pdfjs 5.7 needs but Electron's V8 lacks (see
// `lib/pdfWorker.ts` / `lib/pdfPolyfill.ts`). `?worker` bundles the
// worker for both dev and the packaged build, unlike a bare `?url`.
import PdfWorker from '../lib/pdfWorker?worker';
import { api, errorMessage, versionedAssetUrl } from '../api';
import { preparationWaitCopy } from '../preparation-copy.ts';
import { useApp } from '../store/AppContext';
import { getFileReadiness } from '../store/fileReadiness';
import {
  cleanPdfSearchText,
  exactPageForHighlight,
  findPdfChunkMatch,
  flattenPageText,
  foldPdfText,
  highlightRectsForMatch,
  yRatioForIndex,
  type FlatPage,
  type PdfHighlightRect,
  type PdfPageHighlight,
} from './pdfText';

// Polyfill the main-thread scope too — render() calls getOrInsertComputed
// synchronously before it ever talks to the worker.
import '../lib/pdfPolyfill';

// One shared worker for the viewer, owned by US (a PDFWorker we construct)
// rather than handed to pdfjs via `GlobalWorkerOptions.workerPort`. The
// distinction is load-bearing: a `workerPort` worker is owned by whichever
// loadingTask is created over it, so `loadingTask.destroy()` — fired by the
// load effect's cleanup on tab close AND on React StrictMode's dev
// mount→unmount→mount — terminates the shared worker thread. The next
// getDocument then hits "PDFWorker.create - the worker is being destroyed".
// A worker passed explicitly to getDocument is NOT owned by the task, so
// destroy() tears down only the document and the thread survives every reopen.
// (PDFWorker.create over `new PDFWorker({ port })` only because the latter's
// generated d.ts mistypes `port` as null; both wrap the same port instance.)
const pdfWorker = PDFWorker.create({ port: new PdfWorker() });
const PDF_FIT_SIDE_PADDING = 48;
const PDF_MIN_SCALE = 0.5;
const PDF_MAX_SCALE = 3;
const PDFJS_ASSET_BASE = '/pdfjs-assets';

/**
 * PDF viewer built on pdfjs-dist's programmatic API. Renders every
 * page as a canvas in a single scrollable column so search /
 * chunk-highlight scrolling lands on the right page without virtual-
 * scroll bookkeeping. Pages render lazily once they enter (or come
 * within one viewport of) the visible area — bundle size win on
 * large papers.
 *
 * Two things this component is responsible for, neither of which the
 * out-of-the-box pdfjs viewer.html gives us cleanly:
 *   1. Failure banner sourced from `state.db` so users can reprocess a
 *      failed PDF in-context, not from a separate failure list.
 *   2. Chunk text search — when a search hit on a PDF-derived HTML
 *      file co-opens the PDF, we call into the find controller with
 *      the chunk text so the PDF jumps to the same passage.
 */
export function PdfPreview({ name, showConversionBanner = true }: { name: string; showConversionBanner?: boolean }) {
  const { state, actions, activeTab } = useApp();
  const pendingHighlight = activeTab?.pendingHighlight ?? null;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const currentRef = useRef({ folderPath: state.folderPath, name });
  currentRef.current = { folderPath: state.folderPath, name };
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [autoFit, setAutoFit] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryStarted, setRetryStarted] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [pageHighlight, setPageHighlight] = useState<PdfPageHighlight | null>(null);
  const readiness = getFileReadiness(state, name);
  const failure = readiness.preparationFailure;
  const conversionProgress = state.conversionProgress[name];
  const chromeStatus = failure && showConversionBanner
    ? {
        kind: 'error' as const,
        text: retryError
          ? 'This PDF is not searchable. Reprocess could not start. Try again.'
          : 'This PDF is not searchable. Reprocess it to try again.',
      }
    : showConversionBanner && conversionProgress
      ? {
          kind: 'working' as const,
          text: conversionProgress.phase === 'queued'
            ? preparationWaitCopy('searchable-text', conversionProgress.tasksAhead)
            : conversionProgress.phase === 'yielded'
              ? preparationWaitCopy('searchable-text', conversionProgress.tasksAhead)
            : conversionProgress.phase === 'indexing'
              ? 'Indexing searchable text…'
              : conversionProgress.currentPage
                ? `Reading page ${conversionProgress.currentPage}…`
                : 'Preparing searchable text…',
        }
      : null;
  const retryInProgress = retryBusy || retryStarted;
  // Sampled page 1 viewport at 1× scale. Used as the per-page
  // placeholder height so the lazy-rendered pages reserve the
  // correct layout slot up front — without this, scrolling to a
  // chunk would mis-fire by hundreds of pixels whenever the target
  // page hadn't rendered yet (placeholder 800px vs. real ~1100px
  // shifts everything below). All pages in a typical paper share
  // the same page size, so a single sample is enough.
  const [pageMetrics, setPageMetrics] = useState<{ width: number; height: number } | null>(null);

  // Stable URL for this PDF + cache-bust so reopening after a Retry
  // re-fetches the binary instead of the stale 404 / failed body.
  const sourceVersion = activeTab?.file?.name === name ? activeTab.file.version ?? '' : '';
  const fileUrl = useMemo(
    () => versionedAssetUrl(name, sourceVersion),
    [name, sourceVersion],
  );

  function scrollToPage(pageNumber: number, behavior: ScrollBehavior = 'smooth') {
    const root = containerRef.current;
    if (!root || numPages <= 0) return;
    const targetPage = Math.max(1, Math.min(numPages, Math.round(pageNumber)));
    const target = root.querySelector(`[data-page="${targetPage}"]`) as HTMLElement | null;
    if (!target) return;
    root.scrollTo({
      top: Math.max(0, target.offsetTop - root.clientHeight * 0.08),
      behavior,
    });
    setCurrentPage(targetPage);
  }

  function fitScale(): number {
    const viewportWidth = containerRef.current?.clientWidth ?? 0;
    const pageWidth = pageMetrics?.width ?? 0;
    if (viewportWidth <= 0 || pageWidth <= 0) return 1;
    const available = Math.max(1, viewportWidth - PDF_FIT_SIDE_PADDING);
    return Math.max(PDF_MIN_SCALE, Math.min(PDF_MAX_SCALE, available / pageWidth));
  }

  // Load PDF on name change.
  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof getDocument> | null = null;
    setError(null);
    setDoc(null);
    setNumPages(0);
    setCurrentPage(1);
    setPageMetrics(null);
    setScale(1);
    setAutoFit(true);
    setPageHighlight(null);
    setRetryBusy(false);
    setRetryStarted(false);
    setRetryError(null);
    loadingTask = getDocument({
      url: fileUrl,
      worker: pdfWorker,
      cMapUrl: `${PDFJS_ASSET_BASE}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS_ASSET_BASE}/standard_fonts/`,
      wasmUrl: `${PDFJS_ASSET_BASE}/wasm/`,
      useWorkerFetch: true,
      // Some creator-generated PDFs embed subset TrueType fonts whose
      // browser FontFace rendering maps glyphs incorrectly in Chromium.
      // Let pdf.js draw glyph outlines itself instead.
      disableFontFace: true,
    });
    loadingTask.promise.then(
      (pdf) => {
        if (cancelled) { void pdf.destroy(); return; }
        setDoc(pdf);
        setNumPages(pdf.numPages);
        // Sample page 1 size for placeholder heights — see pageMetrics.
        void pdf.getPage(1).then((p) => {
          if (cancelled) return;
          const vp = p.getViewport({ scale: 1 });
          setPageMetrics({ width: vp.width, height: vp.height });
        }).catch(() => { /* keep falling back to the 800px default */ });
      },
      (err: Error) => {
        if (cancelled) return;
        setError(err?.message || 'failed to open PDF');
      },
    );
    return () => {
      cancelled = true;
      if (loadingTask) loadingTask.destroy().catch(() => { /* ignore */ });
    };
  }, [fileUrl, actions]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root || numPages <= 0) return;
    let frame = 0;
    const updateCurrentPage = () => {
      frame = 0;
      const rootRect = root.getBoundingClientRect();
      const markerY = rootRect.top + Math.min(root.clientHeight * 0.35, 160);
      let bestPage = 1;
      let bestDistance = Number.POSITIVE_INFINITY;
      const pages = root.querySelectorAll<HTMLElement>('[data-page]');
      pages.forEach((pageEl) => {
        const page = Number(pageEl.dataset.page);
        if (!Number.isFinite(page)) return;
        const rect = pageEl.getBoundingClientRect();
        const topDistance = Math.abs(rect.top - markerY);
        const insideDistance = rect.top <= markerY && rect.bottom >= markerY ? 0 : topDistance;
        if (insideDistance < bestDistance) {
          bestDistance = insideDistance;
          bestPage = page;
        }
      });
      setCurrentPage((prev) => (prev === bestPage ? prev : bestPage));
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateCurrentPage);
    };
    updateCurrentPage();
    root.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      root.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [doc, numPages, scale]);

  useEffect(() => {
    if (!autoFit || !pageMetrics) return;
    setScale(fitScale());
  }, [autoFit, pageMetrics]);

  useEffect(() => {
    if (!autoFit) return;
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(fitScale()));
    ro.observe(el);
    return () => ro.disconnect();
  }, [autoFit, pageMetrics]);

  useEffect(() => {
    if (!failure || state.pendingConversions.includes(name)) setRetryStarted(false);
  }, [failure, name, state.pendingConversions]);

  // Search for the chunk text across pages and scroll directly to
  // the matched paragraph (not just the page top).
  //
  // Two robustness measures, on top of the per-page placeholder
  // trick that keeps target.offsetTop stable:
  //   1. Both the chunk text and the pdfjs flat text get stripped
  //      of markdown noise (bold / italic / links / code) and have
  //      Unicode variants (smart quotes, dash variants) folded to
  //      ASCII. Without this, a chunk like "**Figure 1:** Training
  //      loss" never matches the PDF's "Figure 1: Training loss".
  //   2. If the first ~60 chars don't hit, we retry with a slice
  //      from the middle and one from the end. PDF column boundaries
  //      and pymupdf4llm's paragraph reflowing can leave the head
  //      of a chunk unrecognisable in pdfjs's reading order.
  useEffect(() => {
    if (!doc || !pendingHighlight?.chunkText) return;
    let cancelled = false;
    const cleaned = cleanPdfSearchText(pendingHighlight.chunkText);
    if (!cleaned) { actions.consumePendingHighlight(); return; }

    void (async () => {
      let best: { page: number; idx: number; length: number; score: number; fp: FlatPage } | null = null;
      for (let i = 0; i < numPages; i++) {
        if (cancelled) return;
        try {
          const page = await doc.getPage(i + 1);
          const fp = await flattenPageText(page);
          const match = findPdfChunkMatch(fp, pendingHighlight.chunkText);
          if (!match) continue;
          if (!best || match.score > best.score) {
            best = { page: i + 1, idx: match.idx, length: match.length, score: match.score, fp };
            if (match.score >= 800) break;
          }
        } catch { /* skip page */ }
      }
      if (cancelled || !best) {
        if (!cancelled) {
          const fallbackPage = exactPageForHighlight(pendingHighlight, numPages);
          const root = containerRef.current;
          const target = fallbackPage
            ? root?.querySelector(`[data-page="${fallbackPage}"]`) as HTMLElement | null
            : null;
          if (root && target && fallbackPage) {
            setPageHighlight(null);
            setCurrentPage(fallbackPage);
            root.scrollTo({
              top: Math.max(0, target.offsetTop - root.clientHeight * 0.12),
              behavior: 'smooth',
            });
            actions.consumePendingHighlight();
          }
        }
        return;
      }
      const yRatio = yRatioForIndex(best.fp, best.idx);
      const rects = highlightRectsForMatch(best.fp, best.idx, best.length);
      setPageHighlight(rects.length > 0 ? { page: best.page, rects } : null);
      setCurrentPage(best.page);
      const root = containerRef.current;
      const target = root?.querySelector(`[data-page="${best.page}"]`) as HTMLElement | null;
      if (root && target) {
        const renderedHeight = target.offsetHeight;
        const desiredScroll = target.offsetTop
          + yRatio * renderedHeight
          - root.clientHeight * 0.3;
        root.scrollTo({ top: Math.max(0, desiredScroll), behavior: 'smooth' });
      }
      actions.consumePendingHighlight();
    })();
    return () => { cancelled = true; };
  }, [doc, numPages, pendingHighlight, actions]);

  // FindBar integration — registers a Cmd+F-driven controller so the
  // user can search PDFs the same way they search MD / HTML / code.
  // The controller scans pdfjs text content across all pages, builds
  // an in-memory list of match positions, and jumps to each one on
  // next / prev. No overlay or per-match highlight (pdfjs canvas
  // rendering doesn't host DOM-selectable spans) — the FindBar's
  // "N of M" counter + scroll-on-jump carries the navigation; the
  // user's eye picks the match on the page.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    type PdfMatch = { page: number; yRatio: number; rects: PdfHighlightRect[] };
    const state: { matches: PdfMatch[]; current: number } = { matches: [], current: 0 };

    function escapeRegExp(s: string): string {
      return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    function scrollTo(m: PdfMatch) {
      const root = containerRef.current;
      const target = root?.querySelector(`[data-page="${m.page}"]`) as HTMLElement | null;
      if (!root || !target) return;
      const rendered = target.offsetHeight;
      const desired = target.offsetTop + m.yRatio * rendered - root.clientHeight * 0.3;
      setPageHighlight(m.rects.length > 0 ? { page: m.page, rects: m.rects } : null);
      setCurrentPage(m.page);
      root.scrollTo({ top: Math.max(0, desired), behavior: 'smooth' });
    }
    async function rebuild(query: string, wholeWord: boolean, caseSensitive: boolean): Promise<void> {
      state.matches = [];
      state.current = 0;
      const needle = foldPdfText(query).trim();
      if (!needle) return;
      const re = wholeWord
        ? new RegExp(`\\b${escapeRegExp(needle)}\\b`, caseSensitive ? 'g' : 'gi')
        : null;
      for (let i = 0; i < numPages; i++) {
        if (cancelled) return;
        try {
          const page = await doc!.getPage(i + 1);
          const fp = await flattenPageText(page);
          const flat = fp.flat;
          function emit(idx: number, length: number) {
            state.matches.push({
              page: i + 1,
              yRatio: yRatioForIndex(fp, idx),
              rects: highlightRectsForMatch(fp, idx, length),
            });
          }
          if (re) {
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(flat)) !== null) {
              emit(m.index, m[0].length);
              if (re.lastIndex === m.index) re.lastIndex += 1;
            }
          } else {
            const needleCmp = caseSensitive ? needle : needle.toLowerCase();
            const flatCmp = caseSensitive ? flat : flat.toLowerCase();
            let from = 0;
            while (true) {
              const idx = flatCmp.indexOf(needleCmp, from);
              if (idx === -1) break;
              emit(idx, needle.length);
              from = idx + needleCmp.length;
            }
          }
        } catch { /* skip page */ }
      }
    }

    actions.registerFindController({
      setQuery: async (q, { wholeWord, caseSensitive }) => {
        await rebuild(q, wholeWord, caseSensitive);
        if (state.matches.length === 0) return { current: 0, total: 0 };
        scrollTo(state.matches[0]);
        return { current: 1, total: state.matches.length };
      },
      next: () => {
        if (state.matches.length === 0) return { current: 0, total: 0 };
        state.current = (state.current + 1) % state.matches.length;
        scrollTo(state.matches[state.current]);
        return { current: state.current + 1, total: state.matches.length };
      },
      prev: () => {
        if (state.matches.length === 0) return { current: 0, total: 0 };
        state.current = (state.current - 1 + state.matches.length) % state.matches.length;
        scrollTo(state.matches[state.current]);
        return { current: state.current + 1, total: state.matches.length };
      },
      close: () => {
        state.matches = [];
        state.current = 0;
        setPageHighlight(null);
      },
    });

    return () => {
      cancelled = true;
      actions.registerFindController(null);
    };
  }, [doc, numPages, actions]);

  async function onRetry() {
    setRetryBusy(true);
    setRetryError(null);
    const folderPathAtStart = state.folderPath;
    const nameAtStart = name;
    const stillCurrent = () =>
      currentRef.current.folderPath === folderPathAtStart && currentRef.current.name === nameAtStart;
    try {
      await api.reprocessFile(name, { folder: folderPathAtStart || undefined });
      if (!stillCurrent()) return;
      setRetryStarted(true);
    } catch (err: unknown) {
      if (!stillCurrent()) return;
      setRetryError(errorMessage(err));
      setRetryStarted(false);
    } finally {
      if (stillCurrent()) setRetryBusy(false);
    }
  }

  return (
    <div className="pdf-preview" ref={containerRef}>
      {error && <div className="pdf-error">Failed to open PDF: {error}</div>}
      {!error && !doc && <div className="pdf-loading">Loading PDF…</div>}
      <PdfChromePortal
        scale={scale}
        currentPage={currentPage}
        numPages={numPages}
        status={chromeStatus}
        retryLabel={retryInProgress ? 'Reprocessing…' : 'Reprocess'}
        retryDisabled={retryInProgress}
        onRetry={failure && showConversionBanner ? onRetry : undefined}
        onFit={() => {
          setAutoFit(true);
          setScale(fitScale());
        }}
        onZoomOut={() => {
          setAutoFit(false);
          setScale((s) => Math.max(PDF_MIN_SCALE, s - 0.2));
        }}
        onZoomIn={() => {
          setAutoFit(false);
          setScale((s) => Math.min(PDF_MAX_SCALE, s + 0.2));
        }}
        onJumpToPage={scrollToPage}
      />
      <div className="pdf-pages">
        {doc && Array.from({ length: numPages }, (_, i) => (
          <PdfPage
            key={`p-${i}`}
            doc={doc}
            pageIndex={i}
            scale={scale}
            placeholderHeight={pageMetrics ? pageMetrics.height * scale : 800}
            highlight={pageHighlight?.page === i + 1 ? pageHighlight : null}
            isCurrent={currentPage === i + 1}
          />
        ))}
      </div>
    </div>
  );
}

/** Render the PDF chrome (zoom controls + page count) into the
 *  `#pdf-chrome-slot` MainPane mounts at the top-right of the
 *  breadcrumb row — replaces the old "second toolbar row" so the
 *  viewer doesn't waste vertical folder on what's effectively chrome.
 *  Falls back to inline rendering if MainPane hasn't mounted yet
 *  (initial render race). */
function PdfChromePortal({
  scale,
  currentPage,
  numPages,
  status,
  retryLabel,
  retryDisabled,
  onRetry,
  onFit,
  onZoomOut,
  onZoomIn,
  onJumpToPage,
}: {
  scale: number;
  currentPage: number;
  numPages: number;
  status: { kind: 'error' | 'working'; text: string } | null;
  retryLabel: string;
  retryDisabled: boolean;
  onRetry?: () => void;
  onFit: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onJumpToPage: (page: number) => void;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [editingPage, setEditingPage] = useState(false);
  const [pageInput, setPageInput] = useState('');
  // Resolve the portal target once on mount — MainPane renders the
  // `#pdf-chrome-slot` div alongside this viewer, so it's present by the
  // time this effect runs. (No deps: a per-render getElementById is
  // wasteful and the slot doesn't move.)
  useEffect(() => {
    setSlot(document.getElementById('pdf-chrome-slot'));
  }, []);
  useEffect(() => {
    if (!editingPage) setPageInput(String(currentPage));
  }, [currentPage, editingPage]);

  function submitPageJump() {
    const page = Number(pageInput.trim());
    if (!Number.isFinite(page)) {
      setPageInput(String(currentPage));
      setEditingPage(false);
      return;
    }
    onJumpToPage(page);
    setEditingPage(false);
  }

  const chrome = (
    <div className="pdf-chrome">
      <div className={'pdf-search-status' + (status ? ` ${status.kind}` : '')} role={status ? 'status' : undefined}>
        {status?.text ?? ''}
        {status?.kind === 'error' && onRetry && (
          <button
            type="button"
            className="pdf-search-retry"
            disabled={retryDisabled}
            onClick={() => { void onRetry(); }}
          >
            {retryLabel}
          </button>
        )}
      </div>
      <div className="pdf-zoom-controls">
        <button type="button" className="icon-btn" title="Zoom out" onClick={onZoomOut}>−</button>
        <span className="pdf-zoom">{Math.round(scale * 100)}%</span>
        <button type="button" className="icon-btn" title="Zoom in" onClick={onZoomIn}>+</button>
        <button type="button" className="pdf-fit-btn" title="Fit to width" onClick={onFit}>Fit</button>
        {numPages > 0 && (
          editingPage ? (
            <span className="pdf-pagejump">
              <span>Page</span>
              <input
                autoFocus
                value={pageInput}
                inputMode="numeric"
                aria-label="PDF page number"
                onChange={(e) => setPageInput(e.target.value)}
                onBlur={submitPageJump}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitPageJump();
                  if (e.key === 'Escape') {
                    setPageInput(String(currentPage));
                    setEditingPage(false);
                  }
                }}
              />
              <span>/ {numPages}</span>
            </span>
          ) : (
            <button
              type="button"
              className="pdf-pageinfo"
              title="Jump to page"
              onClick={() => {
                setPageInput(String(currentPage));
                setEditingPage(true);
              }}
            >
              Page {currentPage} / {numPages}
            </button>
          )
        )}
      </div>
    </div>
  );
  return slot ? createPortal(chrome, slot) : null;
}

/** Render a single PDF page into a canvas with text layer on top so
 *  selection + find work. Mounted lazily via IntersectionObserver so
 *  the long-tail of pages in a 200-page paper doesn't eat memory. */
function PdfPage({
  doc,
  pageIndex,
  scale,
  placeholderHeight,
  highlight,
  isCurrent,
}: {
  doc: PDFDocumentProxy;
  pageIndex: number;
  scale: number;
  placeholderHeight: number;
  highlight: PdfPageHighlight | null;
  isCurrent: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(pageIndex < 2); // eager-render first 2 pages
  const [renderedSize, setRenderedSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || visible) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { setVisible(true); io.disconnect(); break; }
      }
    }, { rootMargin: '500px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let pageProxy: PDFPageProxy | null = null;
    let renderTask: ReturnType<PDFPageProxy['render']> | null = null;
    void doc.getPage(pageIndex + 1).then((page) => {
      if (cancelled) {
        page.cleanup();
        return;
      }
      pageProxy = page;
      // Canonical pdfjs HiDPI pattern: size the backing store by the
      // device pixel ratio, keep the CSS box at logical size, and let a
      // `transform` matrix scale the drawing up.
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const logicalWidth = Math.floor(viewport.width);
      const logicalHeight = Math.floor(viewport.height);
      const backingWidth = Math.floor(viewport.width * ratio);
      const backingHeight = Math.floor(viewport.height * ratio);
      const renderCanvas = document.createElement('canvas');
      renderCanvas.width = backingWidth;
      renderCanvas.height = backingHeight;
      renderTask = page.render({
        canvas: renderCanvas,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      renderTask.promise.then(() => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        // Resizing a visible canvas clears it immediately. Render the new
        // zoom level offscreen first, then swap the finished bitmap in one
        // frame so zooming does not flash white between old/new paints.
        canvas.width = backingWidth;
        canvas.height = backingHeight;
        canvas.style.width = `${logicalWidth}px`;
        canvas.style.height = `${logicalHeight}px`;
        ctx.drawImage(renderCanvas, 0, 0);
        setRenderedSize({ width: logicalWidth, height: logicalHeight });
      }).catch((err: unknown) => {
        // Cancels (tab switch / scroll-out) reject with
        // RenderingCancelledException — expected, ignore. Surface the rest.
        if ((err as { name?: string })?.name === 'RenderingCancelledException') return;
        console.error(`[pdf] page ${pageIndex + 1} render failed:`, err);
      });
    });
    return () => {
      cancelled = true;
      if (renderTask) renderTask.cancel();
      if (pageProxy) pageProxy.cleanup();
    };
  }, [doc, pageIndex, scale, visible]);

  const reservedHeight = renderedSize?.height ?? placeholderHeight;
  const reservedWidth = renderedSize?.width;

  return (
    <div
      ref={rootRef}
      className="pdf-page-wrap"
      data-page={pageIndex + 1}
      style={{
        minHeight: reservedHeight,
        width: reservedWidth ? `${reservedWidth}px` : undefined,
      }}
    >
      {visible ? <canvas ref={canvasRef} className="pdf-page-canvas" /> : (
        <div className="pdf-page-placeholder">Page {pageIndex + 1}</div>
      )}
      <div className={'pdf-page-number' + (isCurrent ? ' current' : '')} aria-hidden="true">
        p. {pageIndex + 1}
      </div>
      {visible && renderedSize && highlight && (
        <div className="pdf-page-highlight-layer" aria-hidden="true">
          {highlight.rects.map((rect, i) => (
            <div
              key={i}
              className="pdf-page-highlight"
              style={{
                left: `${rect.x * renderedSize.width}px`,
                top: `${rect.y * renderedSize.height}px`,
                width: `${rect.width * renderedSize.width}px`,
                height: `${rect.height * renderedSize.height}px`,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
