/** The Agent transcript and every pure edit made to it. A block is either
 *  settled work or the streaming tail of a turn, and this module owns the
 *  rules that turn one into the other — appending a delta, opening a tool,
 *  asking for permission, settling what a turn left running. The session
 *  reducer only routes actions here, so transcript rules stay in one place. */
import type { AgentContextItem } from '@/features/agent/domain/context';

type AgentToolStatus = 'running' | 'awaiting' | 'done' | 'error' | 'denied' | 'cancelled';

/** Why a turn failed, as this feature names it. The session adapter maps the
 *  wire vocabulary onto these names, so the domain never reads a protocol. */
export type AgentTurnFailureReason =
  | 'rate-limit'
  | 'quota'
  | 'allowance-exhausted'
  | 'access-restricted'
  | 'auth-expired'
  | 'network'
  | 'runtime-outdated';

/** Whether a failed turn may be sent again as it is: a transient failure, or
 *  a runtime too old for its model once that runtime's update ran. Anything
 *  else needs its repair first, and a resend would only fail the same way. */
export function agentTurnFailureIsRetryable(failure: AgentTurnFailureReason | undefined): boolean {
  return (
    failure === undefined ||
    failure === 'network' ||
    failure === 'rate-limit' ||
    failure === 'runtime-outdated'
  );
}

interface AgentTranscriptAttachment {
  path: string;
  name: string;
  dims?: string | undefined;
  previewUrl?: string | undefined;
}

/** One Markdown file an Agent turn left different on disk, as the host saw it
 *  by comparing the folder before and after the turn. `path` is absolute. */
export interface AgentTurnChangedFile {
  readonly path: string;
  readonly change: 'created' | 'edited' | 'deleted';
  readonly additions: number;
  readonly deletions: number;
}

export type AgentTranscriptBlock =
  | {
      kind: 'user';
      id: string;
      text: string;
      attachments?: AgentTranscriptAttachment[] | undefined;
      /** The bound context this prompt was sent with. */
      context?: AgentContextItem[] | undefined;
      at?: number | undefined;
    }
  | { kind: 'assistant'; id: string; text: string; at?: number | undefined }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'notice'; id: string; text: string }
  | {
      kind: 'error';
      id: string;
      text: string;
      failure?: AgentTurnFailureReason | undefined;
      retryablePrompt?: string | undefined;
    }
  | {
      /** What one turn changed in the folder's Markdown, offered for review
       *  inside each document. This stays outside the activity disclosure so
       *  the reader can always find the Review action. */
      kind: 'turn-changes';
      id: string;
      /** The host's identity for the turn, which is what a review asks for. */
      turnId: string;
      files: readonly AgentTurnChangedFile[];
    }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: Record<string, unknown>;
      status: AgentToolStatus;
      permissionId?: string | undefined;
      permissionRequested?: boolean | undefined;
      permissionTitle?: string | null | undefined;
      result?: string | undefined;
    };

type AgentToolBlock = Extract<AgentTranscriptBlock, { kind: 'tool' }>;

const SETTLED_TOOL_STATUSES = new Set<AgentToolStatus>(['cancelled', 'denied', 'done', 'error']);

/** A tool the user already answered for, or one a retirement cancelled,
 *  never moves again — output and results arriving late are dropped. */
function isAnswered(block: AgentToolBlock): boolean {
  return block.status === 'denied' || block.status === 'cancelled';
}

/** A streaming delta extends the tail block when it is the same kind, so one
 *  reply reads as one paragraph rather than a block per chunk. */
export function appendStreamingBlock(
  transcript: readonly AgentTranscriptBlock[],
  kind: 'assistant' | 'thinking',
  id: string,
  delta: string,
): AgentTranscriptBlock[] {
  const last = transcript.at(-1);
  if (last?.kind === kind) {
    return [...transcript.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [...transcript, { id, kind, text: delta }];
}

export function appendBlock(
  transcript: readonly AgentTranscriptBlock[],
  block: AgentTranscriptBlock,
): AgentTranscriptBlock[] {
  return [...transcript, block];
}

export function startTool(
  transcript: AgentTranscriptBlock[],
  tool: { id: string; name: string; input: Record<string, unknown> },
): AgentTranscriptBlock[] {
  const index = transcript.findIndex((block) => block.kind === 'tool' && block.id === tool.id);
  if (index < 0) {
    return [
      ...transcript,
      { id: tool.id, input: tool.input, kind: 'tool', name: tool.name, status: 'running' },
    ];
  }
  const next = transcript.slice();
  const current = next[index];
  if (current?.kind === 'tool') {
    if (SETTLED_TOOL_STATUSES.has(current.status)) return transcript;
    next[index] = {
      ...current,
      input: tool.input,
      name: tool.name,
      status: current.status === 'awaiting' ? 'awaiting' : 'running',
    };
  }
  return next;
}

export function appendToolOutput(
  transcript: readonly AgentTranscriptBlock[],
  id: string,
  delta: string,
): AgentTranscriptBlock[] {
  return transcript.map((block) =>
    block.kind === 'tool' && block.id === id && !isAnswered(block)
      ? { ...block, result: (block.result ?? '') + delta }
      : block,
  );
}

export function finishTool(
  transcript: readonly AgentTranscriptBlock[],
  id: string,
  content: string,
  isError: boolean,
): AgentTranscriptBlock[] {
  return transcript.map((block) =>
    block.kind === 'tool' && block.id === id && !isAnswered(block)
      ? {
          ...block,
          permissionId: undefined,
          permissionRequested: false,
          permissionTitle: undefined,
          result: content,
          status: isError ? ('error' as const) : ('done' as const),
        }
      : block,
  );
}

/** A native diff is settled work the moment it arrives; it renders as the
 *  same `FileDiff` tool block that replayed history carries. */
export function recordFileChange(
  transcript: AgentTranscriptBlock[],
  change: {
    id: string;
    path: string;
    before: string;
    after: string;
    additions: number;
    deletions: number;
  },
): AgentTranscriptBlock[] {
  if (transcript.some((block) => block.kind === 'tool' && block.id === change.id)) {
    return transcript;
  }
  return [
    ...transcript,
    {
      id: change.id,
      input: {
        additions: change.additions,
        after: change.after,
        before: change.before,
        deletions: change.deletions,
        path: change.path,
      },
      kind: 'tool',
      name: 'FileDiff',
      status: 'done',
    },
  ];
}

/**
 * Records what turn `turnId` changed. The host rescans the folder after the
 * turn ends, so this can arrive after the next prompt was already sent; the
 * card then goes before that prompt, beside the turn it describes. Recording
 * twice is as safe as once.
 */
export function recordTurnChanges(
  transcript: AgentTranscriptBlock[],
  changes: { turnId: string; files: readonly AgentTurnChangedFile[] },
  nextPromptId: string | null,
): AgentTranscriptBlock[] {
  const id = `turn-changes-${changes.turnId}`;
  if (transcript.some((block) => block.id === id)) return transcript;
  const block: AgentTranscriptBlock = {
    files: changes.files,
    id,
    kind: 'turn-changes',
    turnId: changes.turnId,
  };
  const index =
    nextPromptId === null
      ? -1
      : transcript.findIndex((entry) => entry.kind === 'user' && entry.id === nextPromptId);
  if (index < 0) return [...transcript, block];
  return [...transcript.slice(0, index), block, ...transcript.slice(index)];
}

export function requestToolPermission(
  transcript: readonly AgentTranscriptBlock[],
  request: {
    id: string;
    toolUseId: string;
    name: string;
    title: string | null;
    input: Record<string, unknown>;
  },
): AgentTranscriptBlock[] {
  const index = transcript.findIndex(
    (block) => block.kind === 'tool' && block.id === request.toolUseId,
  );
  const permissionBlock: AgentToolBlock = {
    id: request.toolUseId,
    input: request.input,
    kind: 'tool',
    name: request.name,
    permissionId: request.id,
    permissionRequested: true,
    permissionTitle: request.title,
    status: 'awaiting',
  };
  if (index < 0) return [...transcript, permissionBlock];
  const next = transcript.slice();
  const current = next[index];
  next[index] = current?.kind === 'tool' ? { ...current, ...permissionBlock } : permissionBlock;
  return next;
}

/** The reader's decision on a pending call. Answers to a clarifying question
 *  ride along on the call's input, the way the runtime carries them, so the
 *  settled row can show what was answered. */
export function replyToolPermission(
  transcript: readonly AgentTranscriptBlock[],
  toolUseId: string,
  allow: boolean,
  answers?: Record<string, string>,
): AgentTranscriptBlock[] {
  return transcript.map((block) =>
    block.kind === 'tool' && block.id === toolUseId && block.status === 'awaiting'
      ? {
          ...block,
          ...(answers ? { input: { ...block.input, answers } } : {}),
          permissionId: undefined,
          status: allow ? ('running' as const) : ('denied' as const),
        }
      : block,
  );
}

/** Whatever a turn left running becomes what the turn's ending made of it. */
export function settlePendingTools(
  transcript: readonly AgentTranscriptBlock[],
  status: 'done' | 'error' | 'cancelled',
): AgentTranscriptBlock[] {
  return transcript.map((block) =>
    block.kind === 'tool' && (block.status === 'running' || block.status === 'awaiting')
      ? { ...block, permissionId: undefined, status }
      : block,
  );
}

/** Stamps the reply that closes the turn just ended — the last assistant
 *  block after the last prompt — with when it settled. A reply that already
 *  carries a time, or a turn that produced no reply, leaves every block as it
 *  was. */
export function stampClosingReply(
  transcript: readonly AgentTranscriptBlock[],
  at: number,
): AgentTranscriptBlock[] {
  let closing = -1;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const block = transcript[index];
    if (block?.kind === 'user') break;
    if (block?.kind !== 'assistant') continue;
    if (block.at === undefined) closing = index;
    break;
  }
  return transcript.map((block, index) =>
    index === closing && block.kind === 'assistant' ? { ...block, at } : block,
  );
}

/** Drops the retry offer on one error block, once its turn has been resent. */
export function settleErrorBlock(
  transcript: readonly AgentTranscriptBlock[],
  id: string,
): AgentTranscriptBlock[] {
  return transcript.map((block) =>
    block.kind === 'error' && block.id === id ? { ...block, retryablePrompt: undefined } : block,
  );
}

/** The prompt a retry would resend: the last user block in the transcript. */
export function latestUserBlock(
  transcript: readonly AgentTranscriptBlock[],
): Extract<AgentTranscriptBlock, { kind: 'user' }> | undefined {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const block = transcript[index];
    if (block?.kind === 'user') return block;
  }
  return undefined;
}
