export const COMPACT_WORKSPACE_QUERY = '(max-width: 960px)';

export type WorkspaceLayout = 'document' | 'split' | 'chat-primary';

/** Presentation-only layout policy. RAG and CoWork share the same workspace;
 * the presence of a document is enough to choose between chat-first and
 * side-by-side collaboration. (A bare window boots into `chat-primary`
 * through this rule with no special case: nothing opens in the main pane,
 * and the boot chat leads with the Gallery band under its composer.) */
export function resolveWorkspaceLayout({
  chatOpen,
  hasDocument,
  compact,
}: {
  chatOpen: boolean;
  hasDocument: boolean;
  compact: boolean;
}): WorkspaceLayout {
  if (!chatOpen) return 'document';
  if (!hasDocument || compact) return 'chat-primary';
  return 'split';
}

/** A newly opened document wins on a compact window. Once it has been shown,
 * reopening Chat is explicit user intent and may take over the main area. */
export function shouldAutoCollapseChat({
  chatOpen,
  hasDocument,
  compact,
  previousHasDocument,
  previousCompact,
}: {
  chatOpen: boolean;
  hasDocument: boolean;
  compact: boolean;
  previousHasDocument: boolean;
  previousCompact: boolean;
}): boolean {
  return chatOpen
    && hasDocument
    && compact
    && (!previousHasDocument || !previousCompact);
}
