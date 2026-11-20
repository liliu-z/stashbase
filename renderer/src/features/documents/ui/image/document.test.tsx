import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { pressKey } from '@/test/dom';

import { ImageDocument } from './document';

afterEach(() => {
  cleanup();
});

describe('image document', () => {
  it('uses compact viewer controls and opens the shared dialog lightbox', async () => {
    const user = userEvent.setup();
    render(
      <ImageDocument
        name="diagram.png"
        resource={{
          kind: 'source',
          url: 'http://127.0.0.1/asset/diagram.png?v=1',
          version: 'v1',
        }}
      />,
    );
    const image = screen.getByRole('img', { name: 'diagram.png' });
    Object.defineProperties(image, {
      naturalHeight: { configurable: true, value: 800 },
      naturalWidth: { configurable: true, value: 1200 },
    });
    fireEvent.load(image);

    expect(screen.getByRole('toolbar', { name: 'Image controls' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Fit to view' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Zoom percentage' }));
    const zoomInput = screen.getByRole('textbox', { name: 'Zoom percentage' });
    fireEvent.change(zoomInput, { target: { value: '150' } });
    pressKey(zoomInput, 'Enter');
    expect(screen.getByRole('button', { name: 'Zoom percentage' }).textContent).toBe('150%');

    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByRole('button', { name: 'Zoom percentage' }).textContent).toBe('180%');
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(screen.getByRole('button', { name: 'Zoom percentage' }).textContent).toBe('150%');
    await user.click(screen.getByRole('button', { name: 'Fit to view' }));
    expect(screen.getByRole('button', { name: 'Fit to view' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Enlarge image' }));
    expect(await screen.findByRole('dialog', { name: 'Image preview' })).not.toBeNull();
    expect(screen.getByRole('toolbar', { name: 'Image zoom controls' })).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
