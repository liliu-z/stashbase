import type { AgentContextExtra } from '@/features/agent/application/failure-messages';
import type { AgentAccessMode } from '@/features/agent/domain/access';
import type { AgentCatalog } from '@/features/agent/domain/agent-catalog';
import type { AgentHistoryEntry } from '@/features/agent/domain/conversation-history';
import type { ResolvedContextFile as ResolvedContextText } from '@/features/agent/domain/prompt-context';
import type {
  AgentId,
  AgentScope,
  AgentSessionEvent,
  AgentTranscriptBlock,
} from '@/features/agent/domain/session';
import type { AgentSessionCommand } from '@/features/agent/domain/session-command';
import { featureErrorClass, type FeatureError } from '@/shared/domain/feature-error';
import type { SourceReference } from '@/shared/domain/source-reference';

/** A packaged persona, or the reader's own prompt for the project. */
export type AgentPersonaChoice = 'marketer' | 'journalist' | 'storyteller' | 'custom';

/** The persona a scope's Chats run under: which one is chosen and the
 *  reader's own prompt, never the resolved text. The runtime composes the
 *  real prompt server-side, so nothing here is the text a turn carries. */
export interface AgentPersona {
  /** Null runs no persona. */
  readonly selected: AgentPersonaChoice | null;
  /** Kept while a packaged persona is chosen, so Custom can return to it. */
  readonly custom: string;
}

export interface AgentPersonaChange {
  readonly selected?: AgentPersonaChoice | null;
  readonly custom?: string;
}

export interface AgentPersonaPort {
  load(scope: AgentScope, signal: AbortSignal): Promise<AgentPersona>;
  save(scope: AgentScope, change: AgentPersonaChange, signal: AbortSignal): Promise<AgentPersona>;
}

export interface AgentCatalogPort {
  listAgents(signal: AbortSignal): Promise<AgentCatalog>;
  prepareAgent(
    id: AgentId,
    action: 'bootstrap' | 'login' | 'update',
    signal: AbortSignal,
  ): Promise<AgentCatalog>;
}

interface AgentReplay {
  transcript: AgentTranscriptBlock[];
  effort: string | null;
}

export interface AgentSocket {
  close(): void;
  send?(command: AgentSessionCommand): boolean;
}

export interface AgentConnectionListener {
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
  resolve(source: SourceReference, signal: AbortSignal): Promise<ResolvedContextFile>;
  /** Uploads transient files outside every project folder; outcomes follow
   *  request order. */
  upload(files: File[], signal: AbortSignal): Promise<AgentUploadOutcome[]>;
}

/** Explicit choices only: opening history and catalog readiness never write this. */
export interface ProjectAgentPreference {
  scope: string;
  agent: AgentId;
  efforts?: Partial<Record<AgentId, string | null | undefined>> | undefined;
}

export interface AgentPreferencesPort {
  load(signal: AbortSignal): Promise<ProjectAgentPreference[]>;
  save(
    scope: AgentScope,
    agent: AgentId,
    signal: AbortSignal,
    effort?: string | null,
  ): Promise<void>;
}
