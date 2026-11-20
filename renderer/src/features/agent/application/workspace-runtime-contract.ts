/** What one window's Agent workspace offers the shell and its surfaces: the
 *  verbs a chat list, a chat pane and a scheduled run call, and what it is
 *  built from. Kept beside the runtime, as the session's own contract is, so
 *  the shape a caller programs against reads on its own. */
import type { StoreApi } from 'zustand/vanilla';

import type {
  AgentContextPort,
  AgentPreferencesPort,
  AgentReconnectScheduler,
  AgentSessionPort,
} from '@/features/agent/application/ports';
import type {
  AgentFilesChanged,
  AgentSessionRuntime,
} from '@/features/agent/application/session-runtime';
import type { AgentUsageEvent } from '@/features/agent/application/session/usage';
import type { VoiceTypingPorts } from '@/features/agent/application/speech-port';
import type { AgentScopeEnvironment } from '@/features/agent/domain/context';
import type { AgentHistoryEntry } from '@/features/agent/domain/conversation-history';
import type { AgentId, AgentScope } from '@/features/agent/domain/session';
import type { AgentWorkspaceState } from '@/features/agent/domain/workspace';

import type { createProjectAgents } from './project-agents';

export interface AgentWorkspaceRuntime {
  readonly store: StoreApi<AgentWorkspaceState>;
  readonly preferences: ReturnType<typeof createProjectAgents>['store'];
  loadPreferences(): Promise<void>;
  chooseAgent(agent: AgentId): Promise<boolean>;
  activate(id: string): void;
  visit(direction: -1 | 1): void;
  activeSession(): AgentSessionRuntime;
  close(id: string): void;
  dispose(): void;
  listHistory(agent: AgentId, scope: AgentScope, signal: AbortSignal): Promise<AgentHistoryEntry[]>;
  newChat(agent?: AgentId, scope?: AgentScope): AgentSessionRuntime;
  /** A new chat that does not take the window: it is not shown, never
   *  reuses a blank chat the reader may be about to type into, keeps the
   *  Agent it was started on, and keeps `title` as a name of its own. A
   *  scheduled run starts here. */
  startBackgroundChat(options: {
    agent: AgentId;
    scope: AgentScope;
    title: string;
  }): AgentSessionRuntime;
  /** The Agent a new chat in `scope` starts on. */
  preferredAgent(scope: AgentScope): AgentId;
  /** Shows the project's scheduled tasks in the chat's place, or the chat. */
  showScheduledTasks(open: boolean): void;
  removeHistory(entry: AgentHistoryEntry, signal: AbortSignal): Promise<void>;
  renameHistory(
    entry: AgentHistoryEntry,
    title: string,
    signal: AbortSignal,
  ): Promise<AgentHistoryEntry>;
  restore(entry: AgentHistoryEntry): Promise<boolean>;
  retireFolder(folderPath: string): void;
  session(id: string): AgentSessionRuntime | null;
  voiceSessions(): readonly AgentSessionRuntime[];
  start(availableAgents?: readonly AgentId[]): void;
  startActive(): void;
  setScopeEnvironment(environment: AgentScopeEnvironment | null): void;
  setWindowFolder(folderPath: string | null): void;
}

export interface AgentWorkspaceRuntimeOptions {
  voice?: VoiceTypingPorts;
  recordUsage?: ((event: AgentUsageEvent) => void) | undefined;
  autostart?: boolean | undefined;
  context?: AgentContextPort | undefined;
  createId(): string;
  folderPath: string | null;
  initialAgent?: AgentId | undefined;
  preferences?: AgentPreferencesPort | undefined;
  onFilesChanged?: ((change: AgentFilesChanged) => void) | undefined;
  port: AgentSessionPort;
  scheduler?: AgentReconnectScheduler | undefined;
}
