/** What one Agent conversation offers its window: the verbs a composer, a
 *  transcript and the workspace runtime call, and what it has to be built
 *  from. Kept beside the runtime rather than inside it so the shape a caller
 *  programs against reads on its own. */
import type { StoreApi } from 'zustand/vanilla';

import type {
  AgentContextPort,
  AgentReconnectScheduler,
  AgentSessionPort,
} from '@/features/agent/application/ports';
import type { AgentUsageEvent } from '@/features/agent/application/session/usage';
import type { AgentAccessMode } from '@/features/agent/domain/access';
import type { AgentContextItem } from '@/features/agent/domain/context';
import type { AgentHistoryEntry } from '@/features/agent/domain/conversation-history';
import type { AgentModel } from '@/features/agent/domain/runtime-catalog';
import type { AgentId, AgentScope, AgentSessionState } from '@/features/agent/domain/session';
import type { AgentPermissionDecision } from '@/features/agent/domain/session-command';
import type { CapturedScope } from '@/shared/runtime/scope-guard';

import type { AgentSendResult, AgentSessionEnvironment } from './dispatch';
import type { AgentFilesChanged } from './files-changed';
import type { QueueEntry } from './prompts';

/** What one session operation was started under. */
type AgentSessionScope = CapturedScope<AgentScope>;

export interface AgentSessionRuntime {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly store: StoreApi<AgentSessionState>;
  /** Runs `completion` only when `capturedScope` still holds and the session
   *  is live. Answers whether it ran, so a caller can drop the rest of a
   *  stale completion too. */
  accept(capturedScope: AgentSessionScope, completion: () => void): boolean;
  /** The scope token as of now. Take it before the first `await` of an
   *  operation and hand it back to `accept` afterwards: capturing at
   *  completion time would compare the live scope with itself and guard
   *  nothing. */
  capture(): AgentSessionScope;
  isBlank(): boolean;
  interrupt(): boolean;
  continueQueue(): Promise<boolean>;
  confirmOutcome(): void;
  changeAgent(agent: AgentId): boolean;
  editQueued(id: string): boolean;
  /** Answers one pending request. `decision` adds what a reader can say
   *  beyond allow or deny: remember the approval, or the replies to a
   *  clarifying question. */
  replyPermission(
    toolUseId: string,
    permissionId: string,
    allow: boolean,
    decision?: AgentPermissionDecision,
  ): boolean;
  rename(title: string): void;
  reconnect(): void;
  retry(errorBlockId: string): boolean;
  /** Takes a sent prompt back into the composer: its text, bound context and
   *  armed skill become a new draft. Refused while busy, when another draft
   *  needs keeping, or when the block is not a prompt. */
  editPrompt(blockId: string): boolean;
  addContext(item: AgentContextItem): void;
  removeContext(key: string): void;
  /** Asks the composer to take focus, or with false records that it did. */
  requestComposerFocus(requested?: boolean): void;
  /** Uploads transient files and binds each successful one to the draft. */
  attachFiles(files: File[]): Promise<void>;
  /** The File behind an upload bound in this session, for thumbnails. */
  fileForTransient(path: string): File | undefined;
  /** Validates and resolves the bound context, then sends the prompt. A
   *  queued id sends that prompt's own context snapshot. */
  sendPrompt(text?: string, options?: { queuedId?: string }): Promise<AgentSendResult>;
  setAccessMode(mode: AgentAccessMode): void;
  setEffort(effort: string | null): void;
  /** Restarts a started session on its own conversation so it runs under the
   *  project's persona as stored now. The runtime reads the persona only when
   *  a session starts; an unstarted one picks it up on its own. */
  applyPersona(): void;
  setModel(model: string | null): void;
  /** Arms a catalog skill for the next turn, or disarms with null. */
  setSkill(skill: string | null): void;
  /** Asks a live runtime to re-read the skills it can run in this scope. */
  refreshSkills(): void;
  /** Gives an unstarted session the catalog the service remembers for its
   *  runtime, so the composer names the model and level before a session
   *  exists. A started session takes its catalog from the socket instead,
   *  so this is refused once the connection has left its draft state. */
  seedModels(models: readonly AgentModel[]): void;
  setDraft(draft: string): void;
  setQueue(queue: QueueEntry[]): void;
  restore(entry: AgentHistoryEntry, connectWhenReady?: boolean): Promise<boolean>;
  retire(folderPath: string): void;
  start(): void;
  dispose(): void;
}

export interface AgentSessionRuntimeOptions {
  recordUsage?: ((event: AgentUsageEvent) => void) | undefined;
  agent: AgentId;
  autostart?: boolean | undefined;
  context?: AgentContextPort | undefined;
  environment?: (() => AgentSessionEnvironment | null) | undefined;
  id: string;
  /** Called after a write tool settles successfully or a native diff
   *  arrives, so the shell can refresh what the change touched. */
  onFilesChanged?: ((change: AgentFilesChanged) => void) | undefined;
  /** Explicit composer choices only; native replay and catalog defaults do not save preferences. */
  onEffortChange?: ((scope: AgentScope, agent: AgentId, effort: string | null) => void) | undefined;
  port: AgentSessionPort;
  scheduler?: AgentReconnectScheduler | undefined;
  scope: AgentScope;
  title?: string | undefined;
}
