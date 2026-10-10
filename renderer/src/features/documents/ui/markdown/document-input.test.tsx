import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vite-plus/test';

import { createDocumentNavigationRuntime } from '@/features/documents/application/navigation-runtime';
import { settleMarkdownListener } from '@/test/milkdown';

import { MarkdownDocument } from './document';

afterEach(cleanup);

it('renders unique heading anchors without turning presentation into document edits', async () => {
  // Heading DOM mutations used to make ProseMirror reparse nearby composing
  // text, cancelling Chromium's IME replacement range and leaving pinyin behind.
  const onChange = vi.fn();
  render(
    <MarkdownDocument
      active
      canChangeMode
      dirty={false}
      mode="writer"
      name="input.md"
      navigation={createDocumentNavigationRuntime('input')}
      onChange={onChange}
      onModeChange={vi.fn()}
      onNavigate={vi.fn()}
      onOpenExternal={vi.fn(async () => true)}
      readOnly={false}
      revision={{ onPending: vi.fn(), state: { kind: 'idle' } }}
      source={{ folderPath: '/project', path: 'input.md' }}
      tabId="input"
      value={'# 推广、报名，\n\n<br />\n\n## 推广、报名，\n'}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('document').getAttribute('data-markdown-state')).toBe('ready'),
  );
  await act(settleMarkdownListener);

  const headings = screen.getAllByRole('heading', { name: '推广、报名，' });
  expect(headings.map((heading) => heading.id)).toEqual(['推广报名', '推广报名-1']);
  expect(onChange).not.toHaveBeenCalled();
});
