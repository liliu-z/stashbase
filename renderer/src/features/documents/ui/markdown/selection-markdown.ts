/**
 * The exact selection as Markdown, for handing a passage to the Agent.
 *
 * Unlike Humanize this does not widen to whole blocks or refuse code and
 * tables: the reader is asking about precisely what they marked, and nothing
 * is rewritten in its place. The editor's own serializer spells it, so the
 * passage reads the way the rest of the document does.
 */
import { editorViewCtx, schemaCtx, serializerCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { useCallback, useRef } from 'react';

import type { DocumentSelection } from '@/features/documents/domain/selection';
import type { SourceReference } from '@/shared/domain/source-reference';

/** The selected passage as Markdown, or null when nothing but whitespace is
 *  selected. */
export function selectedMarkdown(ctx: Ctx): string | null {
  const { doc, selection } = ctx.get(editorViewCtx).state;
  if (selection.empty) return null;
  // With its parents, so a selection inside one paragraph is still a block
  // the serializer can write rather than bare inline text.
  const { content } = doc.slice(selection.from, selection.to, true);
  // Judged on the nodes, not the Markdown: empty paragraphs serialize to
  // `<br />`, which is not a passage.
  let substantive = false;
  content.descendants((node) => {
    if (substantive) return false;
    substantive = node.isText
      ? (node.text ?? '').trim() !== ''
      : node.isLeaf && node.type.name !== 'hardbreak';
    return !substantive;
  });
  if (!substantive) return null;
  return ctx.get(serializerCtx)(ctx.get(schemaCtx).topNodeType.create(null, content)).trim();
}

/** Ask Agent on the selection of the editor it is clicked in, or null without
 *  an Agent beside the document. The handler and source are read on click, so
 *  the answer changes identity only when Ask Agent appears or disappears, and
 *  the editor is rebuilt only then. */
export function useAskAgent(
  onAskAgent: ((selection: DocumentSelection) => void) | undefined,
  source: SourceReference,
): ((ctx: Ctx) => void) | null {
  const latest = useRef({ onAskAgent, source });
  latest.current = { onAskAgent, source };
  const ask = useCallback((ctx: Ctx) => {
    const markdown = selectedMarkdown(ctx);
    if (markdown !== null) latest.current.onAskAgent?.({ markdown, source: latest.current.source });
  }, []);
  return onAskAgent ? ask : null;
}
