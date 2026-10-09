import { ProjectError, type ProjectLifecyclePort } from '@/features/workspace/application/ports';
import type { ProjectLifecycleBridge } from '@/platform/electron/project-lifecycle';
import { reportFailure, type ErrorReporter } from '@/platform/error-reporting';
import type { ProjectLifecycleResponse } from '@/protocols/electron/project';

function lifecycleFailure(
  response: Extract<ProjectLifecycleResponse, { ok: false }>,
): ProjectError {
  const kind = response.failure.kind;
  return new ProjectError(
    kind === 'invalid-response' || kind === 'unauthorized' ? kind : 'unavailable',
    response.failure.message,
  );
}

function accept(response: ProjectLifecycleResponse): void {
  if (!response.ok) throw lifecycleFailure(response);
}

export function createProjectLifecycleAdapter(
  bridge: ProjectLifecycleBridge,
  reportError?: ErrorReporter,
): ProjectLifecyclePort {
  return {
    enterFolder: (path, signal) =>
      reportFailure(
        async () => {
          signal.throwIfAborted();
          const id = crypto.randomUUID();
          const cancel = () => {
            void bridge.cancelEntry(id).catch(() => {});
          };
          signal.addEventListener('abort', cancel, { once: true });
          try {
            const response = await bridge.openFolderWindow(path, id);
            if (!response.ok) throw lifecycleFailure(response);
          } finally {
            signal.removeEventListener('abort', cancel);
          }
        },
        reportError,
        'project-lifecycle',
        signal,
      ),
    onEnterFolder(handler) {
      const pending = new Map<string, AbortController>();
      const unsubscribeCancellation = bridge.onEntryCancelled((id) => pending.get(id)?.abort());
      const unsubscribeEntry = bridge.onEnterFolder(async (request) => {
        const controller = new AbortController();
        pending.set(request.requestId, controller);
        try {
          return await handler(request.folderPath, controller.signal);
        } finally {
          pending.delete(request.requestId);
        }
      });
      return () => {
        unsubscribeCancellation();
        unsubscribeEntry();
        for (const controller of pending.values()) controller.abort();
      };
    },
    notifyFolderRemoved: (folderPath) =>
      reportFailure(
        async () => {
          accept(await bridge.notifyFolderRemoved(folderPath));
        },
        reportError,
        'project-lifecycle',
      ),
    onFolderRemoved: (handler) => bridge.onFolderRemoved(handler),
    onPrepareFolderRemoval: (handler) => bridge.onPrepareFolderRemoval(handler),
    prepareFolderRemoval: (folderPath) =>
      reportFailure(
        async () => {
          const response = await bridge.prepareFolderRemoval(folderPath);
          if (!response.ok) throw lifecycleFailure(response);
          return response.ready;
        },
        reportError,
        'project-lifecycle',
      ),
    setActiveFolder: (folderPath) =>
      reportFailure(
        async () => {
          accept(await bridge.setActiveFolder(folderPath));
        },
        reportError,
        'project-lifecycle',
      ),
  };
}
