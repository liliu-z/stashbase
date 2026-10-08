/**
 * Math in the Markdown surface, proven against the real Milkdown build: only
 * two dollars open math, so prices survive both rendering and saving.
 */
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { codeMirror } from '@milkdown/crepe/feature/code-mirror';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { math } from './math';

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
  return { host, markdown: () => editor.getMarkdown() };
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
