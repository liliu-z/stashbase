import crypto from 'node:crypto';

interface AckTarget {
  id: number;
  send(channel: string, payload: unknown): void;
}

/**
 * One outstanding renderer acknowledgement per webContents. A request names a
 * subject (a folder path, a release reason); a repeat for the same subject
 * shares the pending promise, and a different subject is refused while one is
 * pending. Only an acknowledgement echoing both the request id and the subject
 * settles it; otherwise the timeout resolves it as not ready.
 */
export function createAckCoordinator({
  channel,
  message,
  createRequestId = () => crypto.randomUUID(),
  timeoutMs = 5_000,
}: {
  channel: string;
  message(subject: string, requestId: string): unknown;
  createRequestId?: () => string;
  timeoutMs?: number;
}) {
  const pendingByWebContents = new Map<
    number,
    {
      promise: Promise<boolean>;
      requestId: string;
      resolve: (ready: boolean) => void;
      subject: string;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const settle = (webContentsId: number, ready: boolean) => {
    const pending = pendingByWebContents.get(webContentsId);
    if (!pending) return false;
    pendingByWebContents.delete(webContentsId);
    clearTimeout(pending.timer);
    pending.resolve(ready);
    return true;
  };

  return {
    request(webContents: AckTarget, subject: string): Promise<boolean> {
      const existing = pendingByWebContents.get(webContents.id);
      if (existing) return existing.subject === subject ? existing.promise : Promise.resolve(false);

      const requestId = createRequestId();
      let resolve!: (ready: boolean) => void;
      const promise = new Promise<boolean>((done) => {
        resolve = done;
      });
      const timer = setTimeout(() => settle(webContents.id, false), timeoutMs);
      timer.unref?.();
      pendingByWebContents.set(webContents.id, { promise, requestId, resolve, subject, timer });
      webContents.send(channel, message(subject, requestId));
      return promise;
    },
    /** An interactive barrier keeps its current request live, while a lost
     * renderer still expires within the ordinary acknowledgement deadline. */
    defer(webContentsId: number, requestId: string, subject: string): boolean {
      const pending = pendingByWebContents.get(webContentsId);
      if (!pending || pending.requestId !== requestId || pending.subject !== subject) return false;
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => settle(webContentsId, false), timeoutMs);
      pending.timer.unref?.();
      return true;
    },
    acknowledge(webContentsId: number, requestId: string, subject: string, ready: boolean): boolean {
      const pending = pendingByWebContents.get(webContentsId);
      if (!pending || pending.requestId !== requestId || pending.subject !== subject) return false;
      return settle(webContentsId, ready);
    },
    settle,
  };
}
