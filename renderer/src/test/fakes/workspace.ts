/**
 * Workspace fixtures: listings, project snapshots, and every port as a `vi.fn`.
 *
 * Only shapes and stubs live here. Nothing outside `app/` or `features/` may
 * hold a feature value, so a test that needs a live runtime builds it from the
 * feature's public entry and takes its options from `workspaceRuntimeOptions`.
 */
import { vi } from 'vite-plus/test';

import type {
  FilesPort,
  GitHubImportPort,
  ProjectFolderPickerPort,
  ProjectLifecyclePort,
  ProjectRegistryPort,
  WorkspacePreferencesPort,
  WorkspaceQueryScope,
  WorkspaceSessionPort,
} from '@/features/workspace/application/ports';
import type { WorkspaceRuntimeOptions } from '@/features/workspace/application/runtime';
import type {
  ActiveProjectFolder,
  ProjectRegistrySnapshot,
} from '@/features/workspace/domain/project';
import type {
  FolderSessionState,
  WorkspaceSessionSnapshot,
} from '@/features/workspace/domain/session';
import type {
  WorkspaceFile,
  WorkspaceFolder,
  WorkspaceListing,
} from '@/features/workspace/domain/tree';
import type { WorkspaceAdapters } from '@/features/workspace/infrastructure/adapters';

export const RESEARCH_FOLDER: ActiveProjectFolder = { name: 'Research', path: '/Library/Research' };

/** One readable Markdown file in a listing. Tests name only what they assert
 *  on — usually the path and format. */
export function listingFile(overrides: Partial<WorkspaceFile> = {}): WorkspaceFile {
  return {
    availability: 'available',
    format: 'md',
    kind: 'regular',
    path: 'notes.md',
    size: 12,
    ...overrides,
  };
}

export function listingFolder(overrides: Partial<WorkspaceFolder> = {}): WorkspaceFolder {
  return { kind: 'normal', path: 'lessons', ...overrides };
}

/** A listing built from bare file paths, listing files, or a mix. */
export function listing(
  files: readonly (WorkspaceFile | string)[] = [],
  folders: readonly (WorkspaceFolder | string)[] = [],
  folderName = RESEARCH_FOLDER.name,
): WorkspaceListing {
  return {
    files: files.map((file) => (typeof file === 'string' ? listingFile({ path: file }) : file)),
    folderName,
    showHiddenFiles: false,
    folders: folders.map((folder) =>
      typeof folder === 'string' ? listingFolder({ path: folder }) : folder,
    ),
  };
}

export function projectRegistrySnapshot(
  overrides: Partial<ProjectRegistrySnapshot> = {},
): ProjectRegistrySnapshot {
  return {
    activeFolder: RESEARCH_FOLDER,
    homeDirectory: '/home/person',
    projects: [
      { favorite: false, openedAt: '2026-09-02T00:00:00.000Z', path: RESEARCH_FOLDER.path },
    ],
    ...overrides,
  };
}

export function filesApi(overrides: Partial<FilesPort> = {}): FilesPort {
  return {
    createEntry: vi.fn(async () => ({ path: 'new.md' })),
    createInteractiveNote: vi.fn(async () => ({
      path: 'Untitled',
      entryPath: 'Untitled/index.html',
    })),
    deleteEntry: vi.fn(async () => undefined),
    load: vi.fn(async () => listing()),
    moveEntry: vi.fn(async () => ({ path: 'moved.md' })),
    renameEntry: vi.fn(async () => ({ path: 'renamed.md' })),
    reveal: vi.fn(async () => undefined),
    ...overrides,
  };
}

export function projectApi(overrides: Partial<ProjectRegistryPort> = {}): ProjectRegistryPort {
  return {
    load: vi.fn(async () => projectRegistrySnapshot()),
    openFolder: vi.fn(async () => projectRegistrySnapshot()),
    removeFolder: vi.fn(async () => projectRegistrySnapshot({ activeFolder: null, projects: [] })),
    ...overrides,
  };
}

/** A project whose load never settles, so the shell stays in its restoring
 *  state and no folder ever becomes active. */
export function pendingProjectApi(): ProjectRegistryPort {
  return projectApi({ load: vi.fn(() => new Promise<never>(() => undefined)) });
}

export function projectLifecycle(
  overrides: Partial<ProjectLifecyclePort> = {},
): ProjectLifecyclePort {
  return {
    enterFolder: vi.fn(async () => {}),
    onEnterFolder: vi.fn(() => () => {}),
    notifyFolderRemoved: vi.fn(async () => undefined),
    onFolderRemoved: vi.fn(() => () => undefined),
    onPrepareFolderRemoval: vi.fn(() => () => undefined),
    prepareFolderRemoval: vi.fn(async () => true),
    setActiveFolder: vi.fn(async () => undefined),
    ...overrides,
  };
}

export function folderPicker(
  overrides: Partial<ProjectFolderPickerPort> = {},
): ProjectFolderPickerPort {
  return { chooseFolder: vi.fn(async () => ({ status: 'cancelled' as const })), ...overrides };
}

/** One folder's saved presentation state. Tests name it through this builder
 *  rather than through the Workspace feature's public surface: the shape is a
 *  fixture detail, and the running app only ever reads it back off the
 *  session controller. */
export function folderSession(overrides: Partial<FolderSessionState> = {}): FolderSessionState {
  return {
    activeTabId: null,
    expandedPaths: [],
    folderPath: RESEARCH_FOLDER.path,
    mathMode: false,
    selectedPath: null,
    tabs: [],
    ...overrides,
  };
}

export function sessionPersistence(
  overrides: Partial<WorkspaceSessionPort> = {},
): WorkspaceSessionPort {
  return {
    load: vi.fn(async (): Promise<WorkspaceSessionSnapshot | null> => null),
    save: vi.fn(async () => undefined),
    ...overrides,
  };
}

function workspaceQueryScope(overrides: Partial<WorkspaceQueryScope> = {}): WorkspaceQueryScope {
  return { cancel: vi.fn(async () => undefined), remove: vi.fn(), ...overrides };
}

/** Options for `createWorkspaceRuntime`; generation 1 and a settled query
 *  scope are what every test that does not care about them wants. */
export function workspaceRuntimeOptions(
  overrides: Partial<WorkspaceRuntimeOptions> = {},
): WorkspaceRuntimeOptions {
  return {
    folder: RESEARCH_FOLDER,
    generation: 1,
    queries: workspaceQueryScope(),
    ...overrides,
  };
}

/** Acquisition that succeeds, with stand-in rules. The real mapping from the
 *  repository contracts is the adapter's, and `github-import-api.test.ts`
 *  proves it there; a fake reaching into infrastructure would only move that
 *  proof somewhere it does not belong. */
export function githubImportApi(overrides: Partial<GitHubImportPort> = {}): GitHubImportPort {
  return {
    home: vi.fn(async () => '/home/person/Documents/StashBase'),
    folderNameIssue: (name: string) => (name.includes('/') ? 'name cannot contain slashes' : null),
    readUrl: (raw: string) => {
      const match = /^https:\/\/github\.com\/[^/]+\/([^/]+)$/.exec(raw.trim());
      return match?.[1]
        ? { folderName: match[1], ok: true as const }
        : {
            message: 'Enter a complete https://github.com/<owner>/<repo> URL.',
            ok: false as const,
          };
    },
    run: vi.fn(async (_url: string, folderName: string) => `/home/me/${folderName}`),
    ...overrides,
  };
}

/** Hidden entries off by default, matching the server's own default and its
 *  recovery for invalid stored state. */
export function workspacePreferences(
  overrides: Partial<WorkspacePreferencesPort> = {},
): WorkspacePreferencesPort {
  return {
    load: vi.fn(async () => false),
    setShowHiddenFiles: vi.fn(async (next: boolean) => next),
    ...overrides,
  };
}

/** Every Workspace port, as one record. Override one entry at a time. */
export function workspaceAdapters(overrides: Partial<WorkspaceAdapters> = {}): WorkspaceAdapters {
  return {
    files: filesApi(),
    project: projectApi(),
    githubImport: githubImportApi(),
    lifecycle: projectLifecycle(),
    preferences: workspacePreferences(),
    session: sessionPersistence(),
    upload: { upload: vi.fn(async () => ({ paths: [], refused: [] })) },
    ...overrides,
  };
}
