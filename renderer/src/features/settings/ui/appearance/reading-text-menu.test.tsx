import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { failureMessage } from '@/features/settings/application/failure-messages';
import { appearancePort } from '@/test/fakes/settings';
import { withQueryClient } from '@/test/query';

import { ReadingTextMenu } from './reading-text-menu';

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.readingFont;
  delete document.documentElement.dataset.readingTextSize;
});

async function open() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Reading text: Serif' }));
  return user;
}

const preset = async (group: string, name: string) =>
  within(await screen.findByRole('radiogroup', { name: group })).getByRole('radio', { name });

describe('ReadingTextMenu', () => {
  it('saves only the reading font and applies it at once', async () => {
    const port = appearancePort();
    withQueryClient(<ReadingTextMenu appearanceApi={port} />);

    const user = await open();
    await user.click(await preset('Font', 'Sans'));

    await waitFor(() =>
      expect(port.update).toHaveBeenCalledWith({ readingFont: 'sans' }, expect.any(AbortSignal)),
    );
    expect(document.documentElement.dataset.readingFont).toBe('sans');
    expect(await screen.findByRole('button', { name: 'Reading text: Sans' })).toBeTruthy();
  });

  it('saves the reading size from the same menu', async () => {
    const port = appearancePort();
    withQueryClient(<ReadingTextMenu appearanceApi={port} />);

    const user = await open();
    await user.click(await preset('Size', 'Large'));

    await waitFor(() =>
      expect(port.update).toHaveBeenCalledWith(
        { readingTextSize: 'large' },
        expect.any(AbortSignal),
      ),
    );
    expect(document.documentElement.dataset.readingTextSize).toBe('large');
  });

  it('rolls the choice back and says why when the save is refused', async () => {
    const port = appearancePort({
      update: vi.fn(async () => {
        throw new Error('EPIPE');
      }),
    });
    withQueryClient(<ReadingTextMenu appearanceApi={port} />);

    const user = await open();
    await user.click(await preset('Font', 'Sans'));

    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      failureMessage('unavailable'),
    );
    expect(screen.getByRole('button', { name: 'Reading text: Serif' })).toBeTruthy();
    expect(document.documentElement.dataset.readingFont).toBe('serif');
  });
});
