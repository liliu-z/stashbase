/** The conversation as it reads: prompts, replies, thinking, notices and
 *  activity groups in order, with day breaks between prompts and a quiet
 *  hover row under each prompt and each settled reply — when it happened,
 *  copy, and edit on the latest prompt. Blocks arrive already shaped by the
 *  session domain; this module only decides how each one is presented. */
import { Check, Copy, Pencil } from 'lucide-react';
import { Fragment, memo, useCallback, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ChatMessage, ChatMessageAction } from '@/components/ui/chat-message';
import { FileTypeIcon } from '@/components/ui/file-type-icon';
import { ThinkingIndicator } from '@/components/ui/thinking-indicator';
import { segmentFileMentions, type AgentContextItem } from '@/features/agent/domain/context';
import { agentQuestions } from '@/features/agent/domain/question';
import { latestUserBlock, type AgentTranscriptBlock } from '@/features/agent/domain/session';
import type { AgentPermissionDecision } from '@/features/agent/domain/session-command';
import {
  dayLabel,
  promptTimeLabel,
  replyTimeLabel,
  startOfLocalDay,
  transcriptDayBreaks,
} from '@/features/agent/domain/time';
import type { AgentRuntimeUpdateView } from '@/features/agent/hooks/use-agent-runtime-update';
import { SentContextTiles } from '@/features/agent/ui/composer/context-tiles';
import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';
import type { SourceReference } from '@/shared/domain/source-reference';
import { writeToClipboard } from '@/shared/ui/clipboard';
import { basePathName } from '@/shared/utils/file-path';

import {
  AgentActivityGroup,
  AgentPermissionCard,
  visibleActivitySteps,
  type AgentActivityStep,
} from './activity';
import { AgentMarkdown } from './markdown';
import { AgentQuestionCard } from './question-card';
import { AgentRevisionCard, type AgentRevisionReview } from './revision-card';
import { closingReplies } from './transcript-order';
import { TurnFailure } from './turn-failure';

export { closingReplies } from './transcript-order';

const TRANSCRIPT_PAGE_SIZE = 200;

type TranscriptGroup =
  | AgentTranscriptBlock
  | { kind: 'activity'; id: string; steps: AgentActivityStep[] };

/** Copies the untouched source text; the glyph confirms for a moment. */
function CopyAction({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void writeToClipboard(text).then(
      () => {
        setCopied(true);
        globalThis.setTimeout(() => setCopied(false), 1_500);
      },
      // A host that refused the write has not copied anything, so the glyph
      // stays as it was rather than confirming something that did not happen.
      () => undefined,
    );
  };
  return (
    <ChatMessageAction
      icon={copied ? Check : Copy}
      label={copied ? 'Copied' : label}
      onClick={copy}
    />
  );
}

function DayDivider({ at, now }: { at: number; now: number }) {
  const label = dayLabel(startOfLocalDay(at), startOfLocalDay(now));
  return (
    <div
      aria-label={label}
      className="flex items-center gap-3 text-[11px] text-muted-foreground select-none not-first:mt-2"
      role="separator"
    >
      <span aria-hidden className="h-px flex-1 bg-border" />
      {label}
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

function transcriptGroups(blocks: AgentTranscriptBlock[]): TranscriptGroup[] {
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

/** Context as it was sent, or the replayed attachments a native history
 *  record kept when this renderer never bound them. */
function sentContext(block: Extract<AgentTranscriptBlock, { kind: 'user' }>): AgentContextItem[] {
  if (block.context) return block.context;
  return (block.attachments ?? []).map((attachment) => ({
    dims: attachment.dims,
    kind: 'transient',
    name: attachment.name,
    path: attachment.path,
    previewUrl: attachment.previewUrl,
  }));
}

const TranscriptBlock = memo(function TranscriptBlock({
  block,
  closing,
  editable,
  now,
  onEditPrompt,
  onOpenExternal,
  onOpenSource,
  sourceFor,
  onPermission,
  onRetry,
  promptAt,
  review,
  runtimeUpdate,
  transientFile,
}: {
  block: AgentTranscriptBlock;
  /** This reply closes a settled turn, so it carries the copy and time row. */
  closing: boolean;
  /** This prompt is the latest and its turn has settled, so it can be taken
   *  back into the composer. */
  editable: boolean;
  now: number;
  onEditPrompt?: ((blockId: string) => void) | undefined;
  onOpenExternal(href: string): void;
  onOpenSource?: ((source: SourceReference, phrase: string | null) => void) | undefined;
  sourceFor?: ((path: string) => SourceReference | null) | undefined;
  onPermission(
    toolUseId: string,
    permissionId: string,
    allow: boolean,
    decision?: AgentPermissionDecision,
  ): boolean;
  onRetry(errorBlockId: string): boolean;
  /** When the prompt a closing reply answers was sent, for the duration. */
  promptAt: number | undefined;
  review: AgentRevisionReview | null;
  runtimeUpdate?: AgentRuntimeUpdateView | undefined;
  transientFile?: ((path: string) => File | undefined) | undefined;
}) {
  const shape = useShape();
  if (block.kind === 'user') {
    const context = sentContext(block);
    const transientPaths = context.flatMap((item) =>
      item.kind === 'transient' ? [item.path] : [],
    );
    const segments = segmentFileMentions(block.text, transientPaths);
    const mentioned = new Set(
      segments.flatMap((segment) => (segment.kind === 'mention' ? [segment.path] : [])),
    );
    // A source the text already mentions inline is not repeated as a tile;
    // only sources bound without a mention, such as a dropped row, get one.
    const tiles = context.filter(
      (item) => item.kind !== 'source' || !mentioned.has(item.source.path),
    );
    return (
      <div className="flex max-w-[72%] flex-col items-end gap-1.5 self-end not-first:mt-4">
        <SentContextTiles fileFor={transientFile} items={tiles} />
        <ChatMessage
          actions={
            <>
              <CopyAction label="Copy message" text={block.text} />
              {editable && onEditPrompt && (
                <ChatMessageAction
                  icon={Pencil}
                  label="Reuse message"
                  onClick={() => onEditPrompt(block.id)}
                />
              )}
            </>
          }
          className="max-w-full"
          from="user"
          time={block.at === undefined ? undefined : promptTimeLabel(block.at, now)}
        >
          <span className="sr-only">You: </span>
          {segments.map((segment) =>
            segment.kind === 'text' ? (
              segment.text
            ) : (
              <span
                className={cn(
                  'mx-px inline-flex max-w-full items-center gap-1 bg-foreground/8 px-1.5 py-px align-baseline font-medium',
                  shape.chip,
                )}
                key={`${segment.start}:${segment.path}`}
                title={segment.path}
              >
                <FileTypeIcon
                  aria-hidden="true"
                  className="shrink-0"
                  path={segment.path}
                  size={12}
                />
                <span className="truncate">{basePathName(segment.path)}</span>
                <span className="sr-only"> (file mention: {segment.path})</span>
              </span>
            ),
          )}
        </ChatMessage>
      </div>
    );
  }
  if (block.kind === 'assistant') {
    return (
      <ChatMessage
        actions={closing ? <CopyAction label="Copy response" text={block.text} /> : undefined}
        from="assistant"
        time={
          closing && block.at !== undefined ? replyTimeLabel(block.at, promptAt, now) : undefined
        }
      >
        <span className="sr-only">Agent: </span>
        <AgentMarkdown
          markdown={block.text}
          onOpenExternal={onOpenExternal}
          onOpenSource={onOpenSource}
          sourceFor={sourceFor}
        />
      </ChatMessage>
    );
  }
  if (block.kind === 'thinking') {
    return <p className="text-[13px] leading-5 text-muted-foreground">{block.text}</p>;
  }
  if (block.kind === 'notice') {
    return (
      <p className="border-l border-border pl-3 text-caption text-muted-foreground">{block.text}</p>
    );
  }
  if (block.kind === 'revision') {
    return <AgentRevisionCard name={basePathName(block.path)} review={review} />;
  }
  if (block.kind === 'error') {
    return <TurnFailure block={block} onRetry={onRetry} runtimeUpdate={runtimeUpdate} />;
  }
  const questions = agentQuestions(block.name, block.input);
  if (questions) {
    return <AgentQuestionCard onReply={onPermission} questions={questions} tool={block} />;
  }
  return <AgentPermissionCard onReply={onPermission} tool={block} />;
});

export const AgentTranscript = memo(function AgentTranscript({
  activeTurn,
  blocks,
  onEditPrompt,
  onOpenExternal,
  onOpenSource,
  onPermission,
  onRetry,
  revisionFor,
  runtimeUpdate,
  sourceFor,
  transientFile,
}: {
  activeTurn: boolean;
  blocks: AgentTranscriptBlock[];
  /** Takes a sent prompt back into the composer. Absent when there is no
   *  composer to take it, so no edit control renders. */
  onEditPrompt?: ((blockId: string) => void) | undefined;
  onOpenExternal(href: string): void;
  /** Opens a file the Agent changed beside the chat, without selecting it
   *  on the Agent's behalf. */
  onOpenSource?: ((source: SourceReference, phrase: string | null) => void) | undefined;
  onPermission(
    toolUseId: string,
    permissionId: string,
    allow: boolean,
    decision?: AgentPermissionDecision,
  ): boolean;
  onRetry(errorBlockId: string): boolean;
  revisionFor?: ((path: string, proposalId: string) => AgentRevisionReview | null) | undefined;
  /** The in-place update of the conversation's runtime, offered on a turn
   *  the runtime was too old for. Absent where nothing can run one. */
  runtimeUpdate?: AgentRuntimeUpdateView | undefined;
  /** The workspace source behind a changed path, or null when it is not one. */
  sourceFor?: ((path: string) => SourceReference | null) | undefined;
  /** The File behind a sent upload, when this session still holds it. */
  transientFile?: ((path: string) => File | undefined) | undefined;
}) {
  const [visibleCount, setVisibleCount] = useState(TRANSCRIPT_PAGE_SIZE);
  // The ask's card leaves the transcript on decision, so focus follows the
  // decided tool into the activity group that now holds it.
  const [decidedToolId, setDecidedToolId] = useState<string | null>(null);
  const decide = useCallback(
    (...decision: Parameters<typeof onPermission>) => {
      const accepted = onPermission(...decision);
      if (accepted) setDecidedToolId(decision[0]);
      return accepted;
    },
    [onPermission],
  );
  const hiddenCount = Math.max(0, blocks.length - visibleCount);
  const visibleBlocks = blocks.slice(hiddenCount);
  const groups = useMemo(() => transcriptGroups(visibleBlocks), [visibleBlocks]);
  const closing = useMemo(() => closingReplies(blocks, activeTurn), [activeTurn, blocks]);
  // Only the latest prompt can be edited, and only once its turn has settled;
  // an earlier one would resend into a conversation that has moved on.
  const editableId = onEditPrompt && !activeTurn ? latestUserBlock(blocks)?.id : undefined;
  // Time labels refresh with the transcript, not with every render above it.
  const { dayBreaks, now } = useMemo(
    () => ({ dayBreaks: transcriptDayBreaks(visibleBlocks), now: Date.now() }),
    [visibleBlocks],
  );
  // While a turn runs, the group that closes the transcript narrates it in its
  // own header, and a decision card speaks for itself. The indicator stands in
  // only when neither of those is there to say the work is still moving.
  const tailGroup = groups.at(-1);
  const liveGroup =
    tailGroup?.kind === 'activity' && visibleActivitySteps(tailGroup.steps).length > 0
      ? tailGroup
      : null;
  const tail = blocks.at(-1);
  const narrated = liveGroup !== null || (tail?.kind === 'tool' && tail.status === 'awaiting');
  const reviewFor = (block: AgentTranscriptBlock): AgentRevisionReview | null => {
    if (block.kind !== 'revision') return null;
    const source = sourceFor?.(block.path);
    return source ? (revisionFor?.(source.path, block.proposalId) ?? null) : null;
  };

  return (
    <>
      {hiddenCount > 0 && (
        <Button
          className="mx-auto"
          onClick={() => setVisibleCount((count) => count + TRANSCRIPT_PAGE_SIZE)}
          size="compact"
          variant="ghost"
        >
          Show earlier messages
        </Button>
      )}
      {groups.map((group) =>
        group.kind === 'activity' ? (
          <AgentActivityGroup
            focusToolId={decidedToolId}
            key={group.id}
            live={activeTurn && group === liveGroup}
            onOpenSource={onOpenSource}
            sourceFor={sourceFor}
            steps={group.steps}
          />
        ) : (
          <Fragment key={group.id}>
            {group.kind === 'user' && group.at !== undefined && dayBreaks.has(group.id) && (
              <DayDivider at={group.at} now={now} />
            )}
            <TranscriptBlock
              block={group}
              closing={closing.has(group.id)}
              editable={group.id === editableId}
              now={now}
              onEditPrompt={onEditPrompt}
              onOpenExternal={onOpenExternal}
              onOpenSource={onOpenSource}
              sourceFor={sourceFor}
              onPermission={decide}
              onRetry={onRetry}
              promptAt={closing.get(group.id)}
              review={reviewFor(group)}
              runtimeUpdate={runtimeUpdate}
              transientFile={transientFile}
            />
          </Fragment>
        ),
      )}
      {activeTurn && !narrated && <ThinkingIndicator className="px-0" size="compact" />}
    </>
  );
});
