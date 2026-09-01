/**
 * The transcript itself: the scrolling block list, how one turn's reply is
 * laid out (live-flat while streaming, work trace + answer once settled),
 * and the session-level notices around it. The user half of a turn lives in
 * `AgentUserTurn`, the tool surface in `AgentToolActivity`, and the pure
 * turn model in `lib/turnModel`.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/common/components/ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/common/components/ui/collapsible';
import { AgentMarkdown } from '@/features/agent-panel/components/AgentMarkdown';
import { ChevronDownIcon, CopyIcon, TrashIcon } from '@/common/components/icons';
import { cn } from '@/common/lib/utils';
import { SectionHeading } from '@/common/components/ui/section';
import { StatusMessage } from '@/common/components/ui/status';
import { ToolActivityGroup, PermissionCard } from '@/features/agent-panel/components/AgentToolActivity';
import { MessageAttachments, UserMessageText, UserTurnHead } from '@/features/agent-panel/components/AgentUserTurn';
import { accentDotClass, spinnerClass, turnHeadClass } from '@/features/agent-panel/lib/panelStyles';
import { formatMessageTime, groupTurns, replyTimestamp, settledReplySections, tailBlockSpeaks, turnReplyText, workTraceLabel, type TurnMeta } from '@/features/agent-panel/lib/turnModel';
import { turnFailureGuidance, type TurnFailureActionId } from '@/features/agent-panel/lib/turnFailure';
import { basename } from '@/common/lib/paths';
import type { AgentKind, Attachment, Block, RetiredAgentScope, ToolBlock } from '@/features/agent-panel/lib/types';

/* One exchange: the user bubble plus the reply blocks under it. A class
 * string rather than a component because the two call sites below wrap
 * completely different children — a live turn and a queued preview — and
 * only the box is shared. `agent-turn` leads it as a hook: the
 * between-turn rhythm is an adjacent-sibling rule in agent-panel.css. */
const turnClass = 'agent-turn relative flex flex-col gap-2.5';

/** Accent status dot used by working/queued indicators. */
function Dot() {
  return <span className={accentDotClass} aria-hidden="true" />;
}

export interface QueuedTurnPreview {
  id: string;
  text: string;
  attachments?: Attachment[];
  status: 'waiting' | 'steering' | 'steered' | 'cancelled';
  canSteer?: boolean;
}

export function MessageList({
  blocks, queuedTurns, turnActive, turnMeta, phase, fatal, fatalRecoveryLabel, scopeRetired, agentKind, agentShortName, onPermission, onSteerQueued, onDeleteQueued, onCopyUserMessage, onResendUserMessage, onRetry, onStartLibraryChat, onOpenArtifact, onTurnFailureAction,
}: {
  blocks: Block[];
  queuedTurns: QueuedTurnPreview[];
  turnActive: boolean;
  turnMeta: Record<string, TurnMeta>;
  phase: 'connecting' | 'live' | 'closed';
  fatal: string | null;
  fatalRecoveryLabel: 'Retry' | 'Reconnect';
  scopeRetired: RetiredAgentScope | null;
  agentKind: AgentKind;
  agentShortName: string;
  onPermission: (toolBlockId: string, permId: string, allow: boolean) => void;
  onSteerQueued: (id: string) => void;
  onDeleteQueued: (id: string) => void;
  onCopyUserMessage: (text: string) => void;
  onResendUserMessage: (text: string) => void;
  onRetry: () => void;
  onStartLibraryChat: () => void;
  onOpenArtifact: (path: string) => void;
  onTurnFailureAction: (blockId: string, action: TurnFailureActionId) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);

  function onScroll() {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setShowJump(!stick.current);
  }

  useEffect(() => {
    if (stick.current && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
      setShowJump(false);
    }
  });

  const turns = useMemo(() => groupTurns(blocks), [blocks]);
  // The reply handlers travel as ONE object from here down through
  // TurnBody/WorkTrace/BlockView instead of four parallel props per layer.
  const handlers: ReplyHandlers = useMemo(
    () => ({ agentKind, onPermission, onCopyUserMessage, onResendUserMessage, onOpenArtifact, onTurnFailureAction }),
    [agentKind, onPermission, onCopyUserMessage, onResendUserMessage, onOpenArtifact, onTurnFailureAction],
  );

  return (
    // `agent-messages` is a layout hook: agent-panel.css owns the
    // horizontal padding (responsive centering of the readable column).
    // No top padding — the first child's own top margin carries the
    // breathing room (it scrolls away with the transcript).
    <div
      className="agent-messages scrollbar-quiet flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pt-0 pb-2 [&>*:first-child]:mt-3"
      role="log"
      aria-label="Agent conversation"
      aria-live="polite"
      ref={ref}
      onScroll={onScroll}
    >
      {phase === 'connecting' && <ConnectingNotice agentShortName={agentShortName} />}
      {blocks.length === 0 && phase === 'closed' && fatal && (
        <FatalState fatal={fatal} agentShortName={agentShortName} recoveryLabel={fatalRecoveryLabel} onRetry={onRetry} />
      )}
      {blocks.length === 0 && queuedTurns.length === 0 && scopeRetired && (
        <ScopeRetiredNotice retired={scopeRetired} centered onStartLibraryChat={onStartLibraryChat} />
      )}
      {turns.map((turn, index) => {
        // The last turn is the one still streaming while a turn is
        // active; only a settled turn offers actions on its reply.
        const settled = !(turnActive && index === turns.length - 1);
        const replyText = settled ? turnReplyText(turn) : '';
        return (
          // `aria-busy` rides the ONE turn that is still streaming, not the
          // whole log: token-by-token mutations of the live tail would
          // otherwise re-announce through the log's polite live region on
          // every chunk. The settled turns and notices around it keep
          // announcing; this turn speaks once, when it settles and the
          // busy flag drops.
          <div className={turnClass} key={turn.key} aria-busy={!settled || undefined}>
            {turn.head && (
              <UserTurnHead
                block={turn.head}
                onCopy={onCopyUserMessage}
                onSendEdit={onResendUserMessage}
              />
            )}
            {/* `agent-turn-reply` scopes the reply timestamp's hover reveal
              * to the ANSWER region, mirroring `agent-turn-user` on the
              * question side — hovering one never lights up the other. */}
            <div className="agent-turn-reply group/reply flex flex-col gap-2.5">
              {/* Speaker identity is visual-only (alignment/typography), so
                * a linearized reading gets it stated. Pairs with the "You:"
                * prefix in UserTurnHead. */}
              {turn.body.length > 0 && <span className="sr-only">{agentShortName}: </span>}
              <TurnBody
                blocks={turn.body}
                liveBlockId={turnActive && blocks.length > 0 ? blocks[blocks.length - 1].id : null}
                streaming={!settled}
                meta={turn.head ? turnMeta[turn.head.id] : undefined}
                handlers={handlers}
              />
              {replyText && (
                <TurnActions
                  text={replyText}
                  at={replyTimestamp(turn, turn.head ? turnMeta[turn.head.id] : undefined)}
                  onCopy={onCopyUserMessage}
                />
              )}
            </div>
          </div>
        );
      })}
      {queuedTurns.map((turn) => (
        <QueuedTurn
          key={turn.id}
          turn={turn}
          onSteer={onSteerQueued}
          onDelete={onDeleteQueued}
        />
      ))}
      {blocks.length > 0 && phase === 'closed' && fatal && (
        <FatalInline fatal={fatal} agentShortName={agentShortName} recoveryLabel={fatalRecoveryLabel} onRetry={onRetry} />
      )}
      {(blocks.length > 0 || queuedTurns.length > 0) && scopeRetired && (
        <ScopeRetiredNotice retired={scopeRetired} onStartLibraryChat={onStartLibraryChat} />
      )}
      {turnActive && !tailBlockSpeaks(blocks) && (
        // Generic tail status renders only when no visible block already
        // narrates the moment — a tool group shimmers its own summary
        // (running OR between consecutive calls, so it never blinks off and
        // hands the cue to this line), live thinking shimmers "Thinking",
        // and an awaiting permission card means the agent is waiting on the
        // USER, where "is working…" would be a lie.
        <div className="flex items-center gap-1.5 p-0.5 text-sm text-muted-foreground">
          <Dot /><span className="working-shimmer">{agentShortName} is working…</span>
        </div>
      )}
      {showJump && (
        // Must sit above a pinned user-turn header (z-2), otherwise its
        // upper half is hidden and cannot be clicked while scrolling.
        <Button
          variant="outline"
          size="sm"
          className="sticky bottom-2 z-3 self-center rounded-full bg-popover shadow-elevation"
          onClick={() => {
            if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
            stick.current = true;
            setShowJump(false);
          }}
        >Jump to latest ↓</Button>
      )}
    </div>
  );
}

interface ReplyHandlers {
  agentKind: AgentKind;
  onPermission: (t: string, p: string, a: boolean) => void;
  onCopyUserMessage: (text: string) => void;
  onResendUserMessage: (text: string) => void;
  onOpenArtifact: (path: string) => void;
  onTurnFailureAction: (blockId: string, action: TurnFailureActionId) => void;
}

/** Render a run of reply blocks: consecutive completed/running tool blocks
 * collapse into one ToolActivityGroup; everything else (thinking, assistant
 * prose, notices, errors, and awaiting-permission tools) renders inline. Permission
 * requests stay OUT of the groups so their Allow/Reject controls are never
 * hidden by a collapse. */
function renderReplyBlocks(blocks: Block[], liveBlockId: string | null, h: ReplyHandlers): ReactNode {
  const groups: Array<Block | ToolBlock[]> = [];
  for (const block of blocks) {
    if (block.kind !== 'tool' || block.status === 'awaiting') {
      groups.push(block);
      continue;
    }
    const previous = groups[groups.length - 1];
    if (Array.isArray(previous)) previous.push(block);
    else groups.push([block]);
  }
  return groups.map((group) => Array.isArray(group)
    ? <ToolActivityGroup key={`activity-${group[0].id}`} tools={group} live={group[group.length - 1].id === liveBlockId} onOpenArtifact={h.onOpenArtifact} />
    : <BlockView key={group.id} block={group} live={group.id === liveBlockId} handlers={h} />
  );
}

function TurnBody({ blocks, liveBlockId, streaming, meta, handlers: h }: {
  blocks: Block[];
  /** The stream's last block while the turn is active — the one block
   *  whose meta label may shimmer as "working". */
  liveBlockId: string | null;
  /** This turn is still streaming (the flat, everything-expanded phase). */
  streaming: boolean;
  meta?: TurnMeta;
  handlers: ReplyHandlers;
}) {
  // While streaming, render the trace flat and expanded — the work is
  // happening live and there is no stable "final answer" to separate yet
  // (the last assistant block keeps moving as tokens arrive).
  if (streaming) return <>{renderReplyBlocks(blocks, liveBlockId, h)}</>;

  // Interrupted: no clean answer was produced, so the whole trace stays in
  // the collapsible, expanded by default, under "You stopped after X".
  if (meta?.interrupted) return <WorkTrace blocks={blocks} meta={meta} handlers={h} defaultOpen />;

  // Settled normally: the last assistant answer OR terminal error remains
  // visible. Everything before it collapses under "Worked for X". Hiding a
  // terminal error in the work trace leaves a failed turn unexplained.
  const { workBlocks, answerBlocks } = settledReplySections(blocks);
  return (
    <>
      {workBlocks.length > 0 && <WorkTrace blocks={workBlocks} meta={meta} handlers={h} />}
      {renderReplyBlocks(answerBlocks, null, h)}
    </>
  );
}

/** The turn's working trace — thinking, interim narration, and tool activity —
 * folded under a single "Worked for X" (or "You stopped after X") header, the
 * way Codex presents a completed turn. Collapsed by default once the turn is
 * done (the answer below carries the result); an interrupted turn opens by
 * default since it has no answer. The user can toggle it either way.
 *
 * A real disclosure, not a button that happens to toggle a sibling: the
 * `Collapsible` primitive points the trigger's `aria-controls` at the
 * panel it actually reveals. The trigger is sized to its own label — the
 * summary IS the control — so the hover surface hugs the words instead of
 * washing the full transcript width, which is what a `w-full` ghost row
 * did. The rule stays on the header wrapper, so it still spans the column
 * and still sits between the header and whatever the panel reveals. */
function WorkTrace({ blocks, meta, handlers, defaultOpen = false }: {
  blocks: Block[];
  meta?: TurnMeta;
  handlers: ReplyHandlers;
  defaultOpen?: boolean;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? defaultOpen;
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => setUserOpen(next)}
      render={<section className="agent-worktrace" />}
    >
      <div className="border-b border-b-border/85 pt-0.5 pb-2">
        <CollapsibleTrigger
          render={<Button variant="ghost" />}
          className="-mx-1.5 h-auto w-fit max-w-full justify-start gap-1.5 px-1.5 py-0.5 text-left text-base font-normal text-muted-foreground"
        >
          <span className="agent-worktrace-label">{workTraceLabel(meta)}</span>
          <ChevronDownIcon className={cn('size-3 shrink-0 opacity-70 transition-transform duration-fast ease-out', !open && '-rotate-90')} />
        </CollapsibleTrigger>
      </div>
      <CollapsiblePanel className="flex flex-col gap-2.5 pt-2.5">
        {renderReplyBlocks(blocks, null, handlers)}
      </CollapsiblePanel>
    </Collapsible>
  );
}

function QueuedTurn({
  turn, onSteer, onDelete,
}: {
  turn: QueuedTurnPreview;
  onSteer: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const label = turn.status === 'steered'
    ? 'Steered'
    : turn.status === 'steering'
      ? 'Steering'
      : turn.status === 'cancelled'
        ? 'Cancelled'
        : 'Waiting';
  return (
    <div className={turnClass}>
      <div className={cn(turnHeadClass, 'text-muted-foreground')}>
        {turn.attachments && turn.attachments.length > 0 && <MessageAttachments attachments={turn.attachments} />}
        <div className="flex min-w-0 items-start gap-2.5">
          {turn.text && (
            <UserMessageText
              text={turn.text}
              attachmentPaths={turn.attachments?.map((attachment) => attachment.path)}
            />
          )}
          {/* 1px, not a step: it drops the status baseline onto the
            * first line of the message text beside it. */}
          <span className="inline-flex shrink-0 items-center gap-2.5 pt-px">
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              {turn.status !== 'cancelled' && <Dot />}
              {label}
            </span>
            {turn.canSteer && turn.status === 'waiting' && (
              <Button variant="ghost" size="xs" className="h-auto p-0 text-sm font-semibold text-muted-foreground hover:bg-transparent hover:text-accent" onClick={() => onSteer(turn.id)}>
                Steer
              </Button>
            )}
            {turn.status === 'waiting' && (
              <Button
                variant="ghost"
                size="icon-xs"
                className="-my-0.5 text-muted-foreground hover:bg-transparent hover:text-destructive"
                aria-label="Delete queued message"
                title="Delete queued message"
                onClick={() => onDelete(turn.id)}
              >
                <TrashIcon />
              </Button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

function ScopeRetiredNotice({
  retired,
  centered = false,
  onStartLibraryChat,
}: {
  retired: RetiredAgentScope;
  centered?: boolean;
  onStartLibraryChat: () => void;
}) {
  const notice = (
    <StatusMessage tone="warning" className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5">
      <div>
        <SectionHeading level={3}>{basename(retired.folder)} was removed from Library</SectionHeading>
        <div className="text-sm leading-normal text-muted-foreground">
          This chat is still available, but it can’t continue in that folder.
        </div>
      </div>
      <Button variant="outline" size="sm" className="shrink-0" onClick={onStartLibraryChat}>
        New Library Chat
      </Button>
    </StatusMessage>
  );
  return centered
    ? <div className="grid min-h-45 flex-1 place-items-center px-2 py-6"><div className="w-measure-sm">{notice}</div></div>
    : notice;
}

function fatalCopy(fatal: string, agentShortName: string): { title: string; detail: string } {
  if (/No folder open/i.test(fatal)) {
    return { title: 'No folder open', detail: 'Open a folder, then retry.' };
  }
  return { title: `${agentShortName} couldn't continue`, detail: fatal };
}

/** The fatal message itself, capped and scrollable: a runtime failure can
 *  arrive as a whole stack trace, and an uncapped one pushes its own retry
 *  button off the pane. Stays a class string because its three call sites
 *  wear three different titles (two sizes) above it — the pair is not one
 *  component, and naming the cap once is the only thing they share. */
const fatalDetailClass =
  'max-h-35 overflow-auto text-sm leading-normal break-words whitespace-pre-wrap text-muted-foreground';

function FatalState({
  fatal, agentShortName, recoveryLabel, onRetry,
}: {
  fatal: string;
  agentShortName: string;
  recoveryLabel: 'Retry' | 'Reconnect';
  onRetry: () => void;
}) {
  const copy = fatalCopy(fatal, agentShortName);
  return (
    <div className="grid min-h-45 flex-1 place-items-center px-2 py-6">
      <StatusMessage tone="error" className="flex w-measure-sm flex-col items-start gap-2 rounded-xl p-3.5">
        {/* Level 2, stated: this card fills the pane (it renders only with
          * an empty transcript), so it tops the pane outline like the other
          * pane-level state cards. FatalInline below is a transcript entry
          * and sits at h3 with the other inline cards. */}
        <SectionHeading level={2}>{copy.title}</SectionHeading>
        <div className={fatalDetailClass}>{copy.detail}</div>
        <Button variant="outline" size="sm" onClick={onRetry}>{recoveryLabel}</Button>
      </StatusMessage>
    </div>
  );
}

function FatalInline({
  fatal, agentShortName, recoveryLabel, onRetry,
}: {
  fatal: string;
  agentShortName: string;
  recoveryLabel: 'Retry' | 'Reconnect';
  onRetry: () => void;
}) {
  const copy = fatalCopy(fatal, agentShortName);
  return (
    <StatusMessage tone="error" className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5">
      <div>
        <SectionHeading level={3}>{copy.title}</SectionHeading>
        <div className={fatalDetailClass}>{copy.detail}</div>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry}>{recoveryLabel}</Button>
    </StatusMessage>
  );
}

function ConnectingNotice({ agentShortName }: { agentShortName: string }) {
  return (
    <div className="flex items-center gap-2 px-0.5 py-2 text-sm text-muted-foreground" role="status">
      <span className={spinnerClass} aria-hidden="true" />
      Connecting to {agentShortName}…
    </div>
  );
}

function BlockView({ block, live, handlers }: {
  block: Block;
  live?: boolean;
  handlers: ReplyHandlers;
}) {
  switch (block.kind) {
    case 'user':
      // Unreachable: groupTurns hoists every user block into turn.head, so
      // none travels through renderReplyBlocks. Kept for exhaustiveness.
      return null;
    case 'assistant':
      return <AssistantBlock text={block.text} onOpenArtifact={handlers.onOpenArtifact} />;
    case 'thinking':
      return <ThinkingView text={block.text} active={live} />;
    case 'notice':
      return (
        <StatusMessage tone="warning" className="text-sm leading-normal whitespace-pre-wrap">
          {block.text}
        </StatusMessage>
      );
    case 'error': {
      // A classified live failure explains its recovery; anything else —
      // including replayed history, which carries no kind — stays a plain
      // message. The kind is adapter-assigned; no prose is parsed here.
      const guidance = block.failureKind ? turnFailureGuidance(block.failureKind, handlers.agentKind) : null;
      if (!guidance) {
        return (
          <StatusMessage tone="error" className="text-sm leading-normal whitespace-pre-wrap">
            {block.text}
          </StatusMessage>
        );
      }
      return (
        <StatusMessage tone="error" className="flex flex-col items-start gap-1.5 rounded-xl p-3">
          <SectionHeading level={3} className="text-sm">{guidance.title}</SectionHeading>
          <div className={fatalDetailClass}>{block.text}</div>
          <div className="text-sm leading-normal">{guidance.guidance}</div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlers.onTurnFailureAction(block.id, guidance.action.id)}
          >
            {guidance.action.label}
          </Button>
        </StatusMessage>
      );
    }
    case 'tool':
      // A tool block only reaches BlockView while it is awaiting approval;
      // completed/running tools are grouped into ToolActivityGroup.
      return <PermissionCard block={block} onPermission={handlers.onPermission} />;
  }
}

function ThinkingView({ text, active }: { text: string; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="min-w-0">
      {/* A plain meta disclosure row — closed thinking should cost no
        * chrome, so the ghost button keeps neither height nor a hover
        * fill, only the type step every other meta line in the panel
        * takes. Same shape as WorkTrace's own header above. */}
      <Button
        variant="ghost"
        className="h-auto gap-1 px-0 py-0.5 text-sm font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        // Only while the body exists — an aria-controls pointing at an
        // unmounted id is a dangling reference.
        aria-controls={open ? panelId : undefined}
      >
        <ChevronDownIcon className={cn('size-3 transition-transform duration-fast ease-out', !open && '-rotate-90')} />
        {/* Shimmers while this is the stream's live block — the label
          * itself signals "working" (Cursor register). */}
        <span className={active ? 'working-shimmer' : undefined}>Thinking</span>
      </Button>
      {/* Only the opened body carries the quote bar that marks it as
        * sidetracked prose. The 4/2/10 inset is derived, not eyeballed:
        * it puts the body text at 16px, exactly where the head's own
        * label starts (12px chevron + the button's 4px gap), so the
        * quote bar hangs in the margin the disclosure already opened. */}
      {open && (
        <div id={panelId} className="ml-1 border-l-2 border-border pt-1 pb-1.5 pl-2.5 text-sm leading-normal whitespace-pre-wrap text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  );
}

/** Assistant prose. The actions menu is NOT here — it belongs to the
 * whole reply (see `TurnActions`), not to each paragraph the stream
 * happened to split off between tool calls. */
function AssistantBlock({ text, onOpenArtifact }: {
  text: string;
  onOpenArtifact: (path: string) => void;
}) {
  return <div className="agent-prose"><AgentMarkdown markdown={text} onOpenArtifact={onOpenArtifact} /></div>;
}

/** One Copy Reply button per completed TURN, bottom-left under the
 * reply (Codex register).
 *
 * Per-turn, not per-block: a single reply is delivered as several
 * assistant blocks separated by tool calls, so a per-block button would
 * stamp one after every paragraph. Always visible rather than
 * hover-revealed — unlike the user bubble's hover cluster, this is the
 * one standing action on a reply, and a control that only exists under
 * the pointer is a control most people never find. Same CopyIcon as the
 * user-message copy, at the 14px chrome glyph size. Absent while the
 * turn is still streaming: there is no complete reply to act on yet. */
function TurnActions({ text, at, onCopy }: {
  text: string;
  at?: number;
  onCopy: (text: string) => void;
}) {
  return (
    <div className="flex items-center justify-start gap-1.5">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Copy reply"
        onClick={() => onCopy(text)}
      >
        <CopyIcon className="size-3.5" />
      </Button>
      {/* Metadata, not an action: the reply time surfaces on turn hover
        * only, while the copy button stands. */}
      {at !== undefined && (
        <span className="select-none whitespace-nowrap text-xs text-muted-foreground opacity-0 transition-surface group-hover/reply:opacity-100 group-focus-within/reply:opacity-100">
          {formatMessageTime(at)}
        </span>
      )}
    </div>
  );
}
