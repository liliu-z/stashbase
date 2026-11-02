/** Keeps protected source links on the existing Milkdown command, tooltip, and history owners. */
import {
  linkPreviewTooltip,
  linkTooltipAPI,
  linkTooltipState,
  toggleLinkCommand,
} from '@milkdown/kit/component/link-tooltip';
import { commandsCtx, editorViewCtx, EditorViewReady } from '@milkdown/kit/core';
import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx';
import {
  isMarkSelectedCommand,
  linkSchema,
  sanitizeLinkHref,
  updateLinkCommand,
} from '@milkdown/kit/preset/commonmark';
import type { Mark } from '@milkdown/kit/prose/model';
import { Plugin, type PluginView, type Transaction } from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';

import { sourceSelection, type SourceSelection } from './math-commands';
import {
  markdownLinkParts,
  parseMathProse,
  type MarkdownNode,
  type RemarkParser,
} from './math-prose';

type ParserFactory = (context: Ctx) => RemarkParser;
interface SourceLink {
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
  url: string;
  title?: string | null;
}

function sourceLinks(selected: SourceSelection, parser: RemarkParser): SourceLink[] {
  const tree = parseMathProse(
    selected.source,
    parser,
    String(selected.mark.attrs.references ?? ''),
  );
  const references = new Map<string, MarkdownNode>();
  const definitions = (node: MarkdownNode) => {
    if (
      node.type === 'definition' &&
      node.identifier &&
      !references.has(node.identifier.toUpperCase())
    )
      references.set(node.identifier.toUpperCase(), node);
    node.children?.forEach(definitions);
  };
  definitions(tree);
  const found: SourceLink[] = [];
  const visit = (node: MarkdownNode) => {
    const target =
      node.type === 'linkReference' && node.identifier
        ? references.get(node.identifier.toUpperCase())
        : node;
    if ((node.type === 'link' || node.type === 'linkReference') && target?.url !== undefined) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const innerStart = node.children?.[0]?.position?.start.offset;
      const innerEnd = node.children?.at(-1)?.position?.end.offset;
      if (
        start !== undefined &&
        end !== undefined &&
        innerStart !== undefined &&
        innerEnd !== undefined
      ) {
        found.push({
          start,
          end,
          innerStart,
          innerEnd,
          url: target.url,
          ...(target.title ? { title: target.title } : {}),
        });
      }
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return found;
}

function selectedLink(selected: SourceSelection, parser: RemarkParser): SourceLink | undefined {
  return sourceLinks(selected, parser).find(
    (link) => selected.from >= link.innerStart && selected.to <= link.innerEnd,
  );
}

/** A new link can cover an existing label plus adjacent prose. Remove source
 * wrappers within that selection before applying its target, preserving any
 * unselected portion of the old label as a separate link. */
function addLink(
  tr: Transaction,
  selected: SourceSelection,
  parser: RemarkParser,
  parts: { before: string; after: string },
) {
  const edits: { from: number; to: number; text: string }[] = [];
  for (const link of sourceLinks(selected, parser)) {
    if (selected.from >= link.innerEnd || selected.to <= link.innerStart) continue;
    if (selected.from <= link.innerStart)
      edits.push({ from: link.start, to: link.innerStart, text: '' });
    else
      edits.push({
        from: selected.from,
        to: selected.from,
        text: selected.source.slice(link.innerEnd, link.end),
      });
    if (selected.to >= link.innerEnd) edits.push({ from: link.innerEnd, to: link.end, text: '' });
    else
      edits.push({
        from: selected.to,
        to: selected.to,
        text: selected.source.slice(link.start, link.innerStart),
      });
  }
  for (const edit of edits.toSorted((left, right) => right.from - left.from)) {
    const from = selected.start + edit.from;
    const to = selected.start + edit.to;
    if (edit.text) tr.replaceWith(from, to, tr.doc.type.schema.text(edit.text, [selected.mark]));
    else tr.delete(from, to);
  }
  const from = tr.mapping.map(selected.start + selected.from, 1);
  const to = tr.mapping.map(selected.start + selected.to, -1);
  tr.insert(to, tr.doc.type.schema.text(parts.after, [selected.mark]));
  tr.insert(from, tr.doc.type.schema.text(parts.before, [selected.mark]));
}

function editLink(
  tr: Transaction,
  selected: SourceSelection,
  link: SourceLink | undefined,
  parts: { before: string; after: string },
) {
  const start = link?.start ?? selected.from;
  const end = link?.end ?? selected.to;
  const innerStart = link?.innerStart ?? selected.from;
  const innerEnd = link?.innerEnd ?? selected.to;
  for (const edit of [
    { from: innerEnd, to: end, text: parts.after },
    { from: start, to: innerStart, text: parts.before },
  ]) {
    const from = selected.start + edit.from;
    const to = selected.start + edit.to;
    if (edit.text) tr.replaceWith(from, to, tr.doc.type.schema.text(edit.text, [selected.mark]));
    else tr.delete(from, to);
  }
}

interface PreviewView extends PluginView {
  show(mark: Mark, from: number, to: number, rect: DOMRect): void;
  hide(): void;
}
function isPreview(view: PluginView | undefined): view is PreviewView {
  return Boolean(
    view &&
    'show' in view &&
    typeof view.show === 'function' &&
    'hide' in view &&
    typeof view.hide === 'function',
  );
}

/** Reuse Milkdown's tooltip UI and API. Its configurable PluginSpec exposes a
 * PluginView type, while the shipped preview view also documents show/hide;
 * guard those public methods rather than reaching into private component state. */
export function configureMathSourceLinks(context: Ctx, getParser: ParserFactory): void {
  if (!context.isInjected(linkTooltipAPI.key)) return;
  context.update(linkTooltipAPI.key, (previous) => ({
    ...previous,
    removeLink(from, to) {
      const view = context.get(editorViewCtx);
      const selected = sourceSelection(view.state, from, to);
      const link = selected && selectedLink(selected, getParser(context));
      if (!selected || !link) {
        previous.removeLink(from, to);
        return;
      }
      const tr = view.state.tr;
      editLink(tr, selected, link, { before: '', after: '' });
      view.dispatch(tr);
      previous.removeLink(tr.mapping.map(from), tr.mapping.map(to));
    },
  }));
  context.update(linkPreviewTooltip.key, (previous) => {
    let preview: PreviewView | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
      ...previous,
      view(view) {
        const original = previous.view?.(view);
        if (isPreview(original)) preview = original;
        return {
          update: (next, old) => original?.update?.(next, old),
          destroy: () => {
            clearTimeout(timer);
            original?.destroy?.();
          },
        };
      },
      props: {
        ...previous.props,
        handleDOMEvents: {
          ...previous.props?.handleDOMEvents,
          mousemove(view, event) {
            previous.props?.handleDOMEvents?.mousemove?.call(this, view, event);
            clearTimeout(timer);
            const anchor = event.target instanceof Element ? event.target.closest('a') : null;
            if (!anchor || !view.dom.contains(anchor) || !view.editable || !view.hasFocus())
              return false;
            const at = view.posAtDOM(anchor, 0);
            const selected = sourceSelection(view.state, at, at);
            const link = selected && selectedLink(selected, getParser(context));
            if (!selected || !link) return false;
            // The existing hover handler is debounced. Let it finish before
            // presenting the source-backed link through that same tooltip.
            timer = setTimeout(() => {
              if (!anchor.isConnected || context.get(linkTooltipState.key).mode === 'edit') return;
              preview?.show(
                linkSchema.type(context).create({ href: link.url, title: link.title ?? null }),
                selected.start + link.innerStart,
                selected.start + link.innerEnd,
                anchor.getBoundingClientRect(),
              );
            }, 60);
            return false;
          },
          mouseleave(view, event) {
            clearTimeout(timer);
            return previous.props?.handleDOMEvents?.mouseleave?.call(this, view, event);
          },
        },
      },
    };
  });
}

export function mathSourceLinks(getParser: ParserFactory): MilkdownPlugin[] {
  const changes = $prose(
    (context) =>
      new Plugin({
        appendTransaction(transactions, _old, state) {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          const groups: { from: number; to: number; mark: Mark }[] = [];
          const type = linkSchema.type(context);
          state.doc.descendants((node, position) => {
            if (
              !node.isText ||
              !node.marks.some((mark) => mark.type.name === 'math_source' && mark.attrs.prose)
            )
              return;
            const mark = type.isInSet(node.marks);
            if (!mark) return;
            const last = groups.at(-1);
            if (last?.to === position && last.mark.eq(mark)) last.to += node.nodeSize;
            else groups.push({ from: position, to: position + node.nodeSize, mark });
          });
          if (!groups.length) return null;
          const tr = state.tr;
          const parser = getParser(context);
          for (const group of groups.toReversed()) {
            const selected = sourceSelection(state, group.from, group.to);
            if (!selected) continue;
            const link = selectedLink(selected, parser);
            tr.removeMark(group.from, group.to, type);
            const parts = markdownLinkParts(
              parser,
              sanitizeLinkHref(group.mark.attrs.href),
              group.mark.attrs.title ?? link?.title,
            );
            if (link) editLink(tr, selected, link, parts);
            else addLink(tr, selected, parser, parts);
          }
          if (state.storedMarks?.some((mark) => mark.type === type))
            tr.setStoredMarks(state.storedMarks.filter((mark) => mark.type !== type));
          return tr.docChanged ? tr : null;
        },
      }),
  );
  const commands: MilkdownPlugin = (context) => async () => {
    await context.wait(EditorViewReady);
    const registry = context.get(commandsCtx);
    const parser = getParser(context);
    const update = registry.get(updateLinkCommand.key);
    registry.create(updateLinkCommand.key, (payload) => (state, dispatch, view) => {
      const selected = sourceSelection(state);
      const link = selected && selectedLink(selected, parser);
      if (!selected || !link) return update(payload)(state, dispatch, view);
      if (dispatch) {
        const tr = state.tr;
        editLink(
          tr,
          selected,
          link,
          markdownLinkParts(
            parser,
            sanitizeLinkHref(payload?.href ?? link.url),
            payload?.title ?? link.title,
          ),
        );
        dispatch(tr.scrollIntoView());
      }
      return true;
    });
    const active = registry.get(isMarkSelectedCommand.key);
    registry.create(isMarkSelectedCommand.key, (mark) => (state, dispatch, view) => {
      const selected = mark?.name === 'link' ? sourceSelection(state) : undefined;
      return (
        Boolean(selected && selectedLink(selected, parser)) || active(mark)(state, dispatch, view)
      );
    });
    const toggle = context.isInjected(linkTooltipAPI.key)
      ? registry.get(toggleLinkCommand.key)
      : undefined;
    if (toggle)
      registry.create(toggleLinkCommand.key, (payload) => (state, dispatch, view) => {
        const selected = sourceSelection(state);
        const link = selected && selectedLink(selected, parser);
        if (!selected || !link) return toggle(payload)(state, dispatch, view);
        context
          .get(linkTooltipAPI.key)
          .removeLink(selected.start + link.innerStart, selected.start + link.innerEnd);
        return true;
      });
    return () => {
      registry.create(updateLinkCommand.key, update);
      registry.create(isMarkSelectedCommand.key, active);
      if (toggle) registry.create(toggleLinkCommand.key, toggle);
    };
  };
  return [changes, commands];
}
