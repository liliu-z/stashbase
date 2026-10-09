import { DOCX_PREVIEW_MESSAGES } from '@/features/documents/application/failure-messages';
import { DocxPreviewError, type DocxPreviewPort } from '@/features/documents/application/ports';
import type { ErrorReporter } from '@/platform/error-reporting';

const DIRECT_PREVIEW_TIMEOUT_MS = 20_000;

interface DocxWorkerClient {
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, transfer: Transferable[]): void;
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  terminate(): void;
}

type FetchRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface DocxPreviewApiOptions {
  reportError?: ErrorReporter | undefined;
  createWorker?: () => DocxWorkerClient | Promise<DocxWorkerClient>;
  fetchRequest?: FetchRequest;
  timeoutMs?: number;
}

async function createDocxWorker(): Promise<DocxWorkerClient> {
  const { default: DocxPreviewWorker } = await import('./docx-preview.worker?worker');
  return new DocxPreviewWorker();
}

function convert(
  worker: DocxWorkerClient,
  arrayBuffer: ArrayBuffer,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: { error: unknown } | { html: string }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      worker.removeEventListener('message', receive);
      worker.removeEventListener('error', fail);
      worker.terminate();
      if ('html' in result) resolve(result.html);
      else reject(result.error);
    };
    const abort = () =>
      finish({ error: signal.reason ?? new DOMException('DOCX preview cancelled', 'AbortError') });
    const receive = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (
        message &&
        typeof message === 'object' &&
        (message as Record<string, unknown>).ok === true &&
        typeof (message as Record<string, unknown>).html === 'string'
      ) {
        finish({ html: (message as { html: string }).html });
        return;
      }
      // The converter's own diagnostic names a DOCX feature it choked on, so
      // it is kept as the cause; what a reader sees comes off the ladder.
      const detail =
        message &&
        typeof message === 'object' &&
        (message as Record<string, unknown>).ok === false &&
        typeof (message as Record<string, unknown>).detail === 'string'
          ? (message as { detail: string }).detail
          : null;
      finish({
        error: new DocxPreviewError(
          'invalid-response',
          DOCX_PREVIEW_MESSAGES['invalid-response'],
          detail === null ? undefined : { cause: new Error(detail) },
        ),
      });
    };
    const fail = (event: ErrorEvent) =>
      finish({
        error: new DocxPreviewError(
          'unavailable',
          DOCX_PREVIEW_MESSAGES.unavailable,
          event.message ? { cause: new Error(event.message) } : undefined,
        ),
      });
    worker.addEventListener('message', receive);
    worker.addEventListener('error', fail);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    worker.postMessage({ arrayBuffer }, [arrayBuffer]);
  });
}

export function createDocxPreviewAdapter({
  createWorker = createDocxWorker,
  fetchRequest = fetch,
  timeoutMs = DIRECT_PREVIEW_TIMEOUT_MS,
  reportError,
}: DocxPreviewApiOptions = {}): DocxPreviewPort {
  return {
    async load(resource, signal) {
      const controller = new AbortController();
      let timedOut = false;
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException('DOCX direct preview timed out', 'TimeoutError'));
      }, timeoutMs);
      try {
        const response = await fetchRequest(resource.url, { signal: controller.signal });
        if (!response.ok) {
          throw new DocxPreviewError(
            'unavailable',
            `The DOCX source could not be loaded (HTTP ${response.status}).`,
          );
        }
        const arrayBuffer = await response.arrayBuffer();
        const worker = await createWorker();
        if (controller.signal.aborted) {
          worker.terminate();
          throw controller.signal.reason;
        }
        const html = await convert(worker, arrayBuffer, controller.signal);
        return { html };
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        reportError?.(error, 'docx-preview');
        if (timedOut) {
          throw new DocxPreviewError(
            'timeout',
            'The direct DOCX preview took too long. The prepared preview may still be available.',
            { cause: error },
          );
        }
        if (error instanceof DocxPreviewError) throw error;
        throw new DocxPreviewError('unavailable', 'The DOCX preview could not be created.', {
          cause: error,
        });
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    },
  };
}
