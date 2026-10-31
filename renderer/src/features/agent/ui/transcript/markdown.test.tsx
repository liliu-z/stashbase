import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { AgentMarkdown } from './markdown';

afterEach(cleanup);

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

    expect(container.querySelectorAll('.katex-display')).toHaveLength(2); // dom-contract: KaTeX's display-mode wrapper
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

  it('renders paired single-dollar formulas only while Math mode is on', () => {
    const { container, rerender } = render(<AgentMarkdown markdown="Area: $x^2$." />);

    expect(container.querySelectorAll('math')).toHaveLength(0);
    expect(container.textContent).toContain('$x^2$');

    rerender(<AgentMarkdown mathMode markdown="Area: $x^2$." />);
    expect(container.querySelectorAll('math')).toHaveLength(1);
    expect(container.textContent).not.toContain('$x^2$');
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
