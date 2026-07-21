import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, versionedAssetUrl } from '../api';
import { preparationWaitCopy } from '../preparation-copy.ts';
import { useApp } from '../store/AppContext';
import { getPreparationFailure } from '../store/fileReadiness';

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
  const sourceVersion = activeTab?.file?.name === name ? activeTab.file.version ?? '' : '';
  const src = useMemo(() => versionedAssetUrl(name, sourceVersion), [name, sourceVersion]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const currentRef = useRef({ folderPath: state.folderPath, name });
  currentRef.current = { folderPath: state.folderPath, name };
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const alt = name.split('/').pop() ?? name;
  const failure = getPreparationFailure(state, name);
  const conversionProgress = state.conversionProgress[name];
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
      await api.reprocessFile(name, { folder: folderPathAtStart || undefined });
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
    <div className="image-preview">
      {failure && (
        <div className="pdf-failure-banner" role="status">
          <span className="pdf-failure-text">
            {retryError
              ? 'Searchable text is unavailable. Reprocess could not start. Try again.'
              : 'Searchable text is unavailable. The image still opens normally.'}
          </span>
          <button
            type="button"
            className="pdf-failure-retry"
            disabled={retryBusy}
            onClick={() => { void onRetry(); }}
          >
            {retryBusy ? 'Reprocessing…' : 'Reprocess'}
          </button>
        </div>
      )}
      {preparationStatus && (
        <div className="image-preparation-status" role="status">
          <span className="image-preparation-dot" aria-hidden="true" />
          {preparationStatus}
        </div>
      )}
      <div className="image-preview-scroll" ref={scrollRef}>
        {loadError ? (
          <div className="empty-list">
            Couldn’t load this image — the file may have moved or been deleted.
          </div>
        ) : (
          <div className="image-preview-stage">
            <img
              className="image-preview-img"
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
        <div className="image-zoom-bar">
          <button type="button" title="Zoom out" onClick={() => setScale((s) => clampScale(s / 1.25))}>−</button>
          <button type="button" className="image-zoom-pct" title="Actual size (100%)" onClick={() => setScale(1)}>
            {Math.round(scale * 100)}%
          </button>
          <button type="button" title="Zoom in" onClick={() => setScale((s) => clampScale(s * 1.25))}>+</button>
          <button type="button" title="Fit to pane" onClick={() => setScale(fitScale())}>Fit</button>
        </div>
      )}
    </div>
  );
}
