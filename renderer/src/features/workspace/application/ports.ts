/** Every capability the Workspace feature asks of the host, and the failure
 *  ladders those requests come back on. Adapters implement these; nothing
 *  named here knows which transport answers. */
import type {
  ProjectFailureKind,
  ProjectRegistrySnapshot,
} from '@/features/workspace/domain/project';
import type { WorkspaceSessionSnapshot } from '@/features/workspace/domain/session';
import type { WorkspaceEntry, WorkspaceListing } from '@/features/workspace/domain/tree';
import {
  featureErrorClass,
  type FeatureError,
  type FeatureFailureKind,
} from '@/shared/domain/feature-error';

type ProjectFolderPickerResult =
  | { status: 'cancelled' }
  | {
      status: 'failed';
      failure: {
        kind: ProjectFailureKind | 'fatal';
        message: string;
      };
    }
  | { status: 'selected'; folderPath: string };

export interface ProjectRegistryPort {
  load(signal: AbortSignal): Promise<ProjectRegistrySnapshot>;
  openFolder(path: string, signal: AbortSignal): Promise<ProjectRegistrySnapshot>;
  removeFolder(path: string, signal: AbortSignal): Promise<ProjectRegistrySnapshot>;
  /** Shows a registered project's folder in the system file manager. */
  revealFolder(path: string, signal: AbortSignal): Promise<void>;
}

interface FolderPickerOptions {
  defaultPath?: string;
}

export interface ProjectFolderPickerPort {
  chooseFolder(options?: FolderPickerOptions): Promise<ProjectFolderPickerResult>;
}

export interface WorkspaceQueryScope {
  cancel(): Promise<void>;
  remove(): void;
}

export interface WorkspaceSessionPort {
  load(): Promise<WorkspaceSessionSnapshot | null>;
  save(snapshot: WorkspaceSessionSnapshot): Promise<void>;
}

export interface ProjectLifecyclePort {
  enterFolder(folderPath: string, signal: AbortSignal): Promise<void>;
  onEnterFolder(
    handler: (folderPath: string, signal: AbortSignal) => Promise<string | null>,
  ): () => void;
  notifyFolderRemoved(folderPath: string): Promise<void>;
  onFolderRemoved(handler: (folderPath: string) => void): () => void;
  onPrepareFolderRemoval(handler: (folderPath: string) => boolean | Promise<boolean>): () => void;
  prepareFolderRemoval(folderPath: string): Promise<boolean>;
  setActiveFolder(folderPath: string | null): Promise<void>;
}

/** The Workbench's hidden-entry visibility. One durable application-level
 *  value, so it is neither folder-scoped nor per window. The server keeps
 *  classification authority: this only asks for eligible hidden entries to be
 *  listed, and never widens what is eligible. */
export interface WorkspacePreferencesPort {
  load(signal: AbortSignal): Promise<boolean>;
  setShowHiddenFiles(next: boolean, signal: AbortSignal): Promise<boolean>;
}

/** Acquire a public GitHub repository as a project folder. The server owns
 *  cloning, isolated staging, atomic publication, registration, and the
 *  background sync trigger; this only asks and reports. A refusal names a code
 *  the caller turns into a sentence, so no transport prose reaches a reader,
 *  and a cancelled request leaves no partial member behind. */
export interface GitHubImportPort {
  /** Where the next copy starts: the last copy's location while it remains,
   *  otherwise the folder home. */
  location(signal: AbortSignal): Promise<string>;
  /** Why the server would refuse this destination name, or null when usable.
   *  Carried here rather than re-derived in the feature so inline feedback is
   *  the same rule the request will meet. */
  folderNameIssue(name: string): string | null;
  /** The destination name the server would derive from this URL, or why it
   *  would refuse the URL. */
  readUrl(raw: string): { folderName: string; ok: true } | { message: string; ok: false };
  /** Resolves the published folder path, created inside `location`. */
  run(
    url: string,
    folderName: string,
    location: string,
    signal: AbortSignal,
    templateId?: string,
  ): Promise<string>;
}

export interface FilesPort {
  load(folderPath: string, signal: AbortSignal): Promise<WorkspaceListing>;
  reveal(folderPath: string, entryPath: string, signal: AbortSignal): Promise<void>;
  createInteractiveNote(
    folderPath: string,
    parentPath: string,
    signal: AbortSignal,
  ): Promise<{ path: string; entryPath: string }>;
  /** Creates one file or folder under `parentPath` and returns the settled
   *  path: the server may complete a file's extension. */
  createEntry(
    folderPath: string,
    kind: WorkspaceEntry['kind'],
    parentPath: string,
    name: string,
    signal: AbortSignal,
  ): Promise<{ path: string }>;
  /** Gives an entry a new leaf name in its own parent and returns the
   *  settled path. */
  renameEntry(
    folderPath: string,
    entry: WorkspaceEntry,
    name: string,
    signal: AbortSignal,
  ): Promise<{ path: string }>;
  /** Moves a file or folder under its own name into `parentPath`, an existing
   *  folder of the same project (empty for the root), and returns the settled
   *  path. A folder never moves into itself. */
  moveEntry(
    folderPath: string,
    entry: WorkspaceEntry,
    parentPath: string,
    signal: AbortSignal,
  ): Promise<{ path: string }>;
  /** Deletes a file, or a folder with everything inside it, from disk. */
  deleteEntry(folderPath: string, entry: WorkspaceEntry, signal: AbortSignal): Promise<void>;
}

interface UploadFile {
  readonly blob: Blob;
  /** The file's own name. A name with separators is a dropped folder's
   *  layout, which lands beside existing folders rather than inside them. */
  readonly name: string;
}

export interface UploadResult {
  readonly paths: readonly string[];
  /** Request indices of refused files; successful files must not be retried. */
  readonly refused: readonly number[];
}

export interface UploadPort {
  /** Imports into one captured project, preserving successful partial
   *  results. Files land in `parentPath`, an existing folder of the project;
   *  the root when empty. */
  upload(
    folderPath: string,
    files: readonly UploadFile[],
    signal: AbortSignal,
    parentPath: string,
  ): Promise<UploadResult>;
}

export type ProjectError = FeatureError;
export const ProjectError = featureErrorClass('ProjectError');

/** The saved-session bridge fails on the workspace ladder like every other
 *  workspace transport: the desktop refused the read or the write, and it
 *  names why in a sentence the reader never sees directly. */
export type WorkspaceSessionError = FeatureError;
export const WorkspaceSessionError = featureErrorClass('WorkspaceSessionError');

/** Files failures add the mutation outcomes the listing never meets: a
 *  name already taken, and a request the server refused as invalid. */
type FilesExtra = 'conflict' | 'rejected' | 'outcome-unknown';

export type FilesFailureKind = FeatureFailureKind<FilesExtra>;

export type FilesError = FeatureError<FilesExtra>;
export const FilesError = featureErrorClass<FilesExtra>('FilesError');

/** Actionable import outcomes, including a receipt that must be resolved
 * before another copy can be attempted. Messages are authored by the adapter. */
export class ProjectImportError extends FilesError {
  constructor(
    message: string,
    readonly outcome: 'conflict' | 'retained' | 'unknown' | 'refused',
    readonly destination: { path: string; directory: boolean } | null = null,
    readonly retainedPath: string | null = null,
  ) {
    super('rejected', message);
  }
}
