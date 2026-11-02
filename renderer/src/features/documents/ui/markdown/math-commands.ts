/** Adapt the existing formatting commands to editable Markdown source while
 * retaining native marks, selection, and history in the same transaction. */
import { commandsCtx, EditorViewReady } from '@milkdown/kit/core';
import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx';
import {
  isMarkSelectedCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
} from '@milkdown/kit/preset/commonmark';
import { toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';
import type { Mark } from '@milkdown/kit/prose/model';
import { TextSelection, type EditorState } from '@milkdown/kit/prose/state';
import type { RemarkParser } from '@milkdown/kit/transformer';

interface SyntaxNode {
  type: string;
  children?: SyntaxNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

export interface SourceSelection {
  source: string;
  start: number;
  from: number;
  to: number;
  mark: Mark;
}

interface FormatSpan {
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
}

interface SourceEdit {
  from: number;
  to: number;
  text: string;
}

const formats = [
  { command: toggleStrongCommand, mark: 'strong', syntax: 'strong', delimiter: '**' },
  { command: toggleEmphasisCommand, mark: 'emphasis', syntax: 'emphasis', delimiter: '*' },
  { command: toggleInlineCodeCommand, mark: 'inlineCode', syntax: 'inlineCode', delimiter: '`' },
  {
    command: toggleStrikethroughCommand,
    mark: 'strike_through',
    syntax: 'delete',
    delimiter: '~~',
  },
] as const;

export function sourceSelection(
  state: EditorState,
  from = state.selection.from,
  to = state.selection.to,
): SourceSelection | undefined {
  const $from = state.doc.resolve(from);
  const $to = state.doc.resolve(to);
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return;
  let source = '';
  let mark: Mark | undefined;
  let supported = true;
  $from.parent.forEach((node) => {
    const protection = node.marks.find(
      (candidate) => candidate.type.name === 'math_source' && candidate.attrs.prose === true,
    );
    if (!node.isText || !protection) supported = false;
    else {
      source += node.text;
      mark = protection;
    }
  });
  if (!supported || !mark) return;
  return { source, start: $from.start(), from: $from.parentOffset, to: $to.parentOffset, mark };
}

function matchingSpans(
  parser: RemarkParser,
  selected: SourceSelection,
  syntax: string,
): FormatSpan[] {
  const tree = parser.parse(selected.source) as SyntaxNode;
  const spans: FormatSpan[] = [];
  const visit = (node: SyntaxNode) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === syntax && typeof start === 'number' && typeof end === 'number') {
      let innerStart = node.children?.[0]?.position?.start.offset;
      let innerEnd = node.children?.at(-1)?.position?.end.offset;
      if (syntax === 'inlineCode') {
        const ticks = /^`+/u.exec(selected.source.slice(start, end))?.[0].length ?? 1;
        innerStart = start + ticks;
        innerEnd = end - ticks;
        const content = selected.source.slice(innerStart, innerEnd).replace(/\r\n?|\n/gu, ' ');
        if (content.startsWith(' ') && content.endsWith(' ') && /[^ ]/u.test(content)) {
          innerStart += 1;
          innerEnd -= 1;
        }
      }
      if (
        typeof innerStart === 'number' &&
        typeof innerEnd === 'number' &&
        selected.from < innerEnd &&
        selected.to > innerStart
      ) {
        spans.push({ start, end, innerStart, innerEnd });
      }
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return spans;
}

function removeFormatting(
  selected: SourceSelection,
  spans: FormatSpan[],
  delimiter: string,
  code = false,
): SourceEdit[] {
  const edits: SourceEdit[] = [];
  const outer = spans.filter(
    (span) => !spans.some((other) => other.start < span.start && other.end >= span.end),
  );
  for (const span of spans.filter((candidate) => !outer.includes(candidate))) {
    edits.push(
      { from: span.start, to: span.innerStart, text: '' },
      { from: span.innerEnd, to: span.end, text: '' },
    );
  }
  const nested = [...edits];
  for (const span of outer) {
    const opening = code ? selected.source.slice(span.start, span.innerStart) : delimiter;
    const closing = code ? selected.source.slice(span.innerEnd, span.end) : delimiter;
    let left = Math.max(span.innerStart, selected.from);
    let right = Math.min(span.innerEnd, selected.to);
    if (!code) {
      while (left > span.innerStart) {
        const hidden = nested.find((edit) => edit.to === left);
        if (hidden) left = hidden.from;
        else if (/\s/u.test(selected.source[left - 1] ?? '')) left -= 1;
        else break;
      }
      while (right < span.innerEnd) {
        const hidden = nested.find((edit) => edit.from === right);
        if (hidden) right = hidden.to;
        else if (/\s/u.test(selected.source[right] ?? '')) right += 1;
        else break;
      }
    }
    edits.push({
      from: span.start,
      to: span.innerStart,
      text: left > span.innerStart ? opening : '',
    });
    if (left > span.innerStart) edits.push({ from: left, to: left, text: closing });
    edits.push({ from: span.innerEnd, to: span.end, text: right < span.innerEnd ? closing : '' });
    if (right < span.innerEnd) edits.push({ from: right, to: right, text: opening });
    if (code) {
      const from = Math.max(selected.from, span.innerStart);
      const to = Math.min(selected.to, span.innerEnd);
      const text = selected.source
        .slice(from, to)
        .replace(/\r\n?|\n/gu, ' ')
        .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/gu, '\\$&');
      if (text !== selected.source.slice(from, to)) edits.push({ from, to, text });
    }
  }
  return edits;
}

function formatEdits(
  parser: RemarkParser,
  selected: SourceSelection,
  format: (typeof formats)[number],
  remove: boolean,
): SourceEdit[] {
  const spans = matchingSpans(parser, selected, format.syntax);
  const edits: SourceEdit[] = [];
  if (remove) {
    edits.push(
      ...removeFormatting(selected, spans, format.delimiter, format.syntax === 'inlineCode'),
    );
  } else {
    const text = selected.source.slice(selected.from, selected.to);
    const leading = /^\s*/u.exec(text)?.[0].length ?? 0;
    const trailing = /\s*$/u.exec(text)?.[0].length ?? 0;
    if (leading + trailing === text.length) return edits;
    let delimiter: string = format.delimiter;
    if (format.syntax === 'inlineCode') {
      for (const other of formats.filter((candidate) => candidate.syntax !== 'inlineCode')) {
        edits.push(
          ...removeFormatting(
            selected,
            matchingSpans(parser, selected, other.syntax),
            other.delimiter,
          ),
        );
      }
      const longest = Math.max(0, ...(text.match(/`+/gu) ?? []).map((ticks) => ticks.length));
      delimiter = '`'.repeat(longest + 1);
    }
    const padding = format.syntax === 'inlineCode' && /^`|`$/u.test(text.trim()) ? ' ' : '';
    edits.push({
      from: selected.from + leading,
      to: selected.from + leading,
      text: delimiter + padding,
    });
    edits.push({
      from: selected.to - trailing,
      to: selected.to - trailing,
      text: padding + delimiter,
    });
  }
  return edits;
}

function selectedBlocks(state: EditorState) {
  const blocks: { from: number; to: number; source?: SourceSelection }[] = [];
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node, position) => {
    if (!node.isTextblock) return;
    if (node.type.spec.code) return false;
    const from = Math.max(position + 1, state.selection.from);
    const to = Math.min(position + 1 + node.content.size, state.selection.to);
    if (from < to) {
      const source = sourceSelection(state, from, to);
      blocks.push({ from, to, ...(source ? { source } : {}) });
    }
    return false;
  });
  return blocks;
}

/** Keep the existing toolbar and keymap commands as the single entry point.
 * Protected prose is editable Markdown, so formatting edits its delimiters
 * instead of adding a second ProseMirror mark around the same source. */
export function mathSourceCommands(createParser: (context: Ctx) => RemarkParser): MilkdownPlugin {
  return (ctx) => async () => {
    await ctx.wait(EditorViewReady);
    const parser = createParser(ctx);
    const commands = ctx.get(commandsCtx);
    const restore: (() => void)[] = [];
    for (const format of formats) {
      const original = commands.get(format.command.key);
      commands.create(format.command.key, (payload) => (state, dispatch, view) => {
        if (state.selection.empty) return original(payload)(state, dispatch, view);
        const blocks = selectedBlocks(state);
        if (!blocks.some((block) => block.source)) return original(payload)(state, dispatch, view);
        const nativeMark = state.schema.marks[format.mark];
        if (!nativeMark) return false;
        const remove =
          state.doc.rangeHasMark(state.selection.from, state.selection.to, nativeMark) ||
          blocks.some(
            (block) =>
              block.source && matchingSpans(parser, block.source, format.syntax).length > 0,
          );
        if (!dispatch) return true;
        const tr = state.tr;
        const edits: (SourceEdit & { mark: Mark })[] = [];
        for (const block of blocks) {
          if (remove) tr.removeMark(block.from, block.to, nativeMark);
          else if (format.syntax === 'inlineCode') {
            for (const mark of Object.values(state.schema.marks)) {
              if (mark.name !== 'math_source') tr.removeMark(block.from, block.to, mark);
            }
          }
          if (block.source) {
            const selected = block.source;
            edits.push(
              ...formatEdits(parser, selected, format, remove).map((edit) => ({
                text: edit.text,
                from: selected.start + edit.from,
                to: selected.start + edit.to,
                mark: selected.mark,
              })),
            );
          } else if (!remove) tr.addMark(block.from, block.to, nativeMark.create());
        }
        for (const edit of edits.toSorted(
          (left, right) => right.from - left.from || right.to - left.to,
        )) {
          if (edit.text)
            tr.replaceWith(edit.from, edit.to, state.schema.text(edit.text, [edit.mark]));
          else tr.delete(edit.from, edit.to);
        }
        const anchor = tr.mapping.map(
          state.selection.anchor,
          state.selection.anchor <= state.selection.head ? 1 : -1,
        );
        const head = tr.mapping.map(
          state.selection.head,
          state.selection.anchor <= state.selection.head ? -1 : 1,
        );
        const from = Math.min(anchor, head);
        const to = Math.max(anchor, head);
        const forward = state.selection.anchor <= state.selection.head;
        tr.setSelection(TextSelection.create(tr.doc, forward ? from : to, forward ? to : from));
        dispatch(tr.scrollIntoView());
        return true;
      });
      restore.push(() => commands.create(format.command.key, original));
    }
    const originalSelected = commands.get(isMarkSelectedCommand.key);
    commands.create(isMarkSelectedCommand.key, (mark) => (state, dispatch, view) => {
      const format = formats.find((candidate) => candidate.mark === mark?.name);
      if (format)
        return (
          originalSelected(mark)(state, dispatch, view) ||
          selectedBlocks(state).some(
            (block) =>
              block.source && matchingSpans(parser, block.source, format.syntax).length > 0,
          )
        );

      return originalSelected(mark)(state, dispatch, view);
    });
    restore.push(() => commands.create(isMarkSelectedCommand.key, originalSelected));
    return () => restore.forEach((reset) => reset());
  };
}
