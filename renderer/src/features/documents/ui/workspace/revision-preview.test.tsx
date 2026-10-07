import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vite-plus/test';

import { RevisionPreview } from './revision-preview';

afterEach(cleanup);

it('offers a pasted document for review and shows why one was refused', async () => {
  const user = userEvent.setup();
  const start = vi.fn();
  const { rerender } = render(<RevisionPreview onStart={start} refusal={null} />);
  expect(screen.getByRole('button', { name: 'Start review' }).hasAttribute('disabled')).toBe(true);

  await user.type(screen.getByRole('textbox', { name: 'Document before the turn' }), '# Revised');
  await user.click(screen.getByRole('button', { name: 'Start review' }));
  expect(start).toHaveBeenCalledWith('# Revised');

  rerender(<RevisionPreview onStart={start} refusal="The document has changed." />);
  expect(screen.getByRole('alert').textContent).toBe('The document has changed.');
});
