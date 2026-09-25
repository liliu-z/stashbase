import type { AgentWorkspaceRuntime } from '@/features/agent/application/workspace-runtime';
import { passageContextItem } from '@/features/agent/domain/context';
import { agentScopesEqual, type AgentScope } from '@/features/agent/domain/session';
import type { SourceReference } from '@/shared/domain/source-reference';

/** Binds a passage of a document to the chat in its folder and moves the
 *  reader's caret to that chat's composer. A passage validates only against
 *  its own folder, so a chat about another folder gives way to a new one. */
export function askAbout(
  workspace: AgentWorkspaceRuntime,
  source: SourceReference,
  quote: string,
): void {
  const item = passageContextItem(source, quote);
  if (!item) return;
  const scope: AgentScope = { kind: 'folder', path: source.folderPath };
  const active = workspace.activeSession();
  const session = agentScopesEqual(active.store.getState().scope, scope)
    ? active
    : workspace.newChat(undefined, scope);
  session.addContext(item);
  session.requestComposerFocus();
}
