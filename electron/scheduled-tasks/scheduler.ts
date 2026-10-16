/**
 * When a project's scheduled tasks run.
 *
 * Main keeps the clock because only main outlives every window: a timer in a
 * renderer would not fire for a project whose window is closed, and two
 * windows would each fire it. Each check reads every registered project's
 * tasks from the server, which owns the task files and what this machine
 * remembers about them, and dispatches whatever is due.
 *
 * What is due follows `shared/scheduled-task-timing.ts`, the rule the task
 * list reads its next run from. The server refuses a second claim for the
 * same occurrence, so a lost answer cannot make one occurrence run twice.
 */
import {
  scheduleClaimResponseSchema,
  scheduledProjectsSchema,
  type ProjectScheduleWire,
  type ScheduledTaskDefinitionWire,
} from '../../shared/protocols/http/scheduled-tasks.ts';
import type { ScheduledRunOutcome } from '../../shared/protocols/electron/scheduled-tasks.ts';
import { dueOccurrence } from '../../shared/scheduled-task-timing.ts';

export { dueOccurrence } from '../../shared/scheduled-task-timing.ts';

type Trigger = 'schedule' | 'manual';

const DAY_FORMAT = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' });

/** The run's chat title: the task's name and the day, so each day's result
 *  is easy to find in the chat list. */
export function runTitle(name: string, now: Date): string {
  return `${name.trim()} · ${DAY_FORMAT.format(now)}`.slice(0, 200);
}

export type ClaimResult =
  | { ok: true; runId: string; task: ScheduledTaskDefinitionWire }
  | { ok: false; reason: string };

export interface ScheduleServer {
  listProjects(): Promise<ProjectScheduleWire[]>;
  claim(request: { folderPath: string; taskId: string; trigger: Trigger; occurrence?: string }): Promise<ClaimResult>;
  finish(request: {
    agent: Extract<ScheduledRunOutcome, { status: 'sent' }>['agent'] | null;
    folderPath: string;
    reason: string | null;
    runId: string;
    sessionId: string | null;
    status: 'sent' | 'failed';
    taskId: string;
    title: string | null;
  }): Promise<void>;
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) return body.error.slice(0, 500);
  } catch { /* fall through to the status */ }
  return `StashBase could not start this run (HTTP ${response.status}).`;
}

/** Main's view of the server's task routes. Main sends no window identity:
 *  every request names its project, and only registered projects answer. */
export function createScheduleServer(serverUrl: string, fetchImpl: typeof fetch = fetch): ScheduleServer {
  const url = (path: string) => `${serverUrl}/api/scheduled-tasks${path}`;
  const json = (body: unknown): RequestInit => ({
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return {
    async listProjects() {
      const response = await fetchImpl(url('/projects'), { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Scheduled tasks returned HTTP ${response.status}`);
      return scheduledProjectsSchema.parse(await response.json()).projects;
    },
    async claim(request) {
      const response = await fetchImpl(url('/runs'), {
        ...json(request),
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return { ok: false, reason: await responseMessage(response) };
      const claimed = scheduleClaimResponseSchema.parse(await response.json());
      return { ok: true, runId: claimed.runId, task: claimed.task };
    },
    async finish(request) {
      const response = await fetchImpl(url('/runs'), {
        ...json(request),
        method: 'PUT',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Recording a scheduled run returned HTTP ${response.status}`);
    },
  };
}

export interface ScheduledDispatch<W> {
  folderPath: string;
  runId: string;
  task: ScheduledTaskDefinitionWire;
  title: string;
  /** The window to run in; absent, main finds or opens the project's own. */
  window?: W | undefined;
}

export interface SchedulerDependencies<W> {
  server: ScheduleServer;
  /** Starts the run's chat in a window of its project and answers how that
   *  went. It does not throw for an ordinary failure. */
  dispatch(run: ScheduledDispatch<W>): Promise<ScheduledRunOutcome>;
  /** True while nothing may run, such as during an update install. */
  paused?(): boolean;
  onDiagnostic?(error: unknown, action: string): void;
  now?(): Date;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
  startDelayMs?: number;
  intervalMs?: number;
}

function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : '';
  return (message || 'The run could not start its chat.').slice(0, 500);
}

export function createScheduledTaskScheduler<W>({
  server,
  dispatch,
  paused = () => false,
  onDiagnostic = () => {},
  now = () => new Date(),
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  startDelayMs = 20_000,
  intervalMs = 60_000,
}: SchedulerDependencies<W>) {
  let timer: unknown = null;
  let disposed = false;
  let checking: Promise<void> | null = null;
  const running = new Set<string>();

  async function run(
    folderPath: string,
    taskId: string,
    trigger: Trigger,
    options: { occurrence?: Date; window?: W } = {},
  ): Promise<ScheduledRunOutcome> {
    const key = `${folderPath}\u0000${taskId}`;
    if (running.has(key)) return { reason: 'This task is already running.', status: 'failed' };
    running.add(key);
    try {
      let claim: ClaimResult;
      try {
        claim = await server.claim({
          folderPath,
          taskId,
          trigger,
          ...(options.occurrence ? { occurrence: options.occurrence.toISOString() } : {}),
        });
      } catch (error) {
        onDiagnostic(error, 'claim');
        return { reason: 'StashBase could not start this run.', status: 'failed' };
      }
      if (!claim.ok) return { reason: claim.reason, status: 'failed' };
      const title = runTitle(claim.task.name, now());
      let outcome: ScheduledRunOutcome;
      try {
        outcome = await dispatch({
          folderPath,
          runId: claim.runId,
          task: claim.task,
          title,
          window: options.window,
        });
      } catch (error) {
        onDiagnostic(error, 'dispatch');
        outcome = { reason: failureReason(error), status: 'failed' };
      }
      try {
        await server.finish({
          agent: outcome.status === 'sent' ? outcome.agent : null,
          folderPath,
          reason: outcome.status === 'failed' ? outcome.reason : null,
          runId: claim.runId,
          sessionId: outcome.status === 'sent' ? outcome.sessionId : null,
          status: outcome.status,
          taskId,
          title,
        });
      } catch (error) {
        onDiagnostic(error, 'finish');
      }
      return outcome;
    } finally {
      running.delete(key);
    }
  }

  async function checkDue(): Promise<void> {
    if (disposed || paused()) return;
    let projects: ProjectScheduleWire[];
    try {
      projects = await server.listProjects();
    } catch (error) {
      onDiagnostic(error, 'list');
      return;
    }
    for (const project of projects) {
      for (const task of project.tasks) {
        if (disposed || paused()) return;
        const occurrence = dueOccurrence(task, now());
        if (!occurrence) continue;
        // One run at a time: each may open a window and start a runtime,
        // and a burst of them at one minute gains nothing from overlapping.
        await run(project.folderPath, task.id, 'schedule', { occurrence });
      }
    }
  }

  function schedule(delayMs: number) {
    if (disposed) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void scheduler.check().finally(() => schedule(intervalMs));
    }, delayMs);
    (timer as { unref?: () => void } | null)?.unref?.();
  }

  const scheduler = {
    /** Starts the clock: a first check shortly after launch, which is when a
     *  run missed while the app was closed catches up, then one a minute. */
    start() {
      schedule(startDelayMs);
    },
    /** Checks for due tasks now, sharing a check already in flight. Waking
     *  from sleep calls this, so a missed run catches up without waiting. */
    check(): Promise<void> {
      if (disposed) return Promise.resolve();
      checking ??= checkDue().finally(() => { checking = null; });
      return checking;
    },
    /** The task list's Run now, in the window that asked. It does not move
     *  the task's schedule. */
    runNow(folderPath: string, taskId: string, window: W): Promise<ScheduledRunOutcome> {
      if (disposed) return Promise.resolve({ reason: 'StashBase is closing.', status: 'failed' });
      return run(folderPath, taskId, 'manual', { window });
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
  return scheduler;
}
