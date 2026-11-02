import { EditorView } from '@codemirror/view';
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

it('reads formula blocks without source and preserves editing history across mode changes', async () => {
  const formula = String.raw`\frac{1}{2} + \begin{pmatrix}a & b \\ c & d\end{pmatrix}`;
  const value = `A formula:\n\n$$\n${formula}\n$$\n\n\`\`\`js\nconsole.log("ordinary");\n\`\`\`\n\nAfter formula.\n`;
  const onChange = vi.fn();
  const navigation = createDocumentNavigationRuntime('formula');
  const document = (readOnly: boolean) => (
    <MarkdownDocument
      active
      canChangeMode
      dirty={false}
      holdEdits={() => () => undefined}
      mathMode
      mode={readOnly ? 'reading' : 'writer'}
      name="formula.md"
      navigation={navigation}
      onChange={onChange}
      onModeChange={vi.fn()}
      onNavigate={vi.fn()}
      onOpenExternal={vi.fn(async () => true)}
      readOnly={readOnly}
      revision={{ onPending: vi.fn(), state: { kind: 'idle' } }}
      source={{ folderPath: '/project', path: 'formula.md' }}
      tabId="formula"
      value={value}
    />
  );
  const rendered = render(document(false));
  await waitFor(() =>
    expect(screen.getByRole('document').getAttribute('data-markdown-state')).toBe('ready'),
  );
  const preview = screen.getByRole('button', { name: 'Edit formula' });
  const block = preview.closest<HTMLElement>('.stashbase-math-block'); // dom-contract: formula block presentation is separate from the ordinary code-block view.
  const source = block?.querySelector<HTMLElement>('.stashbase-math-block-source'); // dom-contract: collapsed source remains mounted to preserve CodeMirror and undo state.
  if (!block || !source) throw new Error('Formula block did not mount.');
  expect(source.hidden).toBe(true);
  expect(preview.querySelector('.katex')).not.toBeNull(); // dom-contract: the default view contains the rendered formula.
  const ordinary = screen
    .getByText('console.log("ordinary");')
    .closest<HTMLElement>('.milkdown-code-block'); // dom-contract: non-math fences retain the existing visible code view.
  expect(ordinary).not.toBeNull();
  expect(ordinary?.closest('.stashbase-math-block')).toBeNull(); // dom-contract: only math receives collapsed-source behavior.

  fireEvent.click(preview);
  await screen.findByRole('button', { name: 'Done editing formula' });
  expect(source.hidden).toBe(false);
  rendered.rerender(document(true));
  expect(source.hidden).toBe(true);
  expect(screen.queryByRole('button', { name: 'Edit formula' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Done editing formula' })).toBeNull();
  fireEvent.click(preview);
  expect(source.hidden).toBe(true);
  rendered.rerender(document(false));
  expect(screen.getByRole('button', { name: 'Edit formula' })).toBe(preview);
  expect(source.hidden).toBe(true);
  expect(screen.getByText('console.log("ordinary");').closest('.milkdown-code-block')).toBe(
    ordinary,
  ); // dom-contract: mode changes retain the existing ordinary code view.
  await act(settleMarkdownListener);
  expect(onChange).not.toHaveBeenCalled();

  fireEvent.click(preview);
  const host = source.querySelector<HTMLElement>('.cm-editor'); // dom-contract: formula editing reuses the installed CodeMirror source editor.
  const editor = host && EditorView.findFromDOM(host);
  if (!editor) throw new Error('Formula source editor did not mount.');
  act(() => {
    editor.focus();
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'x^2' } });
  });
  await act(settleMarkdownListener);
  expect(onChange).toHaveBeenLastCalledWith(value.replace(formula, 'x^2'));
  fireEvent.click(screen.getByRole('button', { name: 'Done editing formula' }));
  expect(source.hidden).toBe(true);
  fireEvent.keyDown(preview, { key: 'z', code: 'KeyZ', ctrlKey: true });
  await act(settleMarkdownListener);
  expect(onChange).toHaveBeenLastCalledWith(value);
  fireEvent.keyDown(preview, { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true });
  await act(settleMarkdownListener);
  expect(onChange).toHaveBeenLastCalledWith(value.replace(formula, 'x^2'));
  rendered.rerender(document(true));
  rendered.rerender(document(false));
  fireEvent.click(screen.getByRole('button', { name: 'Edit formula' }));
  fireEvent.keyDown(editor.contentDOM, { key: 'z', code: 'KeyZ', ctrlKey: true });
  await act(settleMarkdownListener);
  expect(onChange).toHaveBeenLastCalledWith(value);
  expect(editor.state.doc.toString()).toBe(formula);
  fireEvent.keyDown(editor.contentDOM, { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true });
  await act(settleMarkdownListener);
  expect(onChange).toHaveBeenLastCalledWith(value.replace(formula, 'x^2'));
});
