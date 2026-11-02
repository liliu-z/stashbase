/**
 * Adapts the existing Markdown clipboard flow to editable math source runs.
 * Copied references become self-contained links; pasted semantic content uses
 * the normal writer, while a formula's literal TeX stays literal.
 */
import {
  Fragment,
  Slice,
  type Mark,
  type Node as ProseMirrorNode,
} from '@milkdown/kit/prose/model';
import type { EditorState } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

import {
  markdownLinkParts,
  parseMathProse,
  type MarkdownNode,
  type RemarkParser,
} from './math-prose';
import { inlineMathSource, mathSourceRanges, typingFormula } from './math-source';

const MATH_SOURCE = 'math_source';

/** A copied source paragraph cannot rely on definitions in its old file.
 * Resolve its references at the clipboard boundary using the normal writer. */
export function pastedMathSource(
  slice: Slice,
  parser: RemarkParser,
  state: EditorState,
  serialize: (doc: ProseMirrorNode) => string,
): Slice {
  let destination: Mark | undefined;
  state.selection.$from.parent.forEach((child) => {
    destination ??= child.marks.find((mark) => mark.type.name === MATH_SOURCE && mark.attrs.prose);
  });
  const transform = (node: ProseMirrorNode): ProseMirrorNode => {
    if (!node.isText) {
      const content = Fragment.fromArray(
        Array.from({ length: node.childCount }, (_, index) => transform(node.child(index))),
      );
      const updated = node.copy(content);
      if (!node.isTextblock || node.type.spec.code || content.size === 0) return updated;
      let protection = destination;
      updated.forEach((child) => {
        protection ??= child.marks.find(
          (mark) => mark.type.name === MATH_SOURCE && mark.attrs.prose,
        );
      });
      if (!protection) return updated;
      const source = inlineMathSource(updated, serialize);
      return source
        ? updated.copy(Fragment.from(node.type.schema.text(source, [protection])))
        : updated;
    }
    const mark = node.marks.find(
      (candidate) => candidate.type.name === MATH_SOURCE && candidate.attrs.references,
    );
    if (!mark) return node;
    const source = node.text ?? '';
    const tree = parseMathProse(source, parser, String(mark.attrs.references));
    const definitions = new Map<string, MarkdownNode>();
    for (const definition of tree.children ?? [])
      if (
        definition.type === 'definition' &&
        definition.identifier &&
        !definitions.has(definition.identifier.toUpperCase())
      )
        definitions.set(definition.identifier.toUpperCase(), definition);
    const replacements: Array<{ from: number; to: number; source: string }> = [];
    const visit = (syntax: MarkdownNode) => {
      const from = syntax.position?.start.offset;
      const to = syntax.position?.end.offset;
      const definition = syntax.identifier
        ? definitions.get(syntax.identifier.toUpperCase())
        : undefined;
      if (
        (syntax.type === 'linkReference' || syntax.type === 'imageReference') &&
        definition?.url &&
        from !== undefined &&
        to !== undefined &&
        to <= source.length
      ) {
        const labelFrom = from + (syntax.type === 'imageReference' ? 2 : 1);
        let labelTo = labelFrom;
        let depth = 1;
        for (; labelTo < to; labelTo += 1) {
          if (source[labelTo] === '\\') {
            labelTo += 1;
            continue;
          }
          if (source[labelTo] === '[') depth += 1;
          if (source[labelTo] === ']' && --depth === 0) break;
        }
        const parts = markdownLinkParts(parser, definition.url, definition.title ?? undefined);
        replacements.push({
          from,
          to,
          source:
            (syntax.type === 'imageReference' ? '!' : '') +
            parts.before +
            source.slice(labelFrom, labelTo) +
            parts.after,
        });
      } else syntax.children?.forEach(visit);
    };
    visit(tree);
    let normalized = source;
    for (const replacement of replacements.toSorted((left, right) => right.from - left.from))
      normalized =
        normalized.slice(0, replacement.from) +
        replacement.source +
        normalized.slice(replacement.to);
    const marks = node.marks.map((candidate) =>
      candidate === mark ? mark.type.create({ ...mark.attrs, references: '' }) : candidate,
    );
    return normalized ? node.type.schema.text(normalized, marks) : node;
  };
  let content = Fragment.fromArray(
    Array.from({ length: slice.content.childCount }, (_, index) =>
      transform(slice.content.child(index)),
    ),
  );
  if (
    destination &&
    Array.from({ length: content.childCount }, (_, index) => content.child(index)).every(
      (node) => node.isInline,
    )
  ) {
    const paragraph = state.schema.nodes.paragraph?.create(null, content);
    const source = paragraph ? inlineMathSource(paragraph, serialize) : '';
    if (source) content = Fragment.from(state.schema.text(source, [destination]));
  }
  return new Slice(content, slice.openStart, slice.openEnd);
}

/** Milkdown reparses plain-text clipboard Markdown after transformPasted.
 * Keep that existing route, then normalize its semantic slice at this boundary. */
export function pasteMathSource(
  view: EditorView,
  event: ClipboardEvent,
  parseMarkdown: (source: string) => ProseMirrorNode | undefined,
  parser: RemarkParser,
  serialize: (doc: ProseMirrorNode) => string,
): boolean {
  const data = event.clipboardData;
  if (!view.editable || !data || data.getData('text/html') || data.getData('vscode-editor-data'))
    return false;
  const text = data.getData('text/plain');
  if (!text) return false;
  const { $from, $to } = view.state.selection;
  let protectedSource = false;
  $from.parent.forEach((child) => {
    if (child.marks.some((mark) => mark.type.name === MATH_SOURCE && mark.attrs.prose))
      protectedSource = true;
  });
  if (!protectedSource || $from.parent.type.spec.code) return false;
  const source = $from.parent.textContent;
  const inside = (from: number, to: number) =>
    $from.sameParent($to) && $from.parentOffset > from && $to.parentOffset < to;
  const complete = mathSourceRanges(source);
  let literal = mathSourceRanges(source, true).some((range) => {
    const open = !complete.some((closed) => closed.from === range.from && closed.to === range.to);
    return (
      range.kind !== 'dollar' &&
      (!open || typingFormula(range)) &&
      (inside(range.from, range.to) ||
        (open &&
          $from.sameParent($to) &&
          $from.parentOffset > range.from &&
          $to.parentOffset === range.to))
    );
  });
  const visit = (node: MarkdownNode) => {
    if (
      node.type === 'inlineCode' &&
      node.position?.start.offset !== undefined &&
      node.position.end.offset !== undefined &&
      inside(node.position.start.offset, node.position.end.offset)
    )
      literal = true;
    node.children?.forEach(visit);
  };
  visit(parseMathProse(source, parser));
  if (literal)
    view.dispatch(
      view.state.tr.insertText(text).setMeta('paste', true).setMeta('uiEvent', 'paste'),
    );
  else {
    const parsed = parseMarkdown(text);
    if (!parsed) return false;
    const slice = pastedMathSource(Slice.maxOpen(parsed.content), parser, view.state, serialize);
    view.dispatch(
      view.state.tr.replaceSelection(slice).setMeta('paste', true).setMeta('uiEvent', 'paste'),
    );
  }
  return true;
}
