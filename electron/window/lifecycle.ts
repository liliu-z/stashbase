import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';

import {
  WINDOW_CONTEXT_RELEASE_READY_CHANNEL,
  WINDOW_CONTEXT_RELEASE_PENDING_CHANNEL,
  WINDOW_FULLSCREEN_CHANNEL,
  WINDOW_INPUT_ACTIVITY_CHANNEL,
  WINDOW_LIFECYCLE_CAPABILITY,
  WINDOW_PREPARE_CONTEXT_RELEASE_CHANNEL,
  type WindowContextReleaseReason,
  windowContextReleaseReadySchema,
  windowContextReleaseRequestSchema,
  windowFullScreenSchema,
  windowContextReleaseResponseSchema,
} from '../../shared/protocols/electron/window-lifecycle.ts';
import { createAckCoordinator } from '../ack-coordinator.ts';
import { authorizeSender, type SenderAuthorization } from '../project/dialog.ts';

export { WINDOW_LIFECYCLE_CAPABILITY };

interface LifecycleWebContents {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  on(event: 'did-finish-load' | 'render-process-gone', listener: () => void): void;
}

type LifecycleWindow = BrowserWindow & { webContents: LifecycleWebContents };

export interface WindowLifecycleDependencies extends SenderAuthorization {
  ipcMain: Pick<IpcMain, 'handle'>;
  isLiveWindow(window: BrowserWindow | null): boolean;
  onCloseBlocked?(): void;
  /** Best-effort host retirement after saves succeed, before sockets disappear. */
  beforeClose?(window: BrowserWindow): Promise<unknown>;
}

export function registerWindowLifecycle(
  dependencies: WindowLifecycleDependencies,
  {
    createRequestId,
    timeoutMs,
  }: { createRequestId?: () => string; timeoutMs?: number } = {},
) {
  const loaded = new WeakSet<LifecycleWindow>();
  const approvedClose = new WeakSet<LifecycleWindow>();
  const retiredClose = new WeakSet<LifecycleWindow>();
  const closing = new WeakSet<LifecycleWindow>();
  const acks = createAckCoordinator({
    channel: WINDOW_PREPARE_CONTEXT_RELEASE_CHANNEL,
    message: (reason, requestId) => ({ reason, requestId }),
    createRequestId,
    timeoutMs,
  });

  const request = (
    window: LifecycleWindow,
    reason: WindowContextReleaseReason,
  ): Promise<boolean> => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve(false);
    if (!loaded.has(window)) return Promise.resolve(true);
    return acks.request(window.webContents, reason);
  };

  dependencies.ipcMain.handle(WINDOW_CONTEXT_RELEASE_PENDING_CHANNEL, (event: IpcMainInvokeEvent, payload) => {
    const window = authorizeSender(event, dependencies, WINDOW_LIFECYCLE_CAPABILITY);
    const parsed = windowContextReleaseRequestSchema.safeParse(payload);
    if (window && parsed.success) acks.defer(event.sender.id, parsed.data.requestId, parsed.data.reason);
    return windowContextReleaseResponseSchema.parse({ ok: true });
  });

  dependencies.ipcMain.handle(
    WINDOW_CONTEXT_RELEASE_READY_CHANNEL,
    (event: IpcMainInvokeEvent, rawResponse) => {
      const senderWindow = authorizeSender(
        event,
        dependencies,
        WINDOW_LIFECYCLE_CAPABILITY,
      ) as LifecycleWindow | null;
      if (!senderWindow) return windowContextReleaseResponseSchema.parse({ ok: true });
      const response = windowContextReleaseReadySchema.safeParse(rawResponse);
      if (response.success) {
        acks.acknowledge(
          event.sender.id,
          response.data.requestId,
          response.data.reason,
          response.data.ready,
        );
      }
      return windowContextReleaseResponseSchema.parse({ ok: true });
    },
  );

  return {
    attach(window: LifecycleWindow) {
      const webContentsId = window.webContents.id;
      // Chromium reports real input even inside an opaque HTML frame. Authored
      // scripts cannot manufacture this through DOM dispatch or postMessage.
      window.webContents.on('input-event', (_event, input) => {
        if (window.isDestroyed() || window.webContents.isDestroyed()
          || !dependencies.isLiveWindow(window) || !window.isVisible() || !window.isFocused()) return;
        const kind = input.type === 'keyDown' || input.type === 'rawKeyDown' ? 'keyboard'
          : input.type === 'mouseDown' || input.type === 'mouseWheel' ? 'pointer' : null;
        if (kind) window.webContents.send(WINDOW_INPUT_ACTIVITY_CHANNEL, kind);
      });
      // Native fullscreen hides the platform's own chrome, and the shell lays
      // itself out around that chrome, so the state is pushed on every change
      // and once more when a document has loaded and can hear it.
      const pushFullScreen = () => {
        if (window.isDestroyed() || window.webContents.isDestroyed()) return;
        window.webContents.send(
          WINDOW_FULLSCREEN_CHANNEL,
          windowFullScreenSchema.parse({ fullscreen: window.isFullScreen() }),
        );
      };
      window.on('enter-full-screen', pushFullScreen);
      window.on('leave-full-screen', pushFullScreen);
      window.webContents.on('did-finish-load', () => {
        loaded.add(window);
        pushFullScreen();
      });
      window.webContents.on('render-process-gone', () => {
        // A gone renderer has already lost its buffers and cannot acknowledge
        // a save barrier. A live but unresponsive renderer still must do so.
        loaded.delete(window);
        acks.settle(webContentsId, true);
      });
      window.on('close', (event) => {
        if (retiredClose.has(window)) return;
        const needsSave = !approvedClose.has(window) && loaded.has(window);
        if (!needsSave && !dependencies.beforeClose) return;
        event.preventDefault();
        if (closing.has(window)) return;
        closing.add(window);
        void (needsSave ? request(window, 'window-close') : Promise.resolve(true))
          .catch(() => false)
          .then(async (ready) => {
            if (!ready) { dependencies.onCloseBlocked?.(); return; }
            if (!dependencies.isLiveWindow(window)) return;
            // A failed/unreachable host cannot retain a window whose saves
            // succeeded. The closed handler still retries context cleanup.
            await dependencies.beforeClose?.(window).catch(() => {});
            if (!dependencies.isLiveWindow(window)) return;
            retiredClose.add(window);
            window.close();
          })
          .finally(() => closing.delete(window));
      });
      window.on('closed', () => acks.settle(webContentsId, false));
    },
    hasLoadedRenderer(window: LifecycleWindow) {
      return loaded.has(window);
    },
    requestContextRelease(window: LifecycleWindow, reason: WindowContextReleaseReason) {
      return request(window, reason);
    },
    approveClose(window: LifecycleWindow) {
      approvedClose.add(window);
    },
    revokeCloseApproval(window: LifecycleWindow) {
      approvedClose.delete(window);
    },
  };
}
