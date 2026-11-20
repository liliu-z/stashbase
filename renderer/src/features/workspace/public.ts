/**
 * The Workspace feature's whole surface to `renderer/src/app`.
 *
 * The feature answers for its own transports through `createWorkspaceAdapters`,
 * so nothing here names an HTTP client or a desktop bridge, and a feature that
 * moves a port between HTTP and the desktop bridge does not change the app.
 * Everything named here has a caller in the running app; what only a test
 * builds lives in `test-support.ts`.
 */
export { useWorkspace } from './hooks/use-workspace';
export { useFiles } from './hooks/use-files';
export { useHiddenFiles } from './hooks/use-hidden-files';
export { useProject } from './hooks/use-project';
export { useProjectLifecycle } from './hooks/use-project-lifecycle';
export {
  useWorkspaceSession,
  type WorkspaceSessionController,
} from './hooks/use-workspace-session';
export { useReveal } from './hooks/use-reveal';
export { refreshFolderListing } from './application/queries';
export type { WorkspaceRuntime } from './application/runtime';
export { AGENT_PANE_WIDTH } from './domain/session';
export {
  fileIsRestricted,
  systemEntryPath,
  type WorkspaceEntry,
  type WorkspaceListing,
} from './domain/tree';
export type { ActiveProjectFolder, ProjectRegistrySnapshot } from './domain/project';
export type { WorkspaceScope } from './domain/workspace';
export { createWorkspaceAdapters, type WorkspaceAdapters } from './infrastructure/adapters';
export { FileTree, type FileTreeRowMarker } from './ui/file-tree';
export { ProjectSidebar } from './ui/sidebar';
export { ProjectWelcome } from './ui/welcome';

export { useProjectEntry, type ProjectEntry } from './hooks/use-project-entry';
export { useProjectEntryReceiver } from './hooks/use-project-entry-receiver';
export { ImportGitHubDialog } from './ui/import-github-dialog';

export type { ProjectFolderPickerPort } from './application/ports';

export { FilesError } from './application/ports';

export { FileImport } from './ui/file-import';
