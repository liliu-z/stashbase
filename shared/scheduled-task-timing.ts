/**
 * When a daily scheduled task runs, in local time. Electron main decides what
 * is due with these; the task list says when the next run will be with the
 * same rule, so the two can never disagree.
 *
 * A task is due once a day at its time. A run missed earlier today while the
 * app was closed or the computer slept starts when it is back; one missed on
 * an earlier day is not run late, because that day's result would be stale,
 * and is listed as missed instead. Never more than one run per task per
 * local day, and never for a time before the task was switched on.
 */
export interface ScheduledTaskTiming {
  readonly enabled: boolean;
  readonly enabledAt: string | null;
  readonly lastDispatchedAt: string | null;
  readonly lastOccurrence: string | null;
  readonly problem: string | null;
  /** `HH:MM`, local. */
  readonly time: string;
}

function clock(time: string): { hours: number; minutes: number } | null {
  const match = time.match(/^(\d{2}):(\d{2})$/u);
  return match ? { hours: Number(match[1]), minutes: Number(match[2]) } : null;
}

function sameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/** A daily time on `day`, `days` later. A time a clock change skipped
 *  resolves the way Date normalizes it. */
function occurrenceOn(
  day: Date,
  at: { hours: number; minutes: number },
  days = 0,
): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days, at.hours, at.minutes);
}

/** Days since an epoch, by the local calendar, so DST days count as one. */
function dayNumber(day: Date): number {
  return Math.round(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) / 86_400_000);
}

/** The occurrence a task should run for now, or null when nothing is due.
 *  Only today's can be due. */
export function dueOccurrence(task: ScheduledTaskTiming, now: Date): Date | null {
  if (!task.enabled || task.problem) return null;
  const at = clock(task.time);
  if (!at) return null;
  const occurrence = occurrenceOn(now, at);
  if (occurrence.getTime() > now.getTime()) return null;
  if (task.enabledAt && occurrence.getTime() < Date.parse(task.enabledAt)) return null;
  if (task.lastOccurrence && occurrence.getTime() <= Date.parse(task.lastOccurrence)) return null;
  if (task.lastDispatchedAt && sameLocalDay(new Date(task.lastDispatchedAt), now)) return null;
  return occurrence;
}

/** When the task will next run: `now` when it is due already, otherwise its
 *  next daily time; null while it is switched off or cannot run. */
export function nextRun(task: ScheduledTaskTiming, now: Date): Date | null {
  if (!task.enabled || task.problem) return null;
  if (dueOccurrence(task, now)) return now;
  const at = clock(task.time);
  if (!at) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), at.hours, at.minutes);
  const ranToday = task.lastDispatchedAt !== null && sameLocalDay(new Date(task.lastDispatchedAt), now);
  if (today.getTime() > now.getTime() && !ranToday) return today;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, at.hours, at.minutes);
}

export interface MissedRuns {
  readonly count: number;
  readonly first: Date;
  readonly last: Date;
}

/**
 * The daily runs that came and went before today without starting, because
 * StashBase was closed or asleep: one a day from the day after the last run
 * that started (or from the switch turning on) through yesterday. A day that
 * had a run is never missed, even if the time changed since. Today's own run
 * is never missed; it is still due. Null when there are none.
 */
export function missedRuns(task: ScheduledTaskTiming, now: Date): MissedRuns | null {
  if (!task.enabled || task.problem) return null;
  const at = clock(task.time);
  if (!at) return null;
  const starts: number[] = [];
  if (task.lastOccurrence) starts.push(dayNumber(new Date(task.lastOccurrence)) + 1);
  if (task.enabledAt) {
    const enabledAt = new Date(task.enabledAt);
    const sameDay = occurrenceOn(enabledAt, at).getTime() >= enabledAt.getTime();
    starts.push(dayNumber(enabledAt) + (sameDay ? 0 : 1));
  }
  if (starts.length === 0) return null;
  const today = dayNumber(now);
  const firstDay = Math.max(...starts);
  if (firstDay >= today) return null;
  return {
    count: today - firstDay,
    first: occurrenceOn(now, at, firstDay - today),
    last: occurrenceOn(now, at, -1),
  };
}
