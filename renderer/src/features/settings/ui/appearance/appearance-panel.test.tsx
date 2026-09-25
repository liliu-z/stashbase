import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { failureMessage } from '@/features/settings/application/failure-messages';
import { appearancePort } from '@/test/fakes/settings';
import { withQueryClient } from '@/test/query';

import { AppearancePanel } from './appearance-panel';

afterEach(() => {
  cleanup();
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  delete root.dataset.uiScale;
  delete root.dataset.readingTextSize;
  delete root.dataset.readingFont;
});

const group = (name: string) => screen.getByRole('radiogroup', { name });

/** The group's options, in document order, named the way a reader hears them. */
function expectOptions(name: string, expected: readonly string[]) {
  const options = within(group(name)).getAllByRole('radio');
  expect(options).toHaveLength(expected.length);
  expected.forEach((label, index) => {
    expect(options[index]).toBe(within(group(name)).getByRole('radio', { name: label }));
  });
}

/** The read has answered once a preset is checked. */
async function loaded(checked: string) {
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: checked })).toHaveProperty('checked', true),
  );
}

describe('AppearancePanel', () => {
  it('offers one group per preference, each with its presets in order', async () => {
    withQueryClient(<AppearancePanel appearanceApi={appearancePort()} />);
    await waitFor(() => expect(screen.getAllByRole('radiogroup')).toHaveLength(4));

    expectOptions('Theme', ['Match system', 'Light', 'Dark']);
    expectOptions('Interface size', ['Small', 'Default', 'Large']);
    expectOptions('Reading text size', ['Small', 'Default', 'Large']);
    expectOptions('Reading font', ['Serif', 'Sans']);
  });

  it('checks the preset the read answered with', async () => {
    withQueryClient(
      <AppearancePanel
        appearanceApi={appearancePort({
          load: async () => ({
            readingFont: 'sans',
            readingTextSize: 'small',
            theme: 'dark',
            uiScale: 'large',
          }),
        })}
      />,
    );

    await waitFor(() =>
      expect(within(group('Theme')).getByRole('radio', { name: 'Dark' })).toHaveProperty(
        'checked',
        true,
      ),
    );
    expect(within(group('Interface size')).getByRole('radio', { name: 'Large' })).toHaveProperty(
      'checked',
      true,
    );
    expect(within(group('Reading text size')).getByRole('radio', { name: 'Small' })).toHaveProperty(
      'checked',
      true,
    );
    expect(within(group('Reading font')).getByRole('radio', { name: 'Sans' })).toHaveProperty(
      'checked',
      true,
    );
  });

  it('saves the one field the chosen row owns', async () => {
    const port = appearancePort();
    withQueryClient(<AppearancePanel appearanceApi={port} />);
    await loaded('Match system');

    await userEvent
      .setup()
      .click(within(group('Reading text size')).getByRole('radio', { name: 'Large' }));

    await waitFor(() =>
      expect(port.update).toHaveBeenCalledWith(
        { readingTextSize: 'large' },
        expect.any(AbortSignal),
      ),
    );
    expect(document.documentElement.dataset.readingTextSize).toBe('large');
  });

  it('keeps the saved preset checked when the save is refused', async () => {
    const port = appearancePort({
      update: vi.fn(async () => {
        throw new Error('EPIPE');
      }),
    });
    withQueryClient(<AppearancePanel appearanceApi={port} />);
    await loaded('Match system');

    await userEvent.setup().click(within(group('Theme')).getByRole('radio', { name: 'Dark' }));

    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      failureMessage('unavailable'),
    );
    expect(within(group('Theme')).getByRole('radio', { name: 'Match system' })).toHaveProperty(
      'checked',
      true,
    );
  });
});
