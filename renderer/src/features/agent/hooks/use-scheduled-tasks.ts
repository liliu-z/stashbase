import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import {
  ScheduledTasksError,
  type ScheduledTasksExtra,
  type ScheduledTasksPort,
} from '@/features/agent/application/ports';
import type { ProjectSchedule, ScheduledTaskDraft } from '@/features/agent/domain/scheduled-tasks';
import {
  readFailure,
  type FailureView,
  type FeatureFailureKind,
} from '@/shared/domain/feature-error';
import { useRequestSignals } from '@/shared/runtime/use-request-signals';

/** While the list is open it follows the task file, which a template, the
 *  Agent or another editor may change at any time. */
const REFRESH_MS = 3_000;

const MESSAGES: Readonly<Record<FeatureFailureKind<ScheduledTasksExtra>, string>> = {
  conflict: 'The task file changed while you were editing. Your edit is still here; save it again.',
  'invalid-file': 'The task file cannot be read as tasks, so it was left as it is.',
  'invalid-response': 'StashBase returned an unexpected response.',
  'invalid-task': 'This task could not be saved.',
  'not-found': 'This task is no longer in the task file.',
  'scope-lost': 'This project is no longer available in this window.',
  unauthorized: 'This window can no longer change scheduled tasks.',
  unavailable: 'StashBase could not reach your scheduled tasks.',
};

function scheduledTasksFailure(error: unknown): FailureView {
  return readFailure<ScheduledTasksExtra>(error, MESSAGES, {
    inputKinds: ['conflict', 'invalid-file', 'invalid-task', 'not-found'],
    owner: 'ScheduledTasksError',
    // The server names what is wrong with the task or the file.
    serverSentenceFor: ['invalid-file', 'invalid-task'],
  });
}

const queryKey = (folderPath: string) => ['agent', 'scheduled-tasks', folderPath] as const;

/** One project's task list while it is on screen, and the edits made to it. */
export function useScheduledTasks(port: ScheduledTasksPort, folderPath: string, open: boolean) {
  const queryClient = useQueryClient();
  const key = queryKey(folderPath);
  const query = useQuery({
    enabled: open,
    queryFn: ({ signal }) => port.read(folderPath, signal),
    queryKey: key,
    refetchInterval: open ? REFRESH_MS : false,
    retry: false,
  });
  const signalFor = useRequestSignals();
  const [failure, setFailure] = useState<FailureView | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const adopt = (schedule: ProjectSchedule) => queryClient.setQueryData(key, schedule);

  /** Runs one edit; a refusal is shown, and a changed file is read again. */
  const attempt = async <T>(lane: string, work: () => Promise<T>): Promise<T | null> => {
    setFailure(null);
    setPending((current) => new Set(current).add(lane));
    try {
      return await work();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      setFailure(scheduledTasksFailure(error));
      if (error instanceof ScheduledTasksError && error.kind !== 'invalid-task') {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      return null;
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(lane);
        return next;
      });
    }
  };

  const schedule = query.data ?? null;
  return {
    failure,
    clearFailure: () => setFailure(null),
    loadFailure: query.isError ? scheduledTasksFailure(query.error) : null,
    loading: query.isLoading,
    pending,
    retry: () => void query.refetch(),
    schedule,
    setEnabled: (taskId: string, enabled: boolean) =>
      attempt(`switch:${taskId}`, async () =>
        adopt(await port.setEnabled(folderPath, taskId, enabled, signalFor(`switch:${taskId}`))),
      ),
    /** Saves against the version the form started from; answers the task's
     *  id, or null when it was refused. */
    save: (draft: ScheduledTaskDraft, baseVersion: string | null) =>
      attempt('save', async () => {
        const saved = await port.save(folderPath, baseVersion, draft, signalFor('save'));
        adopt(saved.schedule);
        return saved.taskId;
      }),
    remove: (taskId: string, baseVersion: string | null) =>
      attempt('save', async () => {
        adopt(await port.remove(folderPath, baseVersion, taskId, signalFor('save')));
        return taskId;
      }),
    /** Main runs it and records the result; the list, which follows the
     *  file and the record, shows it running and then how it went. */
    runNow: (taskId: string) =>
      attempt(`run:${taskId}`, async () => {
        const result = await port.runNow(folderPath, taskId);
        void query.refetch();
        if (!result.ok) setFailure({ message: result.message, tone: 'capability' });
        return result.ok ? result.outcome : null;
      }),
  };
}

/** The native ids of the chats scheduled runs started in one project, so the
 *  Chats list can mark them. It shares the task list's cache and reads it
 *  again whenever `chats` changes, which is when a run's chat can appear. */
export function useScheduledRunSessions(
  port: ScheduledTasksPort | undefined,
  folderPath: string,
  chats: unknown,
): ReadonlySet<string> {
  const query = useQuery({
    enabled: port !== undefined,
    queryFn: ({ signal }) =>
      port ? port.read(folderPath, signal) : Promise.reject(new Error('No scheduled tasks')),
    queryKey: queryKey(folderPath),
    retry: false,
  });
  const { refetch } = query;
  useEffect(() => {
    if (port) void refetch();
  }, [chats, port, refetch]);
  return useMemo(
    () =>
      new Set(
        query.data?.tasks.flatMap((task) =>
          task.runs.flatMap((run) => (run.sessionId ? [run.sessionId] : [])),
        ),
      ),
    [query.data],
  );
}
