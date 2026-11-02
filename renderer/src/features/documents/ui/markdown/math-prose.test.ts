import { CrepeBuilder } from '@milkdown/crepe/builder';
import { editorViewCtx, remarkCtx } from '@milkdown/kit/core';
import { EditorState, Plugin, TextSelection } from '@milkdown/kit/prose/state';
import { DecorationSet, EditorView } from '@milkdown/kit/prose/view';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { mathProseDecorations, parseMathProse } from './math-prose';

const editors: CrepeBuilder[] = [];
const views: EditorView[] = [];

afterEach(async () => {
  for (const view of views.splice(0)) view.destroy();
  for (const editor of editors.splice(0)) await editor.destroy();
});

async function present(source: string, references = '') {
  const root = document.createElement('div');
  document.body.append(root);
  const editor = new CrepeBuilder({
    root,
    defaultValue: source + (references ? `\n\n${references}` : ''),
  });
  editors.push(editor);
  await editor.create();
  const context = editor.editor.action((value) => value);
  const original = context.get(editorViewCtx);
  const schema = original.state.schema;
  const parser = context.get(remarkCtx);
  const tree = parseMathProse(source, parser, references);
  const paragraph = schema.nodes.paragraph;
  if (!paragraph) throw new Error('The document editor requires the paragraph schema');
  const doc = schema.topNodeType.create(null, paragraph.create(null, schema.text(source)));
  const host = document.createElement('div');
  document.body.append(host);
  const view = new EditorView(host, {
    state: EditorState.create({
      doc,
      plugins: [
        new Plugin({
          props: {
            decorations: (state) =>
              DecorationSet.create(
                state.doc,
                mathProseDecorations(
                  source,
                  1,
                  parser,
                  state.selection.from,
                  state.selection.to,
                  tree,
                ),
              ),
          },
        }),
      ],
    }),
  });
  views.push(view);
  return { view, original };
}

function visibleText(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.stashbase-math-source').forEach((syntax) => syntax.remove()); // dom-contract: hidden source syntax must not contribute to displayed prose.
  return copy.textContent ?? '';
}

describe('ordinary Markdown over protected math source', () => {
  it('preserves inline semantics across dollar boundaries and keeps code literal', async () => {
    const source =
      'Cost $10 **per item or $20 per pack**, _emphasis_, ~~old~~ and `\\*literal\\* &amp;`.';
    const { view, original } = await present(source);
    expect(view.dom.querySelector('strong')?.textContent).toBe('per item or $20 per pack'); // dom-contract: semantic inline elements must match ordinary Markdown.
    expect(view.dom.querySelector('em')?.textContent).toBe('emphasis'); // dom-contract: semantic inline elements must match ordinary Markdown.
    expect(view.dom.querySelector('del')?.textContent).toBe('old'); // dom-contract: semantic inline elements must match ordinary Markdown.
    expect(view.dom.querySelector('code')?.textContent).toBe('\\*literal\\* &amp;'); // dom-contract: semantic inline elements must match ordinary Markdown.
    expect(visibleText(view.dom)).toBe(original.dom.textContent);
    expect(view.state.doc.textContent).toBe(source);
  });

  it('uses the existing link sanitizer and image schema output', async () => {
    const source =
      'Cost $10 [guide](guide.md#part "Guide") and [bad](javascript:alert) ![chart](chart.png "Chart") or $20.';
    const { view, original } = await present(source);
    const anchors = view.dom.querySelectorAll('a'); // dom-contract: the source link must expose the native navigation target.
    expect(anchors[0]?.getAttribute('href')).toBe('guide.md#part');
    expect(anchors[0]?.getAttribute('title')).toBe('Guide');
    expect(anchors[1]?.getAttribute('href')).toBe('');
    const image = view.dom.querySelector('img'); // dom-contract: native image attributes must match the existing schema output.
    const ordinary = original.dom.querySelector('img'); // dom-contract: native image attributes must match the existing schema output.
    for (const attribute of ['src', 'alt', 'title']) {
      expect(image?.getAttribute(attribute)).toBe(ordinary?.getAttribute(attribute));
    }
    expect(view.state.doc.textContent).toBe(source);
  });

  it('decodes escaped punctuation and entities without touching source or inline code', async () => {
    const source = String.raw`Cost $10 \*literal\* &amp; &#x1f600; and \$20; \(escaped\).`;
    const { view, original } = await present(source);
    expect(visibleText(view.dom)).toBe(original.dom.textContent);
    expect(view.state.doc.textContent).toBe(source);
  });

  it('reveals syntax for a text cursor and retains semantics for range selection', async () => {
    const source = 'Cost $10 **bold** or $20.';
    const { view } = await present(source);
    const position = source.indexOf('bold') + 2;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position)));
    expect(view.dom.querySelector('strong')).toBeNull(); // dom-contract: semantic inline elements must match ordinary Markdown.
    expect(visibleText(view.dom)).toBe(source);
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, position, position + 1)),
    );
    expect(view.dom.querySelector('strong')?.textContent).toBe('bold'); // dom-contract: semantic inline elements must match ordinary Markdown.
    expect(view.state.doc.textContent).toBe(source);
  });

  it('retains reference targets supplied from outside the source run', async () => {
    const source = 'Cost $10 for [guide][manual] and ![chart][picture] or $20.';
    const { view, original } = await present(
      source,
      '[manual]: guide.md "Guide"\n[MANUAL]: second.md\n[picture]: chart.png',
    );
    expect(view.dom.querySelector('a')?.getAttribute('href')).toBe('guide.md'); // dom-contract: the source link must expose the native navigation target.
    expect(view.dom.querySelector('img')?.getAttribute('src')).toBe('chart.png'); // dom-contract: native image attributes must match the existing schema output.
    expect(visibleText(view.dom)).toBe(original.dom.textContent);
  });

  it('keeps source positions across soft and hard breaks', async () => {
    const source = 'Cost $10 for **bold\nnext** and \\\nvalue or $20; `\r\ncode\r\n`.';
    const { view, original } = await present(source);
    const actualBreaks = view.dom.querySelectorAll('br'); // dom-contract: native line breaks must match the ordinary Markdown renderer.
    const expectedBreaks = original.dom.querySelectorAll('br'); // dom-contract: native line breaks must match the ordinary Markdown renderer.
    expect(actualBreaks).toHaveLength(expectedBreaks.length);
    expect(visibleText(view.dom)).toBe(original.dom.textContent);
    expect(view.state.doc.textContent).toBe(source);
  });
});
