import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      holdEdits={() => () => undefined}
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

it('routes ordinary Markdown links inside prices through the document boundary', async () => {
  const onChange = vi.fn();
  const onNavigate = vi.fn();
  const onOpenExternal = vi.fn(async () => true);
  render(
    <MarkdownDocument
      active
      canChangeMode
      dirty={false}
      holdEdits={() => () => undefined}
      mathMode={false}
      mode="reading"
      name="prices.md"
      navigation={createDocumentNavigationRuntime('prices')}
      onChange={onChange}
      onModeChange={vi.fn()}
      onNavigate={onNavigate}
      onOpenExternal={onOpenExternal}
      readOnly
      revision={{ onPending: vi.fn(), state: { kind: 'idle' } }}
      source={{ folderPath: '/project', path: 'notes/prices.md' }}
      tabId="prices"
      value={
        'Cost $10 for [guide](guide.md#details) or [website](https://example.com), with ![chart](chart.png), total $20.\n'
      }
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('document').getAttribute('data-markdown-state')).toBe('ready'),
  );
  fireEvent.click(await screen.findByRole('link', { name: 'guide' }));
  expect(onNavigate).toHaveBeenCalledWith({
    source: { folderPath: '/project', path: 'notes/guide.md' },
    anchor: 'details',
  });
  fireEvent.click(screen.getByRole('link', { name: 'website' }));
  expect(onOpenExternal).toHaveBeenCalledWith('https://example.com/');
  expect(screen.getByRole('img', { name: 'chart' }).getAttribute('src')).toBe('chart.png');
  await act(settleMarkdownListener);
  expect(onChange).not.toHaveBeenCalled();
});
