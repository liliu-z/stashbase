import { describe, expect, it } from 'vite-plus/test';

import {
  appendStreamingBlock,
  appendToolOutput,
  finishTool,
  latestUserBlock,
  recordFileChange,
  replyToolPermission,
  requestToolPermission,
  settleErrorBlock,
  settlePendingTools,
  stampClosingReply,
  startTool,
  type AgentTranscriptBlock,
} from './session-transcript';

const running: AgentTranscriptBlock = {
  id: 'tool-1',
  input: { command: 'ls' },
  kind: 'tool',
  name: 'Bash',
  status: 'running',
};

describe('Agent transcript edits', () => {
  it('extends the tail block for a same-kind delta and opens a new one otherwise', () => {
    const first = appendStreamingBlock([], 'assistant', 'reply-1', 'Hello');
    const extended = appendStreamingBlock(first, 'assistant', 'reply-2', ' there');
    const thinking = appendStreamingBlock(extended, 'thinking', 'think-1', 'Considering');

    expect(extended).toEqual([{ id: 'reply-1', kind: 'assistant', text: 'Hello there' }]);
    expect(thinking).toHaveLength(2);
    expect(thinking.at(-1)).toEqual({ id: 'think-1', kind: 'thinking', text: 'Considering' });
  });

  it('leaves a settled tool untouched and returns the same transcript', () => {
    const settled = finishTool([running], 'tool-1', 'listing', false);
    const restarted = startTool(settled, { id: 'tool-1', input: {}, name: 'Bash' });

    expect(settled[0]).toMatchObject({ result: 'listing', status: 'done' });
    expect(restarted).toBe(settled);
  });

  it('drops late output and results for a tool the user already denied', () => {
    const awaiting = requestToolPermission([running], {
      id: 'perm-1',
      input: { command: 'rm -rf .' },
      name: 'Bash',
      title: 'Delete everything',
      toolUseId: 'tool-1',
    });
    const denied = replyToolPermission(awaiting, 'tool-1', false);
    const late = finishTool(appendToolOutput(denied, 'tool-1', 'oops'), 'tool-1', 'done', false);

    expect(awaiting[0]).toMatchObject({ permissionId: 'perm-1', status: 'awaiting' });
    expect(denied[0]).toMatchObject({ permissionId: undefined, status: 'denied' });
    expect(late[0]).toMatchObject({ status: 'denied' });
    expect(late[0]).not.toHaveProperty('result');
  });

  it('keeps the answers the reader gave on the call they answer', () => {
    const asked = requestToolPermission([], {
      id: 'perm-2',
      input: { questions: [] },
      name: 'AskUserQuestion',
      title: null,
      toolUseId: 'ask-1',
    });
    const answered = replyToolPermission(asked, 'ask-1', true, { 'Which?': 'This one' });

    expect(answered[0]).toMatchObject({
      input: { answers: { 'Which?': 'This one' }, questions: [] },
      permissionId: undefined,
      status: 'running',
    });
  });

  it('records a native diff once and keeps the same transcript on a repeat', () => {
    const change = {
      additions: 2,
      after: 'b',
      before: 'a',
      deletions: 1,
      id: 'diff-1',
      path: 'notes.md',
    };
    const recorded = recordFileChange([], change);

    expect(recorded).toEqual([
      expect.objectContaining({ kind: 'tool', name: 'FileDiff', status: 'done' }),
    ]);
    expect(recordFileChange(recorded, change)).toBe(recorded);
  });

  it('settles whatever a turn left running and clears a spent retry offer', () => {
    const awaiting = requestToolPermission([running], {
      id: 'perm-1',
      input: {},
      name: 'Write',
      title: null,
      toolUseId: 'tool-2',
    });
    const cancelled = settlePendingTools(awaiting, 'cancelled');
    const withError = settleErrorBlock(
      [{ id: 'error-1', kind: 'error', retryablePrompt: 'Retry me', text: 'It broke' }],
      'error-1',
    );

    expect(cancelled.every((block) => block.kind !== 'tool' || block.status === 'cancelled')).toBe(
      true,
    );
    expect(withError[0]).toMatchObject({ retryablePrompt: undefined });
  });

  it('stamps the reply that closes the turn, and only when it has no time of its own', () => {
    const turn: AgentTranscriptBlock[] = [
      { at: 1_000, id: 'user-1', kind: 'user', text: 'Map the repo' },
      { id: 'reply-1', kind: 'assistant', text: 'Reading.' },
      { id: 'tool-1', input: {}, kind: 'tool', name: 'Bash', status: 'done' },
      { id: 'reply-2', kind: 'assistant', text: 'It is small.' },
      { id: 'notice-1', kind: 'notice', text: 'Reviewed.' },
    ];
    const stamped = stampClosingReply(turn, 13_000);
    expect(stamped[3]).toMatchObject({ at: 13_000, id: 'reply-2' });
    expect(stamped[1]).toBe(turn[1]);
    // A second end for the same turn, or a turn that produced no reply, changes nothing.
    expect(stampClosingReply(stamped, 14_000)).toEqual(stamped);
    const bare: AgentTranscriptBlock[] = [
      { at: 1_000, id: 'user-1', kind: 'user', text: 'Map the repo' },
      { id: 'tool-1', input: {}, kind: 'tool', name: 'Bash', status: 'done' },
    ];
    expect(stampClosingReply(bare, 2_000)).toEqual(bare);
    // A reply from an earlier turn is never mistaken for this one's.
    expect(
      stampClosingReply([...stamped, { id: 'user-2', kind: 'user', text: 'Go on' }], 20_000),
    ).toEqual([...stamped, { id: 'user-2', kind: 'user', text: 'Go on' }]);
  });

  it('finds the prompt a retry would resend, and nothing when there is none', () => {
    const blocks: AgentTranscriptBlock[] = [
      { id: 'u1', kind: 'user', text: 'First' },
      { id: 'a1', kind: 'assistant', text: 'Answer' },
      { id: 'u2', kind: 'user', text: 'Second' },
      { id: 'n1', kind: 'notice', text: 'Reconnected' },
    ];

    expect(latestUserBlock(blocks)?.text).toBe('Second');
    expect(latestUserBlock([{ id: 'n1', kind: 'notice', text: 'Only a notice' }])).toBeUndefined();
  });
});
