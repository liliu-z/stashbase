import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { failureMessage } from '@/features/settings/application/failure-messages';
import type { SystemTextPort } from '@/features/settings/application/ports';
import { applyAppearanceSurface } from '@/shared/runtime/appearance-surface';
import { appearancePort, appearanceSurface } from '@/test/fakes/settings';
import { withQueryClient } from '@/test/query';

import { AppearancePanel } from './appearance-panel';

afterEach(() => {
  cleanup();
  applyAppearanceSurface(appearanceSurface());
  document.documentElement.classList.remove('light', 'dark');
});

const group = (name: string) => screen.getByRole('radiogroup', { name });

/** The group's options, in document order, named the way a reader hears them. */
function expectOptions(name: string, expected: readonly string[]) {
  const options = within(group(name)).getAllByRole('radio');
  expect(options.map((option) => option.getAttribute('value'))).toHaveLength(expected.length);
  expected.forEach((label, index) => {
    expect(options[index]).toBe(within(group(name)).getByRole('radio', { name: label }));
  });
}

/** The read has answered once a preset is checked. */
async function loaded() {
  await waitFor(() =>
    expect(within(group('Mode')).getByRole('radio', { name: 'Match system' })).toHaveProperty(
      'checked',
      true,
    ),
  );
}

const systemText = (fonts: SystemTextPort['listFonts']): SystemTextPort => ({
  listFonts: fonts,
  spellcheckLanguages: async () => ['en-US', 'fr'],
});

describe('AppearancePanel', () => {
  it('offers each preset row with its presets in order', async () => {
    withQueryClient(<AppearancePanel appearanceApi={appearancePort()} />);
    await waitFor(() => expect(screen.getAllByRole('radiogroup')).toHaveLength(6));

    expectOptions('Mode', ['Match system', 'Light', 'Dark']);
    expectOptions('Interface size', ['Small', 'Default', 'Large']);
    expectOptions('Reduce motion', ['Match system', 'On']);
    expectOptions('Text size', ['Small', 'Default', 'Large']);
    expectOptions('Line spacing', ['Compact', 'Default', 'Relaxed']);
    expectOptions('Line width', ['Narrow', 'Default', 'Wide', 'Full']);
  });

  it('saves the one field the chosen row owns', async () => {
    const port = appearancePort();
    withQueryClient(<AppearancePanel appearanceApi={port} />);
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

  it('keeps the saved preset checked when the save is refused', async () => {
    const port = appearancePort({
      update: vi.fn(async () => {
        throw new Error('EPIPE');
      }),
    });
    withQueryClient(<AppearancePanel appearanceApi={port} />);
    await loaded();

    await userEvent.setup().click(within(group('Mode')).getByRole('radio', { name: 'Dark' }));

    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      failureMessage('unavailable'),
    );
    expect(within(group('Mode')).getByRole('radio', { name: 'Match system' })).toHaveProperty(
      'checked',
      true,
    );
  });

  it('lists the included fonts first, then installed fonts, and saves the chosen one', async () => {
    const port = appearancePort();
    withQueryClient(
      <AppearancePanel
        appearanceApi={port}
        systemTextApi={systemText(async () => [
          { family: 'Literata', monospace: false },
          { family: 'JetBrains Mono', monospace: true },
        ])}
      />,
    );
    await loaded();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Writing font: Serif' }));
    const writing = await screen.findByRole('listbox', { name: 'Writing font' });
    expect(
      within(writing)
        .getAllByRole('option')
        .map((row) => row.getAttribute('aria-label')),
    ).toEqual(['Serif, Included', 'Sans, Included', 'Literata', 'JetBrains Mono']);
    await user.click(within(writing).getByRole('option', { name: 'Literata' }));
    await waitFor(() =>
      expect(port.update).toHaveBeenCalledWith(
        { writingFont: 'Literata' },
        expect.any(AbortSignal),
      ),
    );

    // An included font retires the installed one, or it would not show.
    await user.click(await screen.findByRole('button', { name: 'Writing font: Literata' }));
    await user.click(await screen.findByRole('option', { name: 'Sans, Included' }));
    await waitFor(() =>
      expect(port.update).toHaveBeenCalledWith(
        { readingFont: 'sans', writingFont: null },
        expect.any(AbortSignal),
      ),
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
      <AppearancePanel
        appearanceApi={appearancePort({
          load: async () => ({ ...appearanceSurface(), writingFont: 'Gone Serif' }),
        })}
        systemTextApi={systemText(async () => [{ family: 'Literata', monospace: false }])}
      />,
    );

    expect(
      await screen.findByRole('button', { name: 'Writing font: Gone Serif (not installed)' }),
    ).toBeTruthy();
  });

  it('offers the spellcheck languages the system knows', async () => {
    withQueryClient(
      <AppearancePanel
        appearanceApi={appearancePort()}
        systemTextApi={systemText(async () => [])}
      />,
    );
    expect(await screen.findByRole('combobox', { name: 'Spelling language' })).toBeTruthy();
  });
});
