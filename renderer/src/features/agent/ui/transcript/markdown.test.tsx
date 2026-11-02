import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { AgentMarkdown } from './markdown';

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  cleanup();
});

function copySelection(container: HTMLElement, range: Range): string {
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  const setData = vi.fn();
  const root = container.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error('Expected Markdown container.');
  fireEvent.copy(root, { clipboardData: { setData } });
  expect(setData).toHaveBeenCalledOnce();
  expect(setData.mock.calls[0]?.[0]).toBe('text/plain');
  return setData.mock.calls[0]?.[1] as string;
}

describe('Agent Markdown', () => {
  it('renders structured GFM instead of exposing source punctuation', () => {
    render(
      <AgentMarkdown
        markdown={'**Useful**\n\n- First\n- Second\n\n[OpenAI](https://openai.com)'}
      />,
    );

    expect(screen.getByText('Useful').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    const link = screen.getByRole('link', { name: 'OpenAI' });
    expect(link.getAttribute('href')).toBe('https://openai.com');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('keeps unsafe links and remote images inert', () => {
    const { container } = render(
      <AgentMarkdown
        markdown={'[Run](javascript:alert(1))\n\n![tracking](https://example.com/pixel.png)'}
      />,
    );

    expect(screen.queryByRole('link', { name: 'Run' })).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.textContent).toContain('Run');
  });

  it('routes external links through the owning desktop capability', async () => {
    const onOpenExternal = vi.fn();
    render(
      <AgentMarkdown
        markdown="[OpenAI](https://openai.com/codex/)"
        onOpenExternal={onOpenExternal}
      />,
    );

    await userEvent.click(screen.getByRole('link', { name: 'OpenAI' }));
    expect(onOpenExternal).toHaveBeenCalledWith('https://openai.com/codex/');
  });
  it('renders math without enabling trusted HTML or external resource commands', () => {
    const { container } = render(
      <AgentMarkdown
        markdown={String.raw`Inline $$x^2$$.

$$
\frac{1}{2}
$$

$$\href{javascript:alert(1)}{unsafe}$$`}
      />,
    );
    expect(container.querySelectorAll('math')).toHaveLength(3); // dom-contract: KaTeX's accessible MathML output
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).not.toContain('$$');
  });

  it('renders LaTeX bracket delimiters as math and leaves code as written', () => {
    const { container } = render(
      <AgentMarkdown
        markdown={String.raw`The core formula:

\[
\operatorname{softmax}\!\left(\frac{QK^\top}{\sqrt{d_k}}\right)V
\]

- **\(QK^\top\)**: scores, then rows \[a \\[2pt] b\] stacked.
  \[ Q=XW_Q \]

Keep ${'`\\(x\\)`'} as code.`}
      />,
    );

    expect(container.querySelectorAll('.katex-display')).toHaveLength(3); // dom-contract: KaTeX's display-mode wrapper
    expect(container.querySelectorAll('math')).toHaveLength(4); // dom-contract: KaTeX's accessible MathML output
    expect(screen.getByText(String.raw`\(x\)`).tagName).toBe('CODE');
    expect(container.textContent).not.toContain('$$');
  });

  it('copies a fenced draft without the reply around it', async () => {
    const post = 'Shipping today.\n\nTwo lines, kept as written.';
    // user-event installs its own clipboard stub over navigator, so the copy
    // is read back from there rather than from a spy it would have replaced.
    const user = userEvent.setup();
    render(
      <AgentMarkdown markdown={`Here is the post:\n\n\`\`\`\n${post}\n\`\`\`\n\nWant edits?`} />,
    );

    await user.click(screen.getByRole('button', { name: 'Copy block' }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(post));
    expect(await screen.findByRole('button', { name: 'Copied' })).not.toBeNull();
  });

  it('keeps prices as written instead of reading them as math', () => {
    const { container } = render(
      <AgentMarkdown markdown="Sync costs $4 per month billed annually or $5 billed monthly." />,
    );

    expect(container.querySelectorAll('math')).toHaveLength(0); // dom-contract: KaTeX renders no MathML for plain prose
    expect(container.textContent).toContain('$4 per month billed annually or $5');
  });

  it('updates existing formulas when math mode changes, keeping escaped and unpaired dollars literal', () => {
    const markdown = String.raw`Square $x^2$ costs \$10 or \$20. Unpaired $.`;
    const { container, rerender } = render(<AgentMarkdown markdown={markdown} />);
    expect(container.querySelectorAll('math')).toHaveLength(0); // dom-contract: KaTeX's accessible MathML output
    rerender(<AgentMarkdown mathMode markdown={markdown} />);
    expect(container.querySelectorAll('math')).toHaveLength(1); // dom-contract: KaTeX's accessible MathML output
    expect(container.textContent).toContain('$10 or $20. Unpaired $.');
    rerender(<AgentMarkdown markdown={markdown} />);
    expect(container.querySelectorAll('math')).toHaveLength(0); // dom-contract: KaTeX's accessible MathML output
    expect(container.textContent).toContain('$x^2$');
  });

  it.each([false, true])('keeps inline and fenced code literal (Math %s)', (mathMode) => {
    const code = String.raw`\(x^2\) \[x^2\] $x^2$ \$10`;
    const markdown = `Outside \\(x^2\\).\n\n\`${code}\`\n\n~~~text\n${code}\n~~~\n\n\`\`\`js\n${code}\n\`\`\``;
    const { container } = render(<AgentMarkdown mathMode={mathMode} markdown={markdown} />);
    expect(container.querySelectorAll('math')).toHaveLength(1); // dom-contract: KaTeX's accessible MathML output
    expect(screen.getAllByText(code).map((node) => node.textContent?.trim())).toEqual([
      code,
      code,
      code,
    ]);
  });

  it.each([false, true])('copies selected math with its original syntax (Math %s)', (mathMode) => {
    const formulas = [
      String.raw`\(x^2\)`,
      String.raw`$$\frac{1}{2}$$`,
      '$$\n\\begin{matrix}a & b \\\\ c & d\\end{matrix}\n$$',
      '\\[\n\\frac{1}{2}\n\\]',
      '```latex\n\\frac{1}{2}\n```',
      ...(mathMode ? ['$x^2$'] : []),
    ];
    for (const markdown of formulas) {
      const rendered = render(
        <AgentMarkdown mathMode={mathMode} markdown={`Before.\n\n${markdown}\n\nAfter.`} />,
      );
      const formula = rendered.container.querySelector('.katex-html'); // dom-contract: a drag selects KaTeX's visual glyphs inside its source wrapper
      if (!formula) throw new Error(`Expected a rendered formula for ${markdown}.`);
      // A normal drag starts and ends in the formula's glyphs, inside the
      // KaTeX wrapper. The source must survive without selecting that wrapper.
      const range = document.createRange();
      range.selectNodeContents(formula);
      const copied = copySelection(rendered.container, range);
      expect(copied).toBe(markdown);
      rendered.unmount();
    }
  });

  it('copies selected prose and math without flattening paragraphs, lists, or dollar escapes', () => {
    const markdown = String.raw`Price \$10 to \$20; formula $x^2$.

- First $$\frac{1}{2}$$.
- **Second** item.

$$
\begin{matrix}a & b \\ c & d\end{matrix}
$$`;
    const rendered = render(<AgentMarkdown mathMode markdown={markdown} />);
    const root = rendered.container.firstElementChild;
    if (!root) throw new Error('Expected Markdown container.');
    const range = document.createRange();
    range.selectNodeContents(root);
    const copied = copySelection(rendered.container, range);
    expect(copied).toBe(markdown);
  });

  it('keeps partial prose selection exact around a formula and escaped dollars', () => {
    const markdown = String.raw`Before \$10 &amp; $x^2$ then \$20 after.`;
    const { container } = render(<AgentMarkdown mathMode markdown={markdown} />);
    const first = screen.getByText(/^Before/u).firstChild;
    const last = screen.getByText(/ after\.$/u).firstChild;
    if (!first || !last) throw new Error('Expected prose around the formula.');
    const range = document.createRange();
    range.setStart(first, 'Before '.length);
    range.setEnd(last, (last.textContent ?? '').indexOf(' after.'));
    expect(copySelection(container, range)).toBe(String.raw`\$10 &amp; $x^2$ then \$20`);
  });

  it.each([
    '- First\n  continued $x$ tail',
    '> First\n> continued $x$ tail',
    '> - First\n>   continued $x$ tail',
  ])('maps selections across stripped continuation prefixes: %s', (markdown) => {
    const { container } = render(<AgentMarkdown mathMode markdown={markdown} />);
    const first = screen.getByText(/^First/u).firstChild;
    const last = screen.getByText('tail').firstChild;
    if (!first || !last) throw new Error('Expected prose around the formula.');
    const range = document.createRange();
    range.setStart(first, (first.textContent ?? '').indexOf('continued') + 2);
    range.setEnd(last, (last.textContent ?? '').length);
    expect(copySelection(container, range)).toBe('ntinued $x$ tail');
    const root = container.firstElementChild;
    if (!root) throw new Error('Expected Markdown container.');
    range.selectNodeContents(root);
    expect(copySelection(container, range)).toBe(markdown);
  });

  it('keeps invalid formula source available when copying its visible error', () => {
    const markdown = String.raw`$\frac{1}{$`;
    const { container } = render(<AgentMarkdown mathMode markdown={markdown} />);
    const formula = container.querySelector('.katex-error'); // dom-contract: KaTeX exposes malformed formulas as source text
    if (!formula) throw new Error('Expected formula error.');
    const range = document.createRange();
    range.selectNodeContents(formula);
    expect(copySelection(container, range)).toBe(markdown);
  });

  it('opens only project-resolved file references and keeps refused paths inert', async () => {
    const source = { folderPath: '/project', path: 'draft notes.md' };
    const sourceFor = vi.fn((path: string) => (path === 'draft notes.md' ? source : null));
    const onOpenSource = vi.fn();
    render(
      <AgentMarkdown
        markdown="[Draft](draft%20notes.md) [Outside](../secret.md) [Protocol](file:///private/note.md)"
        sourceFor={sourceFor}
        onOpenSource={onOpenSource}
      />,
    );
    await userEvent.click(screen.getByRole('link', { name: 'Draft' }));
    expect(onOpenSource).toHaveBeenCalledWith(source, null);
    expect(screen.queryByRole('link', { name: 'Outside' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Protocol' })).toBeNull();
  });

  it('opens a cited passage with its phrase, and a malformed fragment without one', async () => {
    const source = { folderPath: '/project', path: 'notes/draft.md' };
    const onOpenSource = vi.fn();
    render(
      <AgentMarkdown
        markdown={
          '[the claim](notes/draft.md#:~:text=rising%20tides%2C%20slowly) ' +
          '[broken](notes/draft.md#:~:text=%E0%A4%A)'
        }
        sourceFor={(path) => (path === 'notes/draft.md' ? source : null)}
        onOpenSource={onOpenSource}
      />,
    );

    const cited = screen.getByRole('link', { name: 'the claim' });
    expect(cited.getAttribute('href')).toBe('notes/draft.md#:~:text=rising%20tides%2C%20slowly');
    expect(cited.getAttribute('title')).toContain('rising tides, slowly');
    await userEvent.click(cited);
    expect(onOpenSource).toHaveBeenLastCalledWith(source, 'rising tides, slowly');

    await userEvent.click(screen.getByRole('link', { name: 'broken' }));
    expect(onOpenSource).toHaveBeenLastCalledWith(source, null);
  });
});
