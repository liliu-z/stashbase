/**
 * Tracks editable formula/source ranges across ordinary ProseMirror changes.
 * Existing semantic content is serialized before it joins a raw source run;
 * newly typed source and all protection changes share the user's history step.
 */
import { Fragment, type Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import type { EditorState, Transaction } from '@milkdown/kit/prose/state';
import { Mapping } from '@milkdown/kit/prose/transform';

const MATH_SOURCE = 'math_source';

/** Ranges in the editor's literal formula source. The parser protects this text
 * before Markdown decoding; the same scan covers newly typed source. */
export interface MathSourceRange {
  from: number;
  to: number;
  value: string;
  kind: 'single' | 'inline' | 'display' | 'dollar';
}

export function mathSourceRanges(text: string, includeOpen = false): MathSourceRange[] {
  const ranges: MathSourceRange[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const start = at;
    if (text[at] === '\\') {
      const next = text[at + 1];
      if (next === '$') {
        ranges.push({ from: at, to: at + 2, value: '$', kind: 'dollar' });
        at += 1;
      } else if (next === '(' || next === '[') {
        const closing = next === '(' ? ')' : ']';
        let matched = false;
        let end = at + 2;
        for (; end < text.length; end += 1) {
          if (next === '(' && text[end] === '\n') break;
          if (text[end] !== '\\') continue;
          if (text[end + 1] === closing) {
            ranges.push({
              from: at,
              to: end + 2,
              value: text.slice(at + 2, end),
              kind: next === '(' ? 'inline' : 'display',
            });
            at = end + 1;
            matched = true;
            break;
          }
          end += 1;
        }
        if (!matched && includeOpen && end >= text.length) {
          ranges.push({
            from: start,
            to: text.length,
            value: text.slice(start + 2),
            kind: next === '(' ? 'inline' : 'display',
          });
          break;
        }
      } else {
        at += 1;
      }
      continue;
    }
    if (text[at] !== '$') continue;
    while (text[at + 1] === '$') at += 1;
    const size = at - start + 1;
    let matched = false;
    let end = at + 1;
    while (end < text.length) {
      if (text[end] === '\\') {
        end += 2;
        continue;
      }
      if (text[end] !== '$') {
        end += 1;
        continue;
      }
      const closing = end;
      while (text[end] === '$') end += 1;
      if (end - closing !== size) continue;
      ranges.push({
        from: start,
        to: end,
        value: text.slice(at + 1, closing),
        kind: size === 1 ? 'single' : 'inline',
      });
      at = end - 1;
      matched = true;
      break;
    }
    if (!matched && includeOpen) {
      ranges.push({
        from: start,
        to: text.length,
        value: text.slice(at + 1),
        kind: size === 1 ? 'single' : 'inline',
      });
      break;
    }
  }
  return ranges;
}

export function sourceRanges(doc: ProseMirrorNode, protectedOnly = true): MathSourceRange[] {
  const ranges: MathSourceRange[] = [];
  doc.descendants((node, position) => {
    if (node.type.spec.code) return false;
    if (!node.isTextblock) return;
    let source = '';
    let start = position + 1;
    const flush = () => {
      for (const range of mathSourceRanges(source)) {
        const from = start + range.from;
        const to = start + range.to;
        const type = doc.type.schema.marks[MATH_SOURCE];
        if (!protectedOnly || (type && doc.rangeHasMark(from, from + 1, type))) {
          ranges.push({ ...range, from, to });
        }
      }
      source = '';
    };
    node.forEach((child, offset) => {
      if (child.isText && !child.marks.some((mark) => mark.type.spec.code)) {
        if (!source) start = position + offset + 1;
        source += child.text;
      } else flush();
    });
    flush();
    return false;
  });
  return ranges;
}

/** Keep source protection in the same ProseMirror transaction/history as edits. */
export function protectMathSource(
  transactions: readonly Transaction[],
  state: EditorState,
  oldState: EditorState,
  serialize: (doc: ProseMirrorNode) => string,
): Transaction | null {
  if (!transactions.some((transaction) => transaction.docChanged)) return null;
  const type = state.schema.marks[MATH_SOURCE];
  if (!type) return null;
  const transaction = state.tr;
  // Only new delimiters authorize reinterpreting ordinary text. Decoded
  // literal escapes/entities from a loaded file are not formula source.
  const maps = transactions.flatMap((change) => change.mapping.maps);
  const inverse = new Mapping(maps).invert();
  const changed: Array<{ from: number; to: number }> = [];
  maps.forEach((map, index) =>
    map.forEach((_oldFrom, _oldTo, from, to) => {
      for (const later of maps.slice(index + 1)) {
        from = later.map(from, -1);
        to = later.map(to, 1);
      }
      changed.push({ from, to });
    }),
  );
  const ranges = sourceRanges(state.doc, false).filter(
    (range) =>
      state.doc.rangeHasMark(range.from, range.from + 1, type) ||
      changed.some(
        (change) =>
          (change.from < range.from + 1 && change.to > range.from) ||
          (change.from < range.to && change.to > range.to - 1),
      ),
  );
  let rangeIndex = 0;
  state.doc.descendants((node, position) => {
    if (node.isTextblock) {
      let proseMark: import('@milkdown/kit/prose/model').Mark | undefined;
      node.forEach((child) => {
        proseMark ??= child.marks.find((mark) => mark.type === type && mark.attrs.prose);
      });
      if (proseMark) {
        const protection = proseMark;
        node.forEach((child, offset) => {
          const from = transaction.mapping.map(position + offset + 1);
          const to = transaction.mapping.map(position + offset + 1 + child.nodeSize);
          const existing = child.marks.some((mark) => mark.eq(protection));
          const oldFrom = inverse.map(position + offset + 1, 1);
          const oldTo = inverse.map(position + offset + 1 + child.nodeSize, -1);
          const retained =
            oldTo - oldFrom === child.nodeSize &&
            oldState.doc.slice(oldFrom, oldTo).content.eq(Fragment.from(child));
          if (!child.isText || (!existing && retained)) {
            const source = inlineMathSource(child, serialize);
            if (source) transaction.replaceWith(from, to, state.schema.text(source, [protection]));
          } else if (!existing) transaction.addMark(from, to, protection);
        });
        return false;
      }
    }
    if (!node.isText) return;
    const end = position + node.nodeSize;
    while ((ranges[rangeIndex]?.to ?? Infinity) <= position) rangeIndex += 1;
    let cursor = position;
    const protectedSource = node.marks.some((mark) => mark.type === type);
    for (const range of ranges.slice(rangeIndex)) {
      if (range.from >= end) break;
      const from = Math.max(position, range.from);
      const to = Math.min(end, range.to);
      if (protectedSource && cursor < from) transaction.removeMark(cursor, from, type);
      if (!protectedSource) transaction.addMark(from, to, type.create());
      cursor = to;
    }
    if (protectedSource && cursor < end) transaction.removeMark(cursor, end, type);
  });
  return transaction.docChanged ? transaction : null;
}

/** Existing semantic inline content enters a source run through the normal
 * writer. Sentinels preserve leading/trailing whitespace and hard breaks. */
export function inlineMathSource(
  node: ProseMirrorNode,
  serialize: (doc: ProseMirrorNode) => string,
): string {
  const schema = node.type.schema;
  const content = node.isTextblock ? node.content : Fragment.from(node);
  const paragraph = schema.nodes.paragraph?.create(
    null,
    Fragment.from(schema.text('a'))
      .append(content)
      .append(Fragment.from(schema.text('b'))),
  );
  return paragraph
    ? serialize(schema.topNodeType.create(null, paragraph)).trimEnd().slice(1, -1)
    : '';
}
