import { useEffect, type RefObject } from 'react';
import { useStore } from 'zustand';

import type { AgentSessionRuntime } from '@/features/agent/application/session-runtime';
import { useTextEntryFocused } from '@/shared/runtime/use-text-entry-focused';

/** Spread on whatever element hosts the Agent workspace. The feature owns the
 *  marker so the shell never has to name an Agent selector of its own. */
export const agentSurfaceProps = { 'data-agent-surface': '' } as const;

const AGENT_SURFACE_SELECTOR = '[data-agent-surface]';

/** True while a text field inside the Agent workspace owns focus. */
export function useAgentComposerFocused(): boolean {
  return useTextEntryFocused(AGENT_SURFACE_SELECTOR);
}

/** Moves the caret into the composer once a request for it is pending, which
 *  may have been made before this composer mounted, then settles the request. */
export function useComposerFocusRequest(
  session: AgentSessionRuntime,
  editor: RefObject<{ focus(): void } | null>,
): void {
  const requested = useStore(session.store, (state) => state.composerFocusRequested);
  useEffect(() => {
    if (!requested) return;
    editor.current?.focus();
    session.requestComposerFocus(false);
  }, [editor, requested, session]);
}
