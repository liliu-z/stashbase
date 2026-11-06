import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { failureMessage } from '@/features/settings/application/failure-messages';
import { appearancePort, appearanceSurface } from '@/test/fakes/settings';
import { withQueryClient } from '@/test/query';

import { AppearanceMenu } from './appearance-menu';

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.readingFont;
  delete document.documentElement.dataset.readingTextSize;
  delete document.documentElement.dataset.pageTexture;
  document.documentElement.classList.remove('dark');
});

async function open() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Appearance' }));
  return user;
}

const choice = async (group: string, name: string) =>
  within(await screen.findByRole('radiogroup', { name: group })).getByRole<HTMLInputElement>(
    'radio',
    {
      name,
    },
  );

/** The installed-font list's rows, by name, in order. */
const optionNames = async () =>
  within(await screen.findByRole('listbox', { name: 'Document font' }))
    .getAllByRole('option')
    .map((row) => row.getAttribute('aria-label'));

describe('AppearanceMenu', () => {
  it('saves only the reading font and applies it at once', async () => {
    const port = appearancePort();
    withQueryClient(<AppearanceMenu appearanceApi={port} />);

    const user = await open();
    await user.click(await choice('Font', 'Sans'));

    await waitFor(() =>
      expect(port.update).toHaveBeenCalledWith({ readingFont: 'sans' }, expect.any(AbortSignal)),
    );
    expect(document.documentElement.dataset.readingFont).toBe('sans');
    expect((await choice('Font', 'Sans')).checked).toBe(true);
  });

  it('saves the text size from the slider as one step', async () => {
    const port = appearancePort();
    withQueryClient(<AppearanceMenu appearanceApi={port} />);

    const user = await open();
    const slider = await screen.findByRole('slider', { name: 'Text size' });
    await waitFor(() => expect(slider.hasAttribute('disabled')).toBe(false));
    slider.focus();
    await user.keyboard('{ArrowRight}');

    await waitFor(() =>
      expect(port.update).toHaveBeenCalledWith({ readingTextSize: 4 }, expect.any(AbortSignal)),
    );
    expect(document.documentElement.dataset.readingTextSize).toBe('4');
  });

  it('opens the installed fonts from the custom font and keeps its family beside Serif and Sans', async () => {
    const port = appearancePort();
    withQueryClient(
      <AppearanceMenu
        appearanceApi={port}
        systemTextApi={{
          listFonts: async () => [
            { family: 'Bradley Hand', monospace: false },
            { family: 'Hannotate SC', monospace: false },
          ],
          spellcheckLanguages: async () => [],
        }}
      />,
    );
    const user = await open();

    // The list holds installed fonts only; Serif and Sans stand beside it.
    await user.click(await screen.findByRole('button', { name: 'Custom font' }));
    expect(await optionNames()).toEqual(['Bradley Hand', 'Hannotate SC']);
    await user.click(screen.getByRole('option', { name: 'Hannotate SC' }));
    await waitFor(() =>
      expect(port.update).toHaveBeenCalledWith(
        { readingFont: 'custom', writingFont: 'Hannotate SC' },
        expect.any(AbortSignal),
      ),
    );
    expect(
      await screen.findByRole('button', { name: 'Custom font: Hannotate SC, in use' }),
    ).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByRole('listbox', { name: 'Document font' })).toBeNull(),
    );

    // Serif is chosen in place and leaves the family on its tile.
    await user.click(await choice('Font', 'Serif'));
    await waitFor(() =>
      expect(port.update).toHaveBeenCalledWith({ readingFont: 'serif' }, expect.any(AbortSignal)),
    );
    await user.click(await screen.findByRole('button', { name: 'Custom font: Hannotate SC' }));

    // Reopened, the list leads with that family, so going back is one click.
    expect(await optionNames()).toEqual(['Hannotate SC', 'Bradley Hand']);
    await user.click(screen.getByRole('option', { name: 'Hannotate SC' }));
    await waitFor(() =>
      expect(port.update).toHaveBeenLastCalledWith(
        { readingFont: 'custom', writingFont: 'Hannotate SC' },
        expect.any(AbortSignal),
      ),
    );
  });

  it('chooses a page colour as its light and dark pair', async () => {
    const port = appearancePort();
    withQueryClient(<AppearanceMenu appearanceApi={port} />);

    const user = await open();
    expect((await choice('Page color', 'White')).checked).toBe(true);
    await user.click(await choice('Page color', 'Paper'));

    await waitFor(() =>
      expect(port.update).toHaveBeenCalledWith(
        { lightTheme: 'paper-light', darkTheme: 'paper-dark' },
        expect.any(AbortSignal),
      ),
    );
    expect((await choice('Page color', 'Paper')).checked).toBe(true);
    expect((await choice('Mode', 'Match system')).checked).toBe(true);
  });

  it('says why a chosen grain does not show on a dark page', async () => {
    let saved = appearanceSurface({ theme: 'dark' });
    const port = appearancePort({
      load: vi.fn(async () => saved),
      update: vi.fn(async (change) => (saved = { ...saved, ...change })),
    });
    withQueryClient(<AppearanceMenu appearanceApi={port} />);

    const user = await open();
    expect(screen.queryByText('Grain shows on light pages.')).toBeNull();
    await user.click(await choice('Page texture', 'Grain'));

    await waitFor(() =>
      expect(port.update).toHaveBeenCalledWith({ pageTexture: 'grain' }, expect.any(AbortSignal)),
    );
    expect(document.documentElement.dataset.pageTexture).toBe('grain');
    expect(await screen.findByText('Grain shows on light pages.')).toBeDefined();
  });

  it('rolls the choice back and says why when the save is refused', async () => {
    const port = appearancePort({
      update: vi.fn(async () => {
        throw new Error('EPIPE');
      }),
    });
    withQueryClient(<AppearanceMenu appearanceApi={port} />);

    const user = await open();
    await user.click(await choice('Font', 'Sans'));

    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      failureMessage('unavailable'),
    );
    expect((await choice('Font', 'Serif')).checked).toBe(true);
    expect(document.documentElement.dataset.readingFont).toBe('serif');
  });
});
