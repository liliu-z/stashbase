/**
 * How the task list says what a scheduled task did and will do. A reader
 * should never have to guess whether a task ran: every run is listed with
 * what became of it, a late run says why it was late, and a task that is on
 * says when it runs next.
 */
import type { ScheduledTask, ScheduledTaskRun } from './scheduled-tasks';

export type RunTone = 'progress' | 'waiting' | 'done' | 'failed' | 'quiet' | 'missed';

export interface RunStatusView {
  readonly label: string;
  /** What to do to learn more, when the label alone cannot say. */
  readonly note?: string | undefined;
  readonly tone: RunTone;
}

/** A run that started this long after its time was caught up, not on time. */
const LATE_AFTER_MS = 5 * 60_000;

/**
 * What became of one run. `live` is the work status of the run's chat when
 * this window holds it, which knows more than the record does while the
 * first turn is still going.
 */
export function runStatus(run: ScheduledTaskRun, live: string | null): RunStatusView {
  switch (run.status) {
    case 'running':
      return { label: 'Starting its chat', tone: 'progress' };
    case 'missed':
      return {
        label: (run.missedCount ?? 1) > 1 ? `Missed ${run.missedCount} runs` : 'Missed',
        note: 'StashBase was closed or asleep then.',
        tone: 'missed',
      };
    // The first turn ended; whether the work got done is in its reply.
    case 'completed':
      return { label: 'Finished', tone: 'done' };
    case 'failed':
      return { label: run.sessionId ? 'Did not finish' : 'Did not run', tone: 'failed' };
    case 'sent':
      if (live === 'Waiting for approval')
        return { label: 'Waiting for your approval', tone: 'waiting' };
      if (live === 'Completed') return { label: 'Finished', tone: 'done' };
      if (live === 'Could not finish') return { label: 'Did not finish', tone: 'failed' };
      if (live === 'Stopped') return { label: 'Stopped', tone: 'quiet' };
      if (live) return { label: 'Working', tone: 'progress' };
      // No window here followed the turn to its end, such as after a restart.
      return { label: 'Started', note: 'Open its chat to see how it ended.', tone: 'quiet' };
  }
}

const time = (at: number, locale: Intl.LocalesArgument) =>
  new Date(at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });

/** When a run started: "Oct 16, 8:00 AM" in the reader's own locale. */
function runTimeLabel(at: number, locale: Intl.LocalesArgument = []): string {
  return new Date(at).toLocaleString(locale, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
  });
}

/** When a run was: when it started, or for missed runs the day or the span
 *  of days they were due. */
export function runWhenLabel(run: ScheduledTaskRun, locale: Intl.LocalesArgument = []): string {
  if (run.status !== 'missed' || run.occurrence === null)
    return runTimeLabel(run.startedAt, locale);
  if ((run.missedCount ?? 1) === 1) return runTimeLabel(run.occurrence, locale);
  const day = (at: number) =>
    new Date(at).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  return `${day(run.startedAt)} – ${runTimeLabel(run.occurrence, locale)}`;
}

/** Why a scheduled run started late, or null when it ran on time. */
export function lateNote(run: ScheduledTaskRun, locale: Intl.LocalesArgument = []): string | null {
  if (run.occurrence === null || run.startedAt - run.occurrence < LATE_AFTER_MS) return null;
  return `Due at ${runTimeLabel(run.occurrence, locale)}; StashBase was closed or asleep then.`;
}

/** When an on task runs next, as the list says it. */
export function nextRunLabel(
  task: Pick<ScheduledTask, 'nextRunAt'>,
  now: number,
  locale: Intl.LocalesArgument = [],
): string | null {
  const at = task.nextRunAt;
  if (at === null) return null;
  if (at <= now + 60_000) return 'Runs in a moment';
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const days = Math.floor((at - day.getTime()) / 86_400_000);
  if (days === 0) return `Next run today at ${time(at, locale)}`;
  if (days === 1) return `Next run tomorrow at ${time(at, locale)}`;
  return `Next run ${runTimeLabel(at, locale)}`;
}

export interface TaskRun {
  readonly run: ScheduledTaskRun;
  readonly task: ScheduledTask;
}

/** Every task's runs, newest first: the project's run history. */
export function runHistory(tasks: readonly ScheduledTask[], limit = 50): TaskRun[] {
  return tasks
    .flatMap((task) => task.runs.map((run) => ({ run, task })))
    .toSorted((left, right) => right.run.startedAt - left.run.startedAt)
    .slice(0, limit);
}
