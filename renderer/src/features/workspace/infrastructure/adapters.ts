import type {
  FilesPort,
  GitHubImportPort,
  ProjectLifecyclePort,
  ProjectRegistryPort,
  UploadPort,
  WorkspacePreferencesPort,
  WorkspaceSessionPort,
} from '@/features/workspace/application/ports';
import type { ProjectBridge } from '@/platform/electron/folder-picker';
import type { ProjectLifecycleBridge } from '@/platform/electron/project-lifecycle';
import type { HttpClient } from '@/platform/http/client';

import { createProjectRegistryAdapter } from './api';
import { createFilesAdapter } from './files-api';
import { createGitHubImportAdapter } from './github-import-api';
import { createProjectLifecycleAdapter } from './project-lifecycle';
import type { WorkspaceSessionBridge } from './session-persistence';
import { createWorkspaceSessionAdapter } from './session-persistence';
import { createUploadAdapter } from './upload-api';
import { createWorkspacePreferencesAdapter } from './workspace-preferences-api';

/** Every port the Workspace feature needs a real implementation of, in one
 *  record so the app wires the feature rather than individual transports. */
export interface WorkspaceAdapters {
  files: FilesPort;
  githubImport: GitHubImportPort;
  project: ProjectRegistryPort;
  lifecycle: ProjectLifecyclePort;
  preferences: WorkspacePreferencesPort;
  session: WorkspaceSessionPort;
  upload: UploadPort;
}

export interface WorkspaceAdapterOptions {
  http: HttpClient;
  project: ProjectBridge & ProjectLifecycleBridge;
  serverOrigin: string;
  workspaceSession: WorkspaceSessionBridge;
}

export function createWorkspaceAdapters({
  http,
  project,
  serverOrigin,
  workspaceSession,
}: WorkspaceAdapterOptions): WorkspaceAdapters {
  return {
    files: createFilesAdapter(http),
    githubImport: createGitHubImportAdapter(http),
    project: createProjectRegistryAdapter(http),
    preferences: createWorkspacePreferencesAdapter(http),
    lifecycle: createProjectLifecycleAdapter(project, http.reportError),
    session: createWorkspaceSessionAdapter(workspaceSession, http.reportError),
    upload: createUploadAdapter(serverOrigin, fetch, http.reportError),
  };
}
