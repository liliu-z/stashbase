import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';

import type { DocumentSourcePort } from '@/features/documents/application/ports';
import { createDocumentTabsRuntime } from '@/features/documents/application/tabs-runtime';
import type { DocumentTextSource } from '@/features/documents/domain/document';
import { pending } from '@/features/documents/ui/source/document-source.harness';
import { SOURCE_DRAG_MIME } from '@/shared/utils/source-drag';
import { expectFocused } from '@/test/dom';
import {
  assetApi,
  documentQueryScope,
  docxPreviewApi,
  genericPreviewApi,
  sourceApi,
  tableApi,
  textSource,
} from '@/test/fakes/documents';
import { withQueryClient } from '@/test/query';

import { DocumentOutline } from './outline';
import { DocumentTabs } from './tabs';
import { DocumentWorkspace } from './workspace';

function createRuntime(api: DocumentSourcePort = loadedSourceApi) {
  let next = 2;
  const runtime = createDocumentTabsRuntime({
    api,
    createId: () => `tab-${++next}`,
    createQueries: () => documentQueryScope(),
    folderPath: '/project/notes',
    generation: 1,
    restored: {
      activeTabId: 'tab-2',
      tabs: [
        {
          id: 'tab-1',
          source: { folderPath: '/project/notes', path: 'plan.md' },
        },
        {
          id: 'tab-2',
          source: { folderPath: '/project/notes', path: 'drafts/other.md' },
        },
      ],
    },
  });
  return runtime;
}

const loadedSourceApi = sourceApi({
  load: vi.fn(async () => textSource({ content: '# Loaded' })),
});

const documentWorkspaceProps = {
  assetApi: assetApi({ load: vi.fn(pending()) }),
  docxPreviewApi: docxPreviewApi({ load: vi.fn(pending()) }),
  genericPreviewApi: genericPreviewApi({ load: vi.fn(pending()) }),
  tableApi: tableApi(),
  onReveal: vi.fn(async () => undefined),
  revealLabel: 'Show in file manager',
};

const runtimes: ReturnType<typeof createRuntime>[] = [];

// Mode retention exercises the real editor, but cold chunk transformation is
// fixture setup and must not consume the interaction assertion's deadline.
beforeAll(async () => {
  await import('@/features/documents/ui/source/viewers/markdown');
}, 30_000);

afterEach(() => {
  cleanup();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

describe('document tabs', () => {
  it('renders and operates the active document outline hierarchy', async () => {
    const runtime = createRuntime();
    runtimes.push(runtime);
    const owner = Symbol('outline-test');
    const select = vi.fn();
    const parent = { id: 'plan', level: 1, position: 1, text: 'Plan' };
    const child = { id: 'details', level: 2, position: 8, text: 'Details' };
    runtime.navigation.claimOutline('tab-2', owner);
    runtime.navigation.publishOutline(
      'tab-2',
      owner,
      { activeId: child.id, headings: [parent, child] },
      select,
    );

    render(<DocumentOutline runtime={runtime} />);

    const section = screen.getByLabelText('Document outline section');
    expect(section.dataset.sidebar).toBe('group');
    expect(screen.getByLabelText('other.md outline, 2 headings')).not.toBeNull();
    expect(section.querySelector('[data-slot="scroll-area"]')).toBeNull(); // dom-contract: Base UI ScrollArea internals (@base-ui/react/scroll-area)
    const nav = screen.getByRole('navigation', { name: 'Document outline' });
    // `data-sidebar="menu-sub"` is the app's own structural nesting marker for the heading
    // hierarchy; the wrapper carries no role or label of its own.
    expect(nav.querySelector('[data-sidebar="menu-sub"]')).not.toBeNull(); // dom-contract: see comment above
    expect(
      screen.getByRole('button', { name: 'Heading level 2: Details' }).getAttribute('aria-current'),
    ).toBe('location');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Collapse Plan' }));
    expect(screen.queryByRole('button', { name: 'Heading level 2: Details' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Expand Plan' }));
    await user.click(screen.getByRole('button', { name: 'Heading level 1: Plan' }));

    expect(select).toHaveBeenCalledWith(parent);
  });

  it('explains unavailable and empty document outlines', () => {
    const runtime = createRuntime();
    runtimes.push(runtime);
    const { rerender } = render(<DocumentOutline runtime={runtime} />);

    expect(screen.getByLabelText('Document outline section')).not.toBeNull();
    expect(screen.getByLabelText('other.md outline, loading')).not.toBeNull();
    expect(screen.getByText('Loading outline…')).not.toBeNull();

    const owner = Symbol('empty-outline-test');
    runtime.navigation.claimOutline('tab-2', owner);
    runtime.navigation.publishOutline('tab-2', owner, { activeId: null, headings: [] }, vi.fn());
    rerender(<DocumentOutline runtime={runtime} />);

    expect(screen.getByLabelText('other.md outline, 0 headings')).not.toBeNull();
    expect(screen.getByText('No headings in this document')).not.toBeNull();
    expect(screen.queryByText('No outline available for this document')).toBeNull();
    expect(screen.queryByText('Outline')).toBeNull();
  });

  it('renders one accessible tab per source and activates through the primitive', async () => {
    const runtime = createRuntime();
    runtimes.push(runtime);
    withQueryClient(
      <>
        <DocumentTabs runtime={runtime} />
        <DocumentWorkspace
          {...documentWorkspaceProps}
          runtime={runtime}
          sourceApi={loadedSourceApi}
        />
      </>,
    );

    const tabList = screen.getByRole('tablist', { name: 'Open documents' });
    const tabs = within(tabList).getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs.map((tab) => tab.getAttribute('data-proximity-index'))).toEqual(['0', '1']);
    expect(screen.getByRole('tab', { name: 'other.md' }).getAttribute('aria-selected')).toBe(
      'true',
    );

    await userEvent.setup().click(screen.getByRole('tab', { name: 'plan.md' }));

    expect(runtime.store.getState().activeTabId).toBe('tab-1');
    const active = screen.getByRole('region', { name: 'plan.md document' });
    expect(active).not.toBeNull();
    // getByRole excludes elements hidden from the accessibility tree, so the inactive panel — the
    // very thing under test — has to be found through getByLabelText, which does not filter on it.
    const inactive = screen.getByLabelText('other.md document');
    expect(inactive.getAttribute('aria-hidden')).toBe('true');
    expect(inactive.inert).toBe(true);
  });

  it('closes the focused tab with Delete and exposes an active-tab close control', async () => {
    const runtime = createRuntime();
    runtimes.push(runtime);
    const user = userEvent.setup();
    withQueryClient(
      <>
        <DocumentTabs runtime={runtime} />
        <DocumentWorkspace
          {...documentWorkspaceProps}
          runtime={runtime}
          sourceApi={loadedSourceApi}
        />
      </>,
    );

    const other = screen.getByRole('tab', { name: 'other.md' });
    other.focus();
    await user.keyboard('{Delete}');

    expect(runtime.store.getState().tabs.map((tab) => tab.id)).toEqual(['tab-1']);
    expectFocused(screen.getByRole('tab', { name: 'plan.md' }));
    // `data-tab-trailing` marks the tab's trailing icon, which is aria-hidden by design (the tab's
    // own accessible name already covers dirty/close state), so only the DOM shape reaches it.
    const closeGlyph = screen
      .getByRole('tab', { name: 'plan.md' })
      .querySelector<HTMLElement>('[data-tab-trailing]'); // dom-contract: see comment above
    expect(closeGlyph).not.toBeNull();
    if (!closeGlyph) throw new Error('The active tab must expose a close control.');
    await user.click(closeGlyph);
    expect(screen.queryByRole('region', { name: 'Document workspace' })).toBeNull();
  });

  it('keeps a newly opened active tab visible in an overflowing tab list', async () => {
    const runtime = createRuntime();
    runtimes.push(runtime);
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => undefined);
    render(<DocumentTabs runtime={runtime} />);
    scrollIntoView.mockClear();

    await act(async () => {
      await runtime.open({
        folderPath: '/project/notes',
        path: 'newly-opened.md',
      });
    });

    const newlyOpened = screen.getByRole('tab', { name: 'newly-opened.md' });
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
    });
    expect(scrollIntoView.mock.instances.at(-1)).toBe(newlyOpened);
  });

  it('switches one retained Markdown surface between Writer and Reading modes', async () => {
    const runtime = createRuntime();
    runtimes.push(runtime);
    withQueryClient(
      <>
        <DocumentTabs runtime={runtime} />
        <DocumentWorkspace
          {...documentWorkspaceProps}
          runtime={runtime}
          sourceApi={loadedSourceApi}
        />
      </>,
    );

    const document = await screen.findByRole(
      'document',
      { name: 'other.md Markdown content' },
      { timeout: 5_000 },
    );
    await waitFor(
      () => expect(document.querySelector('.ProseMirror')).not.toBeNull(), // dom-contract: ProseMirror internals
      { timeout: 5_000 },
    );
    const editor = document.querySelector('.ProseMirror'); // dom-contract: ProseMirror internals
    const modes = screen.getByRole('tablist', { name: 'Markdown mode' });
    expect(document.contains(modes)).toBe(true);
    expect(within(modes).queryByText('Writer')).toBeNull();
    expect(within(modes).queryByText('Reading')).toBeNull();

    await userEvent.setup().click(within(modes).getByRole('tab', { name: 'Read' }));

    expect(runtime.getDocument('tab-2')?.store.getState().markdownMode).toBe('reading');
    await waitFor(() => expect(editor?.getAttribute('contenteditable')).toBe('false'));
    expect(document.querySelector('.ProseMirror')).toBe(editor); // dom-contract: ProseMirror internals

    await userEvent.setup().click(within(modes).getByRole('tab', { name: 'Edit' }));

    expect(runtime.getDocument('tab-2')?.store.getState().markdownMode).toBe('writer');
    await waitFor(() => expect(editor?.getAttribute('contenteditable')).toBe('true'));
    expect(document.querySelector('.ProseMirror')).toBe(editor); // dom-contract: ProseMirror internals
  });

  it('keeps a recent Markdown editor mounted and revalidates it when reactivated', async () => {
    const load = vi.fn<DocumentSourcePort['load']>(async (source) =>
      textSource({ content: source.path === 'plan.md' ? '# Plan' : '# Other' }),
    );
    const api = sourceApi({ load });
    const runtime = createRuntime(api);
    runtimes.push(runtime);
    withQueryClient(
      <>
        <DocumentTabs runtime={runtime} />
        <DocumentWorkspace {...documentWorkspaceProps} runtime={runtime} sourceApi={api} />
      </>,
    );

    const retained = await screen.findByRole(
      'document',
      { name: 'other.md Markdown content' },
      { timeout: 5_000 },
    );
    await userEvent.setup().click(screen.getByRole('tab', { name: 'plan.md' }));
    await screen.findByRole('document', { name: 'plan.md Markdown content' }, { timeout: 5_000 });
    await userEvent.setup().click(screen.getByRole('tab', { name: 'other.md' }));

    expect(screen.getByRole('document', { name: 'other.md Markdown content' })).toBe(retained);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    expect(load.mock.calls.at(-1)?.[0]).toEqual({
      folderPath: '/project/notes',
      path: 'drafts/other.md',
    });
  });

  it('replaces the close glyph with a filled circle until an edit is saved', async () => {
    let acceptSave: ((value: DocumentTextSource) => void) | null = null;
    const api = sourceApi({
      load: vi.fn(async () => textSource({ content: '# Loaded' })),
      save: vi.fn(
        () =>
          new Promise<DocumentTextSource>((resolve) => {
            acceptSave = resolve;
          }),
      ),
    });
    const runtime = createRuntime(api);
    runtimes.push(runtime);
    withQueryClient(
      <>
        <DocumentTabs runtime={runtime} />
        <DocumentWorkspace {...documentWorkspaceProps} runtime={runtime} sourceApi={api} />
      </>,
    );

    await userEvent.setup().click(screen.getByRole('tab', { name: 'plan.md' }));
    await waitFor(() =>
      expect(runtime.getDocument('tab-1')?.store.getState().editor).not.toBeNull(),
    );
    act(() => runtime.getDocument('tab-1')?.change('# Draft'));

    // `data-unsaved-indicator` and `data-tab-trailing` mark aria-hidden trailing-icon elements —
    // the tab's own accessible name already carries dirty state, so only the icon swap is untested by role.
    const dirtyTab = screen.getByRole('tab', {
      name: 'plan.md, unsaved changes',
    });
    expect(dirtyTab.querySelector('[data-unsaved-indicator]')).not.toBeNull(); // dom-contract: see comment above
    expect(dirtyTab.getAttribute('data-document-dirty')).toBe('true');

    let save: Promise<boolean> | undefined;
    act(() => {
      save = runtime.getDocument('tab-1')?.save(api);
    });
    expect(dirtyTab.querySelector('[data-unsaved-indicator]')).not.toBeNull(); // dom-contract: see comment above

    await act(async () => {
      acceptSave?.(textSource({ content: '# Draft', version: 'v2' }));
      await save;
    });

    const savedTab = screen.getByRole('tab', { name: 'plan.md' });
    expect(savedTab.querySelector('[data-unsaved-indicator]')).toBeNull(); // dom-contract: see comment above
    expect(savedTab.getAttribute('data-document-dirty')).toBeNull();
    expect(savedTab.querySelector('[data-tab-trailing]')).not.toBeNull(); // dom-contract: see comment above
  });

  it('offers each open document as a source drag without disturbing activation', async () => {
    const runtime = createRuntime();
    runtimes.push(runtime);
    render(<DocumentTabs runtime={runtime} />);

    const tab = screen.getByRole('tab', { name: 'plan.md' });
    expect(tab.getAttribute('draggable')).toBe('true');
    const data = new Map<string, string>();
    fireEvent.dragStart(tab, {
      dataTransfer: {
        effectAllowed: 'none',
        setData: (type: string, value: string) => void data.set(type, value),
      },
    });

    expect(JSON.parse(data.get(SOURCE_DRAG_MIME) ?? 'null')).toEqual({
      folderPath: '/project/notes',
      path: 'plan.md',
    });
    expect(runtime.store.getState().activeTabId).toBe('tab-2');

    await userEvent.setup().click(tab);
    expect(runtime.store.getState().activeTabId).toBe('tab-1');
  });
});

describe('preview tabs', () => {
  it('marks a preview tab and keeps it on a double click or Enter', async () => {
    const runtime = createRuntime();
    runtimes.push(runtime);
    const user = userEvent.setup();
    withQueryClient(
      <>
        <DocumentTabs runtime={runtime} />
        <DocumentWorkspace
          {...documentWorkspaceProps}
          runtime={runtime}
          sourceApi={loadedSourceApi}
        />
      </>,
    );

    await act(async () => {
      await runtime.open(
        { folderPath: '/project/notes', path: 'notes/look.md' },
        { preview: true },
      );
    });
    const preview = screen.getByRole('tab', { name: 'look.md, preview' });
    expect(preview.getAttribute('data-document-preview')).toBe('true');

    await user.dblClick(preview);
    expect(screen.getByRole('tab', { name: 'look.md' }).getAttribute('data-document-preview')).toBe(
      null,
    );
    expect(runtime.store.getState().tabs.find((tab) => tab.id === 'tab-3')?.preview).toBe(false);

    await act(async () => {
      await runtime.open(
        { folderPath: '/project/notes', path: 'notes/glance.md' },
        { preview: true },
      );
    });
    const glance = screen.getByRole('tab', { name: 'glance.md, preview' });
    glance.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('tab', { name: 'glance.md' })).not.toBeNull();
  });
});

/** The strip with a New tab of its own, held the way the window holds it. */
function StripWithNewTab({ runtime }: { runtime: ReturnType<typeof createRuntime> }) {
  const [open, setOpen] = useState(false);
  return (
    <DocumentTabs
      newTab={{ add: () => setOpen(true), close: () => setOpen(false), open }}
      runtime={runtime}
    />
  );
}

describe('new tab', () => {
  it('ends the strip in a plus that seats the New tab last and selected, closed by Delete or a chosen document', async () => {
    const runtime = createRuntime();
    runtimes.push(runtime);
    const user = userEvent.setup();
    withQueryClient(<StripWithNewTab runtime={runtime} />);

    const tabList = screen.getByRole('tablist', { name: 'Open documents' });
    expect(screen.queryByRole('tab', { name: 'New tab' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'New tab' }));

    const newTab = screen.getByRole('tab', { name: 'New tab' });
    const tabs = within(tabList).getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs.at(-1)).toBe(newTab);
    expect(newTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'other.md' }).getAttribute('aria-selected')).toBe(
      'false',
    );
    // The open set is untouched: the New tab is the strip's, not the runtime's.
    expect(runtime.store.getState().tabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2']);

    newTab.focus();
    await user.keyboard('{Delete}');
    expect(screen.queryByRole('tab', { name: 'New tab' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'other.md' }).getAttribute('aria-selected')).toBe(
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'New tab' }));
    await user.click(screen.getByRole('tab', { name: 'plan.md' }));
    expect(screen.queryByRole('tab', { name: 'New tab' })).toBeNull();
    expect(runtime.store.getState().activeTabId).toBe('tab-1');
  });

  it('stands as the plus alone while nothing is open, and seats the New tab on its own', async () => {
    const runtime = createDocumentTabsRuntime({
      api: loadedSourceApi,
      createId: () => 'tab-1',
      createQueries: () => documentQueryScope(),
      folderPath: '/project/notes',
      generation: 1,
      restored: null,
    });
    runtimes.push(runtime);
    const user = userEvent.setup();
    withQueryClient(<StripWithNewTab runtime={runtime} />);

    expect(screen.queryByRole('tablist')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'New tab' }));
    expect(
      within(screen.getByRole('tablist', { name: 'Open documents' })).getAllByRole('tab'),
    ).toHaveLength(1);
    expect(screen.getByRole('tab', { name: 'New tab' }).getAttribute('aria-selected')).toBe('true');
  });
});
