import { SESSION_MESSAGES } from '@/features/workspace/application/failure-messages';
import {
  WorkspaceSessionError,
  type WorkspaceSessionPort,
} from '@/features/workspace/application/ports';
import type { WorkspaceSessionSnapshot } from '@/features/workspace/domain/session';
import { reportFailure, type ErrorReporter } from '@/platform/error-reporting';
import {
  workspaceSessionReadResponseSchema,
  workspaceSessionSnapshotSchema,
  workspaceSessionWriteResponseSchema,
  type WorkspaceSessionSnapshotWire,
} from '@/protocols/electron/workspace-session';

export interface WorkspaceSessionBridge {
  read(): Promise<unknown>;
  write(snapshot: WorkspaceSessionSnapshotWire): Promise<unknown>;
}

function toDomain(snapshot: WorkspaceSessionSnapshotWire): WorkspaceSessionSnapshot {
  return {
    activeFolderPath: snapshot.activeFolderPath,
    folders: snapshot.folders.map((folder) => ({
      activeTabId: folder.activeTabId,
      expandedPaths: [...folder.expandedPaths],
      folderPath: folder.folderPath,
      selectedPath: folder.selectedPath,
      tabs: folder.tabs.map((tab) => ({ ...tab })),
    })),
    shell: { ...snapshot.shell },
    version: snapshot.version,
  };
}

function toWire(snapshot: WorkspaceSessionSnapshot): WorkspaceSessionSnapshotWire {
  return workspaceSessionSnapshotSchema.parse(snapshot);
}

/** The desktop's own sentence names the file it could not touch, so it travels
 *  as the cause; what a reader would see comes from the workspace ladder. */
function sessionRefusal(operation: 'load' | 'save', serverMessage: string): WorkspaceSessionError {
  return new WorkspaceSessionError('unavailable', SESSION_MESSAGES[operation], {
    cause: new Error(serverMessage),
  });
}

export function createWorkspaceSessionAdapter(
  bridge: WorkspaceSessionBridge,
  reportError?: ErrorReporter,
): WorkspaceSessionPort {
  return {
    load: () =>
      reportFailure(
        async () => {
          const response = workspaceSessionReadResponseSchema.parse(await bridge.read());
          if (!response.ok) throw sessionRefusal('load', response.failure.message);
          return response.session ? toDomain(response.session) : null;
        },
        reportError,
        'workspace-session',
      ),
    save: (snapshot) =>
      reportFailure(
        async () => {
          const response = workspaceSessionWriteResponseSchema.parse(
            await bridge.write(toWire(snapshot)),
          );
          if (!response.ok) throw sessionRefusal('save', response.failure.message);
        },
        reportError,
        'workspace-session',
      ),
  };
}
