import type { HttpClient } from '@/platform/http/client';
import type { ErrorReporter } from '@/shared/runtime/error-reporting';
export type { ErrorReporter } from '@/shared/runtime/error-reporting';

/** Diagnostics go only to the local host, which redacts, deduplicates and applies
 * the same privacy preference as usage statistics before any external delivery. */
export function createErrorReporter(client: HttpClient): ErrorReporter {
  let pending = 0;
  const recent = new Map<string, number>();
  return (error, operation) => {
    try {
      const record = error instanceof Error ? error : null;
      if (record?.name === 'AbortError') return;
      const message = record?.message ?? (typeof error === 'string' ? error : 'Unknown error');
      const body = {
        message: message.length <= 32_000 ? message : '[omitted: oversized diagnostic]',
        stack: record?.stack && record.stack.length <= 32_000 ? record.stack : '',
        name: record?.name ?? 'Error',
        operation,
      };
      const key = `${operation}:${body.message}`;
      const now = Date.now();
      if (pending >= 4 || now - (recent.get(key) ?? -Infinity) < 60_000) return;
      if (recent.size >= 100) recent.delete(recent.keys().next().value ?? '');
      recent.set(key, now);
      pending += 1;
      void client
        .request({
          path: '/api/log/client-error',
          method: 'POST',
          body,
          signal: AbortSignal.timeout(2000),
        })
        .catch(() => {})
        .finally(() => {
          pending -= 1;
        });
    } catch {
      /* Reporting never changes the user operation. */
    }
  };
}

export function listenForRendererErrors(
  report: ErrorReporter,
  target: Window = window,
): () => void {
  const onError = (event: ErrorEvent) => {
    if (
      event.target instanceof Element &&
      ['IMG', 'VIDEO', 'AUDIO', 'IFRAME', 'SCRIPT', 'LINK'].includes(event.target.tagName)
    ) {
      report(new Error('Resource loading or decoding failed'), 'resource');
    } else report(event.error ?? event.message, 'uncaught');
  };
  const onRejection = (event: PromiseRejectionEvent) => report(event.reason, 'unhandled-rejection');
  target.addEventListener('error', onError, true);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError, true);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

/** Preserve the result/cancellation semantics of caught native operations. */
export async function reportFailure<T>(
  invoke: () => Promise<T>,
  report: ErrorReporter | undefined,
  operation: string,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await invoke();
  } catch (error) {
    if (!signal?.aborted) report?.(error, operation);
    throw error;
  }
}
