import type { AgentTranscriptBlock } from '@/features/agent/domain/session';

import type { AgentActivityStep } from './activity';

/** The last assistant reply of each settled turn and its prompt time. */
export function closingReplies(
  blocks: AgentTranscriptBlock[],
  activeTurn: boolean,
): Map<string, number | undefined> {
  const replies = new Map<string, number | undefined>();
  let promptAt: number | undefined;
  let lastReply: string | null = null;
  for (const block of blocks) {
    if (block.kind === 'user' && !block.followUp) {
      if (lastReply) replies.set(lastReply, promptAt);
      lastReply = null;
      promptAt = block.at;
    } else if (block.kind === 'assistant') {
      lastReply = block.id;
    }
  }
  if (lastReply && !activeTurn) replies.set(lastReply, promptAt);
  return replies;
}

export type TranscriptGroup =
  | AgentTranscriptBlock
  | { kind: 'activity'; id: string; steps: AgentActivityStep[] };

export function transcriptGroups(blocks: AgentTranscriptBlock[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  let activity: Extract<TranscriptGroup, { kind: 'activity' }> | null = null;
  for (const block of blocks) {
    if (block.kind === 'user') activity = null;
    if (block.kind === 'thinking' || (block.kind === 'tool' && block.status !== 'awaiting')) {
      if (!activity) {
        activity = { kind: 'activity', id: `activity-${block.id}`, steps: [] };
        groups.push(activity);
      }
      activity.steps.push(block);
    } else groups.push(block);
  }
  return groups;
}

/** Keep accepted follow-ups in their original turn while leaving each user
 * message in place. Only an explicitly completed final reply may fold work. */
export function transcriptTurns(groups: TranscriptGroup[]) {
  const turns: Array<{
    id: string;
    groups: TranscriptGroup[];
    finalId?: string;
    completed: boolean;
  }> = [];
  for (const group of groups) {
    let turn = turns.at(-1);
    if (!turn || (group.kind === 'user' && !group.followUp)) {
      turn = { id: group.id, groups: [], completed: false };
      turns.push(turn);
    }
    turn.groups.push(group);
    if (group.kind === 'assistant') {
      turn.finalId = group.id;
      turn.completed = group.turnOutcome === 'completed';
    }
    if (group.kind === 'error') turn.completed = false;
  }
  return turns;
}
