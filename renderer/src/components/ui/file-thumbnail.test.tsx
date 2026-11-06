import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { expectNoA11yViolations } from '@/test/axe';

import { FileThumbnail } from './file-thumbnail';

afterEach(cleanup);

describe('FileThumbnail', () => {
  it('falls back to a typed icon and the name for a file it cannot preview', async () => {
    const file = new File(['StashBase notes'], 'notes.md', { type: 'text/markdown' });
    const view = render(<FileThumbnail file={file} size={96} />);
    // No preview is possible, so the glyph carries the file name as its label
    // and the name is written under it, where the reader can see it.
    expect(screen.getByRole('img', { name: 'notes.md' })).toBeDefined();
    expect(screen.getByText('notes.md')).toBeDefined();
    await expectNoA11yViolations(view.container);
  });
});
