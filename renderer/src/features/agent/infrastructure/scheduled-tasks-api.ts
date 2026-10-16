/**
 * The scheduled-tasks boundary: the server's task routes for the list and the
 * form, and the preload bridge for Run now and for the runs main hands this
 * window. The only module in the feature that sees either wire shape.
 */
import { missedRuns, nextRun } from '@/contracts/scheduled-task-timing';
import {
  ScheduledTasksError,
  type ScheduledRunNowResult,
  type ScheduledRunsPort,
  type ScheduledTasksExtra,
  type ScheduledTasksPort,
} from '@/features/agent/application/ports';
import type {
  ProjectSchedule,
  ScheduledRunOutcome,
  ScheduledTask,
  ScheduledTaskRun,
} from '@/features/agent/domain/scheduled-tasks';
import type { ScheduledTasksBridge } from '@/platform/electron/scheduled-tasks';
import {
  request,
  send,
  type TransportFailure,
  type TransportRequest,
} from '@/platform/http/classify';
import type { HttpClient } from '@/platform/http/client';
import {
  scheduledRunNowResponseSchema,
  scheduledRunOutcomeSchema,
  scheduledRunRequestSchema,
} from '@/protocols/electron/scheduled-tasks';
import { agentRuntimeFailureSchema } from '@/protocols/http/agent-runtime';
import {
  projectScheduleSchema,
  scheduleTaskSaveResponseSchema,
  type ProjectScheduleWire,
  type ScheduledTaskRunWire,
  type ScheduledTaskWire,
} from '@/protocols/http/scheduled-tasks';

const PATH = '/api/scheduled-tasks';

const CONFLICT_CODES: Readonly<Record<string, ScheduledTasksExtra>> = {
  FILE_CHANGED: 'conflict',
  SCHEDULE_FILE_INVALID: 'invalid-file',
  TASK_NOT_FOUND: 'not-found',
};

/** A 409 says which of three things happened; the code tells them apart. */
function conflict({ response, serverMessage }: TransportFailure) {
  if (response.status !== 409) return null;
  const body = agentRuntimeFailureSchema.safeParse(response.body);
  const kind = body.success && body.data.code ? CONFLICT_CODES[body.data.code] : undefined;
  if (!kind) return null;
  return new ScheduledTasksError(
    kind,
    'The task file refused the change.',
    serverMessage ? { cause: new Error(serverMessage) } : undefined,
  );
}

function call(
  path: string,
  signal: AbortSignal,
  method: 'GET' | 'PUT' | 'DELETE' = 'GET',
  body?: unknown,
): TransportRequest<ScheduledTasksExtra> {
  return {
    error: ScheduledTasksError,
    failure: conflict,
    failureSchema: agentRuntimeFailureSchema,
    invalidRequest: 'invalid-task',
    method,
    path,
    signal,
    ...(body === undefined ? {} : { body }),
  };
}

function toRun(run: ScheduledTaskRunWire): ScheduledTaskRun {
  return {
    agent: run.agent,
    missedCount: run.missedCount,
    occurrence: run.occurrence === null ? null : Date.parse(run.occurrence),
    reason: run.reason,
    runId: run.runId,
    sessionId: run.sessionId,
    startedAt: Date.parse(run.startedAt),
    status: run.status,
    summary: run.summary,
    title: run.title,
    trigger: run.trigger,
  };
}

/** Days missed since the last run, by the rule the server records them
 *  with when today's run starts; until then the list shows them from here. */
function pendingMissed(wire: ScheduledTaskWire, now: Date): ScheduledTaskRun | null {
  const missed = missedRuns(wire, now);
  if (!missed) return null;
  return {
    agent: null,
    missedCount: missed.count,
    occurrence: missed.last.getTime(),
    reason: null,
    runId: `missed-${missed.last.toISOString()}`,
    sessionId: null,
    startedAt: missed.first.getTime(),
    status: 'missed',
    summary: null,
    title: null,
    trigger: 'schedule',
  };
}

/** When a run happened, for ordering; missed days by the last one missed. */
function runAt(run: ScheduledTaskRun): number {
  return run.status === 'missed' && run.occurrence !== null ? run.occurrence : run.startedAt;
}

/** The recorded runs, newest first, with the pending missed entry in its
 *  place in time: a Run now started after the missed days stays the latest,
 *  so the task's own row keeps showing how today's run is going. */
function withPendingMissed(runs: ScheduledTaskRun[], missed: ScheduledTaskRun | null) {
  if (!missed) return runs;
  const at = runs.findIndex((run) => runAt(run) < runAt(missed));
  return at < 0 ? [...runs, missed] : [...runs.slice(0, at), missed, ...runs.slice(at)];
}

/** The next run is read when the list is, by the rule main's clock follows. */
function toTask(wire: ScheduledTaskWire, now: Date): ScheduledTask {
  return {
    agent: wire.agent,
    enabled: wire.enabled,
    files: wire.files,
    id: wire.id,
    name: wire.name,
    nextRunAt: nextRun(wire, now)?.getTime() ?? null,
    problem: wire.problem,
    prompt: wire.prompt,
    runs: withPendingMissed(wire.runs.map(toRun), pendingMissed(wire, now)),
    time: wire.time,
  };
}

function toSchedule(wire: ProjectScheduleWire): ProjectSchedule {
  return {
    folderPath: wire.folderPath,
    problem: wire.problem,
    tasks: wire.tasks.map((task) => toTask(task, new Date())),
    version: wire.version,
  };
}

const DESKTOP_ONLY: ScheduledRunNowResult = {
  message: 'Scheduled tasks run in the StashBase desktop app.',
  ok: false,
};

export function createScheduledTasksAdapter(
  client: HttpClient,
  bridge?: ScheduledTasksBridge,
): ScheduledTasksPort {
  const schedule = async (options: TransportRequest<ScheduledTasksExtra>) =>
    toSchedule(await request(client, { ...options, schema: projectScheduleSchema }));
  return {
    read: (folderPath, signal) =>
      schedule(call(`${PATH}?folder=${encodeURIComponent(folderPath)}`, signal)),
    async save(folderPath, baseVersion, draft, signal) {
      const task = {
        agent: draft.agent,
        files: [...draft.files],
        name: draft.name.trim(),
        prompt: draft.prompt,
        time: draft.time,
        ...(draft.id === undefined ? {} : { id: draft.id }),
      };
      const saved = await request(client, {
        ...call(`${PATH}/task`, signal, 'PUT', { baseVersion, folderPath, task }),
        schema: scheduleTaskSaveResponseSchema,
      });
      return { schedule: toSchedule(saved.schedule), taskId: saved.taskId };
    },
    remove: (folderPath, baseVersion, taskId, signal) =>
      schedule(call(`${PATH}/task`, signal, 'DELETE', { baseVersion, folderPath, taskId })),
    setEnabled: (folderPath, taskId, enabled, signal) =>
      schedule(call(`${PATH}/enabled`, signal, 'PUT', { enabled, folderPath, taskId })),
    async settle(folderPath, taskId, runId, outcome, signal) {
      await send(client, {
        ...call(`${PATH}/runs/settled`, signal, 'PUT', {
          folderPath,
          reason: outcome.status === 'failed' ? outcome.reason.slice(0, 500) : null,
          runId,
          status: outcome.status,
          summary: outcome.summary,
          taskId,
        }),
      });
    },
    async runNow(folderPath, taskId) {
      if (!bridge) return DESKTOP_ONLY;
      const response = scheduledRunNowResponseSchema.safeParse(
        await bridge.runNow({ folderPath, taskId }).catch(() => null),
      );
      if (!response.success) return { message: 'StashBase could not start this run.', ok: false };
      return response.data.ok
        ? { ok: true, outcome: response.data.outcome }
        : { message: response.data.failure.message, ok: false };
    },
  };
}

/** Hands each run main sends this window to `handler`, and its answer back. */
export function createScheduledRunsAdapter(bridge: ScheduledTasksBridge): ScheduledRunsPort {
  return {
    onRunRequested: (handler) =>
      bridge.onRunRequested(async (raw): Promise<ScheduledRunOutcome> => {
        const parsed = scheduledRunRequestSchema.safeParse(raw);
        if (!parsed.success) return { reason: 'The run request was invalid.', status: 'failed' };
        const { requestId: _requestId, ...run } = parsed.data;
        const outcome = scheduledRunOutcomeSchema.safeParse(await handler(run));
        return outcome.success
          ? outcome.data
          : { reason: 'The chat could not be started.', status: 'failed' };
      }),
  };
}
