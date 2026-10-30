/** Presents shaped conversation blocks in order, with day breaks and a quiet
 *  action row for settled prompts and replies. */
import { Fragment, memo, useCallback, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ChatMessage } from '@/components/ui/chat-message';
import { ThinkingIndicator } from '@/components/ui/thinking-indicator';
import { agentRoleCallView } from '@/features/agent/domain/agent-role-call';
import type { AgentContextItem } from '@/features/agent/domain/context';
import { agentQuestions } from '@/features/agent/domain/question';
import { latestUserBlock, type AgentTranscriptBlock } from '@/features/agent/domain/session';
import type { AgentPermissionDecision } from '@/features/agent/domain/session-command';
import { replyTimeLabel, startOfLocalDay, transcriptDayBreaks } from '@/features/agent/domain/time';
import type { AgentModelRefreshView } from '@/features/agent/hooks/use-agent-model-refresh';
import type { AgentRuntimeUpdateView } from '@/features/agent/hooks/use-agent-runtime-update';
import type { SourceReference } from '@/shared/domain/source-reference';

import { AgentActivityGroup, AgentPermissionCard, visibleActivitySteps } from './activity';
import { CopyAction } from './copy-action';
import { DayDivider } from './day-divider';
import { AgentMarkdown } from './markdown';
import { AgentQuestionCard } from './question-card';
import { AgentRoleCall } from './role-call';
import { closingReplies, transcriptGroups } from './transcript-order';
import { AgentTurnChangesCard, type AgentTurnChangeReview } from './turn-changes-card';
import { TurnFailure } from './turn-failure';

export { closingReplies } from './transcript-order';

import { useTranscriptPage } from './use-transcript-page';
import { UserMessage } from './user-message';

/** A follow-up waiting for the running turn to read it. */
export interface PendingFollowUp {
  id: string;
  text: string;
  context: AgentContextItem[];
}

interface TranscriptDecisions {
  onPermission(
    toolUseId: string,
    permissionId: string,
    allow: boolean,
    decision?: AgentPermissionDecision,
  ): boolean;
  onRetry(errorBlockId: string): boolean;
  onSignIn?: (() => void) | undefined;
  onUpdateApp?: (() => void) | undefined;
}

const NO_PENDING: readonly PendingFollowUp[] = [];

const TranscriptBlock = memo(function TranscriptBlock({
  block,
  closing,
  editable,
  modelRefresh,
  mathMode,
  now,
  onEditPrompt,
  onOpenExternal,
  onOpenSource,
  onReviewTurnChange,
  sourceFor,
  onPermission,
  onRetry,
  onSignIn,
  onUpdateApp,
  promptAt,
  runtimeUpdate,
  transientFile,
}: TranscriptDecisions & {
  block: AgentTranscriptBlock;
  /** This reply closes a settled turn, so it carries the copy and time row. */
  closing: boolean;
  /** This prompt is the latest and its turn has settled, so it can be taken
   *  back into the composer. */
  editable: boolean;
  modelRefresh?: AgentModelRefreshView | undefined;
  mathMode: boolean;
  now: number;
  onEditPrompt?: ((blockId: string) => void) | undefined;
  onOpenExternal(href: string): void;
  onOpenSource?:
    | ((source: SourceReference, phrase: string | null, quoteFormat?: 'markdown') => void)
    | undefined;
  onReviewTurnChange?: ((review: AgentTurnChangeReview) => void) | undefined;
  sourceFor?: ((path: string) => SourceReference | null) | undefined;
  /** When the prompt a closing reply answers was sent, for the duration. */
  promptAt: number | undefined;
  runtimeUpdate?: AgentRuntimeUpdateView | undefined;
  transientFile?: ((path: string) => File | undefined) | undefined;
}) {
  if (block.kind === 'user') {
    return (
      <UserMessage
        block={block}
        editable={editable}
        now={now}
        onEditPrompt={onEditPrompt}
        onOpenSource={onOpenSource}
        transientFile={transientFile}
      />
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
          mathMode={mathMode}
          markdown={block.text}
          onOpenExternal={onOpenExternal}
          onOpenSource={onOpenSource}
          sourceFor={sourceFor}
        />
      </ChatMessage>
    );
  }
  if (block.kind === 'thinking') {
    return <p className="text-ui-13 leading-5 text-muted-foreground">{block.text}</p>;
  }
  if (block.kind === 'notice') {
    return (
      <p className="border-l border-border pl-3 text-caption text-muted-foreground">{block.text}</p>
    );
  }
  if (block.kind === 'turn-changes') {
    return (
      <AgentTurnChangesCard
        files={block.files}
        onOpenSource={onOpenSource}
        onReviewTurnChange={onReviewTurnChange}
        sourceFor={sourceFor}
        turnId={block.turnId}
      />
    );
  }
  if (block.kind === 'error') {
    return (
      <TurnFailure
        block={block}
        modelRefresh={modelRefresh}
        onRetry={onRetry}
        onSignIn={onSignIn}
        onUpdateApp={onUpdateApp}
        runtimeUpdate={runtimeUpdate}
      />
    );
  }
  const questions = agentQuestions(block.name, block.input);
  return (
    <div data-permission-id={block.status === 'awaiting' ? block.permissionId : undefined}>
      {questions ? (
        <AgentQuestionCard onReply={onPermission} questions={questions} tool={block} />
      ) : (
        <AgentPermissionCard onReply={onPermission} tool={block} />
      )}
    </div>
  );
});

export const AgentTranscript = memo(function AgentTranscript({
  activeTurn,
  blocks,
  focusBlockId,
  modelRefresh,
  mathMode = false,
  onEditPrompt,
  onOpenExternal,
  onOpenSource,
  onPermission,
  onRetry,
  onSignIn,
  onUpdateApp,
  onReviewTurnChange,
  pending = NO_PENDING,
  runtimeUpdate,
  sourceFor,
  transientFile,
}: TranscriptDecisions & {
  activeTurn: boolean;
  blocks: AgentTranscriptBlock[];
  /** Follow-ups sent into the running turn that its runtime has not read
   *  yet. They wait, dimmed, below the turn and join it where it reads them. */
  pending?: readonly PendingFollowUp[] | undefined;
  focusBlockId?: string | undefined;
  /** Reads the hosted models again, offered on a turn refused because the
   *  chosen model's configuration changed. Absent where no hosted list exists. */
  modelRefresh?: AgentModelRefreshView | undefined;
  mathMode?: boolean | undefined;
  /** Takes a sent prompt back into the composer. Absent when there is no
   *  composer to take it, so no edit control renders. */
  onEditPrompt?: ((blockId: string) => void) | undefined;
  onOpenExternal(href: string): void;
  /** Opens a file the Agent changed beside the chat, without selecting it
   *  on the Agent's behalf. */
  onOpenSource?:
    | ((source: SourceReference, phrase: string | null, quoteFormat?: 'markdown') => void)
    | undefined;
  /** Opens what a turn changed in one file as a review inside the document. */
  onReviewTurnChange?: ((review: AgentTurnChangeReview) => void) | undefined;
  /** The in-place update of the conversation's runtime, offered on a turn
   *  the runtime was too old for. Absent where nothing can run one. */
  runtimeUpdate?: AgentRuntimeUpdateView | undefined;
  /** The workspace source behind a changed path, or null when it is not one. */
  sourceFor?: ((path: string) => SourceReference | null) | undefined;
  /** The File behind a sent upload, when this session still holds it. */
  transientFile?: ((path: string) => File | undefined) | undefined;
}) {
  const { hiddenCount, showEarlier } = useTranscriptPage(blocks, focusBlockId);
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
  const visibleBlocks = blocks.slice(hiddenCount);
  const groups = useMemo(() => transcriptGroups(visibleBlocks), [visibleBlocks]);
  const closing = useMemo(() => closingReplies(blocks, activeTurn), [activeTurn, blocks]);
  // Only the latest prompt can be edited, and only once its turn has settled;
  // an earlier one would resend into a conversation that has moved on.
  const editableId = onEditPrompt && !activeTurn ? latestUserBlock(blocks)?.id : undefined;
  // Time labels refresh with the transcript, not with every render above it.
  // They only compare local days, so the start of today keeps every settled
  // block's props equal while a reply streams in.
  const { dayBreaks, now } = useMemo(
    () => ({
      dayBreaks: transcriptDayBreaks(visibleBlocks),
      now: startOfLocalDay(Date.now()).getTime(),
    }),
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
  const narrated =
    liveGroup !== null ||
    (tail?.kind === 'tool' && tail.status === 'awaiting') ||
    (tailGroup?.kind === 'role-call' && tailGroup.tool.status === 'running');
  return (
    <>
      {hiddenCount > 0 && (
        <Button className="mx-auto" onClick={showEarlier} size="compact" variant="ghost">
          Show earlier messages
        </Button>
      )}
      {groups.map((group) =>
        group.kind === 'role-call' ? (
          <AgentRoleCall
            key={group.id}
            status={group.tool.status}
            view={agentRoleCallView(group.tool, group.role)}
          />
        ) : group.kind === 'activity' ? (
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
            <div
              className="flex min-w-0 flex-col"
              data-notification-block-id={group.id}
              tabIndex={-1}
            >
              <TranscriptBlock
                block={group}
                closing={closing.has(group.id)}
                editable={group.id === editableId}
                modelRefresh={modelRefresh}
                mathMode={mathMode}
                now={now}
                onEditPrompt={onEditPrompt}
                onOpenExternal={onOpenExternal}
                onOpenSource={onOpenSource}
                onReviewTurnChange={onReviewTurnChange}
                sourceFor={sourceFor}
                onPermission={decide}
                onRetry={onRetry}
                onSignIn={onSignIn}
                onUpdateApp={onUpdateApp}
                promptAt={closing.get(group.id)}
                runtimeUpdate={runtimeUpdate}
                transientFile={transientFile}
              />
            </div>
          </Fragment>
        ),
      )}
      {activeTurn && !narrated && <ThinkingIndicator className="px-0" size="compact" />}
      {pending.map((prompt) => (
        <div className="flex min-w-0 flex-col opacity-60" key={prompt.id}>
          <span className="sr-only">Not read yet. </span>
          <UserMessage
            block={{
              ...(prompt.context.length > 0 ? { context: prompt.context } : {}),
              id: prompt.id,
              kind: 'user',
              text: prompt.text,
            }}
            editable={false}
            now={now}
            onOpenSource={onOpenSource}
            transientFile={transientFile}
          />
        </div>
      ))}
    </>
  );
});
