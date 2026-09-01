/** How a saved Agent Instructions edit reaches the live Chat sessions it
 * changes. Mirrors `settingsTrigger` / `embeddingSetupTrigger`: the editor
 * announces, and every mounted session decides for itself whether the
 * saved folder is its own.
 *
 * A broadcast rather than a callback because the editor edits a FOLDER, not
 * a tab. Several mounted Chats can share one folder, and the modal opens
 * from whichever tab happens to be active — threading a refresh callback
 * from there would reach exactly the one session that is easiest to reach
 * and silently miss its siblings.
 */
import type { AgentInstructionsScope } from '@/common/api/api';

export const AGENT_INSTRUCTIONS_SAVED_EVENT = 'stashbase-agent-instructions-saved';

export function notifyAgentInstructionsSaved(scope: AgentInstructionsScope): void {
  window.dispatchEvent(new CustomEvent(AGENT_INSTRUCTIONS_SAVED_EVENT, { detail: scope }));
}

/** Subscribe a mounted session. Returns its own unsubscribe. */
export function onAgentInstructionsSaved(handler: (scope: AgentInstructionsScope) => void): () => void {
  const listener = (event: Event) => {
    const scope = (event as CustomEvent<AgentInstructionsScope>).detail;
    if (scope) handler(scope);
  };
  window.addEventListener(AGENT_INSTRUCTIONS_SAVED_EVENT, listener);
  return () => window.removeEventListener(AGENT_INSTRUCTIONS_SAVED_EVENT, listener);
}
