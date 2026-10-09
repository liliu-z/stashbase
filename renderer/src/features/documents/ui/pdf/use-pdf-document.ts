import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useEffect, useState } from 'react';

import { useErrorReporter } from '@/shared/runtime/error-reporting';

export interface PdfLoadTask {
  destroy(): Promise<void>;
  promise: Promise<PDFDocumentProxy>;
}

export type PdfLoader = (url: string) => PdfLoadTask;

export interface PdfDocumentState {
  document: PDFDocumentProxy | null;
  error: string | null;
  loading: boolean;
  pageSize: { height: number; width: number } | null;
}

export function usePdfDocument(url: string, load: PdfLoader): PdfDocumentState {
  const reportError = useErrorReporter();
  const [state, setState] = useState<PdfDocumentState>({
    document: null,
    error: null,
    loading: true,
    pageSize: null,
  });
  useEffect(() => {
    let cancelled = false;
    const task = load(url);
    setState({ document: null, error: null, loading: true, pageSize: null });
    void task.promise.then(
      async (document) => {
        if (cancelled) {
          // swallowed: the effect was cancelled, so a failed teardown has no reader.
          await document.destroy().catch(() => undefined);
          return;
        }
        let pageSize: PdfDocumentState['pageSize'] = null;
        try {
          const page = await document.getPage(1);
          const viewport = page.getViewport({ scale: 1 });
          pageSize = { height: viewport.height, width: viewport.width };
        } catch {
          // Individual pages retain their own failure surface.
        }
        if (!cancelled) setState({ document, error: null, loading: false, pageSize });
      },
      (error: unknown) => {
        if (cancelled) return;
        reportError?.(error, 'pdf-preview');
        // PDF.js says why in developer terms; the reader gets one sentence.
        setState({
          document: null,
          error: 'The PDF could not be opened.',
          loading: false,
          pageSize: null,
        });
      },
    );
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [load, url, reportError]);
  return state;
}
