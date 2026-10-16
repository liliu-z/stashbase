import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo } from 'react';
import { expect, screen, userEvent } from 'storybook/test';

import type { AgentCatalogPort, ScheduledTasksPort } from '@/features/agent/application/ports';
import { createAgentWorkspaceRuntime } from '@/features/agent/application/workspace-runtime';
import type { ProjectSchedule } from '@/features/agent/domain/scheduled-tasks';

import { ScheduledTasksView } from './scheduled-tasks-view';

const FOLDER = '/Library/Brief';
const SCOPE = { kind: 'folder', path: FOLDER } as const;
const at = (daysAgo: number, hours: number, minutes = 0) => {
  const day = new Date();
  day.setDate(day.getDate() - daysAgo);
  day.setHours(hours, minutes, 0, 0);
  return day.getTime();
};
const tomorrowAtEight = at(-1, 8);

const BUSY: ProjectSchedule = {
  folderPath: FOLDER,
  problem: null,
  tasks: [
    {
      agent: 'claude',
      enabled: true,
      files: ['workflows/daily-brief.md'],
      id: 'daily-brief',
      name: 'Daily brief',
      nextRunAt: tomorrowAtEight,
      problem: null,
      prompt: '',
      runs: [
        {
          agent: 'claude',
          missedCount: null,
          occurrence: at(0, 8),
          reason: null,
          runId: 'run-3',
          sessionId: 'native-3',
          startedAt: at(0, 8, 1),
          status: 'completed',
          summary: 'Saved briefs/today.md. Three drafts still need a closing paragraph.',
          title: 'Daily brief',
          trigger: 'schedule',
        },
        {
          agent: null,
          missedCount: 3,
          occurrence: at(1, 8),
          reason: null,
          runId: 'missed-1',
          sessionId: null,
          startedAt: at(3, 8),
          status: 'missed',
          summary: null,
          title: null,
          trigger: 'schedule',
        },
        {
          agent: 'claude',
          missedCount: null,
          occurrence: at(4, 8),
          reason: null,
          runId: 'run-2',
          sessionId: 'native-2',
          startedAt: at(4, 10, 12),
          status: 'completed',
          summary: null,
          title: 'Daily brief',
          trigger: 'schedule',
        },
      ],
      time: '08:00',
    },
    {
      agent: null,
      enabled: false,
      files: [],
      id: 'weekly-review',
      name: 'Weekly review',
      nextRunAt: null,
      problem: null,
      prompt: 'Read this week’s drafts and list what is still open.',
      runs: [
        {
          agent: null,
          missedCount: null,
          occurrence: null,
          reason: 'Sign in to use Default, then run this task again.',
          runId: 'run-1',
          sessionId: null,
          startedAt: at(2, 17, 30),
          status: 'failed',
          summary: null,
          title: 'Weekly review',
          trigger: 'manual',
        },
      ],
      time: '17:30',
    },
  ],
  version: 'sha256:story',
};

const EMPTY: ProjectSchedule = { folderPath: FOLDER, problem: null, tasks: [], version: null };

function port(schedule: ProjectSchedule): ScheduledTasksPort {
  return {
    read: async () => schedule,
    remove: async () => schedule,
    runNow: async () => ({
      message: 'Scheduled tasks run in the StashBase desktop app.',
      ok: false,
    }),
    save: async () => ({ schedule, taskId: 'daily-brief' }),
    setEnabled: async () => schedule,
    settle: async () => undefined,
  };
}

const catalog: AgentCatalogPort = {
  listAgents: async () => ({ agents: [] }),
  prepareAgent: async () => ({ agents: [] }),
};

function Preview({ schedule }: { schedule: ProjectSchedule }) {
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    [],
  );
  const runtime = useMemo(() => {
    const next = createAgentWorkspaceRuntime({
      autostart: false,
      createId: () => 'preview-chat',
      folderPath: FOLDER,
      port: {
        connect: () => ({ close: () => undefined, send: () => true }),
        list: async () => [],
        remove: async () => undefined,
        rename: async (entry) => entry,
        replay: async () => ({ effort: null, transcript: [] }),
      },
    });
    next.setScopeEnvironment({
      activeSource: null,
      folderPath: FOLDER,
      listing: {
        files: [
          { format: 'md', path: 'workflows/daily-brief.md' },
          { format: 'md', path: 'topics.md' },
        ],
        folders: ['workflows'],
      },
      openPaths: [],
      readiness: {},
      versions: {},
    });
    return next;
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <div className="h-[46rem]">
        <ScheduledTasksView
          catalog={catalog}
          header
          port={port(schedule)}
          runtime={runtime}
          scope={SCOPE}
        />
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Agent/ScheduledTasks',
  component: Preview,
  args: { schedule: BUSY },
  parameters: { fluidCanvas: { width: '48rem' } },
} satisfies Meta<typeof Preview>;

export default meta;
type Story = StoryObj<typeof Preview>;

export const TasksAndHistory: Story = {
  play: async () => {
    await expect(await screen.findByRole('button', { name: 'Daily brief' })).toBeVisible();
  },
};

export const NoTasks: Story = {
  args: { schedule: EMPTY },
  play: async () => {
    await expect(await screen.findByText(/^No tasks yet\./u)).toBeVisible();
  },
};

export const EditTask: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Daily brief' }));
    await expect(await screen.findByRole('textbox', { name: 'What to do' })).toBeVisible();
  },
};
