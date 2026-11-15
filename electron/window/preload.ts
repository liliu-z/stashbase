import {
  WINDOW_CONTEXT_RELEASE_READY_CHANNEL,
  WINDOW_CONTEXT_RELEASE_PENDING_CHANNEL,
  WINDOW_APPEARANCE_CHANNEL,
  WINDOW_INPUT_ACTIVITY_CHANNEL,
  WINDOW_PREPARE_CONTEXT_RELEASE_CHANNEL,
  type WindowContextReleaseReason,
  type WindowAppearance,
  windowContextReleaseReadySchema,
  windowContextReleaseRequestSchema,
  windowAppearanceSchema,
  windowInputActivitySchema,
  type WindowInputActivity,
} from '../../shared/protocols/electron/window-lifecycle.ts';

export interface IpcRenderer {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

export interface WindowLifecyclePreload {
  onInputActivity(handler: (kind: WindowInputActivity) => void): () => void;
  onPrepareContextRelease(
    handler: (reason: WindowContextReleaseReason) => boolean | Promise<boolean>,
    options?: { interactive: boolean },
  ): () => void;
  setAppearance(appearance: WindowAppearance): Promise<void>;
}

export function createWindowLifecyclePreload(ipcRenderer: IpcRenderer): WindowLifecyclePreload {
  const inputHandlers = new Set<(kind: WindowInputActivity) => void>();
  ipcRenderer.on(WINDOW_INPUT_ACTIVITY_CHANNEL, (_event, payload) => {
    const input = windowInputActivitySchema.safeParse(payload);
    if (input.success) for (const handler of inputHandlers) handler(input.data);
  });
  const handlers = new Map<(reason: WindowContextReleaseReason) => boolean | Promise<boolean>, boolean>();

  ipcRenderer.on(WINDOW_PREPARE_CONTEXT_RELEASE_CHANNEL, (_event, payload) => {
    const request = windowContextReleaseRequestSchema.safeParse(payload);
    if (!request.success) return;
    void (async () => {
      let ready = handlers.size > 0;
      for (const [handler, interactive] of handlers) {
        const keepWaiting = () => { void ipcRenderer.invoke(WINDOW_CONTEXT_RELEASE_PENDING_CHANNEL, request.data).catch(() => {}); };
        const heartbeat = interactive ? setInterval(keepWaiting, 1000) : undefined;
        if (interactive) keepWaiting();
        try {
          if ((await handler(request.data.reason)) !== true) ready = false;
        } catch {
          ready = false;
        } finally { clearInterval(heartbeat); }
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
    onInputActivity(handler) {
      inputHandlers.add(handler);
      return () => inputHandlers.delete(handler);
    },
    onPrepareContextRelease(handler, options) {
      handlers.set(handler, options?.interactive === true);
      return () => handlers.delete(handler);
    },
    async setAppearance(appearance) {
      await ipcRenderer.invoke(WINDOW_APPEARANCE_CHANNEL, windowAppearanceSchema.parse(appearance));
    },
  };
  return Object.freeze(preload);
}
