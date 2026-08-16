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
import { preparationWaitCopy } from '../preparationCopy.ts';
import { useLatestRef } from '../hooks/useLatestRef';
import { useApp } from '../store/AppContext';
import { getFileReadiness } from '../store/fileReadiness';
import { makePdfFindController, scanPages } from './pdfFindController';
import {
  cleanPdfSearchText,
  currentPdfPageForViewport,
  exactPageForHighlight,
  findPdfChunkMatch,
  highlightRectsForMatch,
  yRatioForIndex,
  type FlatPage,
  type PdfPageHighlight,
} from './pdfText';

// Polyfill the main-thread scope too — render() calls getOrInsertComputed
// synchronously before it ever talks to the worker.
import '../lib/pdfPolyfill';
import { Button } from './ui/button';
import { Input } from './ui/input';

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
  const { consumePendingHighlight, registerFindController, updateTabPdfPage } = actions;
  const pendingHighlight = activeTab?.pendingHighlight ?? null;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const currentRef = useLatestRef({ folderPath: state.folderPath, name });
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(activeTab?.pdfPage ?? 1);
  const programmaticPageRef = useRef<number | null>(null);
  const [scale, setScale] = useState(1);
  const [autoFit, setAutoFit] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryStarted, setRetryStarted] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [pageHighlight, setPageHighlight] = useState<PdfPageHighlight | null>(null);
  const isExternal = activeTab?.file?.name === name && Boolean(activeTab.file.isExternal);
  const effectiveShowConversionBanner = showConversionBanner && !isExternal;
  const readiness = getFileReadiness(state, name);
  const failure = readiness.preparationFailure;
  const conversionProgress = state.conversionProgress[name];

  function getChromeStatus(): { kind: 'error' | 'working'; text: string } | null {
    if (failure && effectiveShowConversionBanner) {
      return {
        kind: 'error',
        text: retryError
          ? 'This PDF is not searchable. Reprocess could not start. Try again.'
          : 'This PDF is not searchable. Reprocess it to try again.',
      };
    }
    if (!effectiveShowConversionBanner || !conversionProgress) return null;
    if (conversionProgress.phase === 'queued' || conversionProgress.phase === 'yielded') {
      return { kind: 'working', text: preparationWaitCopy('searchable-text', conversionProgress.tasksAhead) };
    }
    if (conversionProgress.phase === 'indexing') {
      return { kind: 'working', text: 'Indexing searchable text…' };
    }
    if (conversionProgress.currentPage) {
      return { kind: 'working', text: `Reading page ${conversionProgress.currentPage}…` };
    }
    return { kind: 'working', text: 'Preparing searchable text…' };
  }
  const chromeStatus = getChromeStatus();
  const retryInProgress = retryBusy || retryStarted;
  const [loadError, setLoadError] = useState<string | null>(null);

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
  const sourceFolder = activeTab?.file?.name === name ? activeTab.file.folder : undefined;
  const sourceGrantId = activeTab?.file?.name === name ? activeTab.file.grantId : undefined;
  const fileUrl = useMemo(
    () => versionedAssetUrl(name, sourceVersion, sourceFolder, sourceGrantId),
    [name, sourceVersion, sourceFolder, sourceGrantId],
  );

  /** Single scroll owner for every jump-the-viewer path: page jumps, chunk-
   *  highlight landings, and find-match navigation. `anchor` is the fraction
   *  of the viewport height kept above the landing spot; `yRatio` (0 = page
   *  top, 1 = bottom) picks the spot inside the page. Passing `highlight`
   *  (null included) swaps the highlight overlay; omitting it leaves the
   *  overlay untouched. Returns false — and changes nothing — when the page
   *  element is not in the DOM. */
  function scrollToTarget(
    page: number,
    {
      yRatio = 0,
      anchor,
      behavior = 'smooth',
      highlight,
    }: {
      yRatio?: number;
      anchor: number;
      behavior?: ScrollBehavior;
      highlight?: PdfPageHighlight | null;
    },
  ): boolean {
    const root = containerRef.current;
    const target = root?.querySelector(`[data-page="${page}"]`) as HTMLElement | null;
    if (!root || !target) return false;
    if (highlight !== undefined) setPageHighlight(highlight);
    // During a smooth jump the viewport still crosses the old page. Keep that
    // transient geometry from overwriting the requested tab position before
    // the animation reaches its destination (or the user switches tabs).
    programmaticPageRef.current = behavior === 'smooth' ? page : null;
    setCurrentPage(page);
    root.scrollTo({
      top: Math.max(0, target.offsetTop + yRatio * target.offsetHeight - root.clientHeight * anchor),
      behavior,
    });
    return true;
  }

  function scrollToPage(pageNumber: number, behavior: ScrollBehavior = 'smooth') {
    if (numPages <= 0) return;
    const targetPage = Math.max(1, Math.min(numPages, Math.round(pageNumber)));
    if (!scrollToTarget(targetPage, { anchor: 0.08, behavior })) return;
    // Direct navigation must persist before the next pointer/keyboard event.
    // Waiting for the passive currentPage effect lets an immediate tab switch
    // unmount the viewer before the requested page reaches tab state.
    if (activeTab?.file?.format === 'pdf' && activeTab.pdfPage !== targetPage) {
      updateTabPdfPage(activeTab.id, targetPage);
    }
  }

  /** Fit means fill: the page takes the pane's full width, edge to edge.
   *  A side gutter here would be a strip of canvas the user never asked
   *  for — the canvas already shows above and between pages, which is
   *  where it does the job of separating one sheet from the next.
   *  `clientWidth` excludes a classic vertical scrollbar, so the fitted
   *  page can never provoke a horizontal one. */
  function fitScale(): number {
    const viewportWidth = containerRef.current?.clientWidth ?? 0;
    const pageWidth = pageMetrics?.width ?? 0;
    if (viewportWidth <= 0 || pageWidth <= 0) return 1;
    return Math.max(PDF_MIN_SCALE, Math.min(PDF_MAX_SCALE, viewportWidth / pageWidth));
  }

  // The binary loader is keyed only by the versioned source URL. App-level
  // command objects can change after unrelated polling or shell updates; they
  // must never destroy and recreate the live pdf.js document.
  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof getDocument> | null = null;
    setError(null);
    setDoc(null);
    setNumPages(0);
    setCurrentPage(activeTab?.pdfPage ?? 1);
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
  }, [fileUrl]);

  const initialScrollDone = useRef(false);
  useEffect(() => {
    initialScrollDone.current = false;
  }, [fileUrl]);

  useEffect(() => {
    if (!doc || !pageMetrics || numPages <= 0 || initialScrollDone.current) return;
    const root = containerRef.current;
    if (!root || root.clientWidth <= 0) return;

    // Wait for the auto-fit scale to settle before performing the initial scroll jump
    if (autoFit && Math.abs(scale - fitScale()) > 0.001) return;

    const targetPage = activeTab?.pdfPage ?? 1;
    if (targetPage > 1 && targetPage <= numPages) {
      const frame = requestAnimationFrame(() => {
        scrollToPage(targetPage, 'auto');
        initialScrollDone.current = true;
      });
      return () => cancelAnimationFrame(frame);
    } else {
      initialScrollDone.current = true;
    }
  }, [doc, pageMetrics, numPages, activeTab?.pdfPage, scale, autoFit]);

  useEffect(() => {
    if (activeTab && activeTab.file?.format === 'pdf' && activeTab.pdfPage !== currentPage) {
      updateTabPdfPage(activeTab.id, currentPage);
    }
  }, [currentPage, activeTab?.id, activeTab?.file?.format, activeTab?.pdfPage, updateTabPdfPage]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root || numPages <= 0) return;
    let frame = 0;
    const updateCurrentPage = () => {
      frame = 0;
      if (!initialScrollDone.current) return;
      const rootRect = root.getBoundingClientRect();
      const markerY = rootRect.top + Math.min(root.clientHeight * 0.35, 160);
      const pages = root.querySelectorAll<HTMLElement>('[data-page]');
      const bestPage = currentPdfPageForViewport({
        scrollTop: root.scrollTop,
        scrollHeight: root.scrollHeight,
        clientHeight: root.clientHeight,
        markerY,
        pages: Array.from(pages).flatMap((pageEl) => {
          const page = Number(pageEl.dataset.page);
          if (!Number.isFinite(page)) return [];
          const rect = pageEl.getBoundingClientRect();
          return [{ page, top: rect.top, bottom: rect.bottom }];
        }),
      });
      const programmaticPage = programmaticPageRef.current;
      if (programmaticPage !== null) {
        if (bestPage !== programmaticPage) return;
        programmaticPageRef.current = null;
      }
      setCurrentPage((prev) => (prev === bestPage ? prev : bestPage));
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateCurrentPage);
    };
    const finishProgrammaticScroll = () => {
      programmaticPageRef.current = null;
      schedule();
    };
    updateCurrentPage();
    root.addEventListener('scroll', schedule, { passive: true });
    root.addEventListener('scrollend', finishProgrammaticScroll, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      root.removeEventListener('scroll', schedule);
      root.removeEventListener('scrollend', finishProgrammaticScroll);
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
    if (!cleaned) { consumePendingHighlight(); return; }

    void (async () => {
      type ChunkMatch = { page: number; idx: number; length: number; score: number; fp: FlatPage };
      // Widened initializer: TS cannot see the closure assignment below,
      // so a bare `null` would narrow every later read to `never`.
      let best = null as ChunkMatch | null;
      await scanPages(doc, numPages, (page, fp) => {
        const match = findPdfChunkMatch(fp, pendingHighlight.chunkText);
        if (!match) return;
        if (!best || match.score > best.score) {
          best = { page, idx: match.idx, length: match.length, score: match.score, fp };
          if (match.score >= 800) return false;
        }
      }, () => cancelled);
      const found = best;
      if (cancelled || !found) {
        if (!cancelled) {
          const fallbackPage = exactPageForHighlight(pendingHighlight, numPages);
          if (fallbackPage && scrollToTarget(fallbackPage, { anchor: 0.12, highlight: null })) {
            consumePendingHighlight();
          }
        }
        return;
      }
      const yRatio = yRatioForIndex(found.fp, found.idx);
      const rects = highlightRectsForMatch(found.fp, found.idx, found.length);
      scrollToTarget(found.page, {
        yRatio,
        anchor: 0.3,
        highlight: rects.length > 0 ? { page: found.page, rects } : null,
      });
      consumePendingHighlight();
    })();
    return () => { cancelled = true; };
  }, [doc, numPages, pendingHighlight, consumePendingHighlight]);

  // FindBar integration — registers a Cmd+F-driven controller so the user
  // can search PDFs the same way they search MD / HTML / code. The match
  // scan and navigation state live in pdfFindController; this effect only
  // wires its callbacks to viewer scroll/highlight state and tears the
  // registration down with the document.
  useEffect(() => {
    if (!doc) return;
    const { controller, dispose } = makePdfFindController({
      doc,
      numPages,
      onActiveMatch: (match) => {
        scrollToTarget(match.page, {
          yRatio: match.yRatio,
          anchor: 0.3,
          highlight: match.rects.length > 0 ? { page: match.page, rects: match.rects } : null,
        });
      },
      onClose: () => setPageHighlight(null),
    });
    registerFindController(controller);
    return () => {
      dispose();
      registerFindController(null);
    };
  }, [doc, numPages, registerFindController]);

  async function onRetry() {
    setRetryBusy(true);
    setRetryError(null);
    const folderPathAtStart = state.folderPath;
    const nameAtStart = name;
    const stillCurrent = () =>
      currentRef.current.folderPath === folderPathAtStart && currentRef.current.name === nameAtStart;
    try {
      await api.reprocessFile(name, { folder: sourceFolder ?? (folderPathAtStart || undefined) });
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
    /* Light surface keeps continuity with the rest of the app — the white
     * PDF page + shadow gives enough "paper on a desk" contrast without a
     * heavy dark backdrop. No top padding of its own: MainPane already
     * reserves the chrome band this viewer's controls portal into, so
     * padding here would only push the first page further down the pane.
     *
     * The top hairline is what lets that band stay on the base surface
     * like the tab that merges into it. Tint the band instead and a
     * fitted page — which fills the pane edge to edge — puts a grey
     * stripe between two whites; leave it untinted with no rule and
     * scrolling text is clipped at an invisible line. One stroke does
     * both jobs. `box-border` because Preflight is off here, so the
     * border would otherwise grow the pane past its row. */
    <div className="relative box-border flex h-full w-full flex-col items-center overflow-auto border-t border-border bg-pane" ref={containerRef}>
      {error && <div className="p-4 text-base text-destructive">Failed to open PDF: {error}</div>}
      {!error && !doc && <div className="p-4 text-base text-muted-foreground">Loading PDF…</div>}
      <PdfChromePortal
        scale={scale}
        autoFit={autoFit}
        canZoomOut={scale > PDF_MIN_SCALE + 0.001}
        canZoomIn={scale < PDF_MAX_SCALE - 0.001}
        currentPage={currentPage}
        numPages={numPages}
        status={chromeStatus}
        retryLabel={retryInProgress ? 'Reprocessing…' : 'Reprocess'}
        retryDisabled={retryInProgress}
        onRetry={failure && effectiveShowConversionBanner ? onRetry : undefined}
        onFit={() => {
          setAutoFit(true);
          setScale(fitScale());
        }}
        onActualSize={() => {
          setAutoFit(false);
          setScale(1);
        }}
        onZoomOut={() => {
          setAutoFit(false);
          setScale((s) => Math.max(PDF_MIN_SCALE, s - 0.2));
        }}
        onZoomIn={() => {
          setAutoFit(false);
          setScale((s) => Math.min(PDF_MAX_SCALE, s + 0.2));
        }}
        // A numbered jump is a direct navigation, not continuous reading.
        // Move synchronously so the scroll listener cannot observe the old
        // page during a smooth-scroll frame and overwrite the requested page.
        onJumpToPage={(page) => scrollToPage(page, 'auto')}
      />
      {/* The gap above the first page follows the page's own margins.
        * Fitted, the sheet runs edge to edge and has none, so a top gap
        * would be a stripe of canvas the user never asked for — and one
        * that collapses the moment they scroll, since scrolled content is
        * clipped at this container's top edge either way. Zoomed away
        * from fit, the sheet is an object floating on canvas with room on
        * both sides, and leaving it glued to the toolbar's rule reads as
        * cropped; it then takes the same 10px it takes between pages.
        * (`autoFit` fills the width unless the fit scale hit the zoom
        * ceiling, which only a page narrower than a third of the pane
        * can do.) */}
      <div
        className={
          'flex w-full flex-col items-center gap-2.5 pb-10'
          + (autoFit && scale < PDF_MAX_SCALE - 0.001 ? '' : ' pt-2.5')
        }
      >
        {doc && Array.from({ length: numPages }, (_, i) => (
          <PdfPage
            key={`p-${i}`}
            doc={doc}
            pageIndex={i}
            scale={scale}
            placeholderHeight={pageMetrics ? pageMetrics.height * scale : 800}
            highlight={pageHighlight?.page === i + 1 ? pageHighlight : null}
          />
        ))}
      </div>
    </div>
  );
}

/** Every control in the PDF chrome row. Normal weight because a toolbar
 *  of numbers reads as data, not as labels, and quiet until pointed at:
 *  these sit bare on the chrome band, so a resting background on each one
 *  would put a row of boxes where the band's whole job is to disappear. */
const PDF_TOOL_ITEM = 'font-normal text-muted-foreground hover:text-foreground';

/** Render the PDF chrome (zoom controls + page count) into the
 *  `#pdf-chrome-slot` MainPane mounts at the top of the main pane —
 *  replaces the old "second toolbar row" so the viewer doesn't waste
 *  vertical folder on what's effectively chrome. Renders nothing if
 *  MainPane hasn't mounted the slot yet (initial render race). */
function PdfChromePortal({
  scale,
  autoFit,
  canZoomOut,
  canZoomIn,
  currentPage,
  numPages,
  status,
  retryLabel,
  retryDisabled,
  onRetry,
  onFit,
  onActualSize,
  onZoomOut,
  onZoomIn,
  onJumpToPage,
}: {
  scale: number;
  autoFit: boolean;
  canZoomOut: boolean;
  canZoomIn: boolean;
  currentPage: number;
  numPages: number;
  status: { kind: 'error' | 'working'; text: string } | null;
  retryLabel: string;
  retryDisabled: boolean;
  onRetry?: () => void;
  onFit: () => void;
  onActualSize: () => void;
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
    <div className="pointer-events-auto flex w-full items-center gap-3 text-sm">
      {/* Mounted even when idle: a live region has to exist before the
        * message lands, or the status arrives silently. Empty is empty —
        * no transparent placeholder text holding the row open. */}
      <div
        className={
          'flex min-w-0 flex-1 items-center gap-1.5 leading-tight' +
          (status?.kind === 'error' ? ' text-destructive' : ' text-muted-foreground')
        }
        role="status"
      >
        {status?.kind === 'working' && (
          <span className="image-preparation-dot size-1.75 shrink-0 rounded-full bg-accent" aria-hidden="true" />
        )}
        <span className="truncate">{status?.text ?? ''}</span>
        {status?.kind === 'error' && onRetry && (
          <button
            type="button"
            className="shrink-0 cursor-pointer border-0 bg-transparent p-0 [font:inherit] text-inherit underline underline-offset-2 disabled:cursor-progress disabled:opacity-60"
            disabled={retryDisabled}
            onClick={() => { void onRetry(); }}
          >
            {retryLabel}
          </button>
        )}
      </div>
      {/* No container: the row sits on the viewer's own canvas, and the
        * only control carrying a surface is the one that is switched on.
        * Grouping comes from spacing and a single hairline — a box here
        * would be a grey panel on a grey field. */}
      <div className="flex flex-none items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          className={PDF_TOOL_ITEM + ' text-lg'}
          title="Zoom out"
          aria-label="Zoom out"
          disabled={!canZoomOut}
          onClick={onZoomOut}
        >
          −
        </Button>
        {/* The percentage is the control, not a readout: clicking it is
          * how you get back to actual size. */}
        <Button
          variant="ghost"
          size="xs"
          className={PDF_TOOL_ITEM + ' min-w-10 px-1 tabular-nums'}
          title="Actual size (100%)"
          aria-label="Actual size"
          onClick={onActualSize}
        >
          {Math.round(scale * 100)}%
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className={PDF_TOOL_ITEM + ' text-lg'}
          title="Zoom in"
          aria-label="Zoom in"
          disabled={!canZoomIn}
          onClick={onZoomIn}
        >
          +
        </Button>
        {/* Fit is a mode, so it stays pressed while it holds — otherwise
          * nothing on screen explains why the zoom reads 117%. Pressed is
          * the neutral selected surface, one step past hover: this toggle
          * is on by default, and a standing accent chip on every PDF is
          * exactly the repeated colour moment the palette rations. */}
        <Button
          variant="ghost"
          size="xs"
          className={
            PDF_TOOL_ITEM
            + ' ml-0.5 px-2'
            + ' aria-pressed:bg-active aria-pressed:text-foreground aria-pressed:hover:bg-active'
          }
          title="Fit to width"
          aria-pressed={autoFit}
          onClick={onFit}
        >
          Fit
        </Button>
        {numPages > 0 && (
          <>
            <span className="mx-1.5 h-3.5 w-px shrink-0 bg-border" aria-hidden="true" />
            {editingPage ? (
              /* h-6 matches the buttons it replaces so the row keeps its
                 height while the page field is open. */
              <span className="flex h-6 items-center gap-1 text-xs text-muted-foreground tabular-nums">
                <Input
                  autoFocus
                  className="h-5 w-8 px-0 text-center text-xs"
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
              <Button
                variant="ghost"
                size="xs"
                className={PDF_TOOL_ITEM + ' px-2 tabular-nums'}
                title="Jump to page"
                aria-label={`Page ${currentPage} of ${numPages} — jump to page`}
                onClick={() => {
                  setPageInput(String(currentPage));
                  setEditingPage(true);
                }}
              >
                {currentPage} / {numPages}
              </Button>
            )}
          </>
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
}: {
  doc: PDFDocumentProxy;
  pageIndex: number;
  scale: number;
  placeholderHeight: number;
  highlight: PdfPageHighlight | null;
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
    }).catch((err: unknown) => {
      if (!cancelled) {
        console.error(`[pdf] page ${pageIndex + 1} load failed:`, err);
      }
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
      className="relative bg-white shadow-low"
      data-page={pageIndex + 1}
      style={{
        minHeight: reservedHeight,
        width: reservedWidth ? `${reservedWidth}px` : undefined,
      }}
    >
      {visible ? <canvas ref={canvasRef} className="block" /> : (
        <div className="flex min-h-[800px] w-[600px] items-center justify-center text-sm text-muted-foreground">Page {pageIndex + 1}</div>
      )}
      {/* No margin page number: at fit-to-width the gutter is 24px, so
        * the marker was always clipped by the pane edge, and the chrome
        * row already tracks the page you're on as you scroll. */}
      {visible && renderedSize && highlight && (
        <div className="pointer-events-none absolute inset-0 z-2" aria-hidden="true">
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
