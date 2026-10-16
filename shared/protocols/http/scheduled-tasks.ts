import { z } from 'zod';
import { agentIdSchema } from './agent-runtime';

/** The project-root file a project's scheduled tasks live in. Hidden by
 *  default in Files; the task list is the reader's view of it. */
export const SCHEDULE_FILE_NAME = '.schedules.json';

/** Bounds shared by the file parser and the form, so a task the form accepts
 *  is one the file can hold and the scheduler can run. */
export const SCHEDULED_TASK_LIMITS = {
  files: 20,
  name: 120,
  prompt: 32_000,
  /** How much of a run’s final reply the task list keeps. */
  summary: 300,
  tasks: 50,
} as const;

const folderPath = z.string().min(1).max(4096);
const instant = z.string().datetime();

/** Stable within one file. The form derives it from the first name a task is
 *  saved with, so renaming a task keeps its switch and its last result. */
export const scheduledTaskIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);

/** Local wall-clock time, every day. */
export const scheduledTaskTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);

const name = z.string().trim().min(1).max(SCHEDULED_TASK_LIMITS.name);
const prompt = z.string().max(SCHEDULED_TASK_LIMITS.prompt);
const relativePath = z.string().min(1).max(4096);

/** What one task asks for: a name, a daily time, the request and the project
 *  files it names, and which Agent runs it (null: the project's own choice).
 *  Files are paths only; the run reads whatever they hold at that moment. */
export const scheduledTaskDefinitionSchema = z
  .object({
    agent: agentIdSchema.nullable(),
    files: z.array(relativePath).max(SCHEDULED_TASK_LIMITS.files),
    id: scheduledTaskIdSchema,
    name,
    prompt,
    time: scheduledTaskTimeSchema,
  })
  .strict();

const runTrigger = z.enum(['schedule', 'manual']);

/** One run of a task, as the app recorded it. `running`: its chat is being
 *  started. `sent`: the chat exists and its request was accepted, and the
 *  first turn has not reported back. `completed` and `failed` say how it
 *  ended; a run that failed with no chat never started one. `missed`: daily
 *  runs that never started because StashBase was closed or asleep; one entry
 *  covers `missedCount` days, from `startedAt` (the first one's time) to
 *  `occurrence` (the last one's). */
export const scheduledTaskRunSchema = z
  .object({
    agent: agentIdSchema.nullable(),
    finishedAt: instant.nullable(),
    missedCount: z.number().int().positive().nullable(),
    /** The scheduled time a scheduled run was for; null for Run now. */
    occurrence: instant.nullable(),
    reason: z.string().max(500).nullable(),
    runId: z.string().min(1).max(64),
    sessionId: z.string().min(1).max(256).nullable(),
    startedAt: instant,
    status: z.enum(['running', 'sent', 'completed', 'failed', 'missed']),
    /** The start of the Agent’s last reply once the first turn ended, so the
     *  list says what the run found or why it could not do the work. */
    summary: z.string().max(SCHEDULED_TASK_LIMITS.summary).nullable(),
    title: z.string().max(200).nullable(),
    trigger: runTrigger,
  })
  .strip();

/** One task as the file states it plus what this app keeps about it. A task
 *  the file states badly still appears, with the reason it cannot run. */
export const scheduledTaskSchema = z
  .object({
    agent: agentIdSchema.nullable(),
    enabled: z.boolean(),
    /** When the switch was last turned on; earlier times are never due. */
    enabledAt: instant.nullable(),
    files: z.array(z.string()),
    id: z.string().min(1),
    /** When the schedule last dispatched this task. */
    lastDispatchedAt: instant.nullable(),
    lastOccurrence: instant.nullable(),
    name: z.string(),
    problem: z.string().nullable(),
    prompt: z.string(),
    /** Newest first. */
    runs: z.array(scheduledTaskRunSchema).max(30),
    time: z.string(),
  })
  .strip();

export const projectScheduleSchema = z
  .object({
    folderPath,
    /** Why the file cannot be read as tasks at all; nothing in it runs. */
    problem: z.string().nullable(),
    tasks: z.array(scheduledTaskSchema),
    /** The file version the tasks were read from; null while there is none. */
    version: z.string().nullable(),
  })
  .strip();

export const scheduledProjectsSchema = z
  .object({ projects: z.array(projectScheduleSchema) })
  .strip();

/** A task as the form saves it. A new task has no id yet; the server gives it
 *  one from its name, unique in the file. */
export const scheduledTaskDraftSchema = scheduledTaskDefinitionSchema
  .extend({ id: scheduledTaskIdSchema.optional() })
  .strict();

/** One task written from the form, against the file version the form read.
 *  A null base version means the form saw no file. */
export const scheduleTaskSaveRequestSchema = z
  .object({
    baseVersion: z.string().min(1).max(200).nullable(),
    folderPath,
    task: scheduledTaskDraftSchema,
  })
  .strict();

export const scheduleTaskDeleteRequestSchema = z
  .object({
    baseVersion: z.string().min(1).max(200).nullable(),
    folderPath,
    taskId: z.string().min(1).max(64),
  })
  .strict();

/** The saved task's id with the list as it now stands. */
export const scheduleTaskSaveResponseSchema = z
  .object({ schedule: projectScheduleSchema, taskId: z.string().min(1) })
  .strip();

export const scheduleEnabledRequestSchema = z
  .object({ enabled: z.boolean(), folderPath, taskId: z.string().min(1).max(64) })
  .strict();

/** Main asks before every run. A scheduled claim names the occurrence it is
 *  for, so the same occurrence can never be claimed twice. */
export const scheduleClaimRequestSchema = z
  .object({
    folderPath,
    occurrence: instant.optional(),
    taskId: z.string().min(1).max(64),
    trigger: runTrigger,
  })
  .strict();

export const scheduleClaimResponseSchema = z
  .object({ runId: z.string().min(1).max(64), task: scheduledTaskDefinitionSchema })
  .strip();

export const scheduleFinishRequestSchema = z
  .object({
    agent: agentIdSchema.nullable(),
    folderPath,
    reason: z.string().max(500).nullable(),
    runId: z.string().min(1).max(64),
    sessionId: z.string().min(1).max(256).nullable(),
    status: z.enum(['sent', 'failed']),
    taskId: z.string().min(1).max(64),
    /** The chat's title, such as "Daily brief · Oct 16". */
    title: z.string().min(1).max(200).nullable(),
  })
  .strict();

/** A window's report of how a sent run's first turn ended. */
export const scheduleSettleRequestSchema = z
  .object({
    folderPath,
    reason: z.string().max(500).nullable(),
    runId: z.string().min(1).max(64),
    status: z.enum(['completed', 'failed']),
    summary: z.string().max(SCHEDULED_TASK_LIMITS.summary).nullable(),
    taskId: z.string().min(1).max(64),
  })
  .strict();

export type ScheduledTaskDefinitionWire = z.infer<typeof scheduledTaskDefinitionSchema>;
export type ScheduledTaskDraftWire = z.infer<typeof scheduledTaskDraftSchema>;
export type ScheduledTaskRunWire = z.infer<typeof scheduledTaskRunSchema>;
export type ScheduledTaskWire = z.infer<typeof scheduledTaskSchema>;
export type ProjectScheduleWire = z.infer<typeof projectScheduleSchema>;
