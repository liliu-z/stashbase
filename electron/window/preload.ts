import {
  WINDOW_CONTEXT_RELEASE_READY_CHANNEL,
  WINDOW_APPEARANCE_CHANNEL,
  WINDOW_PREPARE_CONTEXT_RELEASE_CHANNEL,
  type WindowContextReleaseReason,
  type WindowAppearance,
  windowContextReleaseReadySchema,
  windowContextReleaseRequestSchema,
  windowAppearanceSchema,
} from '../../shared/protocols/electron/window-lifecycle.ts';

export interface IpcRenderer {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

export interface WindowLifecyclePreload {
  onPrepareContextRelease(
    handler: (reason: WindowContextReleaseReason) => boolean | Promise<boolean>,
  ): () => void;
  setAppearance(appearance: WindowAppearance): Promise<void>;
}

export function createWindowLifecyclePreload(ipcRenderer: IpcRenderer): WindowLifecyclePreload {
  const handlers = new Set<(reason: WindowContextReleaseReason) => boolean | Promise<boolean>>();

  ipcRenderer.on(WINDOW_PREPARE_CONTEXT_RELEASE_CHANNEL, (_event, payload) => {
    const request = windowContextReleaseRequestSchema.safeParse(payload);
    if (!request.success) return;
    void (async () => {
      let ready = handlers.size > 0;
      for (const handler of handlers) {
        try {
          if ((await handler(request.data.reason)) !== true) ready = false;
        } catch {
          ready = false;
        }
      }
      try {
        await ipcRenderer.invoke(
          WINDOW_CONTEXT_RELEASE_READY_CHANNEL,
          windowContextReleaseReadySchema.parse({ ...request.data, ready }),
        );
      } catch {
        // Main owns the bounded timeout when acknowledgement cannot cross.
      }
    })();
  });

  const preload: WindowLifecyclePreload = {
    onPrepareContextRelease(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async setAppearance(appearance) {
      await ipcRenderer.invoke(WINDOW_APPEARANCE_CHANNEL, windowAppearanceSchema.parse(appearance));
    },
  };
  return Object.freeze(preload);
}
