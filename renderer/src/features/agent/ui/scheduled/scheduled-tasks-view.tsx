/**
 * A project's scheduled tasks, shown in the chat's place: each task with its
 * switch, when it runs next, and what became of its latest run; below them,
 * every recent run in order. A reader should never have to wonder whether a
 * task ran or how it went. The list follows the task file while it is open,
 * so a task a template or the Agent wrote appears without reopening anything.
 * Writing or editing a task happens in the same page.
 */
import { CalendarClock, Play, Plus } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useStore } from 'zustand';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { AgentCatalogPort, ScheduledTasksPort } from '@/features/agent/application/ports';
import type { AgentWorkspaceRuntime } from '@/features/agent/application/workspace-runtime';
import { agentLabel } from '@/features/agent/domain/agent-catalog';
import { nextRunLabel, runHistory } from '@/features/agent/domain/scheduled-task-status';
import {
  scheduleLabel,
  type ScheduledTask,
  type ScheduledTaskRun,
} from '@/features/agent/domain/scheduled-tasks';
import type { AgentScope } from '@/features/agent/domain/session';
import { useScheduledTasks } from '@/features/agent/hooks/use-scheduled-tasks';
import { ChatHistoryPopover } from '@/features/agent/ui/chats/history-popover';
import { NewChatButton } from '@/features/agent/ui/new-chat-button';
import { focusRing } from '@/lib/focus-ring';
import { shapeTokens } from '@/lib/shape-context';
import { cn } from '@/lib/utils';
import { FailureLine, FailureNotice } from '@/shared/ui/failure-notice';

import { ScheduledRunStatus } from './scheduled-run-status';
import { ScheduledTaskForm } from './scheduled-task-form';
import { ScheduledTasksButton } from './scheduled-tasks-button';

export interface ScheduledTasksViewProps {
  catalog: AgentCatalogPort;
  /** Whether the page draws its own name row, as the chat pane does beside
   *  Documents; in Chats the titlebar names it. */
  header: boolean;
  port: ScheduledTasksPort;
  runtime: AgentWorkspaceRuntime;
  scope: AgentScope;
}

/** Which task the form is open on: an id, or null for a new one. */
type Editing = { readonly taskId: string | null } | null;

const SECTION_LABEL = 'm-0 text-caption font-medium text-muted-foreground';

export function ScheduledTasksView({
  catalog,
  header,
  port,
  runtime,
  scope,
}: ScheduledTasksViewProps) {
  const tasks = useScheduledTasks(port, scope.path, true);
  const [editing, setEditing] = useState<Editing>(null);
  const ids = { history: useId(), list: useId() };
  const environment = useStore(runtime.store, (state) =>
    state.scopeEnvironment?.folderPath === scope.path ? state.scopeEnvironment : null,
  );
  const tabs = useStore(runtime.store, (state) => state.tabs);
  // A run whose chat this window holds reads its live state from the chat.
  const live = useMemo(
    () =>
      new Map(
        tabs.flatMap((tab) =>
          tab.nativeSessionId ? [[tab.nativeSessionId, tab.status ?? null]] : [],
        ),
      ),
    [tabs],
  );
  const liveStatus = (run: ScheduledTaskRun) =>
    run.sessionId ? (live.get(run.sessionId) ?? null) : null;
  const schedule = tasks.schedule;
  const projectAgent = runtime.preferredAgent(scope);
  const now = Date.now();
  const editingTask = editing?.taskId
    ? (schedule?.tasks.find((task) => task.id === editing.taskId) ?? null)
    : null;

  const edit = (next: Editing) => {
    tasks.clearFailure();
    setEditing(next);
  };
  const openChat = (task: ScheduledTask, run: ScheduledTaskRun) => {
    if (!run.sessionId) return;
    void runtime.restore({
      agent: run.agent ?? task.agent ?? projectAgent,
      hasContent: true,
      id: run.sessionId,
      lastModified: run.startedAt,
      scope,
      title: run.title ?? task.name,
    });
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-surface-2">
      {header && (
        <div className="relative flex h-10 shrink-0 items-center gap-2 px-4">
          <CalendarClock
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
            strokeWidth={1.75}
          />
          <h2 className="m-0 min-w-0 truncate text-body font-normal text-foreground">
            Scheduled tasks
          </h2>
          <div className="-mr-2 ml-auto flex shrink-0 items-center gap-1">
            <ScheduledTasksButton runtime={runtime} />
            <ChatHistoryPopover runtime={runtime} scope={scope} />
            <NewChatButton catalog={catalog} runtime={runtime} scope={scope} />
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-6 px-5 pt-4 pb-10 max-sm:px-4">
          {editing ? (
            <section
              aria-label={editing.taskId ? 'Edit task' : 'New task'}
              className="flex flex-col gap-4"
            >
              <div className="flex flex-col gap-1">
                <h3 className="m-0 text-body font-medium text-foreground">
                  {editing.taskId ? 'Edit task' : 'New task'}
                </h3>
                <p className="m-0 text-caption text-muted-foreground">
                  Starts a new chat in this project every day, as if you had sent the request.
                </p>
              </div>
              <ScheduledTaskForm
                environment={environment}
                failure={tasks.failure}
                key={editing.taskId ?? 'new'}
                missing={editing.taskId !== null && schedule !== null && editingTask === null}
                onCancel={() => edit(null)}
                onDelete={() => {
                  if (!editing.taskId) return;
                  void tasks.remove(editing.taskId, schedule?.version ?? null).then((removed) => {
                    if (removed) edit(null);
                  });
                }}
                onSave={(draft) =>
                  void tasks.save(draft, schedule?.version ?? null).then((taskId) => {
                    if (taskId) edit(null);
                  })
                }
                projectAgent={projectAgent}
                saving={tasks.pending.has('save')}
                task={editingTask}
              />
            </section>
          ) : (
            <>
              <div className="flex items-start gap-4">
                <p className="m-0 min-w-0 flex-1 text-caption text-muted-foreground">
                  Each task starts a new chat in this project at its time, every day. Tasks run only
                  while StashBase is open; a run missed while it was closed starts when you come
                  back that day, and is listed as missed after that.
                </p>
                <Button
                  disabled={!schedule || schedule.problem !== null}
                  leadingIcon={Plus}
                  onClick={() => edit({ taskId: null })}
                  size="compact"
                  variant="secondary"
                >
                  New task
                </Button>
              </div>
              {tasks.loadFailure && (
                <div className="flex items-center gap-2">
                  <FailureNotice className="m-0" failure={tasks.loadFailure} />
                  <Button onClick={tasks.retry} size="compact" variant="ghost">
                    Retry
                  </Button>
                </div>
              )}
              {schedule?.problem && (
                <FailureLine className="m-0" tone="input">
                  {schedule.problem} Ask the Agent to fix .schedules.json, or edit it with hidden
                  files shown.
                </FailureLine>
              )}
              {tasks.failure && <FailureNotice className="m-0" failure={tasks.failure} />}
              <section aria-labelledby={ids.list} className="flex flex-col gap-2">
                <h3 className={SECTION_LABEL} id={ids.list}>
                  Tasks
                </h3>
                <ul
                  aria-label="Scheduled tasks"
                  className={cn(
                    'm-0 flex list-none flex-col border border-border/50 p-0',
                    shapeTokens.panel,
                  )}
                >
                  {(schedule?.tasks ?? []).map((task) => (
                    <TaskRow
                      key={task.id}
                      live={liveStatus}
                      now={now}
                      onEdit={() => edit({ taskId: task.id })}
                      onOpenChat={(run) => openChat(task, run)}
                      onRunNow={() => void tasks.runNow(task.id)}
                      onToggle={() => void tasks.setEnabled(task.id, !task.enabled)}
                      pending={tasks.pending}
                      projectAgent={agentLabel(task.agent ?? projectAgent)}
                      task={task}
                    />
                  ))}
                  {schedule && schedule.tasks.length === 0 && !schedule.problem && (
                    <li className="px-4 py-6 text-center text-caption text-muted-foreground">
                      No tasks yet. A task can follow a workflow file in this project, such as a
                      daily brief.
                    </li>
                  )}
                  {tasks.loading && (
                    <li className="px-4 py-6 text-center text-caption text-muted-foreground">
                      Loading tasks…
                    </li>
                  )}
                </ul>
              </section>
              <section aria-labelledby={ids.history} className="flex flex-col gap-2">
                <h3 className={SECTION_LABEL} id={ids.history}>
                  Run history
                </h3>
                <ul aria-label="Run history" className="m-0 flex list-none flex-col gap-3 p-0">
                  {runHistory(schedule?.tasks ?? []).map(({ run, task }) => (
                    <li key={run.runId}>
                      <ScheduledRunStatus
                        live={liveStatus(run)}
                        name={task.name}
                        onOpenChat={() => openChat(task, run)}
                        run={run}
                      />
                    </li>
                  ))}
                  {schedule && schedule.tasks.every((task) => task.runs.length === 0) && (
                    <li className="text-caption text-muted-foreground">
                      No runs yet. Every run is listed here, whether it ran or not.
                    </li>
                  )}
                </ul>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TaskRow({
  live,
  now,
  onEdit,
  onOpenChat,
  onRunNow,
  onToggle,
  pending,
  projectAgent,
  task,
}: {
  live(run: ScheduledTaskRun): string | null;
  now: number;
  onEdit(): void;
  onOpenChat(run: ScheduledTaskRun): void;
  onRunNow(): void;
  onToggle(): void;
  pending: ReadonlySet<string>;
  projectAgent: string;
  task: ScheduledTask;
}) {
  const latest = task.runs[0];
  const next = nextRunLabel(task, now);
  return (
    <li className="flex items-start gap-3 border-b border-border/50 px-4 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <button
          className={cn(
            'cursor-pointer self-start truncate text-left text-body font-medium text-foreground hover:underline',
            focusRing(shapeTokens.item),
          )}
          onClick={onEdit}
          type="button"
        >
          {task.name || 'Unnamed task'}
        </button>
        <p className="m-0 text-caption text-muted-foreground">
          {scheduleLabel(task.time)} · {projectAgent}
        </p>
        {task.problem ? (
          <FailureLine announce={false} className="m-0" tone="input">
            {task.problem}
          </FailureLine>
        ) : (
          <p className="m-0 text-caption text-foreground">
            {next ?? 'Off. Switch it on to run every day.'}
          </p>
        )}
        {latest ? (
          <ScheduledRunStatus live={live(latest)} onOpenChat={onOpenChat} run={latest} />
        ) : (
          <p className="m-0 text-caption text-muted-foreground">Not run yet</p>
        )}
      </div>
      <Button
        disabled={
          task.problem !== null || latest?.status === 'running' || pending.has(`run:${task.id}`)
        }
        leadingIcon={Play}
        onClick={onRunNow}
        size="compact"
        variant="secondary"
      >
        Run now
      </Button>
      <Switch
        checked={task.enabled}
        disabled={task.problem !== null || pending.has(`switch:${task.id}`)}
        label={`Run ${task.name || 'this task'} every day`}
        labelHidden
        onToggle={onToggle}
      />
    </li>
  );
}
