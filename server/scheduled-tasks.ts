/**
 * Scheduled tasks: what a project's `.schedules.json` asks for, and what this
 * app remembers about each task.
 *
 * The file is user-owned project content. Templates ship it and the Agent may
 * write it with the ordinary file tools, so it is parsed leniently: a task the
 * file states badly is still listed, with the reason it cannot run, and a form
 * save keeps every field the form does not know about.
 *
 * Whether a task is switched on, and how its last run went, belong to this
 * machine rather than the project. A copied template therefore never starts
 * spending credits on its own, and a folder synced to two computers is not run
 * twice. Both live in app config, which this process alone writes.
 *
 * When a task is due is Electron main's decision; this module only refuses a
 * claim for an occurrence that was already claimed, so one occurrence can
 * never be dispatched twice.
 */
import crypto from 'node:crypto';
import {
  readAppConfig,
  readAppConfigStrict,
  writeAppConfigStrict,
  type AppConfigFile,
} from './app-config.ts';
import { saveFileContent } from './file-save.ts';
import { filesystemPath } from './filesystem-path.ts';
import { registeredFolderRootsAsync, runWithFolderRoot } from './folder.ts';
import { errorMessage, logger } from './log.ts';
import { fileChanged, readTextSnapshotAsync, type TextSnapshot } from './text-file-transaction.ts';
import type { AgentId } from '../shared/agent-protocol.ts';
import {
  SCHEDULE_FILE_NAME,
  SCHEDULED_TASK_LIMITS,
  scheduledTaskIdSchema,
  type ProjectScheduleWire,
  type ScheduledTaskDefinitionWire,
  type ScheduledTaskDraftWire,
  type ScheduledTaskRunWire,
  type ScheduledTaskWire,
} from '../shared/protocols/http/scheduled-tasks.ts';
import { missedRuns } from '../shared/scheduled-task-timing.ts';

const log = logger('scheduled-tasks');

/** The file names Agents by what a reader calls them; `default` is the
 *  built-in runtime. Its implementation id is accepted as well. */
const FILE_AGENTS: Readonly<Record<string, AgentId>> = {
  claude: 'claude',
  codex: 'codex',
  default: 'stashbase',
  stashbase: 'stashbase',
};
const FILE_AGENT_NAMES: Readonly<Record<AgentId, string>> = {
  claude: 'claude',
  codex: 'codex',
  stashbase: 'default',
};

export interface ParsedScheduledTask {
  agent: AgentId | null;
  files: string[];
  id: string;
  name: string;
  /** Why this task cannot run; null when it can. */
  problem: string | null;
  prompt: string;
  time: string;
}

export interface ParsedSchedule {
  /** Why the file cannot be read as tasks at all. */
  problem: string | null;
  tasks: ParsedScheduledTask[];
  /** Each task's entry exactly as the file holds it, in the same order. */
  entries: unknown[];
  /** The file's top-level object, when it is one. */
  root: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function scheduleError(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { code, status });
}

/** A file-safe id from a task's name, unique among `taken`. */
export function taskIdFromName(name: string, taken: ReadonlySet<string>): string {
  const base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48) || 'task';
  let id = base;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}-${suffix}`;
  return id;
}

/** `8:05` and `08:05` are the same time; anything else is not a time. */
export function normalizeTaskTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/u);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${match[2]}`;
}

/** A project-relative path as the file and the composer spell it, or null for
 *  anything that leaves the project or names no file. */
export function normalizeTaskFile(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const slashed = value.trim().replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '');
  if (!slashed || slashed.startsWith('/') || /^[A-Za-z]:/u.test(slashed)) return null;
  const segments = slashed.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  if (/[\x00-\x1f]/u.test(slashed)) return null;
  return slashed;
}

function parseTask(raw: unknown, index: number, taken: Set<string>): ParsedScheduledTask {
  const record = isRecord(raw) ? raw : {};
  const name = typeof record.name === 'string' ? record.name.trim().slice(0, SCHEDULED_TASK_LIMITS.name) : '';
  const explicitId = typeof record.id === 'string' ? record.id.trim() : '';
  const validId = explicitId && scheduledTaskIdSchema.safeParse(explicitId).success ? explicitId : '';
  const duplicate = validId !== '' && taken.has(validId);
  const id = validId && !duplicate ? validId : taskIdFromName(name || `task ${index + 1}`, taken);
  taken.add(id);

  const time = normalizeTaskTime(record.time);
  const agentValue = record.agent;
  const agent = typeof agentValue === 'string' ? FILE_AGENTS[agentValue.trim().toLowerCase()] ?? undefined : undefined;
  const agentProblem = agentValue !== undefined && agentValue !== null && agent === undefined;
  const rawFiles = record.files === undefined ? [] : record.files;
  const files = Array.isArray(rawFiles) ? rawFiles.map(normalizeTaskFile) : null;
  const prompt = typeof record.prompt === 'string' ? record.prompt : '';

  const problem = !isRecord(raw)
    ? 'This entry is not a task.'
    : !name
      ? 'Give this task a name.'
      : explicitId && !validId
        ? 'A task id can use only letters, numbers, hyphens and underscores.'
        : duplicate
          ? 'Another task in this project uses the same id.'
          : !time
            ? 'Set a time like 08:00.'
            : agentProblem
              ? 'Choose Default, Claude or Codex to run this task.'
              : !files || files.some((file) => file === null) || files.length > SCHEDULED_TASK_LIMITS.files
                ? 'List each file by its path inside this project.'
                : record.prompt !== undefined && typeof record.prompt !== 'string'
                  ? 'Write what to do as text.'
                  : prompt.length > SCHEDULED_TASK_LIMITS.prompt
                    ? 'This request is too long.'
                    : !prompt.trim() && files.length === 0
                      ? 'Say what to do, or add a file to follow.'
                      : null;
  return {
    agent: agent ?? null,
    files: (files ?? []).filter((file): file is string => file !== null),
    id,
    name,
    problem,
    prompt,
    time: time ?? (typeof record.time === 'string' ? record.time : ''),
  };
}

/** The file read as tasks. An absent or empty file holds none. */
export function parseScheduleFile(content: string | null): ParsedSchedule {
  const empty = { entries: [], problem: null, root: null, tasks: [] };
  if (content === null || !content.trim()) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ...empty, problem: 'The task file is not valid JSON, so none of its tasks can run.' };
  }
  const root = isRecord(parsed) ? parsed : null;
  const list = Array.isArray(parsed) ? parsed : root ? (root.tasks ?? []) : undefined;
  if (!Array.isArray(list)) {
    return { ...empty, problem: 'The task file must list its tasks under "tasks".', root };
  }
  if (list.length > SCHEDULED_TASK_LIMITS.tasks) {
    return { ...empty, problem: `The task file lists more than ${SCHEDULED_TASK_LIMITS.tasks} tasks.`, root };
  }
  const taken = new Set<string>();
  const tasks = list.map((entry, index) => parseTask(entry, index, taken));
  return { entries: [...list], problem: null, root, tasks };
}

function serialize(parsed: ParsedSchedule, entries: unknown[]): string {
  return `${JSON.stringify({ ...parsed.root, tasks: entries }, null, 2)}\n`;
}

/** The file with one task written from the form: in its place when the file
 *  has it, otherwise last, under an id from its name. Known fields lead the
 *  task in a fixed order and every other field it held is kept; every other
 *  entry, and the file's own top-level fields, stay exactly as they were. */
export function withTask(
  parsed: ParsedSchedule,
  draft: ScheduledTaskDraftWire,
): { content: string; task: ScheduledTaskDefinitionWire } {
  const index = draft.id === undefined ? -1 : parsed.tasks.findIndex((task) => task.id === draft.id);
  if (draft.id !== undefined && index < 0) {
    throw scheduleError('This task is no longer in the task file.', 409, 'TASK_NOT_FOUND');
  }
  const id = draft.id ?? taskIdFromName(draft.name, new Set(parsed.tasks.map((task) => task.id)));
  const base = index < 0 ? undefined : parsed.entries[index];
  const kept = isRecord(base) ? { ...base } : {};
  for (const key of ['id', 'name', 'time', 'prompt', 'files', 'agent']) delete kept[key];
  const task: ScheduledTaskDefinitionWire = { ...draft, id, name: draft.name.trim() };
  const entry = {
    id,
    name: task.name,
    time: task.time,
    prompt: task.prompt,
    ...(task.files.length > 0 ? { files: task.files } : {}),
    ...(task.agent ? { agent: FILE_AGENT_NAMES[task.agent] } : {}),
    ...kept,
  };
  const entries = [...parsed.entries];
  if (index < 0) entries.push(entry);
  else entries[index] = entry;
  return { content: serialize(parsed, entries), task };
}

/** The file without one task; every other entry stays exactly as it was. */
export function withoutTask(parsed: ParsedSchedule, taskId: string): string {
  const index = parsed.tasks.findIndex((task) => task.id === taskId);
  if (index < 0) throw scheduleError('This task is no longer in the task file.', 409, 'TASK_NOT_FOUND');
  return serialize(parsed, parsed.entries.filter((_, position) => position !== index));
}

// What this app remembers about each task.

interface StoredRun {
  agent: AgentId | null;
  finishedAt: string | null;
  /** For a missed entry, how many daily runs it covers. */
  missedCount: number | null;
  /** The scheduled time a scheduled run was for; null for Run now. */
  occurrence: string | null;
  reason: string | null;
  runId: string;
  sessionId: string | null;
  startedAt: string;
  status: RunStatus;
  /** The start of the Agent’s last reply once the first turn ended. */
  summary: string | null;
  title: string | null;
  trigger: 'schedule' | 'manual';
}

type RunStatus = ScheduledTaskRunWire['status'];

interface StoredTaskState {
  enabled?: boolean;
  enabledAt?: string;
  lastDispatchedAt?: string;
  lastOccurrence?: string;
  /** Newest first, bounded. */
  runs?: StoredRun[];
}

export interface StoredProjectSchedule {
  scope: string;
  tasks?: Record<string, StoredTaskState>;
}

export type TaskState = Pick<
  ScheduledTaskWire,
  'enabled' | 'enabledAt' | 'lastDispatchedAt' | 'lastOccurrence' | 'runs'
>;

const NO_STATE: TaskState = {
  enabled: false,
  enabledAt: null,
  lastDispatchedAt: null,
  lastOccurrence: null,
  runs: [],
};

/** How many runs each task keeps, newest first: enough to see whether a
 *  daily task ran each day of the last few weeks. */
export const RUN_HISTORY_LIMIT = 30;

/** A run still marked running after this long never reported back. Main's
 *  own dispatch deadline is well inside it. */
const RUN_REPORT_DEADLINE_MS = 10 * 60_000;

const RUN_STATUSES: ReadonlySet<unknown> = new Set(['running', 'sent', 'completed', 'failed', 'missed']);

function instant(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value ? value.slice(0, max) : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function storedAgent(value: unknown): AgentId | null {
  return value === 'stashbase' || value === 'claude' || value === 'codex' ? value : null;
}

function samePath(stored: unknown, root: string): boolean {
  if (typeof stored !== 'string' || !stored.trim()) return false;
  try { return filesystemPath.equal(stored, root); } catch { return false; }
}

function storedRuns(state: StoredTaskState): StoredRun[] {
  return Array.isArray(state.runs) ? state.runs.filter(isRecord) as StoredRun[] : [];
}

export interface ScheduledTaskStoreIo {
  read(): AppConfigFile;
  /** A read that never throws, for views that must not fail on a bad config. */
  readFallback(): AppConfigFile;
  write(config: AppConfigFile): void;
  now(): Date;
  createId(): string;
}

export type ClaimRefusal = 'disabled' | 'already-claimed' | 'not-due' | 'running';

export function createScheduledTaskStore(io: ScheduledTaskStoreIo) {
  /** Runs this process handed out and has not heard back about. A run left
   *  running by an earlier process can never report, so it reads as failed. */
  const live = new Set<string>();

  const runView = (run: unknown): ScheduledTaskRunWire | null => {
    if (!isRecord(run)) return null;
    const runId = text(run.runId, 64);
    const startedAt = instant(run.startedAt);
    const status = RUN_STATUSES.has(run.status) ? run.status as RunStatus : null;
    if (!runId || !startedAt || !status) return null;
    const view: ScheduledTaskRunWire = {
      agent: storedAgent(run.agent),
      finishedAt: instant(run.finishedAt),
      missedCount: status === 'missed' ? positiveInteger(run.missedCount) ?? 1 : null,
      occurrence: instant(run.occurrence),
      reason: text(run.reason, 500),
      runId,
      sessionId: text(run.sessionId, 256),
      startedAt,
      status,
      summary: text(run.summary, SCHEDULED_TASK_LIMITS.summary),
      title: text(run.title, 200),
      trigger: run.trigger === 'manual' ? 'manual' : 'schedule',
    };
    if (status !== 'running') return view;
    const overdue = io.now().getTime() - Date.parse(startedAt) > RUN_REPORT_DEADLINE_MS;
    if (live.has(runId) && !overdue) return view;
    return {
      ...view,
      reason: live.has(runId)
        ? 'This run did not report whether its chat started.'
        : 'StashBase closed before this run could start its chat.',
      status: 'failed',
    };
  };

  const stateView = (stored: unknown): TaskState => {
    if (!isRecord(stored)) return NO_STATE;
    const runs = Array.isArray(stored.runs) ? stored.runs : [];
    return {
      enabled: stored.enabled === true,
      enabledAt: instant(stored.enabledAt),
      lastDispatchedAt: instant(stored.lastDispatchedAt),
      lastOccurrence: instant(stored.lastOccurrence),
      runs: runs.slice(0, RUN_HISTORY_LIMIT).flatMap((run) => runView(run) ?? []),
    };
  };

  const projectEntry = (config: AppConfigFile, root: string) =>
    (config.scheduledTasks ?? []).find((entry) => isRecord(entry) && samePath(entry.scope, root));

  /** Read-modify-write of one task's record. The whole step is synchronous,
   *  so no other request in this process interleaves with it. */
  const mutate = <T>(root: string, taskId: string, change: (state: StoredTaskState) => T): T => {
    const config = io.read();
    const projects = (config.scheduledTasks ?? []).filter(isRecord) as StoredProjectSchedule[];
    let project = projects.find((entry) => samePath(entry.scope, root));
    if (!project) {
      project = { scope: root, tasks: {} };
      projects.push(project);
    }
    const tasks = isRecord(project.tasks) ? project.tasks : {};
    const state = isRecord(tasks[taskId]) ? { ...tasks[taskId] } : {};
    const result = change(state);
    project.tasks = { ...tasks, [taskId]: state };
    config.scheduledTasks = projects;
    io.write(config);
    return result;
  };

  /** Rewrites one run in place, when the task still keeps it. */
  const updateRun = (
    root: string,
    taskId: string,
    runId: string,
    change: (run: StoredRun) => StoredRun | null,
  ): boolean => {
    const stored = projectEntry(io.read(), root)?.tasks;
    const task = isRecord(stored) && isRecord(stored[taskId]) ? stored[taskId] as StoredTaskState : null;
    if (!task || !storedRuns(task).some((run) => run.runId === runId)) return false;
    return mutate(root, taskId, (state) => {
      let changed = false;
      state.runs = storedRuns(state).map((run) => {
        if (run.runId !== runId) return run;
        const next = change(run);
        if (!next) return run;
        changed = true;
        return next;
      });
      return changed;
    });
  };

  return {
    /** Every task's remembered state in one project, by task id. */
    states(root: string): (taskId: string) => TaskState {
      const tasks = projectEntry(io.readFallback(), root)?.tasks;
      return (taskId) => stateView(isRecord(tasks) ? tasks[taskId] : undefined);
    },

    /** Drops what this app kept about a task, so a new task that later takes
     *  the same id starts switched off with no history. */
    forget(root: string, taskId: string): void {
      const config = io.read();
      const project = (config.scheduledTasks ?? []).find((entry) => isRecord(entry) && samePath(entry.scope, root));
      if (!project || !isRecord(project.tasks) || !(taskId in project.tasks)) return;
      const { [taskId]: _forgotten, ...rest } = project.tasks;
      project.tasks = rest;
      io.write(config);
    },

    setEnabled(root: string, taskId: string, enabled: boolean): TaskState {
      return mutate(root, taskId, (state) => {
        // Turning a task on starts its schedule from now: an earlier time
        // today is not a missed run to catch up on.
        if (enabled && state.enabled !== true) state.enabledAt = io.now().toISOString();
        state.enabled = enabled;
        return stateView(state);
      });
    },

    /** A scheduled claim names its occurrence and the task's time as the file
     *  states it: an occurrence a clock change moved (02:30 that became
     *  03:30) does not say what time the task runs on other days. */
    claim(
      root: string,
      taskId: string,
      request:
        | { trigger: 'manual' }
        | { trigger: 'schedule'; occurrence?: string | undefined; time: string },
    ): { ok: true; runId: string } | { ok: false; refusal: ClaimRefusal } {
      return mutate(root, taskId, (state) => {
        const current = stateView(state);
        if (current.runs[0]?.status === 'running') return { ok: false, refusal: 'running' } as const;
        let occurrence: string | null = null;
        let missed: StoredRun | null = null;
        if (request.trigger === 'schedule') {
          const at = request.occurrence ? Date.parse(request.occurrence) : Number.NaN;
          if (!current.enabled) return { ok: false, refusal: 'disabled' } as const;
          if (!Number.isFinite(at)) return { ok: false, refusal: 'not-due' } as const;
          if (current.enabledAt && at < Date.parse(current.enabledAt)) {
            return { ok: false, refusal: 'not-due' } as const;
          }
          if (current.lastOccurrence && at <= Date.parse(current.lastOccurrence)) {
            return { ok: false, refusal: 'already-claimed' } as const;
          }
          // Days skipped since the last run are kept in history as one entry
          // before this run moves the last occurrence past them.
          const claimed = new Date(at);
          const skipped = missedRuns({ ...current, problem: null, time: request.time }, claimed);
          if (skipped) {
            missed = {
              agent: null,
              finishedAt: null,
              missedCount: skipped.count,
              occurrence: skipped.last.toISOString(),
              reason: null,
              runId: io.createId(),
              sessionId: null,
              startedAt: skipped.first.toISOString(),
              status: 'missed',
              summary: null,
              title: null,
              trigger: 'schedule',
            };
          }
          occurrence = claimed.toISOString();
          state.lastOccurrence = occurrence;
          state.lastDispatchedAt = io.now().toISOString();
        }
        const runId = io.createId();
        live.add(runId);
        const run: StoredRun = {
          agent: null,
          finishedAt: null,
          missedCount: null,
          occurrence,
          reason: null,
          runId,
          sessionId: null,
          startedAt: io.now().toISOString(),
          status: 'running',
          summary: null,
          title: null,
          trigger: request.trigger,
        };
        state.runs = [run, ...(missed ? [missed] : []), ...storedRuns(state)].slice(0, RUN_HISTORY_LIMIT);
        return { ok: true, runId } as const;
      });
    },

    /** Records whether a claimed run started its chat. Only a run still
     *  starting takes it, so a repeated or late report changes nothing. */
    finish(
      root: string,
      taskId: string,
      runId: string,
      result: {
        status: 'sent' | 'failed';
        reason: string | null;
        sessionId: string | null;
        agent: AgentId | null;
        title: string | null;
      },
    ): boolean {
      live.delete(runId);
      return updateRun(root, taskId, runId, (run) => run.status !== 'running' ? null : {
        ...run,
        agent: result.agent,
        finishedAt: io.now().toISOString(),
        reason: result.status === 'failed' ? (result.reason ?? 'The run did not start its chat.') : null,
        sessionId: result.sessionId,
        status: result.status,
        title: result.title,
      });
    },

    /** Records how a sent run's first turn ended, as its window saw it. Only
     *  a sent run takes it, so a late report never rewrites another outcome. */
    settle(
      root: string,
      taskId: string,
      runId: string,
      result: { status: 'completed' | 'failed'; reason: string | null; summary: string | null },
    ): boolean {
      return updateRun(root, taskId, runId, (run) => run.status !== 'sent' ? null : {
        ...run,
        finishedAt: io.now().toISOString(),
        reason: result.status === 'failed' ? (result.reason ?? 'The Agent did not finish.') : null,
        status: result.status,
        summary: result.summary?.slice(0, SCHEDULED_TASK_LIMITS.summary) || null,
      });
    },
  };
}

export type ScheduledTaskStore = ReturnType<typeof createScheduledTaskStore>;

export const scheduledTaskStore = createScheduledTaskStore({
  createId: () => crypto.randomUUID(),
  now: () => new Date(),
  // Writes and their read-modify-write precondition fail closed on a
  // malformed config instead of replacing it with defaults.
  read: readAppConfigStrict,
  readFallback: readAppConfig,
  write: writeAppConfigStrict,
});

// The project file.

async function readScheduleSnapshot(root: string): Promise<{ snapshot: TextSnapshot | null; problem: string | null }> {
  try {
    return { problem: null, snapshot: await runWithFolderRoot(root, () => readTextSnapshotAsync(SCHEDULE_FILE_NAME)) };
  } catch (error) {
    log.warn(`could not read ${SCHEDULE_FILE_NAME} in ${root}:`, error);
    return { problem: `The task file could not be read: ${errorMessage(error)}`, snapshot: null };
  }
}

/** One project's tasks as the file states them, with what this app keeps. */
export async function readProjectSchedule(
  root: string,
  store: ScheduledTaskStore = scheduledTaskStore,
): Promise<ProjectScheduleWire> {
  const { problem: readProblem, snapshot } = await readScheduleSnapshot(root);
  const parsed = parseScheduleFile(snapshot?.content ?? null);
  const state = store.states(root);
  return {
    folderPath: root,
    problem: readProblem ?? parsed.problem,
    tasks: parsed.tasks.map((task) => ({ ...task, ...state(task.id) })),
    version: snapshot?.version ?? null,
  };
}

/** Every registered project that states at least one task, for main. */
export async function listScheduledProjects(
  store: ScheduledTaskStore = scheduledTaskStore,
): Promise<ProjectScheduleWire[]> {
  const projects: ProjectScheduleWire[] = [];
  for (const root of await registeredFolderRootsAsync()) {
    const schedule = await readProjectSchedule(root, store);
    if (schedule.tasks.length > 0) projects.push(schedule);
  }
  return projects;
}

function validateDraft(draft: ScheduledTaskDraftWire): void {
  if (!normalizeTaskTime(draft.time)) throw scheduleError('Set a time like 08:00.', 400, 'INVALID_SCHEDULE');
  if (!draft.prompt.trim() && draft.files.length === 0) {
    throw scheduleError('Say what to do, or add a file to follow.', 400, 'INVALID_SCHEDULE');
  }
  if (draft.files.some((file) => normalizeTaskFile(file) !== file)) {
    throw scheduleError('List each file by its path inside this project.', 400, 'INVALID_SCHEDULE');
  }
}

/** Rewrites the task file from one form edit. The file must still be the one
 *  the form read, and must be readable as tasks: a file the form could not
 *  show is never overwritten from it. */
async function rewriteSchedule(
  root: string,
  baseVersion: string | null,
  change: (parsed: ParsedSchedule) => string,
): Promise<void> {
  await runWithFolderRoot(root, async () => {
    const current = await readTextSnapshotAsync(SCHEDULE_FILE_NAME);
    if ((current?.version ?? null) !== baseVersion) throw fileChanged(current?.version ?? null);
    const parsed = parseScheduleFile(current?.content ?? null);
    if (parsed.problem) throw scheduleError(parsed.problem, 409, 'SCHEDULE_FILE_INVALID');
    await saveFileContent(SCHEDULE_FILE_NAME, change(parsed), current ? { baseVersion: current.version } : {});
  });
}

/** Adds a task, or edits the one with the draft's id. Answers its id. */
export async function saveScheduledTask(
  root: string,
  baseVersion: string | null,
  draft: ScheduledTaskDraftWire,
  store: ScheduledTaskStore = scheduledTaskStore,
): Promise<string> {
  validateDraft(draft);
  let id = '';
  await rewriteSchedule(root, baseVersion, (parsed) => {
    const next = withTask(parsed, draft);
    id = next.task.id;
    return next.content;
  });
  // A task the form creates starts switched off, whatever an earlier task
  // with this id was.
  if (draft.id === undefined) store.forget(root, id);
  return id;
}

export async function deleteScheduledTask(
  root: string,
  baseVersion: string | null,
  taskId: string,
  store: ScheduledTaskStore = scheduledTaskStore,
): Promise<void> {
  await rewriteSchedule(root, baseVersion, (parsed) => withoutTask(parsed, taskId));
  store.forget(root, taskId);
}

/** The task as the file states it now, when it can run. A claim reads the
 *  file again so a run always uses the latest request. */
export async function runnableTask(root: string, taskId: string): Promise<ScheduledTaskDefinitionWire | null> {
  const { snapshot } = await readScheduleSnapshot(root);
  const parsed = parseScheduleFile(snapshot?.content ?? null);
  const task = parsed.problem ? undefined : parsed.tasks.find((entry) => entry.id === taskId);
  if (!task || task.problem) return null;
  const { problem: _problem, ...definition } = task;
  return definition;
}
