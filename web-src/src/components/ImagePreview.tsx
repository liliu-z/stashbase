import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, versionedAssetUrl } from '../api';
import { useLatestRef } from '../hooks/useLatestRef';
import { basename } from '../lib/paths';
import { preparationWaitCopy } from '../preparationCopy.ts';
import { useApp } from '../store/AppContext';
import { getPreparationFailure } from '../store/fileReadiness';
import { emptyStateClass } from './emptyState';
import { Button } from './ui/button';
import { StatusMessage } from './ui/status';

/**
 * In-pane viewer for a standalone image file. The image binary is
 * pulled directly from `/asset/*` (never loaded as text); the
 * searchable text lives in the hidden `.<stem>.md` OCR note that
 * `ocr_extract.py` writes alongside it.
 *
 * Defaults to **actual size (100%)** — for a screenshot that's the size
 * it was captured at, which is usually the most comfortable read — and
 * scrolls when the image is larger than the pane. A small zoom bar
 * (− / % / + / Fit) plus ⌘/Ctrl-scroll (and trackpad pinch) adjust the
 * scale. We size the image via an explicit CSS width rather than a
 * transform so the browser resamples crisply and the scroll bounds stay
 * correct. The view never auto-upscales (Fit caps at 100%) — upscaling
 * a raster only blurs it; the user can still zoom past 100% by hand.
 *
 * "100%" is **device-pixel-accurate**, not 1-image-px-per-CSS-px: the
 * baseline width is `naturalWidth / devicePixelRatio`, so one image pixel
 * maps to one physical pixel. On a Retina screen a 2× screenshot then
 * shows at the logical size it was captured at (not doubled) and stays
 * pin-sharp.
 *
 * If OCR failed for this image, a small banner offers Retry — the image
 * still renders (it's the user-facing file), only its searchable text is
 * missing. Failure state comes from `state.preparationFailures` (fed by
 * the index-status poll), the same list that drives PdfPreview's banner.
 */
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const clampScale = (v: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));

export function ImagePreview({ name }: { name: string }) {
  const { state, activeTab } = useApp();
  const isExternal = activeTab?.file?.name === name && Boolean(activeTab.file.isExternal);
  const sourceVersion = activeTab?.file?.name === name ? activeTab.file.version ?? '' : '';
  const sourceFolder = activeTab?.file?.name === name ? activeTab.file.folder : undefined;
  const sourceGrantId = activeTab?.file?.name === name ? activeTab.file.grantId : undefined;
  const src = useMemo(
    () => versionedAssetUrl(name, sourceVersion, sourceFolder, sourceGrantId),
    [name, sourceVersion, sourceFolder, sourceGrantId],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const currentRef = useLatestRef({ folderPath: state.folderPath, name });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState(1);
  // Fit is a mode like PdfPreview's autoFit: pressed from the moment the
  // user chooses it until any explicit zoom (buttons, %-reset, wheel/pinch)
  // takes over. Unlike the PDF viewer it does not re-fit on pane resize —
  // the image view is anchored to actual size by design.
  const [fitMode, setFitMode] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const alt = basename(name);
  const failure = isExternal ? null : getPreparationFailure(state, name);
  const conversionProgress = isExternal ? null : state.conversionProgress[name];
  const preparationStatus = !failure && conversionProgress
    ? conversionProgress.phase === 'queued'
      ? preparationWaitCopy('searchable-text', conversionProgress.tasksAhead)
      : conversionProgress.phase === 'yielded'
        ? preparationWaitCopy('searchable-text', conversionProgress.tasksAhead)
      : conversionProgress.phase === 'indexing'
        ? 'Indexing searchable text…'
        : 'Reading image text…'
    : null;
  // Device pixel ratio: the baseline (100%) maps one image pixel to one
  // physical pixel, so a Retina screenshot shows at captured size + sharp.
  const dpr = window.devicePixelRatio || 1;

  // Reset to actual size whenever the open file changes.
  useEffect(() => {
    setNatural(null);
    setScale(1);
    setFitMode(false);
    setLoadError(false);
    setRetryBusy(false);
    setRetryError(null);
  }, [src]);

  // Native wheel listener (passive:false) so ⌘/Ctrl-scroll — and trackpad
  // pinch, which the browser delivers as a ctrlKey wheel event — can zoom
  // without the page also scrolling. Plain scroll stays as pan.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setFitMode(false);
      setScale((s) => clampScale(s * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  function fitScale(): number {
    const el = scrollRef.current;
    if (!el || !natural) return 1;
    // Fit the whole image in the scroll viewport, but never above 100% —
    // auto-upscaling a raster just blurs it.
    const availW = el.clientWidth - 48;
    const availH = el.clientHeight - 48;
    // Baseline width is natural/dpr, so compare against that.
    return clampScale(Math.min(1, (availW * dpr) / natural.w, (availH * dpr) / natural.h));
  }

  async function onRetry() {
    setRetryBusy(true);
    setRetryError(null);
    const folderPathAtStart = state.folderPath;
    const nameAtStart = name;
    const stillCurrent = () =>
      currentRef.current.folderPath === folderPathAtStart && currentRef.current.name === nameAtStart;
    try {
      await api.reprocessFile(name, { folder: sourceFolder ?? (folderPathAtStart || undefined) });
      // The failures list / banner clear on the next index-status poll.
    } catch (err: unknown) {
      if (!stillCurrent()) return;
      setRetryError(errorMessage(err));
    } finally {
      if (stillCurrent()) setRetryBusy(false);
    }
  }

  const displayW = natural ? Math.round((natural.w / dpr) * scale) : undefined;

  return (
    /* pt-11 clears the breadcrumb / chrome row at the top of the pane. */
    <div className="relative box-border flex h-full w-full flex-col overflow-hidden bg-pane pt-11">
      {failure && (
        /* Negative top margin cancels the chrome-row padding so the
         * banner sits flush under the tab strip. */
        <StatusMessage tone="warning" className="z-5 -mt-11 flex w-full items-start gap-2.5 rounded-none border-x-0 border-t-0 px-3.5 py-2">
          <span className="min-w-0 flex-1 overflow-auto [overflow-wrap:anywhere] max-h-[4.5em]">
            {retryError
              ? 'Searchable text is unavailable. Reprocess could not start. Try again.'
              : 'Searchable text is unavailable. The image still opens normally.'}
          </span>
          <Button
            variant="outline"
            size="xs"
            className="shrink-0"
            disabled={retryBusy}
            onClick={() => { void onRetry(); }}
          >
            {retryBusy ? 'Reprocessing…' : 'Reprocess'}
          </Button>
        </StatusMessage>
      )}
      {preparationStatus && (
        <div className="box-border flex min-h-7.5 shrink-0 items-center gap-1.5 border-b border-border bg-background px-3.5 py-1.5 text-sm text-muted-foreground" role="status">
          <span className="image-preparation-dot size-1.75 shrink-0 rounded-full bg-accent" aria-hidden="true" />
          {preparationStatus}
        </div>
      )}
      {/* The scroll viewport. Defaults to actual-size content, so a large
        * image scrolls here rather than being squeezed to fit. */}
      <div className="min-h-0 flex-1 overflow-auto" ref={scrollRef}>
        {loadError ? (
          <div className={emptyStateClass}>
            Couldn’t load this image — the file may have moved or been deleted.
          </div>
        ) : (
          /* Grows to at least the viewport so a smaller-than-pane image
           * stays centered, while a larger one expands the stage and the
           * parent scrolls to every edge (the flex-center-on-an-
           * overflowing-child clipping trap is avoided by centering the
           * *stage*, not the img). */
          <div className="box-border flex min-h-full min-w-full items-center justify-center p-6">
            <img
              className="block h-auto flex-none rounded-sm shadow-low"
              src={src}
              alt={alt}
              draggable={false}
              style={displayW != null ? { width: displayW } : undefined}
              onLoad={(e) =>
                setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
              }
              onError={() => setLoadError(true)}
            />
          </div>
        )}
      </div>
      {natural && !loadError && (
        /* Floating zoom controls, pinned to the pane (outside the scroll
         * area so they don't move with the image). */
        <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-border bg-background p-[3px] shadow-elevation">
          <Button variant="ghost" size="xs" className="min-w-7 px-2 font-normal" title="Zoom out" onClick={() => { setFitMode(false); setScale((s) => clampScale(s / 1.25)); }}>−</Button>
          <Button variant="ghost" size="xs" className="min-w-12 px-2 font-normal text-muted-foreground tabular-nums" title="Actual size (100%)" onClick={() => { setFitMode(false); setScale(1); }}>
            {Math.round(scale * 100)}%
          </Button>
          <Button variant="ghost" size="xs" className="min-w-7 px-2 font-normal" title="Zoom in" onClick={() => { setFitMode(false); setScale((s) => clampScale(s * 1.25)); }}>+</Button>
          {/* Pressed is the neutral selected surface — same semantics as
            * PdfPreview's Fit toggle, and the same rationing of accent. */}
          <Button
            variant="ghost"
            size="xs"
            className="px-2 font-normal aria-pressed:bg-active aria-pressed:text-foreground aria-pressed:hover:bg-active"
            title="Fit to pane"
            aria-pressed={fitMode}
            onClick={() => { setFitMode(true); setScale(fitScale()); }}
          >Fit</Button>
        </div>
      )}
    </div>
  );
}
