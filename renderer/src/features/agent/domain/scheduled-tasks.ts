/**
 * A project's scheduled tasks as the Agent feature reads them.
 *
 * A task asks for one thing at one local time every day: a new chat in the
 * project with a request, the project files it names, and an Agent. The task
 * stores file paths only, so a run reads whatever those files hold when it
 * starts. The project's `.schedules.json` holds the tasks; the switch and the
 * run history belong to this computer.
 */
import type { AgentId } from '@/features/agent/domain/session';

/** One run as the app recorded it. `running`: its chat is being started.
 *  `sent`: the chat's request was accepted and its first turn has not
 *  reported back. `completed` and `failed` say how it ended; a failed run
 *  with no chat never started one. `missed`: daily runs that never started
 *  because StashBase was closed or asleep. */
export interface ScheduledTaskRun {
  readonly agent: AgentId | null;
  /** The time a scheduled run was due; null for Run now. */
  readonly occurrence: number | null;
  readonly reason: string | null;
  readonly runId: string;
  /** The native conversation the run started, to open it from the list. */
  readonly sessionId: string | null;
  readonly startedAt: number;
  readonly status: 'running' | 'sent' | 'completed' | 'failed' | 'missed';
  /** For a missed entry, how many daily runs it covers, from `startedAt`
   *  (the first one's time) to `occurrence` (the last one's). */
  readonly missedCount: number | null;
  /** The start of the Agent’s last reply once the first turn ended. */
  readonly summary: string | null;
  readonly title: string | null;
  readonly trigger: 'schedule' | 'manual';
}

export interface ScheduledTask {
  /** Null: the project's own Agent. */
  readonly agent: AgentId | null;
  readonly enabled: boolean;
  /** Project-relative paths of the files the request follows. */
  readonly files: readonly string[];
  readonly id: string;
  readonly name: string;
  /** When it runs next; null while it is off or cannot run. */
  readonly nextRunAt: number | null;
  /** Why the file's entry cannot run as written; null when it can. */
  readonly problem: string | null;
  readonly prompt: string;
  /** Newest first. */
  readonly runs: readonly ScheduledTaskRun[];
  /** `HH:MM`, local time, every day. */
  readonly time: string;
}

export interface ProjectSchedule {
  readonly folderPath: string;
  /** Why the task file cannot be read at all; nothing in it runs. */
  readonly problem: string | null;
  readonly tasks: readonly ScheduledTask[];
  /** The task file version these tasks were read from; null with no file. */
  readonly version: string | null;
}

/** One task as the form edits it. A new task has no id yet. */
export interface ScheduledTaskDraft {
  readonly agent: AgentId | null;
  readonly files: readonly string[];
  readonly id?: string | undefined;
  readonly name: string;
  readonly prompt: string;
  readonly time: string;
}

/** One run as a window starts it. */
export interface ScheduledRunRequest {
  readonly agent: AgentId | null;
  readonly files: readonly string[];
  readonly folderPath: string;
  readonly prompt: string;
  /** The run its first turn's outcome is reported against. */
  readonly runId: string;
  readonly taskId: string;
  readonly title: string;
}

/** How a sent run's first turn ended, as its window saw it, with the start
 *  of the Agent’s last reply: a turn can end normally and still say it could
 *  not do the work. */
export type ScheduledTurnOutcome =
  | { readonly status: 'completed'; readonly summary: string | null }
  | { readonly status: 'failed'; readonly reason: string; readonly summary: string | null };

const SUMMARY_MAX = 300;

/** A reply as one plain line for the task list: headings, list markers,
 *  link targets, bold and code marks and line breaks dropped, cut at a word
 *  near the limit. */
export function runSummary(reply: string): string | null {
  const line = reply
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gmu, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/[*`]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!line) return null;
  if (line.length <= SUMMARY_MAX) return line;
  const cut = line.slice(0, SUMMARY_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > SUMMARY_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export type ScheduledRunOutcome =
  | { readonly status: 'sent'; readonly agent: AgentId; readonly sessionId: string }
  | { readonly status: 'failed'; readonly reason: string };

const NEW_TASK_TIME = '08:00';

export function emptyTaskDraft(): ScheduledTaskDraft {
  return { agent: null, files: [], name: '', prompt: '', time: NEW_TASK_TIME };
}

/** The request with every named file mentioned in it, so the form shows each
 *  file as the chip it is, even where the task file names it only in
 *  `files`. */
function withMentions(prompt: string, files: readonly string[]): string {
  const missing = files.filter((file) => !prompt.includes(`@${file}`));
  if (missing.length === 0) return prompt;
  const lead = prompt && !/\s$/u.test(prompt) ? ' ' : '';
  return `${prompt}${lead}${missing.map((file) => `@${file}`).join(' ')}`;
}

export function taskDraft(task: ScheduledTask): ScheduledTaskDraft {
  return {
    agent: task.agent,
    files: task.files,
    id: task.id,
    name: task.name,
    prompt: withMentions(task.prompt, task.files),
    time: task.time,
  };
}

/** What stops the form from saving, or null. The server checks the same. */
export function draftProblem(draft: ScheduledTaskDraft): string | null {
  if (!draft.name.trim()) return 'Give this task a name.';
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(draft.time)) return 'Set a time like 08:00.';
  if (!draft.prompt.trim() && draft.files.length === 0) {
    return 'Say what to do, or mention a file to follow.';
  }
  return null;
}

/** Each named file as the composer spells a mention. */
function mentions(files: readonly string[]): string {
  const named = files.map((file) => `@${file}`);
  if (named.length <= 1) return named.join('');
  return `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
}

/**
 * The request a run sends. A task that only names files, whether in `files`
 * alone or as bare mentions, asks the Agent to follow them, so a reader never
 * has to say whether a file is a workflow, a skill or a checklist. A file
 * named beside the request but not mentioned in it is still bound to the run.
 */
export function scheduledRunPrompt(prompt: string, files: readonly string[]): string {
  const said = files.reduce((text, file) => text.split(`@${file}`).join(''), prompt);
  if (said.trim()) return prompt;
  return `Follow the steps in ${mentions(files)}.`;
}

/** "Every day at 8:00 AM", in the reader's own clock, the way the list
 *  reads a task's time; a time the file states badly is quoted as written. */
export function scheduleLabel(time: string, locale: Intl.LocalesArgument = []): string {
  // Same rule as the form: `25:00` would otherwise roll over to 1:00 AM.
  const match = time.match(/^([01]\d|2[0-3]):([0-5]\d)$/u);
  if (!match) return `Every day at ${time}`;
  const at = new Date(2000, 0, 1, Number(match[1]), Number(match[2]));
  return `Every day at ${at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}`;
}
