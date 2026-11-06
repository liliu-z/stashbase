import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import type { SystemTextPort } from '@/features/settings/application/ports';
import { applyAppearanceSurface } from '@/shared/runtime/appearance-surface';
import { appearancePort, appearanceSurface } from '@/test/fakes/settings';
import { withQueryClient } from '@/test/query';

import { EditorPanel } from './editor-panel';

afterEach(() => {
  cleanup();
  applyAppearanceSurface(appearanceSurface());
  document.documentElement.classList.remove('light', 'dark');
});

const group = (name: string) => screen.getByRole('radiogroup', { name });

/** The read has answered once a preset is checked. */
async function loaded() {
  await waitFor(() =>
    expect(within(group('Line width')).getByRole('radio', { name: 'Default' })).toHaveProperty(
      'checked',
      true,
    ),
  );
}

const systemText = (fonts: SystemTextPort['listFonts']): SystemTextPort => ({
  listFonts: fonts,
  spellcheckLanguages: async () => ['en-US', 'fr'],
});

describe('EditorPanel', () => {
  it('saves the one field the chosen row owns', async () => {
    const port = appearancePort();
    withQueryClient(<EditorPanel appearanceApi={port} />);
    await loaded();
    const user = userEvent.setup();

    await user.click(within(group('Line width')).getByRole('radio', { name: 'Wide' }));
    await user.click(screen.getByRole('switch', { name: 'Focus mode' }));

    await waitFor(() =>
      expect(port.update).toHaveBeenCalledWith({ lineWidth: 'wide' }, expect.any(AbortSignal)),
    );
    await waitFor(() =>
      expect(port.update).toHaveBeenCalledWith({ focusMode: true }, expect.any(AbortSignal)),
    );
    expect(document.documentElement.dataset.lineWidth).toBe('wide');
    expect(document.documentElement.dataset.focusMode).toBe('on');
  });

  it('lists the included fonts first, then installed fonts, and saves the chosen one', async () => {
    const port = appearancePort();
    withQueryClient(
      <EditorPanel
        appearanceApi={port}
        systemTextApi={systemText(async () => [
          { family: 'Literata', monospace: false },
          { family: 'JetBrains Mono', monospace: true },
        ])}
      />,
    );
    await loaded();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Document font: Serif' }));
    const writing = await screen.findByRole('listbox', { name: 'Document font' });
    expect(
      within(writing)
        .getAllByRole('option')
        .map((row) => row.getAttribute('aria-label')),
    ).toEqual(['Serif, Included', 'Sans, Included', 'Literata', 'JetBrains Mono']);
    await user.click(within(writing).getByRole('option', { name: 'Literata' }));
    await waitFor(() =>
      expect(port.update).toHaveBeenCalledWith(
        { readingFont: 'custom', writingFont: 'Literata' },
        expect.any(AbortSignal),
      ),
    );

    // An included font puts the installed one aside without forgetting it.
    await user.click(await screen.findByRole('button', { name: 'Document font: Literata' }));
    await user.click(await screen.findByRole('option', { name: 'Sans, Included' }));
    await waitFor(() =>
      expect(port.update).toHaveBeenCalledWith({ readingFont: 'sans' }, expect.any(AbortSignal)),
    );

    await user.click(screen.getByRole('button', { name: 'Code font: Geist Mono' }));
    const code = await screen.findByRole('listbox', { name: 'Code font' });
    expect(
      within(code)
        .getAllByRole('option')
        .map((row) => row.getAttribute('aria-label')),
    ).toEqual(['Geist Mono, Included', 'JetBrains Mono']);
  });

  it('keeps a chosen font that is no longer installed and says so', async () => {
    withQueryClient(
      <EditorPanel
        appearanceApi={appearancePort({
          load: async () => ({
            ...appearanceSurface(),
            readingFont: 'custom',
            writingFont: 'Gone Serif',
          }),
        })}
        systemTextApi={systemText(async () => [{ family: 'Literata', monospace: false }])}
      />,
    );

    expect(
      await screen.findByRole('button', { name: 'Document font: Gone Serif (not installed)' }),
    ).toBeTruthy();
  });

  it('offers the spellcheck languages the system knows', async () => {
    withQueryClient(
      <EditorPanel appearanceApi={appearancePort()} systemTextApi={systemText(async () => [])} />,
    );
    expect(await screen.findByRole('combobox', { name: 'Spelling language' })).toBeTruthy();
  });
});
