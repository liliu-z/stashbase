import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vite-plus/test';

import { FluidProviders as Providers } from '@/shared/runtime/fluid-providers';

import { GalleryScreenshot } from './screenshots';

afterEach(cleanup);

it('retries the single cover through the same restricted proxy', () => {
  const source =
    'http://localhost:9000/api/gallery/image?src=https%3A%2F%2Fassets.stashbase.ai%2Fa.png';
  render(
    <Providers>
      <GalleryScreenshot name="Example" screenshot={source} />
    </Providers>,
  );
  fireEvent.error(screen.getByRole('img', { name: 'Example cover' }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry screenshot' }));
  const retried = screen.getByRole('img', { name: 'Example cover' }).getAttribute('src');
  const url = new URL(retried ?? '');
  expect(url.origin + url.pathname).toBe('http://localhost:9000/api/gallery/image');
  expect(url.searchParams.get('src')).toBe('https://assets.stashbase.ai/a.png');
  expect(retried).not.toBe(source);
});
