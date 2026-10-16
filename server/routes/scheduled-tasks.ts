import type express from 'express';
import {
  projectScheduleSchema,
  scheduleClaimRequestSchema,
  scheduleClaimResponseSchema,
  scheduledProjectsSchema,
  scheduleEnabledRequestSchema,
  scheduleFinishRequestSchema,
  scheduleSettleRequestSchema,
  scheduleTaskDeleteRequestSchema,
  scheduleTaskSaveRequestSchema,
  scheduleTaskSaveResponseSchema,
} from '../../shared/protocols/http/scheduled-tasks.ts';
import { exactRegisteredFolderRootAsync } from '../folder.ts';
import { filesystemPath } from '../filesystem-path.ts';
import { sendError } from '../http.ts';
import {
  deleteScheduledTask,
  listScheduledProjects,
  readProjectSchedule,
  runnableTask,
  saveScheduledTask,
  scheduledTaskStore,
  type ScheduledTaskStore,
} from '../scheduled-tasks.ts';

const CLAIM_REFUSALS = {
  'already-claimed': 'This run already started.',
  disabled: 'This task is switched off.',
  'not-due': 'This task is not due.',
  running: 'This task is already running.',
} as const;

function refusal(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { code, status });
}

/** Every request names its project; only a registered one is accepted. */
async function projectRoot(raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || !raw.trim() || !filesystemPath.isAbsolute(raw)) {
    throw refusal('Project must be an absolute path.', 400, 'INVALID_PROJECT');
  }
  const root = await exactRegisteredFolderRootAsync(raw);
  if (!root) throw refusal('Project is no longer registered.', 404, 'PROJECT_NOT_REGISTERED');
  return root;
}

/** The task list the renderer shows and edits, and the run bookkeeping
 *  Electron main reads before every scheduled or manual run. */
export function mount(app: express.Express, store: ScheduledTaskStore = scheduledTaskStore): void {
  app.get('/api/scheduled-tasks', async (req, res) => {
    try {
      const root = await projectRoot(req.query.folder);
      res.json(projectScheduleSchema.parse(await readProjectSchedule(root, store)));
    } catch (error) { sendError(res, error); }
  });

  app.put('/api/scheduled-tasks/task', async (req, res) => {
    try {
      const parsed = scheduleTaskSaveRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid scheduled task.', code: 'INVALID_SCHEDULE' });
      const root = await projectRoot(parsed.data.folderPath);
      const taskId = await saveScheduledTask(root, parsed.data.baseVersion, parsed.data.task, store);
      res.json(scheduleTaskSaveResponseSchema.parse({ schedule: await readProjectSchedule(root, store), taskId }));
    } catch (error) { sendError(res, error); }
  });

  app.delete('/api/scheduled-tasks/task', async (req, res) => {
    try {
      const parsed = scheduleTaskDeleteRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid scheduled task.', code: 'INVALID_SCHEDULE' });
      const root = await projectRoot(parsed.data.folderPath);
      await deleteScheduledTask(root, parsed.data.baseVersion, parsed.data.taskId, store);
      res.json(projectScheduleSchema.parse(await readProjectSchedule(root, store)));
    } catch (error) { sendError(res, error); }
  });

  app.put('/api/scheduled-tasks/enabled', async (req, res) => {
    try {
      const parsed = scheduleEnabledRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid task switch.', code: 'INVALID_SCHEDULE' });
      const root = await projectRoot(parsed.data.folderPath);
      store.setEnabled(root, parsed.data.taskId, parsed.data.enabled);
      res.json(projectScheduleSchema.parse(await readProjectSchedule(root, store)));
    } catch (error) { sendError(res, error); }
  });

  app.get('/api/scheduled-tasks/projects', async (_req, res) => {
    try {
      res.json(scheduledProjectsSchema.parse({ projects: await listScheduledProjects(store) }));
    } catch (error) { sendError(res, error); }
  });

  app.post('/api/scheduled-tasks/runs', async (req, res) => {
    try {
      const parsed = scheduleClaimRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid run request.', code: 'INVALID_SCHEDULE' });
      const root = await projectRoot(parsed.data.folderPath);
      const task = await runnableTask(root, parsed.data.taskId);
      if (!task) throw refusal('This task can no longer run. Check it in the task list.', 409, 'TASK_UNAVAILABLE');
      const claimed = store.claim(
        root,
        task.id,
        parsed.data.trigger === 'schedule'
          ? { occurrence: parsed.data.occurrence, time: task.time, trigger: 'schedule' }
          : { trigger: 'manual' },
      );
      if (!claimed.ok) throw refusal(CLAIM_REFUSALS[claimed.refusal], 409, 'TASK_NOT_CLAIMED');
      res.json(scheduleClaimResponseSchema.parse({ runId: claimed.runId, task }));
    } catch (error) { sendError(res, error); }
  });

  app.put('/api/scheduled-tasks/runs', async (req, res) => {
    try {
      const parsed = scheduleFinishRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid run result.', code: 'INVALID_SCHEDULE' });
      const { folderPath, runId, taskId, ...result } = parsed.data;
      const root = await projectRoot(folderPath);
      res.json({ recorded: store.finish(root, taskId, runId, result) });
    } catch (error) { sendError(res, error); }
  });

  app.put('/api/scheduled-tasks/runs/settled', async (req, res) => {
    try {
      const parsed = scheduleSettleRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid run result.', code: 'INVALID_SCHEDULE' });
      const { folderPath, runId, taskId, ...result } = parsed.data;
      const root = await projectRoot(folderPath);
      res.json({ recorded: store.settle(root, taskId, runId, result) });
    } catch (error) { sendError(res, error); }
  });
}
