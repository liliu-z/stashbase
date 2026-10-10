/** Live-document headings, editor-owned anchors, and outline navigation. */
import type { CrepeBuilder } from '@milkdown/crepe/builder';
import { editorViewCtx } from '@milkdown/kit/core';
import { syncHeadingIdPlugin } from '@milkdown/kit/preset/commonmark';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import { Plugin } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

import { headingSlug, type DocumentHeading } from '@/features/documents/domain/outline';

export interface ProseMirrorDocument {
  descendants(
    visit: (
      node: { attrs: { level?: number }; textContent: string; type: { name: string } },
      position: number,
    ) => void,
  ): void;
}

export interface HeadingNodeView {
  nodeDOM(position: number): Node | null;
  state: { doc: ProseMirrorDocument };
}

const headingNodes = new WeakMap<DocumentHeading, object>();

export function extractDocumentHeadings(document: ProseMirrorDocument): DocumentHeading[] {
  const headings: DocumentHeading[] = [];
  const used = new Map<string, number>();
  document.descendants((node, position) => {
    if (node.type.name !== 'heading') return;
    const text = node.textContent.trim();
    const base = headingSlug(text);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const heading = {
      id: seen === 0 ? base : `${base}-${seen}`,
      level: Number(node.attrs.level) || 1,
      position,
      text,
    };
    headingNodes.set(heading, node);
    headings.push(heading);
  });
  return headings;
}

function sameHeading(
  current: DocumentHeading,
  selected: DocumentHeading,
  includePosition: boolean,
): boolean {
  return (
    current.id === selected.id &&
    current.level === selected.level &&
    current.text === selected.text &&
    (!includePosition || current.position === selected.position)
  );
}

function resolveCurrentDocumentHeading(
  current: DocumentHeading[],
  selected: DocumentHeading,
): DocumentHeading | null {
  const selectedNode = headingNodes.get(selected);
  const identityMatches = selectedNode
    ? current.filter((heading) => headingNodes.get(heading) === selectedNode)
    : [];
  if (identityMatches.length === 1) return identityMatches[0] ?? null;
  if (identityMatches.length > 1) {
    return (
      identityMatches.find((heading) => sameHeading(heading, selected, true)) ??
      identityMatches.find((heading) => sameHeading(heading, selected, false)) ??
      null
    );
  }
  return current.find((heading) => sameHeading(heading, selected, true)) ?? null;
}

export function headingElementAtPosition(
  view: HeadingNodeView | null,
  position: number,
): HTMLElement | null {
  const node = view?.nodeDOM(position) as HTMLElement | null | undefined;
  return node && /^H[1-6]$/u.test(node.tagName) ? node : null;
}

export function documentScroller(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>('.milkdown') ?? host;
}

export function scrollOutlineToHeading(
  host: HTMLElement | null,
  selected: DocumentHeading,
  view: HeadingNodeView | null,
  reducedMotion: boolean,
): boolean {
  if (!host || !view) return false;
  const heading = resolveCurrentDocumentHeading(extractDocumentHeadings(view.state.doc), selected);
  if (!heading) return false;
  const element = headingElementAtPosition(view, heading.position);
  if (!element) return false;
  const scroller = documentScroller(host);
  const top = Math.max(
    0,
    scroller.scrollTop + element.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
  );
  scroller.scrollTo({ behavior: reducedMotion ? 'auto' : 'smooth', top });
  return true;
}

export function activeHeadingId(
  entries: DocumentHeading[],
  positions: Array<{ id: string; top: number }>,
  threshold: number,
): string | null {
  let active = entries[0]?.id ?? null;
  for (const position of positions) {
    if (position.top <= threshold) active = position.id;
    else break;
  }
  return active;
}

function headingAnchors(doc: ProseMirrorNode): DecorationSet {
  return DecorationSet.create(
    doc,
    extractDocumentHeadings(doc).flatMap(({ id, position }) => {
      const node = doc.nodeAt(position);
      return node ? [Decoration.node(position, position + node.nodeSize, { id })] : [];
    }),
  );
}

/** Anchors are presentation, owned by ProseMirror's rendering. Writing ids
 * directly to heading DOM makes its observer reparse the surrounding prose
 * and can cancel Chromium's IME replacement range, leaving pinyin in the text.
 * Replace Milkdown's separate id synchronizer so it cannot compete with the
 * outline's slug and duplicate-heading rules or turn anchors into model edits. */
export function attachHeadingAnchors(editor: CrepeBuilder): void {
  void editor.editor.remove(syncHeadingIdPlugin);
  editor.editor.use(
    $prose(
      () =>
        new Plugin<DecorationSet>({
          state: {
            init: (_, state) => headingAnchors(state.doc),
            apply: (transaction, previous) =>
              transaction.docChanged ? headingAnchors(transaction.doc) : previous,
          },
          props: {
            decorations(state) {
              return this.getState(state) ?? DecorationSet.empty;
            },
          },
        }),
    ),
  );
}

/** The live editor view, narrowed to what reading headings out of it needs. */
export function currentEditorView(editor: CrepeBuilder | null): HeadingNodeView | null {
  return (
    (editor?.editor.action((context) => context.get(editorViewCtx)) as HeadingNodeView | null) ??
    null
  );
}

/** The headings of the document now on screen, reusing the last extraction
 *  while the document node is the same one. */
export function headingsForView(
  view: HeadingNodeView | null,
  cache: { current: { document: ProseMirrorDocument; headings: DocumentHeading[] } | null },
): DocumentHeading[] {
  if (!view) return [];
  if (cache.current?.document === view.state.doc) return cache.current.headings;
  const headings = extractDocumentHeadings(view.state.doc);
  cache.current = { document: view.state.doc, headings };
  return headings;
}
