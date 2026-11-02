import { waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import type { AppDependencies } from '@/app/dependencies';
import { Providers } from '@/app/providers';
import { App } from '@/app/shell';
import { typeInto } from '@/test/dom';
import { agentSessionPort } from '@/test/fakes/agent';
import { appDependencies } from '@/test/fakes/app';
import { documentAdapters, sourceApi } from '@/test/fakes/documents';
import { preparationStatusApi } from '@/test/fakes/preparation';
import {
  filesApi,
  projectApi,
  projectRegistrySnapshot,
  listing,
  listingFile,
  pendingProjectApi,
  sessionPersistence,
  workspaceAdapters,
} from '@/test/fakes/workspace';

/** The shell before any folder is authorized: the project never settles, so
 *  nothing downstream of an active folder can render. */
function restoringDependencies(): AppDependencies {
  const base = appDependencies();
  return {
    ...base,
    documents: { ...base.documents, adapters: documentAdapters({ source: sourceApi() }) },
    project: { ...base.project, api: pendingProjectApi() },
    preparation: {
      ...base.preparation,
      statusApi: preparationStatusApi({ load: vi.fn(() => new Promise<never>(() => undefined)) }),
    },
  };
}

describe('workspace shell', () => {
  let container: HTMLDivElement;
  let root: Root;
  let dependencies: AppDependencies;

  async function mount(next: AppDependencies) {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <Providers>
          <App dependencies={next} />
        </Providers>,
      );
    });
  }

  beforeEach(async () => {
    delete document.body.dataset.bootSettled;
    dependencies = restoringDependencies();
    container = document.createElement('div');
    document.body.append(container);
    await mount(dependencies);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete document.body.dataset.bootSettled;
  });

  it('starts with one folder sidebar and the Agent workspace', () => {
    const sidebars = container.querySelectorAll('[data-slot="sidebar"]'); // dom-contract: sidebar primitive state

    expect(sidebars).toHaveLength(1);
    expect(sidebars[0]?.getAttribute('data-variant')).toBe('inset');
    expect(container.querySelector('[data-slot="sidebar-inset"]')).not.toBeNull(); // dom-contract: sidebar primitive state
    // No wordmark in the sidebar: the welcome screen owns the brand, and the
    // column's standing rows are the footer's.
    expect(sidebars[0]?.textContent).not.toContain('StashBase');
    expect(sidebars[0]?.textContent).toContain('Settings');
    expect(within(container).getByLabelText('Agent workspace')).not.toBeNull();
    expect(sidebars[0]?.textContent).not.toContain('Files');
    expect(container.textContent).not.toContain('Document');
  });

  it('shows and hides the Files sidebar from its chrome controls', async () => {
    const sidebar = container.querySelector('[data-slot="sidebar"]'); // dom-contract: sidebar primitive state

    // A fresh window starts with the sidebar away; the titlebar carries the
    // reopening control, and the sidebar's own header the hiding one.
    expect(sidebar?.getAttribute('data-state')).toBe('collapsed');

    const show = within(container).getByRole('button', { name: 'Show files sidebar' });
    await act(async () => show.click());
    expect(sidebar?.getAttribute('data-state')).toBe('expanded');

    const hide = within(container).getByRole('button', { name: 'Hide files sidebar' });
    await act(async () => hide.click());

    expect(sidebar?.getAttribute('data-state')).toBe('collapsed');
    await waitFor(() => {
      expect(dependencies.workspace.adapters.session.save).toHaveBeenCalledWith(
        expect.objectContaining({
          shell: { agentPaneWidth: 576, sidebarOpen: false, sidebarWidth: 288 },
        }),
      );
    });
  });

  it('applies restored sidebar geometry through the Fluid provider', async () => {
    await act(async () => root.unmount());
    await mount({
      ...dependencies,
      workspace: {
        ...dependencies.workspace,
        adapters: workspaceAdapters({
          ...dependencies.workspace.adapters,
          session: sessionPersistence({
            load: vi.fn(async () => ({
              activeFolderPath: null,
              folders: [],
              shell: { agentPaneWidth: 576, sidebarOpen: false, sidebarWidth: 312 },
              version: 1 as const,
            })),
          }),
        }),
      },
    });

    const wrapper = container.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]'); // dom-contract: sidebar primitive state
    const sidebar = container.querySelector('[data-slot="sidebar"]'); // dom-contract: sidebar primitive state
    expect(wrapper?.style.getPropertyValue('--sidebar-width')).toBe('312px');
    expect(sidebar?.getAttribute('data-state')).toBe('collapsed');
  });

  it('keeps the expand control clear of a floating sidebar', async () => {
    // The window starts with the sidebar away, so the titlebar's reopening
    // control is the collapsed trigger under test.
    const toggle = within(container).getByRole('button', { name: 'Show files sidebar' });
    // The peek arms on a 150ms hover intent, so the delay is the behaviour
    // under test: pointing at the expand control must never arm it.
    vi.useFakeTimers();
    try {
      await act(async () => {
        toggle.dispatchEvent(
          new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }),
        );
        vi.advanceTimersByTime(500);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(container.querySelector('[data-sidebar="peek"]')).toBeNull(); // dom-contract: sidebar primitive state
  });

  /** The window on an authorized folder holding `files`, which is what every
   *  test below the welcome screen needs before it can touch a row. */
  function folderDependencies(files: string[], createId: () => string): AppDependencies {
    return {
      ...dependencies,
      documents: {
        ...dependencies.documents,
        adapters: documentAdapters({
          source: sourceApi({
            load: vi.fn(async () => ({ content: '# Plan', format: 'md' as const, version: 'v1' })),
          }),
        }),
        createId: vi.fn(createId),
      },
      project: {
        ...dependencies.project,
        api: projectApi({
          load: vi.fn(async () =>
            projectRegistrySnapshot({
              activeFolder: { name: 'Notes', path: '/project/notes' },
              projects: [
                { favorite: false, openedAt: '2026-09-02T00:00:00.000Z', path: '/project/notes' },
              ],
            }),
          ),
        }),
      },
      workspace: {
        ...dependencies.workspace,
        adapters: workspaceAdapters({
          ...dependencies.workspace.adapters,
          files: filesApi({
            load: vi.fn(async () =>
              listing(
                files.map((path) => listingFile({ path })),
                [],
                'Notes',
              ),
            ),
          }),
        }),
      },
    };
  }

  it('opens an eligible file-tree source into the document workspace', async () => {
    await act(async () => root.unmount());
    await mount(folderDependencies(['plan.md', 'site/index.html'], () => 'document-tab'));

    const view = within(container);
    await waitFor(() => {
      expect(view.getByRole('treeitem', { name: 'plan.md' })).not.toBeNull();
      expect(document.body.dataset.bootSettled).toBe('1');
    });
    expect(view.queryByLabelText('Document workspace')).toBeNull();
    await act(async () => view.getByRole('treeitem', { name: 'plan.md' }).click());

    const workspace = view.getByLabelText('Document workspace');
    // A tree click browses, so the tab it opens is the preview.
    const tab = view.getByRole('tab', { name: 'plan.md, preview' });
    expect(tab.textContent).toContain('plan.md');
    expect(tab.closest('header')).not.toBeNull();
    // The tab strip lives in the window's title row, never inside the document.
    expect(within(workspace).queryByRole('tablist')).toBeNull();
    await waitFor(
      () => {
        expect(
          within(view.getByLabelText('plan.md Markdown content')).getByRole('heading', { level: 1 })
            .textContent,
        ).toContain('Plan');
      },
      { timeout: 5_000 },
    );
    await waitFor(() => {
      const outline = view.getByLabelText('Document outline section');
      expect(outline.closest('[data-sidebar="content"]')).not.toBeNull();
      expect(outline.closest('[data-sidebar="footer"]')).toBeNull();
    });

    const navigator = within(view.getByRole('tablist', { name: 'Sidebar navigator' }));
    const filesTab = navigator.getByRole('tab', { name: 'Files' });
    const outlineTab = navigator.getByRole('tab', { name: 'Document outline' });
    const searchTab = navigator.getByRole('tab', { name: 'Search' });
    // The navigator is icon-only: each tab is named by its label alone.
    expect(filesTab.textContent).toBe('');
    expect(outlineTab.textContent).toBe('');
    expect(searchTab.textContent).toBe('');
    expect(filesTab.getAttribute('aria-selected')).toBe('true');

    const generalSearch = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: 'f',
      shiftKey: true,
    });
    await act(async () => {
      document.dispatchEvent(generalSearch);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(generalSearch.defaultPrevented).toBe(true);
    expect(searchTab.getAttribute('aria-selected')).toBe('true');
    expect(view.getByLabelText('Exact workspace search')).not.toBeNull();
    expect(view.getByPlaceholderText('Search').matches(':focus')).toBe(true);

    const elsewhere = document.createElement('button');
    container.append(elsewhere);
    elsewhere.focus();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          key: 'f',
          shiftKey: true,
        }),
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(view.getByPlaceholderText('Search').matches(':focus')).toBe(true);

    await act(async () => outlineTab.click());

    expect(outlineTab.getAttribute('aria-selected')).toBe('true');
    expect(
      document.getElementById(filesTab.getAttribute('aria-controls') ?? '')?.hasAttribute('hidden'),
    ).toBe(true);
    expect(
      document
        .getElementById(outlineTab?.getAttribute('aria-controls') ?? '')
        ?.hasAttribute('hidden'),
    ).toBe(false);
  });

  it('excludes the covered document from current context while New tab is selected', async () => {
    await act(async () => root.unmount());
    const next = appDependencies();
    const { listeners, port, sent } = agentSessionPort();
    await mount({
      ...next,
      agent: { ...next.agent, session: port },
      workspace: {
        ...next.workspace,
        adapters: workspaceAdapters({
          ...next.workspace.adapters,
          files: filesApi({ load: vi.fn(async () => listing(['plan.md'])) }),
        }),
      },
    });

    const view = within(container);
    await act(async () => (await view.findByRole('treeitem', { name: 'plan.md' })).click());
    expect(
      await view.findByRole('button', { name: 'Remove plan.md' }, { timeout: 5_000 }),
    ).not.toBeNull();
    await act(async () => view.getByRole('button', { name: 'New tab' }).click());
    expect(view.getByRole('tab', { name: 'New tab' }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(view.queryByRole('button', { name: 'Remove plan.md' })).toBeNull());

    typeInto(view.getByRole('textbox', { name: 'Message' }), 'Start a new idea');
    await act(async () => view.getByRole('button', { name: 'Send' }).click());
    await waitFor(() => expect(port.connect).toHaveBeenCalledOnce());
    await act(async () => listeners[0]?.onEvent({ kind: 'ready' }));
    await waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({ kind: 'prompt', text: 'Start a new idea' }),
      ),
    );

    await act(async () => view.getByRole('tab', { name: 'plan.md, preview' }).click());
    expect(await view.findByRole('button', { name: 'Remove plan.md' })).not.toBeNull();
  }, 15_000);

  it('keeps the tree on the document in front of the reader', async () => {
    await act(async () => root.unmount());
    let nextId = 0;
    await mount(folderDependencies(['index.html', 'plan.md', 'notes.md'], () => `tab-${++nextId}`));

    const view = within(container);
    await waitFor(() => expect(view.getByRole('treeitem', { name: 'plan.md' })).not.toBeNull());
    const row = (name: string) => view.getByRole('treeitem', { name });
    const selectedRows = () =>
      view
        .getAllByRole('treeitem')
        .filter((item) => item.getAttribute('aria-selected') === 'true')
        .map((item) => item.getAttribute('data-path'));

    const landingTab = await view.findByRole('tab', { name: 'index.html, preview' });
    expect(view.getByLabelText('Document workspace')).not.toBeNull();
    expect(selectedRows()).toEqual(['index.html']);
    await act(async () => landingTab.querySelector<HTMLElement>('[data-tab-trailing]')?.click());
    expect(selectedRows()).toEqual([]);

    await act(async () => row('plan.md').click());
    // A double click on the preview asks for the tab to stay, so the next
    // browse opens beside it instead of replacing it.
    await act(async () => {
      view
        .getByRole('tab', { name: 'plan.md, preview' })
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await act(async () => row('notes.md').click());
    expect(selectedRows()).toEqual(['notes.md']);

    // The strip is the only thing that moved: the tree has to follow it, or
    // the highlight stays on a document that is no longer in front.
    await act(async () => view.getByRole('tab', { name: 'plan.md' }).click());
    await waitFor(() => expect(selectedRows()).toEqual(['plan.md']));

    for (const name of ['plan.md', 'notes.md, preview']) {
      const tab = view.getByRole('tab', { name });
      await act(async () => tab.querySelector<HTMLElement>('[data-tab-trailing]')?.click());
    }
    await waitFor(() => expect(view.queryByRole('tab', { name: /\.md/ })).toBeNull());
    expect(selectedRows()).toEqual([]);
  });
});
