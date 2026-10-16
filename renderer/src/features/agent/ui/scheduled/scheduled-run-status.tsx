/** One run's line: what became of it, when, why it was late or failed, the
 *  start of the Agent's last reply, and a way into the chat it started. Ink
 *  and grey throughout; red marks only a run that did not run or did not
 *  finish, the one thing to act on. */
import {
  CalendarX2,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  LoaderCircle,
  type LucideIcon,
} from 'lucide-react';

import {
  lateNote,
  runStatus,
  runWhenLabel,
  type RunTone,
} from '@/features/agent/domain/scheduled-task-status';
import type { ScheduledTaskRun } from '@/features/agent/domain/scheduled-tasks';
import { focusRing } from '@/lib/focus-ring';
import { shapeTokens } from '@/lib/shape-context';
import { cn } from '@/lib/utils';

const TONE_ICONS: Readonly<Record<RunTone, LucideIcon>> = {
  done: CircleCheck,
  failed: CircleX,
  missed: CalendarX2,
  progress: LoaderCircle,
  quiet: CircleDashed,
  waiting: CircleAlert,
};

export function ScheduledRunStatus({
  live,
  name,
  onOpenChat,
  run,
}: {
  /** The run's chat's live work status, when this window holds the chat. */
  live: string | null;
  /** The task's name, for a history line; absent beside the task itself. */
  name?: string | undefined;
  onOpenChat(run: ScheduledTaskRun): void;
  run: ScheduledTaskRun;
}) {
  const status = runStatus(run, live);
  const Icon = TONE_ICONS[status.tone];
  const late = lateNote(run);
  const failed = status.tone === 'failed';
  return (
    <div className="flex min-w-0 items-start gap-2 text-caption">
      <Icon
        aria-hidden
        className={cn(
          'mt-0.5 size-3.5 shrink-0',
          failed ? 'text-destructive' : 'text-muted-foreground',
          status.tone === 'done' && 'text-foreground',
          status.tone === 'progress' && 'animate-spin motion-reduce:animate-none',
        )}
        strokeWidth={1.75}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="m-0 flex flex-wrap items-baseline gap-x-1.5 text-muted-foreground">
          <span className={cn('font-medium', failed ? 'text-destructive' : 'text-foreground')}>
            {status.label}
          </span>
          {name && <span className="text-foreground">{name}</span>}
          <span>{runWhenLabel(run)}</span>
          {run.trigger === 'manual' && <span>via Run now</span>}
          {run.sessionId && (
            <button
              className={cn(
                'cursor-pointer text-foreground underline-offset-2 hover:underline',
                focusRing(shapeTokens.item),
              )}
              onClick={() => onOpenChat(run)}
              type="button"
            >
              Open chat
            </button>
          )}
        </p>
        {late && <p className="m-0 text-muted-foreground">{late}</p>}
        {run.reason && <p className="m-0 text-muted-foreground">{run.reason}</p>}
        {status.note && <p className="m-0 text-muted-foreground">{status.note}</p>}
        {run.summary && run.summary !== run.reason && (
          <blockquote className="m-0 mt-0.5 border-l-2 border-border pl-2 text-muted-foreground">
            {run.summary}
          </blockquote>
        )}
      </div>
    </div>
  );
}
