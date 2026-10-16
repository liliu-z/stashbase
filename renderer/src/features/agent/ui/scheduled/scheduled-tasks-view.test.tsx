/** The page a reader manages scheduled tasks on: always a list, each task
 *  saying when it runs next and what became of its latest run, every run in
 *  the history, and the form that writes a task in the same page. */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { ScheduledTasksError, type ScheduledTasksPort } from '@/features/agent/application/ports';
import { createAgentWorkspaceRuntime } from '@/features/agent/application/workspace-runtime';
import type {
  ProjectSchedule,
  ScheduledTask,
  ScheduledTaskRun,
} from '@/features/agent/domain/scheduled-tasks';
import { pressKey, typeInto } from '@/test/dom';
import { agentCatalogPort, idleAgentSessionPort } from '@/test/fakes/agent';
import { withQueryClient } from '@/test/query';

import { ScheduledTasksView } from './scheduled-tasks-view';

afterEach(cleanup);

const FOLDER = '/project/Brief';
const SCOPE = { kind: 'folder', path: FOLDER } as const;
const HOUR = 3_600_000;

/** 08:00 local, `daysAgo` days before today. */
function day(daysAgo: number): number {
  const at = new Date();
  at.setDate(at.getDate() - daysAgo);
  at.setHours(8, 0, 0, 0);
  return at.getTime();
}

function run(overrides: Partial<ScheduledTaskRun>): ScheduledTaskRun {
  return {
    agent: 'claude',
    missedCount: null,
    occurrence: null,
    reason: null,
    runId: 'run-1',
    sessionId: null,
    startedAt: Date.now() - HOUR,
    status: 'completed',
    summary: null,
    title: null,
    trigger: 'schedule',
    ...overrides,
  };
}

function task(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    agent: 'claude',
    enabled: false,
    files: ['workflows/brief.md'],
    id: 'daily-brief',
    name: 'Daily brief',
    nextRunAt: null,
    problem: null,
    prompt: '',
    runs: [],
    time: '08:00',
    ...overrides,
  };
}

const busy: ProjectSchedule = {
  folderPath: FOLDER,
  problem: null,
  tasks: [
    task({
      enabled: true,
      nextRunAt: Date.now() + 2 * HOUR,
      runs: [
        run({
          runId: 'run-2',
          sessionId: 'native-7',
          status: 'sent',
          title: 'Daily brief · Oct 16',
        }),
        run({
          occurrence: Date.now() - 30 * HOUR,
          runId: 'run-1',
          sessionId: 'native-6',
          startedAt: Date.now() - 26 * HOUR,
          summary: 'Saved briefs/oct-15.md with three open threads.',
          title: 'Daily brief · Oct 15',
        }),
      ],
    }),
    task({
      id: 'weekly',
      name: 'Weekly',
      runs: [
        run({
          agent: null,
          reason: 'Sign in to use Default, then run this task again.',
          runId: 'run-3',
          startedAt: Date.now() - 2 * HOUR,
          status: 'failed',
          trigger: 'manual',
        }),
      ],
    }),
    task({ id: 'broken', name: 'Broken', problem: 'Set a time like 08:00.', time: 'soon' }),
  ],
  version: 'sha256:1',
};

function setup(initial: ProjectSchedule = busy, overrides: Partial<ScheduledTasksPort> = {}) {
  let schedule = initial;
  const port: ScheduledTasksPort = {
    read: vi.fn(async () => schedule),
    remove: vi.fn(async () => schedule),
    runNow: vi.fn(async () => ({
      ok: true as const,
      outcome: { agent: 'claude' as const, sessionId: 'native-8', status: 'sent' as const },
    })),
    save: vi.fn(async (_folder, _base, draft) => {
      schedule = {
        ...schedule,
        tasks: [...schedule.tasks, task({ ...draft, id: 'weekly-review' })],
        version: 'sha256:2',
      };
      return { schedule, taskId: 'weekly-review' };
    }),
    setEnabled: vi.fn(async (_folder, taskId, enabled) => {
      schedule = {
        ...schedule,
        tasks: schedule.tasks.map((entry) => (entry.id === taskId ? { ...entry, enabled } : entry)),
      };
      return schedule;
    }),
    settle: vi.fn(async () => undefined),
    ...overrides,
  };
  let id = 0;
  const runtime = createAgentWorkspaceRuntime({
    createId: () => `chat-${++id}`,
    folderPath: FOLDER,
    port: idleAgentSessionPort(),
  });
  runtime.setScopeEnvironment({
    activeSource: null,
    folderPath: FOLDER,
    listing: { files: [{ format: 'md', path: 'workflows/brief.md' }], folders: [] },
    openPaths: [],
    readiness: {},
    versions: {},
  });
  const restore = vi.spyOn(runtime, 'restore').mockResolvedValue(true);
  withQueryClient(
    <ScheduledTasksView
      catalog={agentCatalogPort()}
      header
      port={port}
      runtime={runtime}
      scope={SCOPE}
    />,
  );
  return { port, restore, runtime };
}

async function row(name: string) {
  const list = await screen.findByRole('list', { name: 'Scheduled tasks' });
  const button = await within(list).findByRole('button', { name });
  const item = button.closest('li');
  if (!item) throw new Error(`No row for ${name}`);
  return item;
}

describe('ScheduledTasksView', () => {
  it('says when each task runs next and what became of its latest run', async () => {
    const { port, restore } = setup();
    const brief = await row('Daily brief');
    const weekly = await row('Weekly');
    const broken = await row('Broken');

    expect(within(brief).getByText(/^Every day at 8:00\sAM · Claude$/u)).not.toBeNull();
    expect(within(brief).getByText(/^Next run (today|tomorrow) at /u)).not.toBeNull();
    expect(within(brief).getByText('Started')).not.toBeNull();
    expect(within(brief).getByText('Open its chat to see how it ended.')).not.toBeNull();
    expect(within(weekly).getByText('Off. Switch it on to run every day.')).not.toBeNull();
    expect(within(weekly).getByText('Did not run')).not.toBeNull();
    expect(
      within(weekly).getByText('Sign in to use Default, then run this task again.'),
    ).not.toBeNull();
    expect(within(broken).getByText('Set a time like 08:00.')).not.toBeNull();
    expect(within(broken).getByRole('button', { name: 'Run now' })).toHaveProperty(
      'disabled',
      true,
    );

    await userEvent.click(within(weekly).getByRole('switch', { name: 'Run Weekly every day' }));
    expect(port.setEnabled).toHaveBeenCalledWith(FOLDER, 'weekly', true, expect.any(AbortSignal));
    await userEvent.click(within(weekly).getByRole('button', { name: 'Run now' }));
    expect(port.runNow).toHaveBeenCalledWith(FOLDER, 'weekly');

    await userEvent.click(within(brief).getByRole('button', { name: 'Open chat' }));
    expect(restore).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        id: 'native-7',
        scope: SCOPE,
        title: 'Daily brief · Oct 16',
      }),
    );
  });

  it('lists every run, says why a late one was late, and reads a held chat live', async () => {
    const { runtime } = setup();
    const history = await screen.findByRole('list', { name: 'Run history' });
    await within(history).findByText(/StashBase was closed or asleep then\./u);
    const lines = within(history).getAllByRole('listitem');
    expect(lines.map((line) => line.textContent)).toEqual([
      expect.stringContaining('Daily brief'),
      expect.stringContaining('Did not run'),
      expect.stringContaining('Finished'),
    ]);
    expect(
      within(history).getByText('Saved briefs/oct-15.md with three open threads.').tagName,
    ).toBe('BLOCKQUOTE');
    expect(within(history).getByText(/StashBase was closed or asleep then\./u)).not.toBeNull();

    // The window holds the sent run's chat, which is waiting for approval.
    runtime.store.setState((state) => {
      const [first] = state.tabs;
      if (!first) throw new Error('No chat tab');
      const held = {
        ...first,
        id: 'chat-9',
        nativeSessionId: 'native-7',
        status: 'Waiting for approval',
      };
      return { ...state, tabs: [...state.tabs, held] };
    });
    expect(
      await within(await row('Daily brief')).findByText('Waiting for your approval'),
    ).not.toBeNull();
  });

  it('is a list even with no tasks, and writes a new task in the same page', async () => {
    const { port } = setup({ folderPath: FOLDER, problem: null, tasks: [], version: null });
    const list = await screen.findByRole('list', { name: 'Scheduled tasks' });
    expect(await within(list).findByText(/^No tasks yet\./u)).not.toBeNull();
    expect(screen.getByText(/^No runs yet\./u)).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'New task' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Weekly review');
    fireEvent.change(screen.getByLabelText('Every day at'), { target: { value: '09:30' } });
    const field = screen.getByRole('textbox', { name: 'What to do' });
    typeInto(field, '@brief');
    await screen.findByRole('option', { name: /brief\.md/u });
    pressKey(field, 'Enter');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(port.save).toHaveBeenCalledWith(
        FOLDER,
        null,
        expect.objectContaining({
          agent: null,
          files: ['workflows/brief.md'],
          name: 'Weekly review',
          prompt: expect.stringContaining('@workflows/brief.md'),
          time: '09:30',
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(await row('Weekly review')).not.toBeNull();
  });

  it('says which days a task missed, with no chat to open and Run now still there', async () => {
    setup({
      ...busy,
      tasks: [
        task({
          enabled: true,
          runs: [
            run({
              agent: null,
              missedCount: 3,
              occurrence: day(1),
              runId: 'missed-1',
              startedAt: day(3),
              status: 'missed',
            }),
          ],
        }),
      ],
    });
    const brief = await row('Daily brief');

    expect(within(brief).getByText('Missed 3 runs')).not.toBeNull();
    expect(within(brief).getByText('StashBase was closed or asleep then.')).not.toBeNull();
    expect(within(brief).getByText(/^\w+ \d+ – \w+ \d+, 8:00/u)).not.toBeNull();
    expect(within(brief).queryByRole('button', { name: 'Open chat' })).toBeNull();
    expect(within(brief).getByRole('button', { name: 'Run now' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('names following the project apart from always using one Agent', async () => {
    setup({ folderPath: FOLDER, problem: null, tasks: [], version: null });
    await userEvent.click(await screen.findByRole('button', { name: 'New task' }));
    const agent = screen.getByRole('combobox', { name: 'Agent' });
    expect(agent.textContent).toBe('Follow this project (now Default)');
    await userEvent.click(agent);
    const options = (await screen.findAllByRole('option')).map((option) => option.textContent);

    expect(options).toEqual([
      'Follow this project (now Default)',
      'Always Codex',
      'Always Claude',
      'Always Default',
    ]);
  });

  it('shows a task pinned to the project’s Agent as pinned, not as following', async () => {
    setup({
      folderPath: FOLDER,
      problem: null,
      tasks: [task({ agent: 'stashbase', id: 'pinned', name: 'Pinned' })],
      version: 'sha256:1',
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Pinned' }));
    expect(screen.getByRole('combobox', { name: 'Agent' }).textContent).toBe('Always Default');
  });

  it('keeps the edit when the task file changed underneath it', async () => {
    setup(busy, {
      save: vi.fn(async () => {
        throw new ScheduledTasksError('conflict', 'The task file refused the change.');
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Daily brief' }));
    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Morning brief');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/The task file changed while you were editing/u)).not.toBeNull();
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Morning brief');
  });
});
