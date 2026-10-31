/**
 * Math in the Markdown surface, proven against the real Milkdown build: only
 * two dollars open math, so prices survive both rendering and saving.
 */
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { codeMirror } from '@milkdown/crepe/feature/code-mirror';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { math, setDollarMathMode } from './math';

const live: CrepeBuilder[] = [];

afterEach(async () => {
  for (const editor of live.splice(0)) await editor.destroy();
});

async function open(source: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new CrepeBuilder({ root: host, defaultValue: source })
    .addFeature(codeMirror)
    .addFeature(math);
  live.push(editor);
  await editor.create();
  return { host, editor, markdown: () => editor.getMarkdown() };
}

describe('math', () => {
  it('leaves single dollars as text, on screen and on save', async () => {
    const source =
      'Reads cost $0.005 each: about $0.10–$0.50 per run ($2.50 at most), users $0.01.\n';
    const { host, markdown } = await open(source);

    expect(host.querySelector('[data-type="math_inline"]')).toBeNull(); // dom-contract: currency stays prose, without math schema nodes.
    expect(host.textContent).toContain('about $0.10–$0.50 per run ($2.50 at most)');
    expect(markdown()).toBe(source);
  });

  it('renders inline math opened by two dollars and saves it unchanged', async () => {
    const source = 'Energy is $$E=mc^2$$ here.\n';
    const { host, markdown } = await open(source);

    // dom-contract: the schema value and KaTeX child prove a formula was rendered.
    const formula = host.querySelector<HTMLElement>('[data-type="math_inline"]');
    expect(formula?.dataset.value).toBe('E=mc^2');
    expect(formula?.querySelector('.katex')).not.toBeNull(); // dom-contract: KaTeX's child proves the formula rendered.
    expect(markdown()).toBe(source);
  });

  it('keeps a $$ block as $$ and a ```latex fence as a fence', async () => {
    const source = '$$\na^2 + b^2 = c^2\n$$\n\n```latex\n\\frac{1}{2}\n```\n';
    const { markdown } = await open(source);

    expect(markdown()).toBe(source);
  });
});

describe('dollar math mode', () => {
  it('leaves $…$ as text until the project switches it on', async () => {
    const source = 'Energy is $x^2$ here.\n';
    const { host, markdown } = await open(source);

    expect(host.querySelector('[data-type="math_dollar_inline"]')).toBeNull(); // dom-contract: off renders prose.
    expect(host.textContent).toContain('$x^2$');
    expect(markdown()).toBe(source);
  });

  it('draws the formula from $…$ once on, without rewriting the document', async () => {
    const source = 'Energy is $x^2$ here.\n';
    const { host, editor, markdown } = await open(source);

    setDollarMathMode(editor, true);

    // dom-contract: the decoration renders KaTeX in place of the source, and
    // the schema's math_inline node is never created, so nothing is saved.
    const formula = host.querySelector<HTMLElement>('[data-type="math_dollar_inline"]'); // dom-contract: the published data attribute is the app's own contract
    expect(formula?.dataset.value).toBe('x^2');
    expect(formula?.querySelector('.katex')).not.toBeNull(); // dom-contract: KaTeX's own class proves the formula rendered
    expect(host.querySelector('[data-type="math_inline"]')).toBeNull(); // dom-contract: the schema node is never created
    expect(markdown()).toBe(source); // the meta-only transaction leaves the file byte-identical.
  });

  it('keeps prices and inline code as prose even when on', async () => {
    const source = 'Runs cost $0.10–$0.50, and `$x^2$` stays code.\n';
    const { host, editor, markdown } = await open(source);

    setDollarMathMode(editor, true);

    expect(host.querySelectorAll('[data-type="math_dollar_inline"]').length).toBe(0); // dom-contract: the published data attribute names a rendered formula, and none appears
    expect(host.textContent).toContain('$0.10–$0.50');
    expect(markdown()).toBe(source);
  });
});
