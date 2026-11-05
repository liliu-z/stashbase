import { type ProjectRegistryPort, ProjectError } from '@/features/workspace/application/ports';
import type { ProjectRegistrySnapshot } from '@/features/workspace/domain/project';
import { request, type TransportFailure } from '@/platform/http/classify';
import type { HttpClient } from '@/platform/http/client';
import {
  projectFailureSchema,
  projectOpenFolderRequestSchema,
  projectRemoveFolderRequestSchema,
  projectRegistrySnapshotSchema,
  projectRevealFolderRequestSchema,
  projectRevealFolderResponseSchema,
} from '@/protocols/http/project';
import type { ProjectRegistrySnapshotWire } from '@/protocols/http/project';

function mapSnapshot(snapshot: ProjectRegistrySnapshotWire): ProjectRegistrySnapshot {
  return {
    activeFolder: snapshot.current,
    homeDirectory: snapshot.homeDir,
    projects: snapshot.recent.map((member) => ({
      favorite: member.favorite === true,
      openedAt: member.openedAt,
      path: member.path,
    })),
  };
}

/** The project owns no folder scope of its own, so a refusal is either the
 *  window losing its grant or the project itself being unreachable. */
function projectFailure({ response, serverMessage }: TransportFailure): ProjectError {
  const retired = response.status === 401 || response.status === 403 || response.status === 410;
  return new ProjectError(
    retired ? 'unauthorized' : 'unavailable',
    retired ? 'This window can no longer open folders.' : 'The project is unavailable.',
    serverMessage === null ? undefined : { cause: new Error(serverMessage) },
  );
}

export function createProjectRegistryAdapter(client: HttpClient): ProjectRegistryPort {
  const snapshot = async (
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<ProjectRegistrySnapshot> =>
    mapSnapshot(
      await request(client, {
        ...(body === undefined ? {} : { body, method: 'POST' as const }),
        error: ProjectError,
        failure: projectFailure,
        failureSchema: projectFailureSchema,
        path,
        schema: projectRegistrySnapshotSchema,
        signal,
      }),
    );

  return {
    load: (signal) => snapshot('/api/projects', signal),
    openFolder: (path, signal) =>
      snapshot('/api/projects/open', signal, projectOpenFolderRequestSchema.parse({ path })),
    removeFolder: (path, signal) =>
      snapshot('/api/projects/remove', signal, projectRemoveFolderRequestSchema.parse({ path })),
    async revealFolder(path, signal) {
      await request(client, {
        body: projectRevealFolderRequestSchema.parse({ path }),
        error: ProjectError,
        failure: projectFailure,
        failureSchema: projectFailureSchema,
        method: 'POST',
        path: '/api/projects/reveal',
        schema: projectRevealFolderResponseSchema,
        signal,
      });
    },
  };
}
