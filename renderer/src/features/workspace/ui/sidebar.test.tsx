import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { ProjectRegistryPort } from '@/features/workspace/application/ports';
import type { ProjectEntry } from '@/features/workspace/hooks/use-project-entry';
import { projectApi, projectRegistrySnapshot, pendingProjectApi } from '@/test/fakes/workspace';
import { withQueryClient } from '@/test/query';

import { ProjectSidebar, type ProjectSidebarProps } from './sidebar';

const emptyProject = projectRegistrySnapshot({
  activeFolder: null,
  homeDirectory: '/project',
  projects: [],
});

const RESEARCH = { name: 'Research', path: '/project/research' };
const researchMember = {
  favorite: false,
  openedAt: '2026-08-31T12:00:00.000Z',
  path: RESEARCH.path,
};
const notesMember = {
  favorite: false,
  openedAt: '2026-08-30T12:00:00.000Z',
  path: '/project/notes',
};
const activeProject = projectRegistrySnapshot({
  ...emptyProject,
  activeFolder: RESEARCH,
  projects: [researchMember, notesMember],
});

function projectEntry(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    failure: null,
    isPending: false,
    pendingRequest: null,
    create: vi.fn(),
    open: vi.fn(),
    select: vi.fn(),
    copy: vi.fn(),
    importDialog: { open: false, request: {} as never, close: vi.fn(), start: vi.fn() },
    ...overrides,
  };
}

type SidebarTestProps = Omit<
  ProjectSidebarProps,
  'api' | 'contentId' | 'entry' | 'onOpenChange' | 'open' | 'revealLabel'
> &
  Partial<
    Pick<ProjectSidebarProps, 'contentId' | 'entry' | 'onOpenChange' | 'open' | 'revealLabel'>
  > & {
    api: Partial<ProjectRegistryPort>;
  };

function renderProject({ api, ...props }: SidebarTestProps) {
  return withQueryClient(
    <ProjectSidebar
      contentId="folder-content"
      entry={projectEntry()}
      onOpenChange={vi.fn()}
      open
      revealLabel="Show in Finder"
      {...props}
      api={projectApi(api)}
    />,
  );
}

afterEach(cleanup);

describe('project sidebar', () => {
  it('does not claim the project is empty before membership resolves', () => {
    renderProject({ api: pendingProjectApi() });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('folds the section from the chevron beside the name', async () => {
    const onOpenChange = vi.fn();
    renderProject({ api: { load: vi.fn(async () => activeProject) }, onOpenChange });

    const fold = await screen.findByRole('button', { name: 'Fold project' });
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(fold.getAttribute('aria-controls')).toBe('folder-content');
    await userEvent.setup().click(fold);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('switches to another recent project from the name, keeping this window its own', async () => {
    const entry = projectEntry();
    renderProject({ api: { load: vi.fn(async () => activeProject) }, entry });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Switch project: Research' }));
    const current = await screen.findByRole('menuitemradio', { name: /research/ });
    expect(current.getAttribute('aria-checked')).toBe('true');
    await user.click(current);
    expect(entry.select).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Switch project: Research' }));
    await user.click(await screen.findByRole('menuitemradio', { name: /notes/ }));
    expect(entry.select).toHaveBeenCalledExactlyOnceWith('/project/notes');
  });

  it('tells projects that share a name apart by their directory', async () => {
    const twin = { ...notesMember, path: '/archive/research' };
    renderProject({
      api: {
        load: vi.fn(async () =>
          projectRegistrySnapshot({
            ...activeProject,
            projects: [researchMember, notesMember, twin],
          }),
        ),
      },
    });
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Switch project: Research' }));

    // A unique name stands alone; the shared one carries its directory.
    expect(await screen.findByRole('menuitemradio', { name: 'notes' })).not.toBeNull();
    expect(screen.getByRole('menuitemradio', { name: /^research\. \/archive/ })).not.toBeNull();
    expect(screen.getByRole('menuitemradio', { name: 'research. ~' })).not.toBeNull();
  });

  it('opens, creates, and imports projects through the shared entry', async () => {
    const entry = projectEntry();
    renderProject({ api: { load: vi.fn(async () => activeProject) }, entry });
    const user = userEvent.setup();
    const choose = async (name: string) => {
      await user.click(await screen.findByRole('button', { name: 'Switch project: Research' }));
      await user.click(await screen.findByRole('menuitem', { name }));
    };

    await choose('Open project…');
    expect(entry.open).toHaveBeenCalledOnce();
    await choose('Create project…');
    expect(entry.create).toHaveBeenCalledWith('/project');
    await choose('Import from GitHub…');
    expect(entry.importDialog.start).toHaveBeenCalledOnce();
  });

  it('shows the current project in the file manager, and says when it cannot', async () => {
    const revealFolder = vi
      .fn<ProjectRegistryPort['revealFolder']>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('gone'));
    renderProject({ api: { load: vi.fn(async () => activeProject), revealFolder } });
    const user = userEvent.setup();
    const reveal = async () => {
      await user.click(await screen.findByRole('button', { name: 'Switch project: Research' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Show in Finder' }));
    };

    await reveal();
    await waitFor(() => expect(revealFolder).toHaveBeenCalledOnce());
    expect(revealFolder.mock.calls[0]?.[0]).toBe('/project/research');
    expect(screen.queryByRole('alert')).toBeNull();

    await reveal();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The project folder could not be shown.',
    );
  });

  it('says why an entry from the switcher failed', async () => {
    renderProject({
      api: { load: vi.fn(async () => activeProject) },
      entry: projectEntry({ failure: 'That project could not be opened.' }),
    });

    expect((await screen.findByRole('alert')).textContent).toContain(
      'That project could not be opened.',
    );
  });

  it('offers New file and New folder on the header when the window can make them', async () => {
    const onNewFile = vi.fn();
    const onNewFolder = vi.fn();
    renderProject({ api: { load: vi.fn(async () => activeProject) }, onNewFile, onNewFolder });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'New file' }));
    expect(onNewFile).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'New folder' }));
    expect(onNewFolder).toHaveBeenCalledOnce();
  });

  it('offers Collapse all beside the creates when the tree is showing', async () => {
    const onCollapseAll = vi.fn();
    renderProject({
      api: { load: vi.fn(async () => activeProject) },
      onCollapseAll,
      onNewFile: vi.fn(),
      onNewFolder: vi.fn(),
    });

    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Collapse all folders' }));
    expect(onCollapseAll).toHaveBeenCalledOnce();
  });

  it('offers no creates on the header without a window to make them in', async () => {
    renderProject({ api: { load: vi.fn(async () => activeProject) } });

    await screen.findByRole('button', { name: 'Switch project: Research' });
    expect(screen.queryByRole('button', { name: 'New file' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
  });

  it('exposes local retry after membership failure', async () => {
    const load = vi
      .fn<ProjectRegistryPort['load']>()
      .mockRejectedValueOnce(new Error('server offline'))
      .mockResolvedValue(emptyProject);
    renderProject({ api: { load } });

    // Unreachable projects are a lost capability, said quietly.
    expect((await screen.findByRole('status')).textContent).toContain('Projects unavailable.');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('does not represent an inactive member as the active folder', async () => {
    renderProject({
      api: {
        load: vi.fn(async () =>
          projectRegistrySnapshot({
            ...emptyProject,
            projects: [{ ...researchMember, path: '/project/notes' }],
          }),
        ),
      },
    });
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  });
});
