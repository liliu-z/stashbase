import { useEffect, useRef, useState } from 'react';
import '@/features/documents/documents.css';
import { assetBaseUrl, versionedAssetUrl } from '@/common/api/api';
import { preparationWaitCopy } from '@/features/documents/lib/preparationCopy';
import { useLatestRef } from '@/common/hooks/useLatestRef';
import { useIframeDropForward } from '@/features/documents/hooks/useIframeDropForward';
import { useFileReprocess } from '@/features/documents/hooks/useFileReprocess';
import { previewClickHandler } from '@/features/documents/lib/previewIframe';
import { useAppActions, useUiShell, useWorkspace } from '@/store/contexts/AppContext';
import { getPreparationFailure } from '@/store/lib/fileReadiness';
import { makeIframeFindController } from '@/features/documents/lib/findIframe';
import { HtmlPreview } from '@/features/documents/components/HtmlPreview';
import { applyChunkHighlight } from '@/features/documents/lib/previewChunkHighlight';
import { Button } from '@/common/components/ui/button';
import { StatusMessage } from '@/common/components/ui/status';

const DIRECT_PREVIEW_TIMEOUT_MS = 20_000;

/**
 * Immediate DOCX preview. The source binary is fetched from `/asset/*` and
 * converted in a renderer-owned worker, so visible document content neither
 * waits for a server scheduler slot nor blocks the UI thread. The server light
 * lane still prepares durable HTML for search, Agent reads, and fallback.
 */
export function DocxPreview({ name }: { name: string }) {
  const state = useWorkspace();
  const { activeTab } = state;
  const { find } = useUiShell();
  const { actions } = useAppActions();
  const pendingAnchor = activeTab?.pendingAnchor ?? null;
  const pendingHighlight = activeTab?.pendingHighlight ?? null;
  const sourceVersion = activeTab?.file?.name === name ? activeTab.file.version ?? '' : '';
  // Out-of-folder tab: fetch source bytes + resolve embedded assets against
  // the file's own member folder.
  const sourceFolder = activeTab?.file?.name === name ? activeTab.file.folder : undefined;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const loadedHtmlRef = useRef('');
  const findAtMount = useLatestRef(find);
  const [html, setHtml] = useState<string | null>(null);
  const [directFailed, setDirectFailed] = useState(false);
  const { retryBusy, retryError, retry } = useFileReprocess(name, { folder: sourceFolder, version: sourceVersion });
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
    loadedHtmlRef.current = '';

    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('DOCX direct preview timed out', 'TimeoutError'));
      worker?.terminate();
      if (!cancelled) setDirectFailed(true);
    }, DIRECT_PREVIEW_TIMEOUT_MS);

    void (async () => {
      try {
        const response = await fetch(versionedAssetUrl(name, sourceVersion, sourceFolder), { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        worker = new Worker(new URL('../workers/docxPreview.worker.ts', import.meta.url), { type: 'module' });
        const bodyHtml = await convertDocxInWorker(worker, arrayBuffer, controller.signal);
        if (cancelled) return;
        setHtml(renderDocxDocument(bodyHtml, name, assetBaseUrl(name, sourceFolder)));
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
  }, [name, sourceVersion, sourceFolder]);

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


  return (
    /* DOCX renders directly from the source in the renderer. Search/Agent
     * preparation continues independently and occupies only the slim
     * status row, never the document viewport. */
    <div className="relative box-border flex h-full w-full flex-col overflow-hidden bg-background">
      {directFailed || failure ? (
        <StatusMessage tone="warning" className="flex min-h-7 shrink-0 items-center gap-1.5 rounded-none border-x-0 border-t-0 px-3.5 py-1.5">
          <span className="min-w-0 flex-1">
            {directFailed
              ? failure
                ? 'Direct DOCX preview failed, and its searchable fallback is unavailable.'
                : 'Direct DOCX preview failed. StashBase will show the prepared fallback when it is available.'
              : retryError
                ? 'The document is visible, but search preparation could not restart.'
                : 'The document is visible, but its searchable text is unavailable.'}
          </span>
          {failure ? (
            <Button
              variant="outline"
              size="xs"
              className="shrink-0"
              disabled={retryBusy}
              onClick={() => { void retry(); }}
            >
              {retryBusy ? 'Reprocessing…' : 'Reprocess'}
            </Button>
          ) : null}
        </StatusMessage>
      ) : preparationStatus ? (
        <div className="box-border flex min-h-7 shrink-0 items-center gap-1.5 border-b border-border bg-background px-3.5 py-1.5 text-sm text-muted-foreground" role="status">
          <span className="image-preparation-dot size-2 shrink-0 rounded-full bg-accent" aria-hidden="true" />
          {preparationStatus}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-white">
        {directFailed ? (
          <HtmlPreview name={name} derived />
        ) : html ? (
          <iframe
            ref={frameRef}
            id="previewFrame"
            className="absolute inset-0 block h-full w-full border-0 bg-white"
            sandbox="allow-same-origin"
            srcDoc={html}
            title="DOCX preview"
          />
        ) : (
          <div className="grid h-full place-items-center text-base text-muted-foreground">Opening document…</div>
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
  // Paper policy — same as PdfPreview's white pages: the DOCX sheet stays
  // light-on-paper in both themes (the wrapper is `bg-white`, and the 20 s
  // fallback — `server/docx.ts` durable HTML — is light-locked the same
  // way), so the ink greys below are content values like the page white,
  // not chrome tokens, and deliberately do not follow the active theme.
  // Concretely: `#222` body ink, `#d7dbe2` table/quote rules, `#555` quote
  // ink. They are the app's last raw hexes outside the token layer and
  // they stay raw for two independent reasons, either of which is
  // sufficient. First, they are unreachable: this string is `srcDoc` for a
  // sandboxed iframe, a separate document whose `:root` has none of the
  // renderer's tokens, so `var(--fg)` would resolve to nothing and the
  // declaration would be dropped. Second, even resolved through the
  // build-time escape hatch used for `--font-sans` below, `--fg` flips to a
  // near-white in the dark theme and would paint white ink on the
  // permanently white sheet. Do not "tokenize" these.
  // The type stack IS a chrome role: resolve `--font-sans` from the parent
  // document at build time (findIframe's token-resolution pattern — the
  // iframe never receives the app stylesheet, so var() would not resolve
  // there) instead of hand-copying the stack, so the CJK fallbacks cannot
  // drift from the token layer.
  const fontSans = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-sans').trim() || 'system-ui, sans-serif';
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '  <meta charset="utf-8">',
    `  <base href="${escapeHtml(baseHref)}">`,
    `  <title>${escapeHtml(title)}</title>`,
    '  <style>',
    `    body { font: 16px/1.55 ${fontSans}; color: #222; max-width: 840px; margin: 40px auto; padding: 0 32px; }`,
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
