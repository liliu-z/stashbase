/** What one Agent conversation is: its scope, its bound draft, and — as a
 *  single discriminated union — where its connection stands. Modelling the
 *  connection as one value is what keeps "live with a running turn" and
 *  "failed with a reason" from being spellable at the same time, which the
 *  four independent flags this replaced could not prevent. */
import type { AgentAccessMode } from '@/features/agent/domain/access';
import type { AgentContextItem } from '@/features/agent/domain/context';
import type { AgentModel, AgentSkill } from '@/features/agent/domain/runtime-catalog';
import type {
  AgentTranscriptBlock,
  AgentTurnFailureReason,
} from '@/features/agent/domain/session-transcript';
import type { AgentId } from '@/shared/domain/agent-id';

export type { AgentId };

export type AgentScope = { kind: 'folder'; path: string };

export const MAX_QUEUED_PROMPTS = 20;

/** What a conversation is called before it has a name of its own: the same
 *  word an unnamed document takes, so nothing unnamed reads as an action. */
export const UNTITLED_CHAT_TITLE = 'Untitled';

/** The turn the runtime is streaming right now. A turn exists only while the
 *  connection is live, which is why it lives inside that member. */
export interface AgentActiveTurn {
  /** Transcript id of the user block this turn answers, when it has one. A
   *  turn the runtime opened by itself answers no particular prompt. */
  promptBlockId: string | null;
}

/** Where the conversation's transport stands. Every member carries exactly
 *  what that state means and nothing else: an attempt count belongs to a
 *  connection being retried, a message to one that stopped. */
export type AgentConnection =
  | { kind: 'draft' }
  | { kind: 'restoring' }
  | { kind: 'connecting'; attempt: number }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'live'; turn: AgentActiveTurn | null }
  | { kind: 'closed'; message: string | null }
  | { kind: 'failed'; message: string }
  | { kind: 'retired' }
  | { kind: 'disposed' };

/** The coarse label tabs and status rows read. It is derived from the
 *  connection, never stored beside it. */
export type AgentSessionPhase =
  | 'draft'
  | 'restoring'
  | 'connecting'
  | 'live'
  | 'closed'
  | 'retired'
  | 'disposed';

type AgentSkillCatalogState = 'available' | 'empty' | 'failed';

/** What the runtime last said about the skills it can run in this scope.
 *  Every member carries exactly what that answer means and nothing else:
 *  only a stocked catalog has skills, only a failed read has a reason, and
 *  neither can be spelled with the other's payload. A failed load is a state
 *  the picker shows, not a transcript notice. */
export type AgentSkillCatalog =
  | { kind: 'empty' }
  | { kind: 'available'; skills: AgentSkill[] }
  | { kind: 'failed'; message: string };

export interface AgentQueuedPrompt {
  id: string;
  text: string;
  /** Snapshot of the bound context taken when the prompt was queued. */
  context: AgentContextItem[];
  /** Skill armed when the prompt was queued, by id; null when none was. */
  skill: string | null;
}

export interface AgentSessionState {
  readonly id: string;
  readonly agent: AgentId;
  readonly scope: AgentScope;
  title: string;
  titleEdited: boolean;
  delivery: 'idle' | 'preparing' | 'stopping' | 'stopped' | 'completed' | 'failed' | 'unknown';
  queuePaused: boolean;
  accessMode: AgentAccessMode;
  draft: string;
  /** Bound context for the draft: mentioned sources and transient uploads. */
  context: AgentContextItem[];
  /** Why the last send or attach was refused; cleared by any draft change. */
  contextIssue: string | null;
  /** Set when something outside the composer bound context for the reader to
   *  write about; the composer takes focus and clears it, even when it mounts
   *  after the request. */
  composerFocusRequested: boolean;
  queuedPrompts: AgentQueuedPrompt[];
  nativeSessionId: string | null;
  transcript: AgentTranscriptBlock[];
  lastModified: number;
  models: AgentModel[];
  model: string | null;
  activeModel: string | null;
  skillCatalog: AgentSkillCatalog;
  /** The skill armed for the next turn, by id; a skill applies to one turn. */
  skill: string | null;
  effort: string | null;
  connection: AgentConnection;
}

export function createAgentSessionState(options: {
  id: string;
  agent: AgentId;
  scope: AgentScope;
  title?: string | undefined;
}): AgentSessionState {
  if (!options.id.trim()) throw new Error('Agent session id must not be empty.');
  if (options.scope.kind === 'folder' && !options.scope.path.trim()) {
    throw new Error('Agent folder scope must not be empty.');
  }
  return {
    id: options.id,
    agent: options.agent,
    scope: options.scope,
    title: options.title?.trim() || UNTITLED_CHAT_TITLE,
    titleEdited: false,
    delivery: 'idle',
    queuePaused: false,
    accessMode: 'auto',
    connection: { kind: 'draft' },
    draft: '',
    context: [],
    contextIssue: null,
    composerFocusRequested: false,
    queuedPrompts: [],
    nativeSessionId: null,
    transcript: [],
    lastModified: 0,
    models: [],
    model: null,
    activeModel: null,
    skillCatalog: { kind: 'empty' },
    skill: null,
    effort: null,
  };
}

/**
 * Events the reducer applies unchanged.
 *
 * Each member is state the runtime reported and nothing else has to decide,
 * so it reaches `transitionAgentSession` exactly as it arrived. These used to
 * be spelled twice — once as an event, once as an action with a different
 * name and the same payload — with a hand-written map between them; the map
 * was the only thing that could disagree, so it is gone.
 */
type AgentSessionStateEvent =
  | { kind: 'ready' }
  | { kind: 'identified'; id: string }
  | { kind: 'titled'; title: string }
  | {
      kind: 'models';
      models: AgentModel[];
      activeModel: string | null;
      fallback: string | null;
    }
  | {
      kind: 'skills';
      skills: AgentSkill[];
      state: AgentSkillCatalogState;
      error: string | null;
    }
  | { kind: 'turn-started' }
  | { kind: 'tool-started'; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'tool-output'; id: string; delta: string }
  | { kind: 'tool-finished'; id: string; content: string; isError: boolean }
  | {
      /** A whole-file change the runtime reports on its own, beside any
       *  tool call: OpenQuill's native diffs. */
      kind: 'file-changed';
      id: string;
      path: string;
      before: string;
      after: string;
      additions: number;
      deletions: number;
    }
  | {
      kind: 'permission-requested';
      id: string;
      toolUseId: string;
      name: string;
      title: string | null;
      input: Record<string, unknown>;
    };

/** Events the application layer has to interpret before any state moves: a
 *  stream delta that needs a fresh transcript block id, a failure that reads
 *  differently inside and outside a turn, a turn's end that is stamped with
 *  the clock it settled at, or an ending that also has to settle the
 *  transport. */
type AgentSessionStreamEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'notice'; message: string }
  | { kind: 'failed'; failure?: AgentTurnFailureReason | undefined; message: string }
  | { kind: 'turn-ended'; isError: boolean }
  | { kind: 'exited'; message: string | null }
  | { kind: 'scope-retired'; folderPath: string };

export type AgentSessionEvent = AgentSessionStateEvent | AgentSessionStreamEvent;

/** Changes only this window can decide: what the composer holds, which turn
 *  the transport is opening, and how a stream event was interpreted. */
type AgentSessionLocalAction =
  | { kind: 'connect'; attempt: number }
  | { kind: 'schedule-reconnect'; attempt: number }
  | { kind: 'set-access-mode'; mode: AgentAccessMode }
  | { kind: 'set-model'; model: string | null }
  | { kind: 'set-effort'; effort: string | null }
  | { kind: 'set-skill'; skill: string | null }
  | { kind: 'set-draft'; draft: string }
  | { kind: 'select-agent'; agent: AgentId }
  | { kind: 'reset-draft-connection' }
  | { kind: 'rename'; title: string }
  | { kind: 'delivery'; value: AgentSessionState['delivery'] }
  | { kind: 'pause-queue'; paused: boolean }
  | { kind: 'set-context'; context: AgentContextItem[] }
  | { kind: 'set-context-issue'; message: string | null }
  | { kind: 'request-composer-focus'; requested: boolean }
  | { kind: 'set-queue'; queue: AgentQueuedPrompt[] }
  | {
      kind: 'submit-prompt';
      id: string;
      text: string;
      context: AgentContextItem[];
      at: number;
      clearDraft?: boolean;
      titleHint?: string;
    }
  | { kind: 'append-text'; id: string; delta: string }
  | { kind: 'append-thinking'; id: string; delta: string }
  | {
      kind: 'reply-permission';
      toolUseId: string;
      allow: boolean;
      answers?: Record<string, string> | undefined;
    }
  | { kind: 'append-notice'; id: string; message: string }
  | {
      /** The wire's turn end, stamped with when it settled so the reply that
       *  closes the turn can say so. */
      kind: 'settle-turn';
      isError: boolean;
      at: number;
    }
  | {
      kind: 'turn-fail';
      id: string;
      failure?: AgentTurnFailureReason | undefined;
      message: string;
      retryablePrompt?: string | undefined;
    }
  | { kind: 'settle-error'; id: string }
  | { kind: 'fail'; message: string }
  | { kind: 'close'; message: string | null }
  | { kind: 'begin-restore'; title: string }
  | {
      kind: 'restore';
      effort: string | null;
      lastModified: number;
      nativeSessionId: string;
      transcript: AgentTranscriptBlock[];
    }
  | { kind: 'retire' }
  | { kind: 'dispose' };

export type AgentSessionAction = AgentSessionStateEvent | AgentSessionLocalAction;
