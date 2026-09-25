/** Pure session transitions keep transport state separate from turn outcomes. */
import { supportedEffort } from './model-choice';
import {
  agentActiveTurn,
  agentTurnIsActive,
  skillCatalogOf,
  agentSkills,
} from './session-selectors';
export {
  agentReconnectAttempt,
  agentTurnIsActive,
  agentCanSend,
  agentSessionPhase,
  agentSkills,
  agentSessionIsUnstarted,
  agentCanChangeAgent,
  agentSessionIsBlank,
  agentScopesEqual,
  scopeForWindowFolder,
  agentScopeKey,
  scopeLabel,
  agentWorkStatus,
  agentSessionIsBusy,
} from './session-selectors';
/** The Agent session reducer and the selectors that read its state. Every
 *  action lands in one exhaustive switch: transcript work is delegated to
 *  `session-transcript`, the connection moves as one discriminated union, and
 *  the composer, catalog and scope fields are edited in place. Selectors are
 *  the only way anything outside the domain asks a question about a session,
 *  so the union's shape stays an implementation detail of this module. */
import { revisionProposalForTool } from './file-change';
import {
  MAX_QUEUED_PROMPTS,
  type AgentActiveTurn,
  type AgentConnection,
  type AgentSessionAction,
  type AgentSessionState,
} from './session-state';
import {
  appendBlock,
  appendStreamingBlock,
  appendToolOutput,
  finishTool,
  recordFileChange,
  recordRevisionProposal,
  replyToolPermission,
  requestToolPermission,
  settledToolName,
  settleErrorBlock,
  settlePendingTools,
  stampClosingReply,
  startTool,
} from './session-transcript';

export {
  createAgentSessionState,
  UNTITLED_CHAT_TITLE,
  type AgentConnection,
  type AgentId,
  type AgentQueuedPrompt,
  type AgentScope,
  type AgentSessionAction,
  type AgentSessionEvent,
  type AgentSessionPhase,
  type AgentSessionState,
  type AgentSkillCatalog,
} from './session-state';

import type { AgentTranscriptBlock } from './session-transcript';

export {
  agentTurnFailureIsRetryable,
  latestUserBlock,
  type AgentTranscriptBlock,
} from './session-transcript';

/** Moves the turn inside a live connection. Any other connection has no turn
 *  to move, so turn actions arriving late are ignored rather than forging a
 *  live state the transport is not in. */
function withTurn(connection: AgentConnection, turn: AgentActiveTurn | null): AgentConnection {
  return connection.kind === 'live' ? { kind: 'live', turn } : connection;
}

// Reducer

export function transitionAgentSession(
  state: AgentSessionState,
  action: AgentSessionAction,
): AgentSessionState {
  switch (action.kind) {
    case 'connect':
      return {
        ...state,
        queuePaused: state.queuePaused || agentTurnIsActive(state.connection),
        delivery: agentTurnIsActive(state.connection) ? 'unknown' : state.delivery,
        connection: { attempt: action.attempt, kind: 'connecting' },
      };
    case 'schedule-reconnect':
      return {
        ...state,
        queuePaused: true,
        delivery: agentTurnIsActive(state.connection)
          ? 'unknown'
          : state.delivery === 'preparing'
            ? 'failed'
            : state.delivery,
        connection: { attempt: action.attempt, kind: 'reconnecting' },
      };
    case 'ready':
      return { ...state, connection: { kind: 'live', turn: null } };
    case 'identified':
      return { ...state, nativeSessionId: action.id };
    case 'rename':
      return { ...state, title: action.title.trim() || state.title, titleEdited: true };
    case 'titled':
      return state.titleEdited || /^(new chat|untitled)$/i.test(action.title.trim())
        ? state
        : { ...state, title: action.title.trim() || state.title };
    case 'delivery':
      return { ...state, delivery: action.value };
    case 'pause-queue':
      return { ...state, queuePaused: action.paused };
    case 'reset-draft-connection':
      return { ...state, connection: { kind: 'draft' }, delivery: 'idle' };
    case 'select-agent':
      return {
        ...state,
        agent: action.agent,
        nativeSessionId: null,
        models: [],
        model: null,
        activeModel: null,
        effort: null,
        skill: null,
        skillCatalog: { kind: 'empty' },
      };
    case 'set-access-mode':
      return { ...state, accessMode: action.mode };
    case 'set-model':
      return { ...state, model: action.model };
    case 'set-effort':
      return { ...state, effort: action.effort };
    case 'models': {
      const catalogIds = new Set(action.models.map((model) => model.id));
      const next = {
        ...state,
        activeModel: action.activeModel ?? state.activeModel,
        models: action.models,
        model:
          action.fallback || (state.model && !catalogIds.has(state.model)) ? null : state.model,
      };
      return { ...next, effort: supportedEffort(next, state.effort) };
    }
    case 'skills': {
      const catalogIds = new Set(action.skills.map((skill) => skill.id));
      return {
        ...state,
        skill: state.skill && !catalogIds.has(state.skill) ? null : state.skill,
        skillCatalog: skillCatalogOf(action),
      };
    }
    case 'set-skill':
      return {
        ...state,
        skill:
          action.skill && agentSkills(state.skillCatalog).some((skill) => skill.id === action.skill)
            ? action.skill
            : null,
      };
    case 'set-draft':
      return { ...state, contextIssue: null, draft: action.draft };
    case 'set-context':
      return { ...state, context: action.context, contextIssue: null };
    case 'set-context-issue':
      return { ...state, contextIssue: action.message };
    case 'request-composer-focus':
      return { ...state, composerFocusRequested: action.requested };
    case 'set-queue':
      return { ...state, queuedPrompts: action.queue.slice(0, MAX_QUEUED_PROMPTS) };
    case 'submit-prompt':
      return {
        ...state,
        connection: withTurn(state.connection, { promptBlockId: action.id }),
        delivery: 'idle',
        title: !state.titleEdited && action.titleHint ? action.titleHint : state.title,
        context: action.clearDraft === false ? state.context : [],
        contextIssue: null,
        draft: action.clearDraft === false ? state.draft : '',
        skill: action.clearDraft === false ? state.skill : null,
        transcript: appendBlock(state.transcript, {
          at: action.at,
          ...(action.context.length > 0 ? { context: action.context } : {}),
          id: action.id,
          kind: 'user',
          text: action.text,
        }),
      };
    case 'turn-started':
      return {
        ...state,
        connection: withTurn(
          state.connection,
          agentActiveTurn(state.connection) ?? { promptBlockId: null },
        ),
      };
    case 'append-text':
      return {
        ...state,
        transcript: appendStreamingBlock(state.transcript, 'assistant', action.id, action.delta),
      };
    case 'append-thinking':
      return {
        ...state,
        transcript: appendStreamingBlock(state.transcript, 'thinking', action.id, action.delta),
      };
    case 'tool-started':
      return sameTranscript(state, startTool(state.transcript, action));
    case 'tool-output':
      return {
        ...state,
        transcript: appendToolOutput(state.transcript, action.id, action.delta),
      };
    case 'tool-finished':
      return { ...state, transcript: finishedToolTranscript(state, action) };
    case 'file-changed':
      return sameTranscript(state, recordFileChange(state.transcript, action));
    case 'permission-requested':
      return { ...state, transcript: requestToolPermission(state.transcript, action) };
    case 'reply-permission':
      return {
        ...state,
        transcript: replyToolPermission(
          state.transcript,
          action.toolUseId,
          action.allow,
          action.answers,
        ),
      };
    case 'settle-turn':
      return {
        ...state,
        connection: withTurn(state.connection, null),
        delivery:
          state.delivery === 'stopping'
            ? 'stopped'
            : state.delivery === 'failed' || action.isError
              ? 'failed'
              : 'completed',
        queuePaused: state.queuePaused || action.isError || state.delivery === 'stopping',
        transcript: stampClosingReply(
          settlePendingTools(
            state.transcript,
            state.delivery === 'stopping' ? 'cancelled' : action.isError ? 'error' : 'done',
          ),
          action.at,
        ),
      };
    case 'append-notice':
      return {
        ...state,
        transcript: appendBlock(state.transcript, {
          id: action.id,
          kind: 'notice',
          text: action.message,
        }),
      };
    case 'turn-fail':
      return {
        ...state,
        delivery: 'failed',
        queuePaused: true,
        connection: withTurn(state.connection, null),
        transcript: appendBlock(settlePendingTools(state.transcript, 'error'), {
          failure: action.failure,
          id: action.id,
          kind: 'error',
          retryablePrompt: action.retryablePrompt,
          text: action.message,
        }),
      };
    case 'settle-error':
      return { ...state, transcript: settleErrorBlock(state.transcript, action.id) };
    case 'fail':
      return {
        ...state,
        queuePaused: true,
        delivery:
          agentTurnIsActive(state.connection) || state.delivery === 'unknown'
            ? 'unknown'
            : 'failed',
        connection: { kind: 'failed', message: action.message },
        transcript: settlePendingTools(state.transcript, 'error'),
      };
    case 'close':
      return {
        ...state,
        queuePaused: true,
        delivery:
          agentTurnIsActive(state.connection) || state.delivery === 'unknown'
            ? 'unknown'
            : action.message || state.delivery === 'preparing'
              ? 'failed'
              : state.delivery,
        connection: { kind: 'closed', message: action.message },
        transcript: settlePendingTools(state.transcript, 'error'),
      };
    case 'begin-restore':
      return {
        ...state,
        connection: { kind: 'restoring' },
        delivery: state.delivery === 'unknown' ? 'unknown' : 'idle',
        title: action.title,
        titleEdited: true,
      };
    case 'restore':
      return {
        ...state,
        effort: action.effort,
        lastModified: action.lastModified,
        nativeSessionId: action.nativeSessionId,
        transcript: action.transcript,
      };
    case 'retire':
      return {
        ...state,
        connection: { kind: 'retired' },
        delivery: 'stopped',
        queuePaused: true,
        contextIssue: null,
        queuedPrompts: [],
        transcript: retiredTranscript(state),
      };
    case 'dispose':
      return { ...state, connection: { kind: 'disposed' } };
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

/** What a settled tool leaves behind. A `suggest_edits` that parked a revision
 *  also leaves one to decide inside the document, which its own answer is what
 *  says. A tool that ended in error parks nothing. */
function finishedToolTranscript(
  state: AgentSessionState,
  action: Extract<AgentSessionAction, { kind: 'tool-finished' }>,
): AgentTranscriptBlock[] {
  const name = settledToolName(state.transcript, action.id);
  const settled = finishTool(state.transcript, action.id, action.content, action.isError);
  const proposal = action.isError || !name ? null : revisionProposalForTool(name, action.content);
  return proposal === null
    ? settled
    : recordRevisionProposal(settled, {
        id: action.id,
        path: proposal.path,
        proposalId: proposal.id,
      });
}

/** An edit a transcript helper declined to make leaves the state itself
 *  untouched, so a repeated event costs no subscriber a re-render. */
function sameTranscript(
  state: AgentSessionState,
  transcript: AgentTranscriptBlock[],
): AgentSessionState {
  return transcript === state.transcript ? state : { ...state, transcript };
}

/** Retirement cancels whatever was running and says how many queued messages
 *  went with the folder, so the transcript explains its own ending. */
function retiredTranscript(state: AgentSessionState) {
  const cancelled = settlePendingTools(state.transcript, 'cancelled');
  if (state.queuedPrompts.length === 0) return cancelled;
  const count = state.queuedPrompts.length;
  return appendBlock(cancelled, {
    id: `${state.id}-retired-queue`,
    kind: 'notice',
    text: `${count} queued ${count === 1 ? 'message was' : 'messages were'} cancelled when this folder was removed.`,
  });
}
