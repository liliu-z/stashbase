/** The agent feature's ports: the services a conversation, its catalog,
 *  personas, tools, and context reach through, each implemented in
 *  `infrastructure/`. */
import type {
  AgentContextExtra,
  AgentHistoryExtra,
} from '@/features/agent/application/failure-messages';
import type { AgentAccessMode } from '@/features/agent/domain/access';
import type { AgentCatalog } from '@/features/agent/domain/agent-catalog';
import type { AgentHistoryEntry } from '@/features/agent/domain/conversation-history';
import type { ResolvedContextFile as ResolvedContextText } from '@/features/agent/domain/prompt-context';
import type {
  ProjectSchedule,
  ScheduledRunOutcome,
  ScheduledRunRequest,
  ScheduledTaskDraft,
  ScheduledTurnOutcome,
} from '@/features/agent/domain/scheduled-tasks';
import type {
  AgentId,
  AgentScope,
  AgentSessionEvent,
  AgentTranscriptBlock,
} from '@/features/agent/domain/session';
import type { AgentSessionCommand } from '@/features/agent/domain/session-command';
import { featureErrorClass, type FeatureError } from '@/shared/domain/feature-error';
import type { PersonaIconName } from '@/shared/domain/persona-icon';
import type { SourceReference } from '@/shared/domain/source-reference';

/** One persona in the reader's library. */
export interface AgentPersona {
  readonly id: string;
  readonly name: string;
  /** One line under the name in the picker. */
  readonly description: string;
  readonly icon: PersonaIconName;
  /** The exact text a session receives. */
  readonly prompt: string;
  /** The Gallery entry it was copied from; null for the reader's own. */
  readonly gallery: string | null;
}

/** What a create or an edit sends. */
export interface AgentPersonaInput {
  readonly name: string;
  readonly description: string;
  readonly icon: PersonaIconName;
  readonly prompt: string;
  readonly gallery?: string | null | undefined;
}

/** The reader's persona library, shared by every project. Which persona a
 *  Chat runs under is session state; the service composes the real prompt. */
/** A Default Agent tool from the service's catalog, which the main agent
 *  may call once the user turns it on, on a model from the tool model pool. */
export interface AgentTool {
  readonly id: string;
  readonly label: string;
  /** The function name the main agent calls it by. */
  readonly toolName: string;
  /** The short line the tools list shows. */
  readonly summary: string;
  /** A generic icon name; an unknown one falls back. */
  readonly icon: string;
  /** Whether the user turned it on. Every tool starts off. */
  readonly enabled: boolean;
  /** Why it cannot be used at all right now, or null. */
  readonly unavailable: string | null;
  /** The model it runs on, or would once on; null when none can be used. */
  readonly model: string | null;
  /** Why the user must choose a model first, or null. */
  readonly modelProblem: string | null;
  /** The model it runs on until the user picks another. */
  readonly defaultModel: string | null;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly available: boolean;
    readonly reason: string | null;
  }[];
}

/** One change to a tool: turn it on or off, pick its model, or both. */
export interface AgentToolChange {
  readonly enabled?: boolean;
  readonly model?: string;
}

/** Which tools Default's main agent has. A change answers every tool as the
 *  service now resolves it, and applies to chats started or reconnected. */
export interface AgentToolsPort {
  list(signal: AbortSignal, chat: string): Promise<readonly AgentTool[]>;
  set(
    tool: AgentTool['id'],
    change: AgentToolChange,
    signal: AbortSignal,
    chat: string,
  ): Promise<readonly AgentTool[]>;
}

export interface AgentPersonaPort {
  list(signal: AbortSignal): Promise<AgentPersona[]>;
  create(input: AgentPersonaInput, signal: AbortSignal): Promise<AgentPersona>;
  update(id: string, input: AgentPersonaInput, signal: AbortSignal): Promise<AgentPersona>;
  remove(id: string, signal: AbortSignal): Promise<void>;
}

export interface AgentCatalogPort {
  listAgents(signal: AbortSignal): Promise<AgentCatalog>;
  /** Starts a preparation step, or `stop`s waiting on one the reader started,
   *  such as a browser sign-in; the answer is the catalog that follows. */
  prepareAgent(
    id: AgentId,
    action: 'bootstrap' | 'login' | 'stop' | 'update',
    signal: AbortSignal,
  ): Promise<AgentCatalog>;
}

interface AgentReplay {
  transcript: AgentTranscriptBlock[];
  effort: string | null;
  /** The persona this Chat last ran under, when it still exists. */
  persona?: string | null | undefined;
}

export interface AgentSocket {
  close(): void;
  send?(command: AgentSessionCommand): boolean;
}

export interface AgentConnectionListener {
  telemetryTurnId?(): string | undefined;
  onEvent(event: AgentSessionEvent): void;
  onClose(): void;
  onInvalidResponse(): void;
}

/** What opening a session needs: which runtime, over which scope, and the
 *  optional turn settings. Named here rather than restated at the call sites,
 *  so the adapter that builds the socket URL maps this one shape. */
export interface AgentConnectRequest {
  agent: AgentId;
  scope: AgentScope;
  resume?: string | undefined;
  effort?: string | undefined;
  model?: string | undefined;
  access?: AgentAccessMode | undefined;
  persona?: string | undefined;
  crew?: string | undefined;
}

export interface AgentSessionPort {
  connect(request: AgentConnectRequest, listener: AgentConnectionListener): AgentSocket;
  list(agent: AgentId, scope: AgentScope, signal: AbortSignal): Promise<AgentHistoryEntry[]>;
  replay(entry: AgentHistoryEntry, signal: AbortSignal): Promise<AgentReplay>;
  rename(entry: AgentHistoryEntry, title: string, signal: AbortSignal): Promise<AgentHistoryEntry>;
  remove(entry: AgentHistoryEntry, signal: AbortSignal): Promise<void>;
}

export interface AgentReconnectScheduler {
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
  jitter(delayMs: number): number;
}

export type AgentSessionError = FeatureError;
export const AgentSessionError = featureErrorClass('AgentSessionError');

export type AgentHistoryError = FeatureError<AgentHistoryExtra>;
export const AgentHistoryError = featureErrorClass<AgentHistoryExtra>('AgentHistoryError');

export type AgentContextError = FeatureError<AgentContextExtra>;
export const AgentContextError = featureErrorClass<AgentContextExtra>('AgentContextError');

/** The domain's resolved file plus the member folder label the route names. */
export interface ResolvedContextFile extends ResolvedContextText {
  readonly folder: string;
}

export interface AgentUploadOutcome {
  readonly error?: string | undefined;
  readonly name: string;
  readonly path?: string | undefined;
}

export interface AgentContextPort {
  /** Resolves one project source to what the Agent should read. A missing
   *  file is `not-found`; a format the Agent cannot read is `unsupported`. */
  resolve(
    source: SourceReference,
    signal: AbortSignal,
    telemetryTurnId?: string,
  ): Promise<ResolvedContextFile>;
  /** Uploads transient files outside every project folder; outcomes follow
   *  request order. */
  upload(files: File[], signal: AbortSignal, folderPath: string): Promise<AgentUploadOutcome[]>;
}

/** Explicit choices only: opening history and catalog readiness never write this. */
export interface ProjectAgentPreference {
  scope: string;
  agent: AgentId;
  models?: Partial<Record<AgentId, string | null | undefined>> | undefined;
  efforts?: Partial<Record<AgentId, string | null | undefined>> | undefined;
  /** The persona this project's next new Chat starts with. */
  persona?: string | null | undefined;
}

export interface AgentPreferencesPort {
  load(signal: AbortSignal): Promise<{
    defaultAgent: AgentId;
    defaultModels?: ProjectAgentPreference['models'];
    defaultEfforts?: ProjectAgentPreference['efforts'];
    projects: ProjectAgentPreference[];
  }>;
  save(
    scope: AgentScope,
    agent: AgentId,
    signal: AbortSignal,
    change?: { model?: string | null; effort?: string | null; persona?: string | null },
  ): Promise<void>;
}

/** `conflict`: the task file changed since it was read. `invalid-file`: the
 *  file cannot be read as tasks, so the form will not write it. `invalid-task`:
 *  the task itself was refused. `not-found`: the task left the file. */
export type ScheduledTasksExtra = 'conflict' | 'invalid-file' | 'invalid-task' | 'not-found';
export type ScheduledTasksError = FeatureError<ScheduledTasksExtra>;
export const ScheduledTasksError = featureErrorClass<ScheduledTasksExtra>('ScheduledTasksError');

/** Run now's answer: how the run went, or why it could not be asked for. */
export type ScheduledRunNowResult =
  | { readonly ok: true; readonly outcome: ScheduledRunOutcome }
  | { readonly ok: false; readonly message: string };

/** A project's task list: read and edited through the server, which owns the
 *  task file and this computer's switches; Run now goes through main, which
 *  owns every run. */
export interface ScheduledTasksPort {
  read(folderPath: string, signal: AbortSignal): Promise<ProjectSchedule>;
  save(
    folderPath: string,
    baseVersion: string | null,
    draft: ScheduledTaskDraft,
    signal: AbortSignal,
  ): Promise<{ schedule: ProjectSchedule; taskId: string }>;
  remove(
    folderPath: string,
    baseVersion: string | null,
    taskId: string,
    signal: AbortSignal,
  ): Promise<ProjectSchedule>;
  setEnabled(
    folderPath: string,
    taskId: string,
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<ProjectSchedule>;
  runNow(folderPath: string, taskId: string): Promise<ScheduledRunNowResult>;
  /** Reports how a sent run's first turn ended, so the list keeps it. */
  settle(
    folderPath: string,
    taskId: string,
    runId: string,
    outcome: ScheduledTurnOutcome,
    signal: AbortSignal,
  ): Promise<void>;
}

/** The runs main asks this window to start. */
export interface ScheduledRunsPort {
  onRunRequested(
    handler: (request: ScheduledRunRequest) => Promise<ScheduledRunOutcome>,
  ): () => void;
}
