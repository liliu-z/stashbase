import { useEffect, useRef, useState } from 'react';
import { api, assetBaseUrl, errorMessage, versionedAssetUrl } from '../api';
import { preparationWaitCopy } from '../preparation-copy.ts';
import { useIframeDropForward } from '../hooks/useIframeDropForward';
import { previewClickHandler } from '../lib/previewIframe';
import { useApp } from '../store/AppContext';
import { getPreparationFailure } from '../store/fileReadiness';
import { makeIframeFindController } from './findIframe';
import { HtmlPreview } from './HtmlPreview';
import { applyChunkHighlight } from './previewChunkHighlight';

const DIRECT_PREVIEW_TIMEOUT_MS = 20_000;

/**
 * Immediate DOCX preview. The source binary is fetched from `/asset/*` and
 * converted in a renderer-owned worker, so visible document content neither
 * waits for a server scheduler slot nor blocks the UI thread. The server light
 * lane still prepares durable HTML for search, Agent reads, and fallback.
 */
export function DocxPreview({ name }: { name: string }) {
  const { state, actions, activeTab } = useApp();
  const pendingAnchor = activeTab?.pendingAnchor ?? null;
  const pendingHighlight = activeTab?.pendingHighlight ?? null;
  const sourceVersion = activeTab?.file?.name === name ? activeTab.file.version ?? '' : '';
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const loadedHtmlRef = useRef('');
  const findAtMount = useRef(state.find);
  findAtMount.current = state.find;
  const currentRef = useRef({ folderPath: state.folderPath, name });
  currentRef.current = { folderPath: state.folderPath, name };
  const [html, setHtml] = useState<string | null>(null);
  const [directFailed, setDirectFailed] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const failure = getPreparationFailure(state, name);
  const progress = state.conversionProgress[name];
  const preparationStatus = progress
    ? progress.phase === 'queued'
      ? preparationWaitCopy('searchable-text', progress.tasksAhead)
      : progress.phase === 'yielded'
        ? preparationWaitCopy('searchable-text', progress.tasksAhead)
      : progress.phase === 'indexing'
        ? 'Indexing searchable text…'
        : 'Preparing searchable text…'
    : null;

  useEffect(() => {
    const controller = new AbortController();
    let worker: Worker | null = null;
    let cancelled = false;
    let timedOut = false;
    setHtml(null);
    setDirectFailed(false);
    setRetryBusy(false);
    setRetryError(null);
    loadedHtmlRef.current = '';

    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('DOCX direct preview timed out', 'TimeoutError'));
      worker?.terminate();
      if (!cancelled) setDirectFailed(true);
    }, DIRECT_PREVIEW_TIMEOUT_MS);

    void (async () => {
      try {
        const response = await fetch(versionedAssetUrl(name, sourceVersion), { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        worker = new Worker(new URL('../workers/docxPreview.worker.ts', import.meta.url), { type: 'module' });
        const bodyHtml = await convertDocxInWorker(worker, arrayBuffer, controller.signal);
        if (cancelled) return;
        setHtml(renderDocxDocument(bodyHtml, name, assetBaseUrl(name)));
      } catch (err: unknown) {
        if (cancelled || ((err as DOMException)?.name === 'AbortError' && !timedOut)) return;
        console.warn(`[docx] direct preview failed for ${name}:`, err);
        setDirectFailed(true);
      } finally {
        clearTimeout(timeout);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
      worker?.terminate();
    };
  }, [name, sourceVersion]);

  useEffect(() => {
    if (!html) return;
    const documentHtml: string = html;
    const iframe = frameRef.current;
    if (!iframe) return;
    const activeIframe: HTMLIFrameElement = iframe;
    let installedDoc: Document | null = null;

    function findKeyHandler(e: Event) {
      const ke = e as KeyboardEvent;
      if (!(ke.metaKey || ke.ctrlKey)) return;
      const key = ke.key.toLowerCase();
      if (key === 'f') {
        ke.preventDefault();
        actions.openFind();
      } else if (key === 'g') {
        ke.preventDefault();
        if (ke.shiftKey) actions.findPrev(); else actions.findNext();
      }
    }

    function handleClick(e: Event) {
      previewClickHandler(e, name);
    }

    function attach() {
      const doc = activeIframe.contentDocument;
      if (!doc || installedDoc === doc) return;
      installedDoc = doc;
      for (const image of Array.from(doc.images)) image.dataset.stashbasePreviewable = 'true';
      doc.addEventListener('click', handleClick);
      doc.addEventListener('keydown', findKeyHandler);
      loadedHtmlRef.current = documentHtml;
      applyPendingScroll(doc);
      applyPendingHighlight(doc);
      const find = findAtMount.current;
      if (find.open && find.query) queueMicrotask(() => actions.setFindQuery(find.query));
    }

    activeIframe.addEventListener('load', attach);
    if (activeIframe.contentDocument?.readyState === 'complete') attach();
    return () => {
      activeIframe.removeEventListener('load', attach);
      installedDoc?.removeEventListener('click', handleClick);
      installedDoc?.removeEventListener('keydown', findKeyHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, name]);

  useIframeDropForward(frameRef, html);

  useEffect(() => {
    const controller = makeIframeFindController(
      () => frameRef.current?.contentDocument ?? null,
      () => frameRef.current?.contentWindow ?? null,
    );
    actions.registerFindController(controller);
    return () => actions.registerFindController(null);
  }, [actions]);

  useEffect(() => {
    if (!html || loadedHtmlRef.current !== html) return;
    const doc = frameRef.current?.contentDocument;
    if (doc) applyPendingScroll(doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAnchor, html]);

  useEffect(() => {
    if (!html || loadedHtmlRef.current !== html) return;
    const doc = frameRef.current?.contentDocument;
    if (doc) applyPendingHighlight(doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingHighlight, html]);

  function applyPendingScroll(doc: Document) {
    if (!pendingAnchor) return;
    doc.getElementById(pendingAnchor)?.scrollIntoView({ behavior: 'auto', block: 'start' });
    actions.consumePendingScroll();
  }

  function applyPendingHighlight(doc: Document) {
    if (!pendingHighlight) return;
    if (applyChunkHighlight(doc, pendingHighlight.chunkText)) actions.consumePendingHighlight();
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
    } catch (err: unknown) {
      if (stillCurrent()) setRetryError(errorMessage(err));
    } finally {
      if (stillCurrent()) setRetryBusy(false);
    }
  }

  return (
    <div className="docx-preview">
      {failure ? (
        <div className="docx-preparation-status error" role="status">
          <span className="docx-preparation-text">
            {retryError
              ? 'The document is visible, but search preparation could not restart.'
              : 'The document is visible, but its searchable text is unavailable.'}
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
      ) : preparationStatus ? (
        <div className="docx-preparation-status" role="status">
          <span className="image-preparation-dot" aria-hidden="true" />
          {preparationStatus}
        </div>
      ) : null}
      <div className="docx-preview-body">
        {directFailed ? (
          <HtmlPreview name={name} derived />
        ) : html ? (
          <iframe
            ref={frameRef}
            id="previewFrame"
            className="html-viewer"
            sandbox="allow-same-origin"
            srcDoc={html}
            title="DOCX preview"
          />
        ) : (
          <div className="docx-preview-loading">Opening document…</div>
        )}
      </div>
    </div>
  );
}

function convertDocxInWorker(
  worker: Worker,
  arrayBuffer: ArrayBuffer,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: { html: string } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      worker.terminate();
      if ('html' in result) resolve(result.html);
      else reject(result.error);
    };
    const onAbort = () => finish({
      error: signal.reason ?? new DOMException('DOCX preview cancelled', 'AbortError'),
    });
    worker.onmessage = (event: MessageEvent<{ ok: true; html: string } | { ok: false; error: string }>) => {
      if (event.data.ok) finish({ html: event.data.html });
      else finish({ error: new Error(event.data.error) });
    };
    worker.onerror = (event) => {
      finish({ error: new Error(event.message || 'DOCX preview worker failed') });
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    worker.postMessage({ arrayBuffer }, [arrayBuffer]);
  });
}

function renderDocxDocument(bodyHtml: string, title: string, baseHref: string): string {
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '  <meta charset="utf-8">',
    `  <base href="${escapeHtml(baseHref)}">`,
    `  <title>${escapeHtml(title)}</title>`,
    '  <style>',
    '    body { font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #222; max-width: 840px; margin: 40px auto; padding: 0 32px; }',
    '    img { max-width: 100%; height: auto; }',
    '    table { width: 100%; border-collapse: collapse; }',
    '    td, th { border: 1px solid #d7dbe2; padding: 6px 8px; text-align: left; vertical-align: top; }',
    '    blockquote { margin-left: 0; padding-left: 16px; border-left: 3px solid #d7dbe2; color: #555; }',
    '  </style>',
    '</head>',
    '<body>',
    bodyHtml,
    '</body>',
    '</html>',
  ].join('\n');
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
