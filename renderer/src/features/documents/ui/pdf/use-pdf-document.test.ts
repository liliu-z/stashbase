import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { ErrorReportingProvider } from '@/shared/runtime/error-reporting';

import { usePdfDocument, type PdfLoadTask } from './use-pdf-document';

afterEach(cleanup);

function pendingTask(): PdfLoadTask {
  return { destroy: vi.fn(async () => undefined), promise: new Promise(() => undefined) };
}

describe('PDF document lifecycle', () => {
  it('destroys the old loading task when the versioned URL changes', () => {
    const first = pendingTask();
    const second = pendingTask();
    const load = vi.fn((url: string) => (url.endsWith('v=1') ? first : second));
    const hook = renderHook(({ url }) => usePdfDocument(url, load), {
      initialProps: { url: 'http://127.0.0.1/asset/paper.pdf?v=1' },
    });

    hook.rerender({ url: 'http://127.0.0.1/asset/paper.pdf?v=2' });
    expect(first.destroy).toHaveBeenCalledOnce();
    hook.unmount();
    expect(second.destroy).toHaveBeenCalledOnce();
  });

  it('rejects late document completion after disposal', async () => {
    let resolveDocument: ((value: never) => void) | undefined;
    const task = {
      destroy: vi.fn(async () => undefined),
      promise: new Promise<never>((resolve) => {
        resolveDocument = resolve;
      }),
    };
    const document = { destroy: vi.fn(async () => undefined) };
    const load = vi.fn(() => task);
    const hook = renderHook(() => usePdfDocument('http://127.0.0.1/paper.pdf?v=1', load));
    hook.unmount();
    resolveDocument?.(document as never);

    await waitFor(() => expect(document.destroy).toHaveBeenCalledOnce());
  });
});

it('reports PDF parser rejection while preserving its local failure surface', async () => {
  const failure = new Error('Invalid PDF structure');
  const load = vi.fn(() => ({
    destroy: vi.fn(async () => undefined),
    promise: Promise.reject(failure),
  }));
  const report = vi.fn();
  const hook = renderHook(() => usePdfDocument('http://127.0.0.1/private.pdf', load), {
    wrapper: ({ children }) => createElement(ErrorReportingProvider, { report }, children),
  });
  await waitFor(() => expect(hook.result.current.error).toBe('The PDF could not be opened.'));
  expect(report).toHaveBeenCalledWith(failure, 'pdf-preview');
});
