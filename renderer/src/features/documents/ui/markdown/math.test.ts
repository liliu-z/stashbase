/**
 * Source-backed math against the real Milkdown parser, live editor and save
 * boundary, including the text a reader edits around formulas.
 */
import { EditorView as CodeMirror } from '@codemirror/view';
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { codeMirror } from '@milkdown/crepe/feature/code-mirror';
import { editorViewCtx } from '@milkdown/kit/core';
import { joinBackward } from '@milkdown/kit/prose/commands';
import { redo, undo } from '@milkdown/kit/prose/history';
import { TextSelection } from '@milkdown/kit/prose/state';
import { within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { watchMarkdownChanges } from './changes';
import { math } from './math';

const live: CrepeBuilder[] = [];

function visibleText(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.stashbase-math-source').forEach((syntax) => syntax.remove()); // dom-contract: the editor hides raw syntax with this decoration class.
  return copy.textContent ?? '';
}

afterEach(async () => {
  for (const editor of live.splice(0)) await editor.destroy();
});

async function open(source: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new CrepeBuilder({ root: host, defaultValue: source })
    .addFeature(codeMirror)
    .addFeature(math);
  const saved: string[] = [];
  const changes = watchMarkdownChanges(editor, {
    accepts: () => true,
    report: (value) => saved.push(value),
  });
  live.push(editor);
  await editor.create();
  changes.rebase(source);
  const view = editor.editor.action((context) => context.get(editorViewCtx));
  return { editor, host, view, changes, saved, markdown: () => editor.getMarkdown() };
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

  it.each(['open', 'type'] as const)(
    'reads only a tight single-dollar formula beside prices (%s)',
    async (entry) => {
      const source = 'Costs $5, or $50-$100, and $x^2$ is a formula; $ y $ is not.';
      const { host, view, markdown } = await open(entry === 'open' ? `${source}\n` : '');
      if (entry === 'type')
        for (const character of source) {
          const { from, to } = view.state.selection;
          const handled = view.someProp('handleTextInput', (handler) =>
            handler(view, from, to, character, () => view.state.tr.insertText(character, from, to)),
          );
          if (!handled) view.dispatch(view.state.tr.insertText(character));
        }
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
      const formulas = [...host.querySelectorAll<HTMLElement>('[data-type="math_inline"]')]; // dom-contract: the published formula decoration exposes the source rendered by KaTeX.
      expect(formulas.map((formula) => formula.dataset.value)).toEqual(['x^2']);
      expect(visibleText(host)).toContain('Costs $5, or $50-$100, and');
      expect(markdown()).toBe(`${source}\n`);
    },
  );

  it.each(['open', 'type'] as const)(
    'keeps a misread formula as text from the caret, one or all at once (%s)',
    async (entry) => {
      const source = 'Pay $a$ or $b$.';
      const { host, view, markdown } = await open(entry === 'open' ? `${source}\n` : '');
      if (entry === 'type')
        for (const character of source) {
          const { from, to } = view.state.selection;
          const handled = view.someProp('handleTextInput', (handler) =>
            handler(view, from, to, character, () => view.state.tr.insertText(character, from, to)),
          );
          if (!handled) view.dispatch(view.state.tr.insertText(character));
        }
      view.focus();
      const offer = () => host.querySelector<HTMLElement>('[role="toolbar"][aria-label="Formula"]');
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
      expect(offer()?.dataset.show).toBe('false');

      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7)));
      expect(offer()?.dataset.show).toBe('true');
      const button = (name: string) => {
        const found = within(offer() ?? host).getByRole('button', { name });
        found.click();
      };
      button('Show as text');
      expect(markdown()).toBe('Pay \\$a\\$ or $b$.\n');
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
      const shown = () =>
        [...host.querySelectorAll<HTMLElement>('[data-type="math_inline"]')].map(
          // dom-contract: the published formula decoration exposes the source rendered by KaTeX.
          (formula) => formula.dataset.value,
        );
      expect(shown()).toEqual(['b']);
      expect(visibleText(host)).toContain('Pay $a$ or');
      expect(undo(view.state, view.dispatch)).toBe(true);
      expect(markdown()).toBe(`${source}\n`);

      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7)));
      button('Show all as text (2)');
      expect(markdown()).toBe('Pay \\$a\\$ or \\$b\\$.\n');
      expect(offer()?.dataset.show).toBe('false');
      expect(undo(view.state, view.dispatch)).toBe(true);
      expect(markdown()).toBe(`${source}\n`);
    },
  );

  it('renders inline math opened by two dollars and saves it unchanged', async () => {
    const source = 'Energy is $$E=mc^2$$ here.\n';
    const { host, markdown } = await open(source);

    // dom-contract: the schema value and KaTeX child prove a formula was rendered.
    const formula = host.querySelector<HTMLElement>('[data-type="math_inline"]'); // dom-contract: the published formula decoration exposes the source rendered by KaTeX.
    expect(formula?.dataset.value).toBe('E=mc^2');
    expect(formula?.querySelector('.katex')).not.toBeNull(); // dom-contract: KaTeX's child proves the formula rendered.
    expect(markdown()).toBe(source);
  });

  it('renders a tight single-dollar formula beside escaped dollar amounts', async () => {
    const source = 'Energy is $E=mc^2$ here, while \\$10 stays a dollar amount.\n';
    const { host, markdown } = await open(source);

    const formula = host.querySelector<HTMLElement>('[data-type="math_inline"]'); // dom-contract: the published formula decoration exposes the source rendered by KaTeX.
    expect(formula?.dataset.value).toBe('E=mc^2');
    expect(host.textContent).toContain('$10 stays a dollar amount');
    expect(markdown()).toBe(source);
  });

  it('renders LaTeX bracket delimiters outside code', async () => {
    const source = 'Inline \\(x^2\\).\n\n\\[\n\\frac{1}{2}\n\\]\n\nKeep `\\(x\\)` as code.\n';
    const { host, markdown } = await open(source);

    expect(host.querySelector<HTMLElement>('[data-type="math_inline"]')?.dataset.value).toBe('x^2'); // dom-contract: the published formula decoration exposes the source rendered by KaTeX.
    expect(host.textContent).toContain(String.raw`\(x\)`);
    expect(markdown()).toContain('$$');
  });

  it('keeps a $$ block as $$ and a ```latex fence as a fence', async () => {
    const source = '$$\na^2 + b^2 = c^2\n$$\n\n```latex\n\\frac{1}{2}\n```\n';
    const { markdown } = await open(source);

    expect(markdown()).toBe(source);
  });

  it('reopens an externally updated formula for native input after reading mode', async () => {
    const source = 'Before.\n\n$$\nx^2\n$$\n\nAfter.\n';
    const { editor, view, host, markdown } = await open(source);
    const preview = host.querySelector<HTMLElement>('[aria-label="Edit formula"]');
    preview?.click();
    const element = host.querySelector<HTMLElement>('.cm-editor'); // dom-contract: formula input remains the native CodeMirror editor.
    const input = element && CodeMirror.findFromDOM(element);
    if (!input || !preview) throw new Error('Formula source editor did not mount.');
    editor.setReadonly(true);
    const at = (view.state.doc.firstChild?.nodeSize ?? 0) + 1;
    view.dispatch(view.state.tr.insertText('y', at, at + 1));
    expect(input.state.readOnly).toBe(true);
    editor.setReadonly(false);
    expect(input.state.readOnly).toBe(false);
    preview.click();
    input.focus();
    input.dispatch({ selection: { anchor: input.state.doc.length } });
    // Native key handling respects readonly; direct replacement would bypass it.
    input.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', bubbles: true }),
    );
    expect(input.state.doc.toString()).toBe('y^');
    expect(markdown()).toBe(source.replace('x^2', 'y^'));
  });

  it.each([
    String.raw`Formula $\{x\}$ and $a*b*c$ here.`,
    String.raw`Matrix $\begin{pmatrix}a & b \\ c & d\end{pmatrix}$ here.`,
    String.raw`Price \$10 and \$20; \*note\*.`,
    String.raw`Bracket \(\{x\} + a*b*c\) here.`,
  ])('preserves formula meaning and escaping after editing %s', async (body) => {
    const source = `${body}\n`;
    const { host, view, changes, saved } = await open(source);
    expect(host.querySelector('.katex-error')).toBeNull(); // dom-contract: these supported formulas remain valid TeX.
    view.dispatch(view.state.tr.insertText('New: ', 1));
    changes.flush();
    expect(saved.at(-1)).toBe(`New: ${source}`);
    const reopened = await open(saved.at(-1) ?? '');
    expect(reopened.host.querySelector('.katex-error')).toBeNull(); // dom-contract: saved text renders the same supported formulas.
    expect(reopened.markdown()).toBe(`New: ${source}`);
  });

  it('keeps literal-dollar escaping beside entities and bracket formulas', async () => {
    const source = String.raw`Inline \(x\), literal \*star\* &amp; tax \$10 and \$20.` + '\n';
    const { host, view, changes, saved } = await open(source);
    expect(visibleText(host)).toContain(', literal *star* & tax');
    expect(host.querySelectorAll('[data-type="math_inline"]')).toHaveLength(1); // dom-contract: dollars remain prose.
    view.dispatch(view.state.tr.insertText('New: ', 1));
    changes.flush();
    expect(saved.at(-1)).toBe('New: ' + source);
  });

  it('keeps every untouched source block when another paragraph changes', async () => {
    const source =
      'Title\n=====\n\n' +
      String.raw`Untouched \(x\) and \$10.` +
      '\n\n' +
      String.raw`\[\frac{1}{2}\]` +
      '\n\nSecond paragraph.\n';
    const { view, changes, saved } = await open(source);
    let position = 1;
    for (let index = 0; index < 3; index += 1) position += view.state.doc.child(index).nodeSize;
    view.dispatch(view.state.tr.insertText('New: ', position));
    changes.flush();
    expect(saved.at(-1)).toBe(source.replace('Second paragraph.', 'New: Second paragraph.'));
  });

  it.each(['type', 'paste'] as const)(
    'preserves newly %s source through save, reopen and undo',
    async (entry) => {
      const source = String.raw`Product $a*b*c$, subscript $x_i + y_j$, set $\{x\}$, matrix $\begin{pmatrix}a & b \\ c & d\end{pmatrix}$, and \$10.`;
      const { view, changes, saved, markdown } = await open('');
      if (entry === 'paste') view.pasteText(source);
      else
        for (const character of source) {
          const { from, to } = view.state.selection;
          const handled = view.someProp('handleTextInput', (handler) =>
            handler(view, from, to, character, () => view.state.tr.insertText(character, from, to)),
          );
          if (!handled) view.dispatch(view.state.tr.insertText(character));
        }
      changes.flush();
      expect(saved.at(-1)).toBe(source + '\n');
      const reopened = await open(saved.at(-1) ?? '');
      expect(reopened.markdown()).toBe(source + '\n');
      expect(undo(view.state, view.dispatch)).toBe(true);
      expect(markdown()).toBe('');
      expect(redo(view.state, view.dispatch)).toBe(true);
      expect(markdown()).toBe(source + '\n');
    },
  );

  it('lets the reader correct a displayed formula and edit ordinary prices', async () => {
    const { host, view, markdown } = await open('Formula $x$ here.\n');
    const formula = host.querySelector<HTMLElement>('[data-type="math_inline"]'); // dom-contract: the published formula decoration exposes the source rendered by KaTeX.
    formula?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(host.querySelector('[data-type="math_inline"]')).toBeNull(); // dom-contract: the formula exposes editable source after a click.
    view.dispatch(view.state.tr.insertText('y', 10, 11));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    expect(markdown()).toBe('Formula $y$ here.\n');
    expect(host.querySelector<HTMLElement>('[data-type="math_inline"]')?.dataset.value).toBe('y'); // dom-contract: the published formula decoration exposes the source rendered by KaTeX.

    const price = await open('Cost $10 and $20.\n');
    price.view.dispatch(price.view.state.tr.insertText('1', 8, 9));
    expect(price.markdown()).toBe('Cost $11 and $20.\n');
  });

  it('keeps all inline code and non-math fences literal', async () => {
    const source =
      'Formula \\(y\\), keep `' +
      String.raw`$x$ \(x\) \[x\]` +
      '` code.\n\n~~~text\n' +
      String.raw`$x$ \(x\) \[x\]` +
      '\n~~~\n\n    ' +
      String.raw`\(x\)` +
      '\n';
    const { host } = await open(source);
    expect(host.querySelectorAll('[data-type="math_inline"]')).toHaveLength(1); // dom-contract: only the formula outside code receives a decoration.
    expect(host.textContent).toContain(String.raw`$x$ \(x\) \[x\]`);
  });

  it('keeps escaped literal delimiters literal after an unrelated edit', async () => {
    const source = String.raw`Literal \\(x\\) and &#36;x&#36;. Other prose.` + '\n';
    const { host, view, changes, saved } = await open(source);
    expect(host.querySelector('[data-type="math_inline"]')).toBeNull(); // dom-contract: decoded escapes/entities are not formulas.
    view.dispatch(view.state.tr.insertText('New: ', 1));
    changes.flush();
    expect(host.querySelector('[data-type="math_inline"]')).toBeNull(); // dom-contract: an unrelated edit does not reinterpret literals.
    const reopened = await open(saved.at(-1) ?? '');
    expect(reopened.host.querySelector('[data-type="math_inline"]')).toBeNull(); // dom-contract: saving does not turn literals into formulas.
  });

  it('restores repaired math and keeps subsequent source edits consistent on reopen', async () => {
    const { view, host, markdown } = await open('$x$\n');
    view.dispatch(view.state.tr.delete(3, 4));
    expect(host.querySelector('[data-type="math_inline"]')).toBeNull(); // dom-contract: unfinished formula stays editable text.
    view.dispatch(view.state.tr.insertText('$', 3));
    expect(host.querySelector<HTMLElement>('[data-type="math_inline"]')?.dataset.value).toBe('x'); // dom-contract: the published formula decoration exposes the source rendered by KaTeX.
    view.dispatch(view.state.tr.delete(3, 4).delete(1, 2));
    view.dispatch(view.state.tr.insertText('*y*', 2));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    expect(host.querySelector('em')?.textContent).toBe('y'); // dom-contract: ordinary Markdown formatting is represented by semantic inline tags.
    const reopened = await open(markdown());
    expect(reopened.host.querySelector('em')?.textContent).toBe('y'); // dom-contract: ordinary Markdown formatting is represented by semantic inline tags.
    expect(visibleText(host)).toBe(visibleText(reopened.host));
  });

  it('uses toolbar formatting in the same formula before and after reopening', async () => {
    const { view, host, markdown } = await open('$x+1$\n');
    const strong = view.state.schema.marks.strong;
    if (!strong) throw new Error('Missing strong mark');
    view.dispatch(view.state.tr.addMark(2, 3, strong.create()));
    const before = host.querySelector<HTMLElement>('[data-type="math_inline"]')?.dataset.value; // dom-contract: the published formula decoration exposes the source rendered by KaTeX.
    const reopened = await open(markdown());
    expect(
      reopened.host.querySelector<HTMLElement>('[data-type="math_inline"]')?.dataset.value, // dom-contract: the published formula decoration exposes the source rendered by KaTeX.
    ).toBe(before);
    expect(before).toContain('**x**');
  });
  it('keeps ordinary inline Markdown and references editable beside dollar amounts', async () => {
    const source =
      'Cost $10 **per item or $20 per pack**, [guide][id], `code $x$` and \\$30.\n\n[id]: guide.md "Guide"\n';
    const { host, view, changes, saved } = await open(source);
    expect(host.querySelector('strong')?.textContent).toBe('per item or $20 per pack'); // dom-contract: ordinary Markdown formatting is represented by semantic inline tags.
    expect(host.querySelector('a')?.getAttribute('href')).toBe('guide.md'); // dom-contract: Milkdown anchors carry the saved link target.
    expect(host.querySelector('code')?.textContent).toBe('code $x$'); // dom-contract: inline-code DOM must contain literal source.
    expect(visibleText(host)).toContain('$30.');
    view.dispatch(view.state.tr.insertText('New: ', 1));
    changes.flush();
    expect(saved.at(-1)).toBe('New: ' + source);
    const reopened = await open(saved.at(-1) ?? '');
    expect(reopened.host.querySelector('strong')?.textContent).toBe('per item or $20 per pack'); // dom-contract: ordinary Markdown formatting is represented by semantic inline tags.
    expect(reopened.host.querySelector('a')?.getAttribute('href')).toBe('guide.md'); // dom-contract: Milkdown anchors carry the saved link target.
  });

  it('keeps container structure when editing multiline source in quotes, lists and headings', async () => {
    const source =
      '# Price $10 **heading** or $20\n\n> - Cost $10 **per\n>   item or $20 per pack**.\n';
    const { host, view, changes, saved } = await open(source);
    expect(host.querySelector('h1 strong')?.textContent).toBe('heading'); // dom-contract: ordinary Markdown formatting is represented by semantic inline tags.
    expect(
      Array.from(
        host.querySelectorAll('blockquote li strong'), // dom-contract: ordinary Markdown formatting is represented by semantic inline tags.
        (element) => element.textContent,
      ).join(''),
    ).toBe('per\nitem or $20 per pack');
    let at = 0;
    view.state.doc.descendants((node, position) => {
      if (node.isTextblock && node.textContent.startsWith('Cost ')) at = position + 1;
    });
    view.dispatch(view.state.tr.insertText('New: ', at));
    changes.flush();
    const value = saved.at(-1) ?? '';
    expect(value).toContain('> * New: Cost $10 **per\n>   item or $20 per pack**.');
    expect(value).not.toContain('>   >');
    const reopened = await open(value);
    expect(visibleText(reopened.host)).toBe(visibleText(host));
    expect(reopened.host.querySelectorAll('blockquote li')).toHaveLength(1); // dom-contract: native blockquote/list elements preserve the Markdown container structure.
  });

  it('keeps formula positions and source when native inline nodes are inserted', async () => {
    const { host, view, markdown } = await open('Price $10 and $20. Formula \\(x\\).\n');
    const image = view.state.schema.nodes.image;
    const hardbreak = view.state.schema.nodes.hardbreak;
    if (!image || !hardbreak) throw new Error('Missing inline schemas');
    view.dispatch(
      view.state.tr.insert(7, image.create({ src: 'figure.png', alt: 'Figure', title: '' })),
    );
    view.dispatch(view.state.tr.insert(7, hardbreak.create()));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    expect(host.querySelector<HTMLElement>('[data-type="math_inline"]')?.dataset.value).toBe('x'); // dom-contract: the published formula decoration exposes the source rendered by KaTeX.
    expect(host.querySelector('img')?.getAttribute('src')).toBe('figure.png'); // dom-contract: the existing image schema exposes its source on the rendered image.
    const reopened = await open(markdown());
    expect(
      reopened.host.querySelector<HTMLElement>('[data-type="math_inline"]')?.dataset.value, // dom-contract: the published formula decoration exposes the source rendered by KaTeX.
    ).toBe('x');
    expect(reopened.host.querySelector('img')?.getAttribute('src')).toBe('figure.png'); // dom-contract: the existing image schema exposes its source on the rendered image.
  });
  it('preserves ordinary formatting typed across currency delimiters', async () => {
    const source = 'Cost $10 **per item or $20 per pack**.';
    const { host, view, markdown } = await open('');
    for (const character of source) {
      const { from, to } = view.state.selection;
      const handled = view.someProp('handleTextInput', (handler) =>
        handler(view, from, to, character, () => view.state.tr.insertText(character, from, to)),
      );
      if (!handled) view.dispatch(view.state.tr.insertText(character));
    }
    expect(host.querySelector('strong')?.textContent).toBe('per item or $20 per pack'); // dom-contract: ordinary Markdown formatting is represented by semantic inline tags.
    expect(markdown()).toBe(source + '\n');
    const reopened = await open(markdown());
    expect(reopened.host.querySelector('strong')?.textContent).toBe('per item or $20 per pack'); // dom-contract: ordinary Markdown formatting is represented by semantic inline tags.
  });

  it('exports Shift+Enter in protected prose with the ordinary hard-break semantics', async () => {
    for (const source of ['Ordinary text. Tail.\n', 'Cost $10 and $20. Tail.\n']) {
      const { host, view, markdown } = await open(source);
      const position = view.state.doc.textContent.indexOf('Tail') + 1;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position)));
      const key = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey: true });
      expect(view.someProp('handleKeyDown', (handler) => handler(view, key))).toBe(true);
      expect(markdown()).toBe(source.replace('Tail', '\\\nTail'));
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
      expect(host.querySelector('br[data-is-inline="false"]')).not.toBeNull(); // dom-contract: Milkdown distinguishes explicit hard breaks with this schema attribute.
      const reopened = await open(markdown());
      expect(reopened.host.querySelector('br[data-is-inline="false"]')).not.toBeNull(); // dom-contract: Milkdown distinguishes explicit hard breaks with this schema attribute.
    }
  });

  it('keeps source context through the editor HTML clipboard path', async () => {
    const source = 'Cost $10 **bold** or $20; [guide][id].\n\n[id]: guide.md\n';
    const opened = await open(source);
    const slice = opened.view.state.doc.slice(1, opened.view.state.doc.content.size - 1);
    const clipboard = opened.view.serializeForClipboard(slice);
    const pasted = await open('');
    pasted.view.pasteHTML(clipboard.dom.innerHTML);
    pasted.view.dispatch(
      pasted.view.state.tr.setSelection(TextSelection.create(pasted.view.state.doc, 1)),
    );
    expect(pasted.host.querySelector('strong')?.textContent).toBe('bold'); // dom-contract: ordinary Markdown formatting is represented by semantic inline tags.
    expect(pasted.host.querySelector('a')?.getAttribute('href')).toBe('guide.md'); // dom-contract: Milkdown anchors carry the saved link target.
    expect(pasted.markdown()).toContain('Cost $10 **bold** or $20; [guide](guide.md).');
    const reopened = await open(pasted.markdown());
    expect(reopened.host.querySelector('a')?.getAttribute('href')).toBe('guide.md'); // dom-contract: Milkdown anchors carry the saved link target.
  });

  it.each([
    { prefix: '# ', node: 'heading' },
    { prefix: '- ', node: 'bullet_list' },
    { prefix: '> ', node: 'blockquote' },
  ])('keeps the existing $node input rule before protected prose', async ({ prefix, node }) => {
    const { view, markdown } = await open('Cost $10 and $20.\n');
    for (const character of prefix) {
      const { from, to } = view.state.selection;
      const handled = view.someProp('handleTextInput', (handler) =>
        handler(view, from, to, character, () => view.state.tr.insertText(character, from, to)),
      );
      if (!handled) view.dispatch(view.state.tr.insertText(character));
    }
    expect(view.state.doc.firstChild?.type.name).toBe(node);
    const reopened = await open(markdown());
    expect(reopened.view.state.doc.firstChild?.type.name).toBe(node);
    expect(reopened.view.state.doc.textContent).toBe('Cost $10 and $20.');
  });
  it('retains table cells and inline semantics when editing protected cell source', async () => {
    const source = '| Price |\n| --- |\n| Cost $10 **each** or $20 |\n';
    const { host, view, markdown } = await open(source);
    expect(host.querySelector('td strong')?.textContent).toBe('each'); // dom-contract: ordinary Markdown formatting is represented by semantic inline tags.
    let at = 0;
    view.state.doc.descendants((node, position) => {
      if (node.isText && node.text?.includes('Cost')) at = position + node.text.indexOf('Cost');
    });
    view.dispatch(view.state.tr.insertText('New: ', at));
    const reopened = await open(markdown());
    expect(reopened.host.querySelector('td strong')?.textContent).toBe('each'); // dom-contract: ordinary Markdown formatting is represented by semantic inline tags.
    expect(visibleText(reopened.host)).toContain('New: Cost $10 each or $20');
  });
  it.each(['Cost $5 and $10.\n\nLiteral \\*x\\*.\n', 'Literal \\*x\\*.\n\nCost $5 and $10.\n'])(
    'retains literal escapes when joining semantic and source paragraphs',
    async (source) => {
      const { view, changes, saved } = await open(source);
      const position = (view.state.doc.firstChild?.nodeSize ?? 0) + 1;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position)));
      expect(joinBackward(view.state, view.dispatch)).toBe(true);
      changes.flush();
      expect(saved.at(-1)).toBe(source.replace('\n\n', ''));
      expect(undo(view.state, view.dispatch)).toBe(true);
      expect(view.state.doc.childCount).toBe(2);
      expect(redo(view.state, view.dispatch)).toBe(true);
      const reopened = await open(saved.at(-1) ?? '');
      expect(reopened.host.querySelector('em')).toBeNull(); // dom-contract: ordinary Markdown formatting is represented by semantic inline tags.
    },
  );

  it.each([
    { kind: 'html', value: '<code>$x$</code>', source: '`$x$`' },
    { kind: 'text', value: 'Literal \\*x\\*.', source: 'Literal \\*x\\*.' },
  ])(
    'keeps pasted $kind semantics inside an existing source paragraph',
    async ({ kind, value, source }) => {
      const { view, host, markdown } = await open('Formula $y$ and code: ');
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, view.state.doc.content.size - 1),
        ),
      );
      const clipboardData = new DataTransfer();
      clipboardData.setData(kind === 'html' ? 'text/html' : 'text/plain', value);
      const event = new ClipboardEvent('paste', { clipboardData });
      expect(kind === 'html' ? view.pasteHTML(value, event) : view.pasteText(value, event)).toBe(
        true,
      );
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
      expect(host.querySelectorAll('[data-type="math_inline"]')).toHaveLength(1); // dom-contract: the published formula decoration exposes the source rendered by KaTeX.
      expect(markdown()).toContain(source);
      const reopened = await open(markdown());
      expect(reopened.host.querySelectorAll('[data-type="math_inline"]')).toHaveLength(1); // dom-contract: the published formula decoration exposes the source rendered by KaTeX.
      expect(reopened.host.querySelector('em')).toBeNull(); // dom-contract: ordinary Markdown formatting is represented by semantic inline tags.
    },
  );
  it.each([false, true])(
    'pastes literal TeX into a formula (unfinished: %s) through the clipboard',
    async (unfinished) => {
      const { view, host, markdown } = await open('Formula $x$ here.\n');
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 10, 11)));
      if (unfinished) view.dispatch(view.state.tr.delete(11, 12));
      const text = String.raw`\{x\} + a*b*c`;
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', text);
      expect(view.pasteText(text, new ClipboardEvent('paste', { clipboardData }))).toBe(true);
      if (unfinished) view.dispatch(view.state.tr.insertText('$', 10 + text.length));
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
      expect(markdown()).toBe('Formula $' + text + '$ here.\n');
      expect(host.querySelector<HTMLElement>('[data-type="math_inline"]')?.dataset.value).toBe(
        // dom-contract: the published formula decoration exposes the source rendered by KaTeX.
        text,
      );
    },
  );
});
