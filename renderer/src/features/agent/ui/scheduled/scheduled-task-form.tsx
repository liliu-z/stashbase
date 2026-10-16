/**
 * Writes a new scheduled task or edits one, in the task list's own page: its
 * name, its daily time, the Agent that runs it and what to do. The task file
 * is never shown; this form is how a reader reads and changes it.
 */
import { useEffect, useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { AGENT_ORDER, agentLabel } from '@/features/agent/domain/agent-catalog';
import type { AgentScopeEnvironment } from '@/features/agent/domain/context';
import {
  draftProblem,
  emptyTaskDraft,
  taskDraft,
  type ScheduledTask,
  type ScheduledTaskDraft,
} from '@/features/agent/domain/scheduled-tasks';
import type { AgentId } from '@/features/agent/domain/session';
import { shapeTokens } from '@/lib/shape-context';
import { cn } from '@/lib/utils';
import type { FailureView } from '@/shared/domain/feature-error';
import { FailureLine, FailureNotice } from '@/shared/ui/failure-notice';
import { textFieldClass } from '@/shared/ui/text-field';

import { ScheduledPromptField } from './scheduled-prompt-field';

const LINE_CLASS = textFieldClass('bg-surface-3 text-body text-foreground', shapeTokens.panel);
const LABEL_CLASS = 'text-caption text-muted-foreground';
const PROJECT_AGENT = 'project';

function sameDraft(left: ScheduledTaskDraft, right: ScheduledTaskDraft): boolean {
  return (
    left.name === right.name &&
    left.time === right.time &&
    left.prompt === right.prompt &&
    left.agent === right.agent &&
    left.files.length === right.files.length &&
    left.files.every((file, index) => right.files[index] === file)
  );
}

export interface ScheduledTaskFormProps {
  environment: AgentScopeEnvironment | null;
  failure: FailureView | null;
  /** True for a task being edited that has since left the task file. */
  missing: boolean;
  onCancel(): void;
  onDelete(): void;
  onSave(draft: ScheduledTaskDraft): void;
  /** Which Agent "the project's Agent" currently means. */
  projectAgent: AgentId;
  saving: boolean;
  /** The task as the file now states it; null for a new one. */
  task: ScheduledTask | null;
}

export function ScheduledTaskForm({
  environment,
  failure,
  missing,
  onCancel,
  onDelete,
  onSave,
  projectAgent,
  saving,
  task,
}: ScheduledTaskFormProps) {
  const latest = task ? taskDraft(task) : null;
  const [opened, setOpened] = useState<ScheduledTaskDraft>(() => latest ?? emptyTaskDraft());
  const [draft, setDraft] = useState<ScheduledTaskDraft>(opened);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const ids = { agent: useId(), name: useId(), note: useId(), prompt: useId(), time: useId() };
  const dirty = !sameDraft(draft, opened);
  const latestKey = latest ? JSON.stringify(latest) : null;

  // The form follows the task file until the reader changes something; from
  // then on their edit stands, and the form says when the file moved under it.
  useEffect(() => {
    if (!latestKey) return;
    const next = JSON.parse(latestKey) as ScheduledTaskDraft;
    if (sameDraft(next, opened)) return;
    if (!dirty) {
      setOpened(next);
      setDraft(next);
    }
  }, [dirty, latestKey, opened]);
  const changedUnderneath = latest !== null && dirty && !sameDraft(latest, opened);

  const problem = draftProblem(draft);
  // Following the project and pinning one Agent are different choices even
  // when they name the same Agent today, so each says which it is.
  const agentItems = [
    { label: `Follow this project (now ${agentLabel(projectAgent)})`, value: PROJECT_AGENT },
    ...AGENT_ORDER.map((id) => ({ label: `Always ${agentLabel(id)}`, value: id })),
  ];

  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <label className="flex min-w-0 flex-col gap-1" htmlFor={ids.name}>
            <span className={LABEL_CLASS}>Name</span>
            <input
              className={LINE_CLASS}
              disabled={saving}
              id={ids.name}
              maxLength={120}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="Daily brief"
              value={draft.name}
            />
          </label>
          <label className="flex flex-col gap-1" htmlFor={ids.time}>
            <span className={LABEL_CLASS}>Every day at</span>
            <input
              aria-describedby={ids.note}
              className={cn(LINE_CLASS, 'w-36')}
              disabled={saving}
              id={ids.time}
              onChange={(event) => setDraft({ ...draft, time: event.target.value })}
              required
              step={60}
              type="time"
              value={draft.time}
            />
          </label>
        </div>
        <p className="m-0 text-caption text-muted-foreground" id={ids.note}>
          Runs only while StashBase is open. A run missed while it was closed starts when you open
          it again that day.
        </p>
        <div className="flex flex-col gap-1">
          <label className={LABEL_CLASS} htmlFor={ids.agent}>
            Agent
          </label>
          <Select
            disabled={saving}
            items={agentItems}
            onValueChange={(value) =>
              setDraft({ ...draft, agent: value === PROJECT_AGENT ? null : (value as AgentId) })
            }
            value={draft.agent ?? PROJECT_AGENT}
          >
            <SelectTrigger className="w-full sm:w-72" id={ids.agent} />
            <SelectContent>
              {agentItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <span className={LABEL_CLASS} id={ids.prompt}>
            What to do
          </span>
          <ScheduledPromptField
            describedBy={ids.prompt}
            disabled={saving}
            environment={environment}
            label="What to do"
            onChange={({ files, text }) => setDraft({ ...draft, files, prompt: text })}
            value={{ files: draft.files, text: draft.prompt }}
          />
          <p className="m-0 text-caption text-muted-foreground">
            Mention a file with @, such as a workflow. Each run reads it as it is then.
          </p>
        </div>
      </div>
      {missing && (
        <FailureLine className="m-0" tone="input">
          This task is no longer in the task file. Saving adds it back.
        </FailureLine>
      )}
      {changedUnderneath && !missing && (
        <FailureLine className="m-0" tone="capability">
          This task changed in its file while you were editing. Saving keeps your version.
        </FailureLine>
      )}
      {failure && <FailureNotice className="m-0" failure={failure} />}
      <div className="flex items-center justify-end gap-2">
        {task && !missing && (
          <Button
            className="mr-auto"
            disabled={saving}
            onClick={() => (confirmingDelete ? onDelete() : setConfirmingDelete(true))}
            variant="ghost"
          >
            {confirmingDelete ? 'Delete for good' : 'Delete'}
          </Button>
        )}
        <Button onClick={onCancel} variant="ghost">
          Back
        </Button>
        <Button
          disabled={problem !== null || (!dirty && !missing && task !== null) || saving}
          loading={saving}
          onClick={() =>
            onSave(missing ? { ...draft, id: undefined } : { ...draft, id: task?.id ?? draft.id })
          }
        >
          Save
        </Button>
      </div>
    </>
  );
}
