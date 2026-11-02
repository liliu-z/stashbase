import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { failureMessage } from '@/features/settings/application/failure-messages';
import { appearancePort, projectMathPort } from '@/test/fakes/settings';
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
    withQueryClient(
      <ReadingTextMenu appearanceApi={port} mathApi={projectMathPort()} projectPath="/project" />,
    );

    const user = await open();
    await user.click(await preset('Font', 'Sans'));

    await waitFor(() =>
      expect(port.update).toHaveBeenCalledWith(
        { readingFont: 'sans', writingFont: null },
        expect.any(AbortSignal),
      ),
    );
    expect(document.documentElement.dataset.readingFont).toBe('sans');
    expect(await screen.findByRole('button', { name: 'Reading text: Sans' })).toBeTruthy();
  });

  it('saves the reading size from the same menu', async () => {
    const port = appearancePort();
    withQueryClient(
      <ReadingTextMenu appearanceApi={port} mathApi={projectMathPort()} projectPath="/project" />,
    );

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
    withQueryClient(
      <ReadingTextMenu appearanceApi={port} mathApi={projectMathPort()} projectPath="/project" />,
    );

    const user = await open();
    await user.click(await preset('Font', 'Sans'));

    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      failureMessage('unavailable'),
    );
    expect(screen.getByRole('button', { name: 'Reading text: Serif' })).toBeTruthy();
    expect(document.documentElement.dataset.readingFont).toBe('serif');
  });

  it('places the project Math switch beside the reading control and persists only this project setting', async () => {
    const mathApi = projectMathPort();
    withQueryClient(
      <ReadingTextMenu
        appearanceApi={appearancePort()}
        mathApi={mathApi}
        projectPath="/project-a"
      />,
    );

    const user = userEvent.setup();
    const control = await screen.findByRole('switch', { name: 'Math' });
    expect(control.getAttribute('aria-checked')).toBe('false');
    await user.click(control);

    await waitFor(() =>
      expect(mathApi.update).toHaveBeenCalledWith('/project-a', true, expect.any(AbortSignal)),
    );
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('dialog', { name: 'Reading text' })).toBeNull();
  });

  it('keeps Math consistent across document menus while a save is pending, then rolls back a refusal', async () => {
    let rejectSave: ((error: Error) => void) | undefined;
    const mathApi = projectMathPort({
      update: vi.fn(
        () =>
          new Promise<{ scope: string; math_mode: boolean }>((_resolve, reject) => {
            rejectSave = reject;
          }),
      ),
    });
    const appearanceApi = appearancePort();
    const first = withQueryClient(
      <ReadingTextMenu appearanceApi={appearanceApi} mathApi={mathApi} projectPath="/project" />,
    );
    const user = userEvent.setup();
    const control = await screen.findByRole('switch', { name: 'Math' });
    await user.click(control);
    await waitFor(() => expect(mathApi.update).toHaveBeenCalledTimes(1));
    const readsBeforeSwitch = vi.mocked(mathApi.load).mock.calls.length;

    withQueryClient(
      <ReadingTextMenu appearanceApi={appearanceApi} mathApi={mathApi} projectPath="/project" />,
      first.client,
    );
    await waitFor(() => {
      const controls = screen.getAllByRole('switch', { name: 'Math' });
      expect(controls).toHaveLength(2);
      for (const next of controls) {
        expect(next.getAttribute('aria-checked')).toBe('true');
        expect(next.getAttribute('aria-disabled')).toBe('true');
      }
    });
    expect(mathApi.load).toHaveBeenCalledTimes(readsBeforeSwitch);
    first.unmount();
    await act(async () => rejectSave?.(new Error('EPIPE')));
    await waitFor(() => {
      for (const next of screen.getAllByRole('switch', { name: 'Math' })) {
        expect(next.getAttribute('aria-checked')).toBe('false');
        expect(next.getAttribute('aria-disabled')).not.toBe('true');
      }
    });
    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      failureMessage('unavailable'),
    );
  });

  it('offers retry when the project Math setting cannot be loaded', async () => {
    const mathApi = projectMathPort();
    vi.mocked(mathApi.load).mockRejectedValueOnce(new Error('EPIPE'));
    withQueryClient(
      <ReadingTextMenu appearanceApi={appearancePort()} mathApi={mathApi} projectPath="/project" />,
    );
    const retry = await screen.findByRole('button', { name: 'Retry Math setting' });
    expect(screen.getByRole('switch', { name: 'Math' }).getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(retry);
    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.getByRole('switch', { name: 'Math' }).getAttribute('aria-disabled')).not.toBe(
        'true',
      );
    });
  });

  it('refreshes a project setting changed in another desktop window on return', async () => {
    const mathApi = projectMathPort();
    withQueryClient(
      <ReadingTextMenu appearanceApi={appearancePort()} mathApi={mathApi} projectPath="/project" />,
    );
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Math' }).getAttribute('aria-disabled')).not.toBe(
        'true',
      ),
    );
    vi.mocked(mathApi.load).mockResolvedValue({ scope: '/project', math_mode: true });
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Math' }).getAttribute('aria-checked')).toBe(
        'true',
      ),
    );
    expect(mathApi.update).not.toHaveBeenCalled();
  });
});
