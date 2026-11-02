/** Keep transcript selection-copy tied to original Markdown source, including
 * formula delimiters, decoded prose, and the selected block structure. */
import type { ClipboardEvent } from 'react';

interface HtmlNode {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  value?: string;
  children?: HtmlNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

function classes(node: HtmlNode): readonly unknown[] {
  const value = node.properties?.className;
  return Array.isArray(value) ? value : [];
}

function isMath(node: HtmlNode): boolean {
  return classes(node).some(
    (name) => name === 'language-math' || name === 'math-inline' || name === 'math-display',
  );
}

/** Source positions survive Markdown parsing but not KaTeX's replacement DOM.
 * Keep them outside the formula and on prose runs so selection-copy can slice
 * the original Markdown, including its escapes and block structure. */
export function preserveMarkdownSource() {
  return (tree: HtmlNode) => {
    const containsMath = (node: HtmlNode): boolean =>
      isMath(node) || Boolean(node.children?.some(containsMath));
    if (!containsMath(tree)) return;
    const visit = (node: HtmlNode): HtmlNode => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const math = isMath(node) || (node.tagName === 'pre' && node.children?.some(isMath));
      const atomic = math || node.tagName === 'code' || node.tagName === 'pre';
      const properties =
        typeof start === 'number' && typeof end === 'number'
          ? { dataMarkdownStart: start, dataMarkdownEnd: end }
          : null;
      if (properties && (node.type === 'text' || math)) {
        return {
          type: 'element',
          tagName: 'span',
          properties: {
            ...properties,
            dataMarkdownLeaf: math ? 'atom' : 'text',
            ...(math ? { dataMarkdownMath: true } : {}),
          },
          children: [node],
        };
      }
      if (properties && node.type === 'element') {
        node.properties = {
          ...node.properties,
          ...properties,
          ...(atomic ? { dataMarkdownLeaf: 'atom' } : {}),
        };
      }
      if (!atomic && node.children) node.children = node.children.map(visit);
      return node;
    };
    if (tree.children) tree.children = tree.children.map(visit);
  };
}

interface SourceRange {
  start: number;
  end: number;
}

function sourceRange(element: HTMLElement): SourceRange {
  return {
    start: Number(element.dataset.markdownStart),
    end: Number(element.dataset.markdownEnd),
  };
}

/** Map decoded prose back across escapes/entities and container prefixes that
 * Markdown removes from continuation lines (list indentation and `> `). */
function sourceSelection(
  source: string,
  text: string,
  start: number,
  end: number,
  ownerDocument: Document,
): SourceRange {
  if (start === 0 && end === text.length) return { start: 0, end: source.length };
  let decoded = '';
  const positions: SourceRange[] = [];
  for (let index = 0; index < source.length;) {
    let value = source[index] ?? '';
    let length = 1;
    const escaped =
      source[index] === '\\' &&
      /^\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/u.exec(source.slice(index));
    const entity =
      source[index] === '&' &&
      /^&(?:#[0-9]{1,7}|#x[\da-f]{1,6}|[a-z][a-z0-9]{1,31});/iu.exec(source.slice(index));
    if (escaped) {
      value = escaped[0].slice(1);
      length = escaped[0].length;
    } else if (entity) {
      const decoder = ownerDocument.createElement('textarea');
      decoder.innerHTML = entity[0];
      if (decoder.value !== entity[0]) {
        value = decoder.value;
        length = entity[0].length;
      }
    } else if (value === '\r') {
      value = '\n';
      length = source.startsWith('\r\n', index) ? 2 : 1;
    }
    decoded += value;
    for (let character = 0; character < value.length; character += 1) {
      positions.push({ start: index, end: index + length });
    }
    index += length;
  }
  const at = (offset: number): SourceRange | undefined => {
    let sourceLineStart = 0;
    let textLineStart = 0;
    for (const line of text.split('\n')) {
      const next = decoded.indexOf('\n', sourceLineStart);
      const sourceLineEnd = next === -1 ? decoded.length : next;
      const sourceLine = decoded.slice(sourceLineStart, sourceLineEnd);
      const prefix = sourceLine.lastIndexOf(line);
      if (prefix === -1) return undefined;
      if (offset < textLineStart + line.length) {
        return positions[sourceLineStart + prefix + offset - textLineStart];
      }
      if (offset === textLineStart + line.length) return positions[sourceLineEnd];
      sourceLineStart = sourceLineEnd + 1;
      textLineStart += line.length + 1;
    }
    return undefined;
  };
  const first = at(start);
  const last = at(end - 1);
  // Keep a source run intact if a parser transformation cannot be mapped.
  return first && last ? { start: first.start, end: last.end } : { start: 0, end: source.length };
}

function selectedLeaf(range: Range, element: HTMLElement, markdown: string): SourceRange | null {
  const content = element.ownerDocument.createRange();
  content.selectNodeContents(element);
  if (
    range.compareBoundaryPoints(Range.END_TO_START, content) >= 0 ||
    range.compareBoundaryPoints(Range.START_TO_END, content) <= 0
  )
    return null;
  const original = sourceRange(element);
  if (element.dataset.markdownLeaf === 'atom') return original;
  const selected = content.cloneRange();
  if (range.compareBoundaryPoints(Range.START_TO_START, content) > 0) {
    selected.setStart(range.startContainer, range.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, content) < 0) {
    selected.setEnd(range.endContainer, range.endOffset);
  }
  const before = content.cloneRange();
  before.setEnd(selected.startContainer, selected.startOffset);
  const start = before.toString().length;
  const end = start + selected.toString().length;
  if (start === end) return null;
  const source = markdown.slice(original.start, original.end);
  const part = sourceSelection(
    source,
    element.textContent ?? '',
    start,
    end,
    element.ownerDocument,
  );
  return { start: original.start + part.start, end: original.start + part.end };
}

export function copyRenderedMathSource(
  event: ClipboardEvent<HTMLDivElement>,
  markdown: string,
): void {
  const root = event.currentTarget;
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  // Do not replace a selection that also contains content outside this reply.
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
  const selected = new Map<HTMLElement, SourceRange>();
  let hasMath = false;
  for (const leaf of root.querySelectorAll<HTMLElement>('[data-markdown-leaf]')) {
    const part = selectedLeaf(range, leaf, markdown);
    if (!part) continue;
    selected.set(leaf, part);
    if (leaf.hasAttribute('data-markdown-math')) hasMath = true;
  }
  if (!hasMath) return;
  let start = Math.min(...Array.from(selected.values(), (part) => part.start));
  let end = Math.max(...Array.from(selected.values(), (part) => part.end));
  // A fully selected link/list/paragraph keeps its source punctuation too.
  // Partial prose at the endpoints remains limited to the selected characters.
  for (const element of root.querySelectorAll<HTMLElement>(
    '[data-markdown-start]:not([data-markdown-leaf])',
  )) {
    const leaves = Array.from(element.querySelectorAll<HTMLElement>('[data-markdown-leaf]'));
    if (
      leaves.length === 0 ||
      !leaves.every((leaf) => {
        const part = selected.get(leaf);
        const original = sourceRange(leaf);
        return part?.start === original.start && part.end === original.end;
      })
    )
      continue;
    const full = sourceRange(element);
    start = Math.min(start, full.start);
    end = Math.max(end, full.end);
  }
  event.clipboardData.setData('text/plain', markdown.slice(start, end));
  event.preventDefault();
}
