/**
 * J13 at the renderer composition boundary: both ways into the shop, the entry
 * page a card opens, and the copy that registers a project through the ordinary
 * import and a window of its own.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { Providers } from '@/app/providers';
import { App } from '@/app/shell';
import type { GalleryEntry } from '@/features/gallery/public';
import { appDependencies, galleryPort } from '@/test/fakes/app';
import {
  projectApi,
  projectRegistrySnapshot,
  workspaceAdapters,
  githubImportApi,
  projectLifecycle,
} from '@/test/fakes/workspace';

afterEach(cleanup);

const PUBLISHED: GalleryEntry = {
  about: 'Why I made this.\n\nWhat is in it, and who it is for.',
  category: 'reference',

  description: 'Everything about widgets.',

  id: 'widgets',

  name: 'Widget Handbook',
  repo: 'https://github.com/owner/widgets',
  screenshot: null,
};

function harness({ folderOpen }: { folderOpen: boolean }) {
  const copy = vi.fn(async () => '/project/Widget Handbook');
  const snapshot = projectRegistrySnapshot();
  const dependencies = appDependencies({
    gallery: galleryPort({
      loadIndex: vi.fn(async () => ({ personas: null, wikis: [PUBLISHED] })),
    }),
    workspace: {
      adapters: workspaceAdapters({
        githubImport: githubImportApi({ run: copy }),
        lifecycle: projectLifecycle(),
        project: projectApi({
          load: vi.fn(async () => ({
            ...snapshot,
            activeFolder: folderOpen ? snapshot.activeFolder : null,
          })),
        }),
      }),
      revealLabel: 'Show in file manager',
    },
  });
  dependencies.project.api = dependencies.workspace.adapters.project;
  render(
    <Providers>
      <App dependencies={dependencies} />
    </Providers>,
  );
  return { copy };
}

describe('Gallery shop', () => {
  it('bands the shelf onto the welcome screen and opens the entry a card names', async () => {
    harness({ folderOpen: false });

    // Browsing needs no folder, no account, and no Agent runtime. The band is
    // derived rather than offered, so the entry is on the screen before any
    // click. The click is retried against a fresh node: the welcome screen
    // re-renders as its project query settles, and a node found before that is
    // already detached.
    await screen.findByRole('button', { name: /Widget Handbook/u });
    expect(screen.queryByRole('dialog', { name: 'Gallery' })).toBeNull();
    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /Widget Handbook/u }));
      expect(
        within(screen.getByRole('dialog', { name: 'Gallery' })).getByRole('heading', {
          name: 'Widget Handbook',
        }),
      ).not.toBeNull();
    });
  });

  it('opens over a folder window from the sidebar and copies an entry', async () => {
    const { copy } = harness({ folderOpen: true });
    const user = userEvent.setup();

    fireEvent.click(await screen.findByRole('button', { name: 'Gallery' }));
    await user.click(await screen.findByRole('button', { name: /Widget Handbook/u }));

    // The entry page states what is inside and the instructions the wiki
    // was built with before asking for the copy.
    const page = await screen.findByRole('dialog', { name: 'Gallery' });
    // About is the publisher's own introduction, paragraph by paragraph; the
    // inventory line and the file listing are not on the page.
    expect(within(page).getByRole('heading', { name: 'About' })).not.toBeNull();
    expect(within(page).getByText('Why I made this.')).not.toBeNull();
    expect(within(page).getByText('What is in it, and who it is for.')).not.toBeNull();
    expect(within(page).queryByText('Two pages')).toBeNull();
    expect(within(page).queryByText('README.md')).toBeNull();
    // The instructions are folded beneath the introduction: most readers
    // never need them, and they are one press away for the ones who do. Copy
    // is all the Gallery ever does with them: it never places composer text.
    expect(within(page).queryByRole('button', { name: 'Prompt' })).toBeNull();
    expect(within(page).queryByRole('button', { name: 'Copy prompt' })).toBeNull();

    await user.click(within(page).getByRole('button', { name: 'Make a copy' }));
    await waitFor(() =>
      expect(copy).toHaveBeenCalledWith(
        'https://github.com/owner/widgets',
        'Widget Handbook',
        expect.anything(),
      ),
    );
    // The shop stays put for the next entry: a copy opens a window of its own.
    expect(screen.queryByRole('dialog', { name: 'Gallery' })).not.toBeNull();
    await user.click(within(page).getByRole('button', { name: 'Gallery home' }));
    expect(await screen.findByRole('button', { name: /Widget Handbook/u })).not.toBeNull();
  });
});
