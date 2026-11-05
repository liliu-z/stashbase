import type { QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { FilesPort } from '@/features/workspace/application/ports';
import {
  createWorkspaceRuntime,
  type WorkspaceRuntime,
} from '@/features/workspace/application/runtime';
import type { WorkspaceListing } from '@/features/workspace/domain/tree';
import { expectFocused } from '@/test/dom';
import {
  filesApi,
  listing,
  listingFile,
  listingFolder,
  RESEARCH_FOLDER,
  workspaceRuntimeOptions,
} from '@/test/fakes/workspace';
import { createTestQueryClient, withQueryClient } from '@/test/query';

import { FileTree } from './file-tree';

const PLAN = listingFile({ path: 'docs/plan.md', size: 42 });
const ARCHIVE = listingFile({
  format: 'generic',
  path: 'archive.zip',
  size: 7,
});
const LINKED = listingFile({
  format: 'generic',
  kind: 'symlink',
  path: 'linked-file',
  size: 0,
});
const RESEARCH_LISTING = listing(
  [PLAN, ARCHIVE, LINKED],
  ['docs', listingFolder({ kind: 'excluded', path: 'vendor' })],
);

const runtimes: WorkspaceRuntime[] = [];

/** One runtime per rendered tree, bound to the client the tree reads through
 *  so disposal cancels exactly those queries. */
function treeRuntime(client: QueryClient): WorkspaceRuntime {
  const runtime = createWorkspaceRuntime(
    workspaceRuntimeOptions({
      generation: runtimes.length + 1,
      queries: {
        cancel: () => client.cancelQueries(),
        remove: () => client.removeQueries(),
      },
    }),
  );
  runtimes.push(runtime);
  return runtime;
}

function renderTree(
  api: FilesPort,
  onOpenSource?: ComponentProps<typeof FileTree>['onOpenSource'],
  extra: Partial<Pick<ComponentProps<typeof FileTree>, 'onReprocess' | 'rowMarkers'>> = {},
) {
  const client = createTestQueryClient();
  return withQueryClient(
    <FileTree
      {...extra}
      api={api}
      onOpenSource={onOpenSource}
      revealLabel="Show in file manager"
      runtime={treeRuntime(client)}
    />,
    client,
  );
}

function treeApi(value: WorkspaceListing = RESEARCH_LISTING): FilesPort {
  return filesApi({ load: vi.fn(async () => value) });
}

afterEach(() => {
  cleanup();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

describe('file tree', () => {
  it('renders one semantic visible-row model and omits collapsed descendants', async () => {
    const api = treeApi();
    renderTree(api);

    const tree = await screen.findByRole('tree', { name: 'Files' });
    expect(api.load).toHaveBeenCalledWith(RESEARCH_FOLDER.path, expect.any(AbortSignal));
    expect(tree.tabIndex).toBe(-1);
    expect(screen.queryByRole('treeitem', { name: 'plan.md' })).toBeNull();
    const rows = screen.getAllByRole('treeitem');
    expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);

    const docs = screen.getByRole('treeitem', { name: 'docs' });
    expect(docs.getAttribute('aria-level')).toBe('1');
    expect(docs.getAttribute('data-proximity-index')).toBe('0');
    expect(docs.style.paddingLeft).toBe('8px');
    await userEvent.setup().click(docs);

    const plan = await screen.findByRole('treeitem', { name: 'plan.md' });
    expect(plan.getAttribute('aria-level')).toBe('2');
    expect(plan.getAttribute('aria-posinset')).toBe('1');
    expect(plan.getAttribute('data-proximity-index')).toBe('1');
    expect(plan.style.getPropertyValue('--hover')).toBe('transparent');
    expect(docs.style.getPropertyValue('--hover')).toBe('');
    expect(plan.style.paddingLeft).toBe('34px');
    expect(tree.contains(plan)).toBe(true);
  });

  it('uses arrows, Home, and End over the same rendered order', async () => {
    renderTree(treeApi());
    const user = userEvent.setup();
    const docs = await screen.findByRole('treeitem', { name: 'docs' });
    docs.focus();

    await user.keyboard('{ArrowRight}');
    const plan = await screen.findByRole('treeitem', { name: 'plan.md' });
    await user.keyboard('{ArrowRight}');
    await waitFor(() => {
      expectFocused(plan);
    });

    await user.keyboard('{ArrowLeft}');
    await waitFor(() => {
      expectFocused(docs);
    });
    await user.keyboard('{End}');
    expectFocused(screen.getByRole('treeitem', { name: /linked-file/ }));
    await user.keyboard('{Home}');
    expectFocused(docs);
  });

  it('explains generic files and reveals restricted entries without expanding them', async () => {
    const api = treeApi();
    renderTree(api);
    const user = userEvent.setup();

    expect(
      await screen.findByRole('treeitem', {
        name: 'archive.zip, excluded from Search and automatic Chat context',
      }),
    ).not.toBeNull();
    const restrictedFolder = screen.getByRole('treeitem', {
      name: 'vendor, restricted, Show in file manager',
    });
    expect(restrictedFolder.hasAttribute('aria-expanded')).toBe(false);
    expect(restrictedFolder.title).toBe('Show in file manager');
    await user.click(restrictedFolder);

    expect(api.reveal).toHaveBeenCalledWith(
      RESEARCH_FOLDER.path,
      'vendor',
      expect.any(AbortSignal),
    );
    await user.click(
      screen.getByRole('treeitem', {
        name: 'linked-file, restricted, Show in file manager',
      }),
    );
    expect(api.reveal).toHaveBeenCalledWith(
      RESEARCH_FOLDER.path,
      'linked-file',
      expect.any(AbortSignal),
    );
  });

  it('emits explicit source identity for regular files and keeps restricted files reveal-only', async () => {
    const api = treeApi();
    const onOpenSource = vi.fn();
    renderTree(api, onOpenSource);
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('treeitem', {
        name: 'archive.zip, excluded from Search and automatic Chat context',
      }),
    );
    expect(onOpenSource).toHaveBeenCalledWith({
      folderPath: RESEARCH_FOLDER.path,
      path: 'archive.zip',
    });

    await user.click(
      screen.getByRole('treeitem', {
        name: 'linked-file, restricted, Show in file manager',
      }),
    );
    expect(onOpenSource).toHaveBeenCalledOnce();
    expect(api.reveal).toHaveBeenCalledWith(
      RESEARCH_FOLDER.path,
      'linked-file',
      expect.any(AbortSignal),
    );
  });

  it('marks rows that need attention and offers Reprocess from the context menu', async () => {
    const api = treeApi({
      ...RESEARCH_LISTING,
      files: [
        ...RESEARCH_LISTING.files,
        listingFile({ format: 'pdf', path: 'paper.pdf', size: 9 }),
        listingFile({ format: 'pdf', path: 'cancelled.pdf', size: 9 }),
      ],
    });
    const onReprocess = vi.fn();
    renderTree(api, undefined, {
      onReprocess,
      rowMarkers: {
        'paper.pdf': { kind: 'failed', title: 'File preparation failed.' },
        'cancelled.pdf': {
          kind: 'cancelled',
          title: 'Preparation was cancelled.',
        },
      },
    });

    const failed = await screen.findByRole('treeitem', {
      name: 'paper.pdf, File preparation failed.',
    });
    expect(failed.getAttribute('title')).toBe('File preparation failed.');
    // The marker icon is aria-hidden and picked from a kind→icon map with no other observable
    // signal, so which lucide icon rendered is only readable from its own generated class name.
    expect(failed.querySelector('svg.lucide-triangle-alert')).not.toBeNull(); // dom-contract: see comment above
    const cancelled = screen.getByRole('treeitem', {
      name: 'cancelled.pdf, Preparation was cancelled.',
    });
    expect(cancelled.querySelector('svg.lucide-circle-slash')).not.toBeNull(); // dom-contract: see comment above
    expect(screen.getByRole('treeitem', { name: 'docs' }).getAttribute('title')).toBe('docs');

    fireEvent.contextMenu(failed, { clientX: 12, clientY: 12 });
    await userEvent.setup().click(await screen.findByRole('menuitem', { name: 'Reprocess' }));
    expect(onReprocess).toHaveBeenCalledWith({
      folderPath: RESEARCH_FOLDER.path,
      path: 'paper.pdf',
    });

    fireEvent.contextMenu(cancelled, { clientX: 12, clientY: 12 });
    expect(screen.getByRole('menuitem', { name: 'Reprocess' })).not.toBeNull();
  });

  it('keeps initial rendering bounded and progressively reveals more rows', async () => {
    const manyFiles = listing(
      Array.from({ length: 250 }, (_, index) =>
        listingFile({
          format: 'txt',
          path: `file-${String(index).padStart(3, '0')}.txt`,
          size: index,
        }),
      ),
      [],
      'Large',
    );
    renderTree(treeApi(manyFiles));

    await screen.findByRole('tree');
    expect(screen.getAllByRole('treeitem')).toHaveLength(240);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show 10 more' }));
    expect(screen.getAllByRole('treeitem')).toHaveLength(250);
  });

  it('keeps listing failure and retry local to Files', async () => {
    const load = vi
      .fn<FilesPort['load']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(RESEARCH_LISTING);
    renderTree(filesApi({ load }));

    // The tone is the one `filesFailure` assigned, not one the view picked:
    // an unreadable listing is a lost capability.
    expect((await screen.findByRole('status')).textContent).toBe('StashBase is unavailable.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('tree', { name: 'Files' })).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('file tree keep and create', () => {
  it('keeps a file open from a double click and makes a draft beside the selection', async () => {
    // The listing grows with what the tree creates, so the new row shows.
    const files = [PLAN, ARCHIVE, LINKED];
    const api = filesApi({
      createEntry: vi.fn(async (_folder, _kind, parent, name) => {
        const path = parent ? `${parent}/${name}` : name;
        files.push(listingFile({ path }));
        return { path };
      }),
      load: vi.fn(async () =>
        listing(files, ['docs', listingFolder({ kind: 'excluded', path: 'vendor' })]),
      ),
    });
    const onOpenSource = vi.fn();
    renderTree(api, onOpenSource);
    const runtime = runtimes.at(-1);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('treeitem', { name: 'docs' }));
    const plan = await screen.findByRole('treeitem', { name: 'plan.md' });
    await user.dblClick(plan);
    // The first click browsed; the double click asked for the tab to stay.
    expect(onOpenSource).toHaveBeenNthCalledWith(1, {
      folderPath: RESEARCH_FOLDER.path,
      path: 'docs/plan.md',
    });
    expect(onOpenSource).toHaveBeenLastCalledWith(
      { folderPath: RESEARCH_FOLDER.path, path: 'docs/plan.md' },
      { keep: true },
    );

    // With plan.md selected, the window's new draft lands in docs at once,
    // as Untitled, and opens for editing.
    act(() => runtime?.requestCreate('draft'));
    await waitFor(() =>
      expect(api.createEntry).toHaveBeenCalledWith(
        RESEARCH_FOLDER.path,
        'file',
        'docs',
        'Untitled.md',
        expect.any(AbortSignal),
      ),
    );
    expect(runtime?.store.getState().pendingCreate).toBeNull();
    await waitFor(() =>
      expect(onOpenSource).toHaveBeenLastCalledWith(
        { folderPath: RESEARCH_FOLDER.path, path: 'docs/Untitled.md' },
        { keep: true },
      ),
    );
    // Once its row shows, the draft is renamed in place with the stem
    // selected, so the name is the first thing typed.
    const field = await screen.findByRole<HTMLInputElement>('textbox', {
      name: 'Rename Untitled.md',
    });
    expectFocused(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 8]);
    await user.keyboard('Ideas{Enter}');
    await waitFor(() =>
      expect(api.renameEntry).toHaveBeenCalledWith(
        RESEARCH_FOLDER.path,
        { kind: 'file', path: 'docs/Untitled.md' },
        'Ideas.md',
        expect.any(AbortSignal),
      ),
    );
  });

  it('starts a folder named in place beside the selection when the window asks', async () => {
    const api = filesApi({
      load: vi.fn(async () => listing([PLAN, ARCHIVE, LINKED], ['docs'])),
    });
    renderTree(api, vi.fn());
    const runtime = runtimes.at(-1);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('treeitem', { name: 'docs' }));
    // A folder is named first, so the request opens the tree's own naming
    // row where the selection sits, and clears itself as it is taken up.
    act(() => runtime?.requestCreate('folder'));
    const field = await screen.findByRole<HTMLInputElement>('textbox', {
      name: 'New folder in docs',
    });
    expectFocused(field);
    expect(runtime?.store.getState().pendingCreate).toBeNull();
    expect(api.createEntry).not.toHaveBeenCalled();
  });
});

describe('file tree reveal', () => {
  it('brings a revealed row into view once the page and the listing show it', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    const many = Array.from({ length: 250 }, (_, index) =>
      listingFile({ format: 'txt', path: `file-${String(index).padStart(3, '0')}.txt`, size: 1 }),
    );
    const written = listingFile({ path: 'docs/drafts/new.md', size: 1 });
    const load = vi
      .fn<FilesPort['load']>()
      .mockResolvedValueOnce(listing([PLAN, ...many], ['docs']))
      .mockResolvedValue(listing([PLAN, written, ...many], ['docs', 'docs/drafts']));
    const { client } = renderTree(filesApi({ load }));
    const runtime = runtimes.at(-1);
    await screen.findByRole('tree');

    // A row past the rendered page extends the page rather than waiting.
    act(() => runtime?.revealPath('file-245.txt'));
    const far = await screen.findByRole('treeitem', { name: 'file-245.txt' });
    expect(scroll.mock.contexts.at(-1)).toBe(far);
    expect(runtime?.store.getState().pendingReveal).toBeNull();

    // A file the agent has just written is not listed yet: the reveal waits
    // for the listing that has it, with the folders above it already open.
    act(() => runtime?.revealPath('docs/drafts/new.md'));
    expect(screen.getByRole('treeitem', { name: 'plan.md' })).not.toBeNull();
    expect(runtime?.store.getState().pendingReveal?.path).toBe('docs/drafts/new.md');
    await act(() => client.invalidateQueries());
    const fresh = await screen.findByRole('treeitem', { name: 'new.md' });
    expect(scroll.mock.contexts.at(-1)).toBe(fresh);
    expect(runtime?.store.getState().pendingReveal).toBeNull();
    scroll.mockRestore();
  });
});
