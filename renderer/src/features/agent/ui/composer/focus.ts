import { useEffect, type RefObject } from 'react';
import { useStore } from 'zustand';

import type { AgentSessionRuntime } from '@/features/agent/application/session-runtime';

/** Spread on whatever element hosts the Agent workspace. The feature owns the
 *  marker so the shell never has to name an Agent selector of its own. */
export const agentSurfaceProps = { 'data-agent-surface': '' } as const;

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
