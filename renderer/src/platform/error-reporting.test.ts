import { describe, expect, it, vi } from 'vite-plus/test';

import { httpClient } from '@/test/fakes/http';

import { createErrorReporter, listenForRendererErrors } from './error-reporting';

describe('renderer error reporting', () => {
  it('reports only diagnostic fields to the local host, coalesces repeats, and contains delivery failure', async () => {
    const client = httpClient();
    const request = vi.spyOn(client, 'request').mockRejectedValue(new Error('host unavailable'));
    const report = createErrorReporter(client);
    const error = new Error('Renderer failed');
    report(error, 'render');
    report(error, 'render');
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      path: '/api/log/client-error',
      method: 'POST',
      signal: expect.any(AbortSignal),
      body: { message: 'Renderer failed', stack: error.stack, name: 'Error', operation: 'render' },
    });
    report(new DOMException('cancelled', 'AbortError'), 'render');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not stringify unknown objects and bounds large diagnostics', () => {
    const client = httpClient();
    const request = vi.spyOn(client, 'request');
    const report = createErrorReporter(client);
    report({ prompt: 'private input', token: 'private token' }, 'render');
    report(new Error('x'.repeat(40_000)), 'render');
    expect(JSON.stringify(request.mock.calls)).not.toContain('private input');
    expect(JSON.stringify(request.mock.calls)).not.toContain('private token');
    expect(JSON.stringify(request.mock.calls)).not.toContain('x'.repeat(100));
  });

  it('owns global error listeners and removes them on disposal', () => {
    const report = vi.fn();
    const dispose = listenForRendererErrors(report);
    const failure = new Error('Event handler failed');
    window.dispatchEvent(new ErrorEvent('error', { error: failure }));
    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: failure });
    window.dispatchEvent(rejection);
    expect(report.mock.calls).toEqual([
      [failure, 'uncaught'],
      [failure, 'unhandled-rejection'],
    ]);
    dispose();
    window.dispatchEvent(new ErrorEvent('error', { error: failure }));
    expect(report).toHaveBeenCalledTimes(2);
  });
});

it('captures non-bubbling media errors without collecting the resource URL', () => {
  const report = vi.fn();
  const dispose = listenForRendererErrors(report);
  const image = document.createElement('img');
  image.src = 'file:///private/Acquisition.png';
  document.body.append(image);
  image.dispatchEvent(new Event('error', { bubbles: false }));
  expect(report).toHaveBeenCalledWith(expect.any(Error), 'resource');
  expect(report.mock.calls[0]?.[0].message).not.toContain('Acquisition');
  dispose();
  image.dispatchEvent(new Event('error'));
  expect(report).toHaveBeenCalledTimes(1);
  image.remove();
});
