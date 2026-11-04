export { createAgentCatalogAdapter } from './infrastructure/catalog-api';
export { createAgentContextAdapter } from './infrastructure/context-api';
export { createAgentSessionAdapter } from './infrastructure/session-api';
export { AgentChats, AgentWorkspace } from './ui/workspace-lazy';
export { ChatNavButtons } from './ui/chat-nav-buttons';
export { ChatTitle } from './ui/chat-title';
export { askAbout, attachDroppedSource, releaseDroppedSource } from './application/ask-about';
export { useAgentWorkspaceRuntime } from './hooks/use-agent-workspace-runtime';
export type { AgentCatalogPort, AgentContextPort, AgentSessionPort } from './application/ports';
export type { AgentFilesChanged } from './application/session-runtime';
export type { AgentScopeEnvironment } from './domain/context';
export type { AgentScope } from './domain/session';
export type { AgentPersonaPort } from './application/ports';
export { createAgentPersonaAdapter } from './infrastructure/agent-persona-api';
export { createAgentToolsAdapter } from './infrastructure/agent-tools-api';
export type { AgentToolsPort } from './application/ports';
export { useAgentPersonaLibrary } from './hooks/use-agent-persona';
export type { AgentWorkspaceRuntime } from './application/workspace-runtime';

export { createAgentPreferencesAdapter } from './infrastructure/agent-preferences-api';
export type { AgentPreferencesPort } from './application/ports';

export {
  focusAgentRequest,
  pendingAgentRequests,
  subscribeAgentAttention,
} from './application/attention';

export { attentionId } from './domain/attention';

export { observeAgentOutcomes } from './application/outcome-notifications';
export { subscribeDesktopSessions, focusDesktopSession } from './application/desktop-sessions';

export {
  createScheduledRunsAdapter,
  createScheduledTasksAdapter,
} from './infrastructure/scheduled-tasks-api';
export { useScheduledRunReceiver } from './hooks/use-scheduled-run-receiver';
export type { ScheduledRunsPort, ScheduledTasksPort } from './application/ports';

export { useReferencedPassages } from './hooks/use-referenced-passages';
