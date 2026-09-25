/** The Agent's work as the reader sees it: consecutive tool calls collapse
 *  into one expandable group, a tool awaiting permission becomes a card with
 *  the decision on it, and a file write shows the diff it produced. Only the
 *  presentation lives here; what a tool means is decided in the domain. */
import {
  Ban,
  Check,
  ChevronRight,
  CircleAlert,
  FileText,
  FolderOpen,
  MessageCircleQuestionMark,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type ComponentType } from 'react';

import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import {
  ThinkingSteps,
  ThinkingStepsContent,
  ThinkingStepsHeader,
} from '@/components/ui/thinking-steps';
import {
  fileChangeKey,
  fileChangesForTool,
  settledFileChanges,
} from '@/features/agent/domain/file-change';
import { agentQuestionAnswers, agentQuestions } from '@/features/agent/domain/question';
import type { AgentTranscriptBlock } from '@/features/agent/domain/session';
import { agentToolKind } from '@/features/agent/domain/tool-kind';
import { focusRing } from '@/lib/focus-ring';
import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';
import type { SourceReference } from '@/shared/domain/source-reference';
import { holdsTextSelection } from '@/shared/utils/click-intent';

import { AgentDecisionCard, AgentDecisionStatus } from './decision-card';
import { AgentChangedFiles, AgentFileChangeView } from './file-change';
import { AgentQuestionSummary } from './question-card';
import {
  agentActivitySummary,
  agentPermissionTitle,
  agentToolPayload,
  agentToolResult,
  agentToolRow,
  STATUS_LABELS,
  type AgentToolBlock,
} from './tool-presentation';

type ToolIcon = ComponentType<{
  'aria-hidden'?: boolean;
  className?: string;
  strokeWidth?: number;
}>;

function iconFor(tool: AgentToolBlock): ToolIcon {
  switch (agentToolKind(tool.name)) {
    case 'command':
      return Terminal;
    case 'edit':
    case 'write':
      return FileText;
    case 'list':
      return FolderOpen;
    case 'question':
      return MessageCircleQuestionMark;
    case 'read':
      return FileText;
    case 'search':
      return Search;
    case 'other':
      return Wrench;
  }
}

/** The payload a tool surface renders once, shared by the row and the
 *  permission card so the ladder cannot drift: the diff when the call is a
 *  file change with evidence, the bounded inert text otherwise. */
function AgentToolPayload({ indent = true, tool }: { indent?: boolean; tool: AgentToolBlock }) {
  const changes = fileChangesForTool(tool.name, tool.input).filter(
    (change) => change.text !== undefined || change.patch !== undefined,
  );
  const questions = agentQuestions(tool.name, tool.input);
  const payload = changes.length > 0 || questions ? null : agentToolPayload(tool.input);
  const result = tool.result ? agentToolResult(tool.result) : null;
  return (
    <div
      className={cn(
        'space-y-2 pr-2 pb-2 text-[12px] text-muted-foreground',
        indent ? 'pl-7' : 'pt-2',
      )}
    >
      {changes.map((change) => (
        <AgentFileChangeView change={change} key={fileChangeKey(change)} />
      ))}
      {questions && (
        <AgentQuestionSummary answers={agentQuestionAnswers(tool.input)} questions={questions} />
      )}
      {payload !== null && (
        <pre
          aria-label={`${tool.name} arguments`}
          className="max-h-72 overflow-auto font-mono break-words whitespace-pre-wrap"
        >
          {payload}
        </pre>
      )}
      {result && (
        <pre
          aria-label={`${tool.name} result`}
          className={cn(
            'max-h-72 overflow-auto border-l border-border pl-2 font-mono break-words whitespace-pre-wrap',
            tool.status === 'error' && 'text-destructive',
          )}
        >
          {result}
        </pre>
      )}
    </div>
  );
}

function AgentToolRow({ tool }: { tool: AgentToolBlock }) {
  const shape = useShape();
  const [open, setOpen] = useState(false);
  // The payload stays unmounted until the row is opened and leaves again once
  // the close lands, which is the Disclosure's default: a long transcript is
  // hundreds of these rows, and the diffs behind them are the expensive part.
  const panelId = useId();
  const Icon = iconFor(tool);
  const presentation = agentToolRow(tool);
  const hasDetails = Object.keys(tool.input).length > 0 || Boolean(tool.result);
  return (
    <div
      className={cn(
        shape.item,
        tool.status === 'error' && 'bg-destructive-light',
        tool.status === 'cancelled' && 'opacity-65',
      )}
    >
      <button
        aria-controls={hasDetails ? panelId : undefined}
        aria-expanded={hasDetails ? open : undefined}
        className={cn(
          'group flex min-h-8 w-full items-center gap-2 px-2 text-left text-[12px] outline-none',
          shape.item,
          focusRing('hover:bg-hover'),
          !hasDetails && 'cursor-default',
        )}
        disabled={!hasDetails}
        // The row's verb and target are selectable, so the drag that copies a
        // path or a command ends as a click here. Folding the row shut on that
        // gesture would take the text away as the reader lifts the pointer.
        onClick={(event) => {
          if (holdsTextSelection(event.currentTarget)) return;
          if (hasDetails) setOpen((value) => !value);
        }}
        type="button"
      >
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        {/* select-text on both text spans: a button's text is not selectable
            by default, and what the agent touched — the command it ran, the
            file it edited — is the line a reader most wants to copy out of a
            transcript. Truncation is visual, so a selection carries the whole
            path even where the row shows its head. */}
        <span className="shrink-0 font-medium text-foreground select-text">
          {presentation.verb}
        </span>
        {presentation.target && (
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-muted-foreground select-text',
              presentation.mono && 'font-mono',
            )}
            title={presentation.target}
          >
            {presentation.target}
          </span>
        )}
        <span
          className={cn(
            'ml-auto shrink-0 text-muted-foreground',
            tool.status === 'error' && 'text-destructive',
          )}
        >
          {STATUS_LABELS[tool.status]}
        </span>
        {hasDetails && (
          <ChevronRight
            aria-hidden
            className={cn(
              'size-3 shrink-0 transition-transform duration-fast motion-reduce:transition-none',
              open && 'rotate-90',
            )}
            strokeWidth={1.5}
          />
        )}
      </button>
      {hasDetails && (
        <Disclosure id={panelId} open={open}>
          <AgentToolPayload tool={tool} />
        </Disclosure>
      )}
    </div>
  );
}

export type AgentActivityStep = Extract<AgentTranscriptBlock, { kind: 'thinking' | 'tool' }>;

/** What a group actually shows. Tool failures belong to native execution
 *  history. The Agent explains task outcomes; transcript-level failures
 *  separately report an interrupted turn. A group left with nothing renders
 *  nothing, so the transcript above must ask before counting on it to
 *  narrate. */
export function visibleActivitySteps(steps: AgentActivityStep[]): AgentActivityStep[] {
  return steps.filter((step) => step.kind !== 'tool' || step.status !== 'error');
}

export function AgentActivityGroup({
  focusToolId = null,
  live = false,
  onOpenSource,
  sourceFor,
  steps,
}: {
  /** A tool whose ask was just decided: the group that receives it takes
   *  focus once, at its summary, so the decision stays reachable. */
  focusToolId?: string | null;
  /** This group holds the turn that is still running, so its header names the
   *  step in hand. A tool between calls leaves nothing running; the turn is
   *  what makes the group live, not a single call's status. */
  live?: boolean;
  onOpenSource?: ((source: SourceReference, phrase: string | null) => void) | undefined;
  sourceFor?: ((path: string) => SourceReference | null) | undefined;
  steps: AgentActivityStep[];
}) {
  const visibleSteps = visibleActivitySteps(steps);
  const tools = visibleSteps.filter((step): step is AgentToolBlock => step.kind === 'tool');
  const active = live || tools.some((tool) => tool.status === 'running');
  const changes = settledFileChanges(tools);
  const headerRef = useRef<HTMLButtonElement>(null);
  const focusedFor = useRef<string | null>(null);
  const holdsFocusTool = focusToolId !== null && tools.some((tool) => tool.id === focusToolId);
  useEffect(() => {
    if (!holdsFocusTool || focusedFor.current === focusToolId) return;
    focusedFor.current = focusToolId;
    headerRef.current?.focus();
  }, [focusToolId, holdsFocusTool]);
  // Thinking alone has no step to name, so the header says what it is and
  // carries the same unfinished mark the summaries do.
  const thinkingHeader = active ? 'Thinking…' : 'Thinking';
  if (visibleSteps.length === 0) return null;
  return (
    <div className="-ml-2 flex w-[calc(100%+0.5rem)] flex-col gap-1">
      <ThinkingSteps className="w-full" defaultOpen={false}>
        <ThinkingStepsHeader className="px-2 py-1.5 text-[13px]" ref={headerRef}>
          {tools.length ? agentActivitySummary(tools, active) : thinkingHeader}
        </ThinkingStepsHeader>
        <ThinkingStepsContent className="gap-0.5 pl-2">
          {visibleSteps
            .filter((step) => step.kind !== 'tool' || step.status !== 'denied')
            .map((step) =>
              step.kind === 'thinking' ? (
                <p className="text-caption whitespace-pre-wrap text-muted-foreground" key={step.id}>
                  {step.text}
                </p>
              ) : (
                <AgentToolRow key={step.id} tool={step} />
              ),
            )}
        </ThinkingStepsContent>
      </ThinkingSteps>
      {tools
        .filter((tool) => tool.status === 'denied')
        .map((tool) => (
          <AgentToolRow key={tool.id} tool={tool} />
        ))}
      <AgentChangedFiles changes={changes} onOpenSource={onOpenSource} sourceFor={sourceFor} />
    </div>
  );
}

export function AgentPermissionCard({
  tool,
  onReply,
}: {
  tool: AgentToolBlock;
  onReply(toolUseId: string, permissionId: string, allow: boolean): boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const permissionId = tool.permissionId;
  const reply = (allow: boolean) => {
    if (!permissionId || !onReply(tool.id, permissionId, allow)) return;
    requestAnimationFrame(() => headingRef.current?.focus());
  };
  return (
    <AgentDecisionCard
      heading={agentPermissionTitle(tool)}
      headingRef={headingRef}
      icon={CircleAlert}
    >
      <AgentToolPayload indent={false} tool={tool} />
      {permissionId ? (
        <div className="mt-1 flex justify-end gap-2">
          <Button leadingIcon={Ban} onClick={() => reply(false)} size="compact" variant="tertiary">
            Reject
          </Button>
          <Button leadingIcon={Check} onClick={() => reply(true)} size="compact">
            Allow
          </Button>
        </div>
      ) : (
        <AgentDecisionStatus status={tool.status} />
      )}
    </AgentDecisionCard>
  );
}
