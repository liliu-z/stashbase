/** Follow-ups the reader sends into a running turn. Each waits as a steer
 *  until the runtime answers: taken, it becomes a user message at that point
 *  in the transcript; not taken, it goes next, ahead of the queue. */
import {
  MAX_QUEUED_PROMPTS,
  type AgentSessionAction,
  type AgentSessionState,
} from './session-state';
import { appendBlock } from './session-transcript';

type FollowUpAction = Extract<
  AgentSessionAction,
  { kind: 'steer-sent' | 'steer-taken' | 'steer-returned' }
>;

/** A turn that ends, or a connection that drops, before its runtime took a
 *  follow-up sends that follow-up next instead, ahead of anything queued. */
export function returnSteers(
  state: AgentSessionState,
): Pick<AgentSessionState, 'queuedPrompts' | 'steers'> {
  return state.steers.length === 0
    ? { queuedPrompts: state.queuedPrompts, steers: state.steers }
    : { queuedPrompts: [...state.steers, ...state.queuedPrompts], steers: [] };
}

/** The bound stops the queue growing. Follow-ups a turn handed back can
 *  already exceed it, and a later reorder or removal keeps them. */
export function boundedQueue(
  state: AgentSessionState,
  queue: AgentSessionState['queuedPrompts'],
): AgentSessionState['queuedPrompts'] {
  return queue.slice(0, Math.max(MAX_QUEUED_PROMPTS, state.queuedPrompts.length));
}

export function transitionFollowUp(
  state: AgentSessionState,
  action: FollowUpAction,
): AgentSessionState {
  switch (action.kind) {
    case 'steer-sent':
      return {
        ...state,
        context: [],
        contextIssue: null,
        draft: '',
        steers: [...state.steers, action.prompt],
      };
    case 'steer-taken': {
      const prompt = state.steers.find((item) => item.id === action.id);
      if (!prompt) return state;
      return {
        ...state,
        steers: state.steers.filter((item) => item !== prompt),
        transcript: appendBlock(state.transcript, {
          at: action.at,
          ...(prompt.context.length > 0 ? { context: prompt.context } : {}),
          id: action.blockId,
          followUp: true,
          kind: 'user',
          text: prompt.text,
        }),
      };
    }
    case 'steer-returned': {
      const prompt = state.steers.find((item) => item.id === action.id);
      if (!prompt) return state;
      return {
        ...state,
        queuedPrompts: [prompt, ...state.queuedPrompts],
        steers: state.steers.filter((item) => item !== prompt),
      };
    }
  }
}
