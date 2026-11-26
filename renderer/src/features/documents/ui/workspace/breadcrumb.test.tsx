import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { pending } from '@/features/documents/ui/source/document-source.harness';
import { externalSource } from '@/shared/domain/external-source';
import { assetApi, docxPreviewApi, genericPreviewApi, tableApi } from '@/test/fakes/documents';
import { withQueryClient } from '@/test/query';

import { DocumentBreadcrumb } from './breadcrumb';
import { createRuntime, loadedSourceApi } from './tabs.harness';
import { DocumentWorkspace } from './workspace';

afterEach(cleanup);

function location() {
  return screen.getByRole('navigation', { name: 'Document location' });
}

describe('document breadcrumb', () => {
  it('names the project and each folder, and shows a folder in Files when chosen', async () => {
    const onRevealFolder = vi.fn<(folder: string) => void>();
    const user = userEvent.setup();
    render(
      <DocumentBreadcrumb
        onRevealFolder={onRevealFolder}
        source={{ folderPath: '/home/me/novel', path: 'drafts/part one/chapter.md' }}
      />,
    );

    expect(
      within(location())
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['novel', 'drafts', 'part one', 'chapter.md']);
    // The project and the document itself only read; each folder is a button.
    expect(
      within(location())
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['drafts', 'part one']);
    expect(within(location()).getByText('chapter.md').getAttribute('aria-current')).toBe('page');

    await user.click(within(location()).getByRole('button', { name: 'part one' }));
    expect(onRevealFolder).toHaveBeenCalledWith('drafts/part one');
  });

  it('names the directory of a file opened from outside the project, with nothing to reveal', () => {
    render(
      <DocumentBreadcrumb
        onRevealFolder={vi.fn()}
        source={externalSource('grant', String.raw`C:\Users\me\Desktop\notes.pdf`)}
      />,
    );

    expect(
      within(location())
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([String.raw`C:\Users\me\Desktop`, 'notes.pdf']);
    expect(within(location()).queryByRole('button')).toBeNull();
  });

  it('follows the document in front of the workspace', async () => {
    // The restored front tab is drafts/other.md in /project/notes.
    const runtime = renderWorkspace({ folderPath: '/project/notes', reveal: vi.fn() });

    expect(within(location()).getByRole('button', { name: 'drafts' })).not.toBeNull();
    await act(async () => runtime.activate('tab-1'));
    expect(within(location()).queryByRole('button')).toBeNull();
    expect(within(location()).getByText('plan.md').getAttribute('aria-current')).toBe('page');
    runtime.dispose();
  });

  it('offers no reveal for a document from a project other than the Files tree', () => {
    // Files shows /project/other, which may hold a `drafts` folder of its own;
    // revealing this document's `drafts` there would select the wrong one.
    const reveal = vi.fn<(folder: string) => void>();
    const runtime = renderWorkspace({ folderPath: '/project/other', reveal });

    expect(within(location()).getByText('drafts')).not.toBeNull();
    expect(within(location()).queryByRole('button')).toBeNull();
    expect(reveal).not.toHaveBeenCalled();
    runtime.dispose();
  });
});

function renderWorkspace(folderReveal: { folderPath: string; reveal(folder: string): void }) {
  const runtime = createRuntime();
  withQueryClient(
    <DocumentWorkspace
      assetApi={assetApi({ load: vi.fn(pending()) })}
      docxPreviewApi={docxPreviewApi({ load: vi.fn(pending()) })}
      folderReveal={folderReveal}
      genericPreviewApi={genericPreviewApi({ load: vi.fn(pending()) })}
      onReveal={vi.fn(async () => undefined)}
      revealLabel="Show in file manager"
      runtime={runtime}
      sourceApi={loadedSourceApi}
      tableApi={tableApi()}
    />,
  );
  return runtime;
}
