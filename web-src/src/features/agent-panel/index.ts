/**
 * Public surface of the Agent Panel feature.
 *
 * `ChatPane` carries the agent runtime, which is the whole reason it
 * loads at its interaction boundary — the feature owns that boundary
 * here so a consumer cannot accidentally make it eager. The session
 * history popover has its own boundary, but it now lives beside its only
 * caller (`ScopeHistoryButton`) rather than in this barrel.
 *
 * The two sidebar entry points are eager on purpose: `NewChatButton` is
 * the shell's one chat-creation row and `ScopeHistoryButton` sits on
 * every scope header, so both mount with the window. They live here
 * rather than in `app/` because what they own is agent business logic —
 * the next-chat agent preference and session resume — not composition.
 */
import { lazyWithRetry } from '@/common/components/ErrorBoundary';

export { NewChatButton, launcherRowClass } from '@/features/agent-panel/components/NewChatButton';
export { ScopeHistoryButton } from '@/features/agent-panel/components/ScopeHistoryButton';

export { useAgentCatalogPrime } from '@/features/agent-panel/hooks/useAgentCatalogPrime';
export { useChatLayoutFollowUp } from '@/features/agent-panel/hooks/useChatLayoutFollowUp';

export const ChatPane = lazyWithRetry(() =>
  import('@/features/agent-panel/components/ChatPane'));
