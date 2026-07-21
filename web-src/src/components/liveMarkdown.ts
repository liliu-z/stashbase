import { syntaxTree } from '@codemirror/language';
import { type EditorState } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';

type ConstructKind = 'heading' | 'emphasis' | 'strong' | 'strikethrough' | 'inline-code' | 'horizontal-rule';

type Construct = {
  kind: ConstructKind;
  from: number;
  to: number;
  markerNames: readonly string[];
  markers: Array<{ from: number; to: number }>;
  level?: number;
};

export type LiveMarkdownProjection = Pick<Construct, 'kind' | 'from' | 'to'> & { active: boolean };

const constructKinds: Record<string, { kind: ConstructKind; markerNames: readonly string[] } | undefined> = {
  ATXHeading1: { kind: 'heading', markerNames: ['HeaderMark'] },
  ATXHeading2: { kind: 'heading', markerNames: ['HeaderMark'] },
  ATXHeading3: { kind: 'heading', markerNames: ['HeaderMark'] },
  ATXHeading4: { kind: 'heading', markerNames: ['HeaderMark'] },
  ATXHeading5: { kind: 'heading', markerNames: ['HeaderMark'] },
  ATXHeading6: { kind: 'heading', markerNames: ['HeaderMark'] },
  SetextHeading1: { kind: 'heading', markerNames: ['HeaderMark'] },
  SetextHeading2: { kind: 'heading', markerNames: ['HeaderMark'] },
  Emphasis: { kind: 'emphasis', markerNames: ['EmphasisMark'] },
  StrongEmphasis: { kind: 'strong', markerNames: ['EmphasisMark'] },
  Strikethrough: { kind: 'strikethrough', markerNames: ['StrikethroughMark'] },
  InlineCode: { kind: 'inline-code', markerNames: ['CodeMark'] },
  HorizontalRule: { kind: 'horizontal-rule', markerNames: [] },
};

/** Returns the source-tree constructs projected by Live Editing. This is also
 * the test seam: source text and editor selections remain the authority. */
export function describeLiveMarkdownProjection(state: EditorState): LiveMarkdownProjection[] {
  const constructs = collectConstructs(state);
  const selection = state.selection.main;
  return constructs.map((construct) => ({
    kind: construct.kind,
    from: construct.from,
    to: construct.to,
    active: intersectsSelection(construct, selection.from, selection.to),
  }));
}

/** A selection-aware, syntax-tree-derived presentation layer. It adds no
 * document changes: malformed or unsupported Markdown has no recognized tree
 * node and stays ordinary editable source. */
export const liveMarkdownProjection = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view.state);
  }

  update(update: { docChanged: boolean; selectionSet: boolean; viewportChanged: boolean; state: EditorState }) {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = buildDecorations(update.state);
    }
  }
}, {
  decorations: (value) => value.decorations,
});

export function toggleMarkdownStrong(view: EditorView): boolean {
  return toggleMarkdownDelimiter(view, '**', 'StrongEmphasis');
}

export function toggleMarkdownEmphasis(view: EditorView): boolean {
  return toggleMarkdownDelimiter(view, '*', 'Emphasis');
}

function buildDecorations(state: EditorState): DecorationSet {
  const selection = state.selection.main;
  const markers: Array<{ from: number; to: number; decoration: Decoration }> = [];
  for (const construct of collectConstructs(state)) {
    const active = intersectsSelection(construct, selection.from, selection.to);
    if (construct.kind === 'horizontal-rule') {
      if (!active) markers.push({ from: construct.from, to: construct.to, decoration: horizontalRuleDecoration });
      continue;
    }
    markers.push({
      from: construct.from,
      to: construct.to,
      decoration: Decoration.mark({
        class: `cm-live-${construct.kind}${construct.level ? ` cm-live-heading-${construct.level}` : ''}`,
      }),
    });
    if (!active) {
      for (const marker of hiddenMarkdownMarkupRanges(state, construct)) {
        markers.push({ from: marker.from, to: marker.to, decoration: hiddenMarkupDecoration });
      }
    }
  }
  markers.sort((a, b) => a.from - b.from || b.to - a.to);
  return Decoration.set(markers.map(({ from, to, decoration }) => decoration.range(from, to)), true);
}

/** Returns the source ranges that an inactive construct conceals. ATX
 * headings include their required following whitespace so the reading
 * projection does not retain an editor-width indent after the `#` marks. */
export function hiddenMarkdownMarkupRanges(state: EditorState, one?: Construct) {
  const source = state.doc.toString();
  const selection = state.selection.main;
  const ranges: Array<{ from: number; to: number }> = [];
  const constructs = one ? [one] : collectConstructs(state);
  for (const construct of constructs) {
    if (intersectsSelection(construct, selection.from, selection.to)) continue;
    for (const marker of construct.markers) {
      let to = marker.to;
      let from = marker.from;
      if (construct.kind === 'heading' && marker.from === construct.from) {
        while (to < construct.to && (source[to] === ' ' || source[to] === '\t')) to++;
      } else if (construct.kind === 'heading' && source[from - 1] === '\n') {
        // Setext heading markers are on their own source line. Removing its
        // preceding newline hides that syntax line without consuming the
        // ordinary paragraph break that follows the heading.
        from--;
      } else if (construct.kind === 'heading') {
        while (from > construct.from && (source[from - 1] === ' ' || source[from - 1] === '\t')) from--;
      }
      ranges.push({ from, to });
    }
  }
  return ranges;
}

function collectConstructs(state: EditorState): Construct[] {
  const constructs: Construct[] = [];
  const stack: Construct[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      const definition = constructKinds[node.name];
      if (definition) {
        const construct = {
          from: node.from,
          to: node.to,
          ...definition,
          ...(definition.kind === 'heading' ? { level: Number(node.name.slice(-1)) } : {}),
          markers: [],
        };
        constructs.push(construct);
        stack.push(construct);
        return;
      }

      const owner = [...stack].reverse().find((construct) => construct.markerNames.includes(node.name));
      if (owner) owner.markers.push({ from: node.from, to: node.to });
    },
    leave(node) {
      if (constructKinds[node.name]) stack.pop();
    },
  });
  return constructs;
}

function intersectsSelection(construct: Construct, from: number, to: number): boolean {
  if (from === to) return construct.from <= from && from <= construct.to;
  return construct.from < Math.max(from, to) && construct.to > Math.min(from, to);
}

function toggleMarkdownDelimiter(view: EditorView, delimiter: string, nodeName: string): boolean {
  const selection = view.state.selection.main;
  const construct = enclosingConstruct(view.state, nodeName, selection.from, selection.to);
  const existingDelimiter = construct && delimiterForConstruct(view.state.doc.toString(), construct, delimiter);
  if (construct && existingDelimiter) {
    const contentFrom = construct.from + existingDelimiter.length;
    const contentTo = construct.to - existingDelimiter.length;
    view.dispatch({
      changes: [
        { from: contentTo, to: construct.to },
        { from: construct.from, to: contentFrom },
      ],
      selection: {
        anchor: clamp(selection.anchor - existingDelimiter.length, construct.from, contentTo - existingDelimiter.length),
        head: clamp(selection.head - existingDelimiter.length, construct.from, contentTo - existingDelimiter.length),
      },
    });
    return true;
  }

  if (selection.empty) {
    view.dispatch({
      changes: { from: selection.from, insert: delimiter + delimiter },
      selection: { anchor: selection.from + delimiter.length },
    });
  } else {
    view.dispatch({
      changes: [
        { from: selection.to, insert: delimiter },
        { from: selection.from, insert: delimiter },
      ],
      selection: {
        anchor: selection.anchor + delimiter.length,
        head: selection.head + delimiter.length,
      },
    });
  }
  return true;
}

function enclosingConstruct(state: EditorState, nodeName: string, from: number, to: number) {
  const candidates: Array<{ from: number; to: number }> = [];
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== nodeName) return;
      const contains = start === end
        ? node.from <= start && start <= node.to
        : node.from <= start && node.to >= end;
      if (contains) candidates.push({ from: node.from, to: node.to });
    },
  });
  return candidates.sort((a, b) => (a.to - a.from) - (b.to - b.from))[0] ?? null;
}

function delimiterForConstruct(source: string, construct: { from: number; to: number }, fallback: string) {
  const opening = source.slice(construct.from, construct.from + fallback.length);
  const closing = source.slice(construct.to - fallback.length, construct.to);
  const valid = fallback === '**' ? opening === '**' || opening === '__' : opening === '*' || opening === '_';
  return valid && opening === closing ? opening : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

class HorizontalRuleWidget extends WidgetType {
  toDOM() {
    const rule = document.createElement('hr');
    rule.className = 'cm-live-horizontal-rule';
    return rule;
  }

  eq() { return true; }
}

const hiddenMarkupDecoration = Decoration.replace({});
const horizontalRuleDecoration = Decoration.replace({ widget: new HorizontalRuleWidget(), block: true });
