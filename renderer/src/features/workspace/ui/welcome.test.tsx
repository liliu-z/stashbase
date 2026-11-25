import { useQueryClient } from '@tanstack/react-query';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { projectFailureMessage } from '@/features/workspace/application/failure-messages';
import {
  ProjectError,
  type ProjectRegistryPort,
  type ProjectFolderPickerPort,
  type GitHubImportPort,
} from '@/features/workspace/application/ports';
import { workspaceQueryKeys } from '@/features/workspace/application/queries';
import { useProjectEntry } from '@/features/workspace/hooks/use-project-entry';
import {
  folderPicker,
  githubImportApi,
  projectApi,
  projectLifecycle,
  projectRegistrySnapshot,
  pendingProjectApi,
} from '@/test/fakes/workspace';
import { withQueryClient } from '@/test/query';

import { ImportGitHubDialog } from './import-github-dialog';
import { ProjectWelcome, type ProjectWelcomeProps } from './welcome';

const emptyProject = projectRegistrySnapshot({ activeFolder: null, projects: [] });

type WelcomeTestProps = Omit<ProjectWelcomeProps, 'api' | 'entry' | 'lifecycle'> & {
  api: Partial<ProjectRegistryPort>;
  folderPicker?: ProjectFolderPickerPort;
  githubImport?: GitHubImportPort;
  lifecycle?: ProjectWelcomeProps['lifecycle'];
};

function renderWelcome({
  api,
  folderPicker: picker,
  githubImport,
  lifecycle,
  ...props
}: WelcomeTestProps) {
  const registry = projectApi(api);

  const picking = picker ?? folderPicker();
  const importing = githubImport ?? githubImportApi();
  function Welcome() {
    const cache = useQueryClient();
    const host =
      lifecycle ??
      projectLifecycle({
        enterFolder: vi.fn(async (path: string) => {
          const snapshot = await registry.openFolder(path, new AbortController().signal);
          registry.load = vi.fn(async () => snapshot);
          cache.setQueryData(workspaceQueryKeys.project, snapshot);
        }),
      });
    const entry = useProjectEntry(picking, host, importing);
    return (
      <>
        <ProjectWelcome {...props} api={registry} entry={entry} lifecycle={host} />
        <ImportGitHubDialog
          import={entry.importDialog.request}
          onClose={entry.importDialog.close}
          open={entry.importDialog.open}
        />
      </>
    );
  }
  return withQueryClient(<Welcome />);
}

function recentList() {
  return within(screen.getByRole('list', { name: 'Recent projects' }));
}

afterEach(cleanup);

describe('project welcome', () => {
  it('waits for membership before presenting first-run actions', () => {
    renderWelcome({ api: pendingProjectApi() });

    expect(screen.queryByRole('heading', { name: 'StashBase' })).toBeNull();
  });

  it('offers existing and new folder paths after membership settles', async () => {
    const chooseFolder = vi.fn(async () => ({ status: 'cancelled' as const }));
    renderWelcome({
      api: { load: vi.fn(async () => emptyProject) },
      folderPicker: folderPicker({ chooseFolder }),
    });

    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { level: 1, name: 'StashBase' })).not.toBeNull();
    expect(screen.getByText('Keep your context in one place for recurring work.')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Recent' })).not.toBeNull();
    expect(screen.getByText('Projects you open will appear here.')).not.toBeNull();
    expect(screen.queryByRole('list', { name: 'Recent projects' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open a project' }));
    expect(chooseFolder).toHaveBeenLastCalledWith(undefined);

    await user.click(screen.getByRole('button', { name: 'Create a project' }));
    expect(chooseFolder).toHaveBeenLastCalledWith({
      defaultPath: '/home/person',
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('opens the selected folder and leaves the welcome state', async () => {
    const opened = projectRegistrySnapshot({
      ...emptyProject,
      activeFolder: { name: 'Research', path: '/home/person/Research' },
      projects: [
        {
          favorite: false,
          openedAt: '2026-08-31T12:00:00.000Z',
          path: '/home/person/Research',
        },
      ],
    });
    const openFolder = vi.fn(async () => opened);
    renderWelcome({
      api: { load: vi.fn(async () => emptyProject), openFolder },
      folderPicker: folderPicker({
        chooseFolder: vi.fn(async () => ({
          folderPath: '/home/person/Research',
          status: 'selected' as const,
        })),
      }),
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Open a project' }));

    expect(screen.queryByRole('heading', { name: 'StashBase' })).toBeNull();
    expect(openFolder).toHaveBeenCalledWith('/home/person/Research', expect.any(AbortSignal));
  });

  it('presents every known member when no folder is active', async () => {
    const knownProject = projectRegistrySnapshot({
      ...emptyProject,
      projects: [
        {
          favorite: false,
          openedAt: '2026-08-31T12:00:00.000Z',
          path: '/home/person/Research',
        },
        {
          favorite: false,
          openedAt: '2026-08-30T12:00:00.000Z',
          path: '/home/person/Writing',
        },
      ],
    });
    const openedProject = projectRegistrySnapshot({
      ...knownProject,
      activeFolder: { name: 'Writing', path: '/home/person/Writing' },
    });
    const openFolder = vi.fn(async () => openedProject);
    renderWelcome({
      api: { load: vi.fn(async () => knownProject), openFolder },
    });

    expect(await screen.findByRole('heading', { name: 'Recent' })).not.toBeNull();
    expect(recentList().getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText('Projects you open will appear here.')).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Writing/u }));

    expect(openFolder).toHaveBeenCalledWith('/home/person/Writing', expect.any(AbortSignal));
    expect(screen.queryByRole('heading', { name: 'StashBase' })).toBeNull();
  });

  it('copies a project path instead of opening it when the click was a drag to select', async () => {
    const knownProject = projectRegistrySnapshot({
      ...emptyProject,
      projects: [
        {
          favorite: false,
          openedAt: '2026-08-31T12:00:00.000Z',
          path: '/home/person/Research',
        },
      ],
    });
    const openFolder = vi.fn(async () => knownProject);
    renderWelcome({ api: { load: vi.fn(async () => knownProject), openFolder } });

    const row = await screen.findByRole('button', { name: /^Research/u });
    // What a drag across the row's text leaves behind: the browser then
    // delivers the row's click, which must not open the project.
    const range = document.createRange();
    range.selectNodeContents(row);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    await userEvent.setup().click(row);

    expect(openFolder).not.toHaveBeenCalled();
    expect(selection?.toString()).toContain('Research');
  });

  it('keeps the temporary directories a smoke test registers out of the list', async () => {
    const knownProject = projectRegistrySnapshot({
      ...emptyProject,
      projects: [
        {
          favorite: false,
          openedAt: '2026-09-01T12:00:00.000Z',
          path: '/var/folders/zz/abc/T/stashbase-smoke-1',
        },
        {
          favorite: false,
          openedAt: '2026-08-31T12:00:00.000Z',
          path: '/home/person/Research',
        },
      ],
    });
    renderWelcome({ api: { load: vi.fn(async () => knownProject) } });

    expect(await screen.findByRole('list', { name: 'Recent projects' })).not.toBeNull();
    expect(recentList().getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /stashbase-smoke/u })).toBeNull();
  });

  it('removes a recent folder from the project registry through its row menu', async () => {
    const knownProject = projectRegistrySnapshot({
      ...emptyProject,
      projects: [
        {
          favorite: false,
          openedAt: '2026-08-31T12:00:00.000Z',
          path: '/home/person/Research',
        },
        {
          favorite: false,
          openedAt: '2026-08-30T12:00:00.000Z',
          path: '/home/person/Notes',
        },
      ],
    });
    const removeFolder = vi.fn(async () =>
      projectRegistrySnapshot({
        ...knownProject,
        projects: knownProject.projects.slice(0, 1),
      }),
    );
    const prepareFolderRemoval = vi.fn(async () => true);
    renderWelcome({
      api: { load: vi.fn(async () => knownProject), removeFolder },
      lifecycle: projectLifecycle({ prepareFolderRemoval }),
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove Notes' }));

    expect(await screen.findByRole('heading', { name: 'Remove this project?' })).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(removeFolder).toHaveBeenCalledWith('/home/person/Notes', expect.any(AbortSignal)),
    );
    expect(prepareFolderRemoval).toHaveBeenCalledWith('/home/person/Notes');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(recentList().getAllByRole('listitem')).toHaveLength(1);
  });

  it('keeps open failure local and allows another attempt', async () => {
    const opened = projectRegistrySnapshot({
      ...emptyProject,
      activeFolder: { name: 'Notes', path: '/home/person/Notes' },
    });
    const openFolder = vi
      .fn<ProjectRegistryPort['openFolder']>()
      .mockRejectedValueOnce(new ProjectError('unavailable', 'HTTP 503 from /api/project'))
      .mockResolvedValue(opened);
    renderWelcome({
      api: { load: vi.fn(async () => emptyProject), openFolder },
      folderPicker: folderPicker({
        chooseFolder: vi.fn(async () => ({
          folderPath: '/home/person/Notes',
          status: 'selected' as const,
        })),
      }),
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Open a project' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      projectFailureMessage('unavailable', 'opened'),
    );

    await user.click(screen.getByRole('button', { name: 'Open a project' }));
    expect(screen.queryByRole('heading', { name: 'StashBase' })).toBeNull();
    expect(openFolder).toHaveBeenCalledTimes(2);
  });

  it('renders the Gallery band it is handed and stands without one', async () => {
    const withBand = renderWelcome({
      api: { load: vi.fn(async () => emptyProject) },
      gallery: <p>Widget Handbook</p>,
    });

    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: 'Or start from a project in the Gallery',
      }),
    ).not.toBeNull();
    expect(screen.getByText('Widget Handbook')).not.toBeNull();
    withBand.unmount();

    renderWelcome({ api: { load: vi.fn(async () => emptyProject) } });
    expect(await screen.findByRole('heading', { level: 1, name: 'StashBase' })).not.toBeNull();
    expect(
      screen.queryByRole('heading', {
        name: 'Or start from a project in the Gallery',
      }),
    ).toBeNull();
  });
});
