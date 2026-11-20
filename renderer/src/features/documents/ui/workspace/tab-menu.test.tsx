import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { DocumentSourcePort } from '@/features/documents/application/ports';
import { sourceApi, textSource } from '@/test/fakes/documents';
import { withQueryClient } from '@/test/query';

import { DocumentTabs } from './tabs';
import { createRuntime, loadedSourceApi, RESTORED_TABS } from './tabs.harness';

/** Right-clicks a tab and waits for its menu. */
function openTabMenu(name: string) {
  fireEvent.contextMenu(screen.getByRole('tab', { name }));
  return screen.findByRole('menu', { name: `${name} tab actions` });
}

const runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(() => {
  cleanup();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});
describe('document tab menu', () => {
  it('offers closing and the file on disk from a tab menu, by right click or keyboard', async () => {
    const runtime = createRuntime(loadedSourceApi, [
      ...RESTORED_TABS,
      { id: 'tab-3', source: { folderPath: '/project/notes', path: 'summary.md' } },
    ]);
    runtimes.push(runtime);
    const user = userEvent.setup();
    const menuActions = {
      onCopyPath: vi.fn(),
      onReveal: vi.fn(),
      revealLabel: 'Show in file manager',
    };
    withQueryClient(<DocumentTabs menuActions={menuActions} runtime={runtime} />);
    const tabIds = () => runtime.store.getState().tabs.map((tab) => tab.id);
    const other = { folderPath: '/project/notes', path: 'drafts/other.md' };

    await user.click(
      within(await openTabMenu('other.md')).getByRole('menuitem', { name: 'Copy relative path' }),
    );
    expect(menuActions.onCopyPath).toHaveBeenCalledWith(other, 'relative');
    await user.click(
      within(await openTabMenu('other.md')).getByRole('menuitem', { name: 'Show in file manager' }),
    );
    expect(menuActions.onReveal).toHaveBeenCalledWith(other);

    await user.click(
      within(await openTabMenu('other.md')).getByRole('menuitem', { name: 'Close to the right' }),
    );
    await waitFor(() => expect(tabIds()).toEqual(['tab-1', 'tab-2']));
    const menu = await openTabMenu('other.md');
    expect(
      within(menu)
        .getByRole('menuitem', { name: 'Close to the right' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    await user.click(within(menu).getByRole('menuitem', { name: 'Close others' }));
    await waitFor(() => expect(tabIds()).toEqual(['tab-2']));

    // The keyboard reaches the same menu, and closing hands focus on.
    screen.getByRole('tab', { name: 'other.md' }).focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    const keyboardMenu = await screen.findByRole('menu', { name: 'other.md tab actions' });
    expect(
      within(keyboardMenu)
        .getByRole('menuitem', { name: 'Close others' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    await user.click(within(keyboardMenu).getByRole('menuitem', { name: 'Close all' }));
    await waitFor(() => expect(tabIds()).toEqual([]));
  });

  it('stops closing several tabs at the first one that stays open', async () => {
    const runtime = createRuntime();
    runtimes.push(runtime);
    const user = userEvent.setup();
    // A tab stays open when its save fails or its draft needs the reader's
    // answer; the tabs after it must wait for that rather than close behind it.
    const close = vi.spyOn(runtime, 'close').mockResolvedValueOnce(false);
    withQueryClient(<DocumentTabs runtime={runtime} />);

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'plan.md' }));
    const menu = await screen.findByRole('menu', { name: 'plan.md tab actions' });
    expect(within(menu).queryByRole('menuitem', { name: 'Copy path' })).toBeNull();
    await user.click(within(menu).getByRole('menuitem', { name: 'Close all' }));

    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(close).toHaveBeenCalledWith('tab-1');
    expect(runtime.store.getState().tabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2']);
  });

  it('focuses the surviving tab after a bulk close waits for a dirty save', async () => {
    let finishSave!: () => void;
    const api = sourceApi({
      load: vi.fn(async () => textSource({ content: 'before' })),
      save: vi.fn<DocumentSourcePort['save']>(
        (_source, input) =>
          new Promise((resolve) => {
            finishSave = () => resolve(textSource({ content: input.content, version: 'saved' }));
          }),
      ),
    });
    const runtime = createRuntime(api, [
      ...RESTORED_TABS,
      { id: 'tab-3', source: { folderPath: '/project/notes', path: 'waiting.md' } },
      { id: 'tab-4', source: { folderPath: '/project/notes', path: 'survivor.md' } },
    ]);
    runtimes.push(runtime);
    await runtime.activate('tab-3');
    runtime.getDocument('tab-3')?.reconcile(textSource({ content: 'before' }));
    runtime.getDocument('tab-3')?.change('draft');
    await runtime.activate('tab-2');
    const user = userEvent.setup();
    withQueryClient(<DocumentTabs runtime={runtime} />);
    await user.click(
      within(await openTabMenu('survivor.md')).getByRole('menuitem', { name: 'Close others' }),
    );
    await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
    await act(async () => finishSave());
    await waitFor(() =>
      expect(runtime.store.getState().tabs.map((tab) => tab.id)).toEqual(['tab-4']),
    );
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'survivor.md' }));
  });
});
