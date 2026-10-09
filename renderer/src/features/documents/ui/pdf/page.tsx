import { TextLayer, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import { useEffect, useRef, useState } from 'react';

import { useErrorReporter } from '@/shared/runtime/error-reporting';

export function PdfPage({
  document: pdf,
  pageNumber,
  placeholder,
  scale,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  placeholder: { height: number; width: number };
  scale: number;
}) {
  const reportError = useErrorReporter();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(pageNumber <= 2);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setNearViewport(entry?.isIntersecting ?? false),
      { rootMargin: '600px 0px' },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!nearViewport) {
      canvasRef.current
        ?.getContext('2d')
        ?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      textRef.current?.replaceChildren();
      return;
    }
    let cancelled = false;
    let page: PDFPageProxy | null = null;
    let renderTask: ReturnType<PDFPageProxy['render']> | null = null;
    let textLayer: TextLayer | null = null;
    setFailed(false);
    void pdf
      .getPage(pageNumber)
      .then(async (loadedPage) => {
        if (cancelled) {
          loadedPage.cleanup();
          return;
        }
        page = loadedPage;
        const viewport = loadedPage.getViewport({ scale });
        const ratio = globalThis.devicePixelRatio || 1;
        const rendered = globalThis.document.createElement('canvas');
        rendered.width = Math.floor(viewport.width * ratio);
        rendered.height = Math.floor(viewport.height * ratio);
        renderTask = loadedPage.render({
          canvas: rendered,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
          viewport,
        });
        const textHost = globalThis.document.createElement('div');
        textLayer = new TextLayer({
          container: textHost,
          textContentSource: loadedPage.streamTextContent(),
          viewport,
        });
        const textReady = textLayer
          .render()
          .then(() => true)
          .catch(() => false);
        await renderTask.promise;
        const hasText = await textReady;
        if (cancelled) return;
        const canvas = canvasRef.current;
        const context = canvas?.getContext('2d');
        if (!canvas || !context) return;
        canvas.width = rendered.width;
        canvas.height = rendered.height;
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        context.drawImage(rendered, 0, 0);
        const layer = textRef.current;
        if (layer && hasText) {
          layer.setAttribute('style', textHost.getAttribute('style') ?? '');
          layer.style.setProperty(
            '--total-scale-factor',
            String(viewport.scale * (viewport.userUnit || 1)),
          );
          const rotation = textHost.getAttribute('data-main-rotation');
          if (rotation) layer.setAttribute('data-main-rotation', rotation);
          else layer.removeAttribute('data-main-rotation');
          layer.replaceChildren(...Array.from(textHost.childNodes));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled && (error as { name?: string })?.name !== 'RenderingCancelledException') {
          reportError?.(error, 'pdf-preview');
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      page?.cleanup();
    };
  }, [nearViewport, pageNumber, pdf, scale, reportError]);

  return (
    <div
      aria-label={`Page ${pageNumber}`}
      className="relative shrink-0 overflow-hidden bg-surface-3 shadow-surface-3"
      data-page={pageNumber}
      ref={rootRef}
      role="group"
      style={{ height: placeholder.height * scale, width: placeholder.width * scale }}
    >
      {failed ? (
        <div className="flex h-full items-center justify-center text-caption text-muted-foreground">
          Page {pageNumber} could not be rendered
        </div>
      ) : nearViewport ? (
        <>
          <canvas aria-hidden="true" className="block" ref={canvasRef} />
          <div className="stashbase-pdf-text-layer" ref={textRef} />
        </>
      ) : (
        <span className="sr-only">Page {pageNumber} is outside the visible area</span>
      )}
    </div>
  );
}
