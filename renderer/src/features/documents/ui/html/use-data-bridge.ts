/** Source-checked RPC from an opaque frame; data paths remain page-relative. */
import { useEffect, useRef, type RefObject } from 'react';

import { htmlDataFailureMessage } from '@/features/documents/application/failure-messages';
import type { HtmlDataSession } from '@/features/documents/application/html-data-session';

import type { PageLoadObserver } from './page-ready';

export function useHtmlDataBridge(
  frame: RefObject<HTMLIFrameElement | null>,
  data: HtmlDataSession | undefined,
  url: string,
  active: boolean,
  loads?: PageLoadObserver,
): void {
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    if (!data) return;
    let disposed = false;
    let pending = 0;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const message: unknown = event.data;
      if (!message || typeof message !== 'object') return;
      const request = message as Record<string, unknown>;
      if (request.type !== 'stashbase-data-request' || !Number.isSafeInteger(request.id)) return;
      const target = frame.current?.contentWindow;
      const reply = (value: unknown, error?: string) => {
        if (!disposed && target === frame.current?.contentWindow)
          target?.postMessage({ type: 'stashbase-data-result', id: request.id, value, error }, '*');
      };
      if (pending >= 64) {
        reply(undefined, 'Too many pending data requests.');
        return;
      }
      if (
        request.method !== 'load' &&
        (!activeRef.current || globalThis.navigator.userActivation?.isActive !== true)
      ) {
        reply(undefined, 'Use a form control to update or save data.');
        return;
      }
      pending++;
      const loading = request.method === 'load';
      if (loading) loads?.started();
      void (async () => {
        try {
          if (disposed) return;
          if (
            request.method === 'load' &&
            (request.path === undefined || typeof request.path === 'string')
          )
            reply(await data.load(request.path));
          else if (request.method === 'save') {
            await data.save();
            reply(undefined);
          } else if (request.method === 'update' && typeof request.content === 'string') {
            await data.update(request.content);
            reply(undefined);
          } else reply(undefined, 'Invalid data request.');
        } catch (error) {
          reply(undefined, htmlDataFailureMessage(error));
        } finally {
          pending--;
          if (loading) loads?.settled();
        }
      })();
    };
    globalThis.addEventListener('message', receive);
    return () => {
      disposed = true;
      globalThis.removeEventListener('message', receive);
    };
  }, [data, frame, loads, url]);
}
