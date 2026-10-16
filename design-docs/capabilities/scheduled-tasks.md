# Scheduled Tasks

## Scope

A scheduled task is recurring work a project asks of its Agent: at a set local time
every day, a new chat starts in the project with a request the reader wrote once. A
daily brief that follows a workflow file in the project is the typical case. This
document owns why scheduled tasks work the way they do and the rules that follow from
it. [J14](../journeys/README.md#j14-run-a-scheduled-task-in-a-project) is the user
journey; [Engineering Boundaries](../../code-review/architecture.md#scheduled-tasks)
owns how the work is split between processes.

StashBase is an IDE for writing, so a scheduled task is held to the standard of
everything else in a project: its definition is an ordinary file the reader owns, its
result is an ordinary chat, and the reader can always see what it did and what it will
do next.

## Principles

### The framework sends a request at a time; the work is content

The app does one thing: at the task's time, it starts a chat and sends the task's
request. What that request does lives in the project, usually as a workflow file the
task mentions, not in app code. A daily brief, a weekly review, or a reading digest is
a file a template ships or the reader writes; none needs a release of StashBase.

- A task's request is text, project files mentioned with `@`, or both, written in the
  same field as a Chat message. A task that only mentions files asks the Agent to
  follow them, so a reader never has to decide whether a file is a workflow, a skill,
  or a checklist.
- A task stores file paths, never their contents. Each run reads the files as they
  are at that moment, so improving a workflow improves the next run.

### A run is a chat the reader could have sent

A run is the reader opening a new chat in the project, writing the request, and
pressing Send. It uses the same session, send path, and context checks as any chat,
so the Agent, model, permission mode, approvals, and clarifying questions behave
exactly as they do when the reader is at the keyboard. There is no separate automation
engine and no second permission model to learn or to secure.

- The chat runs on the task's Agent, or on the project's Agent when the task names
  none, and keeps it for its whole life.
- Its title is the task's name and the day, such as "Daily brief · Oct 16", kept as a
  name of its own, so each day's result is easy to find in the chat list.
- An approval or a question waits in the run's chat until the reader comes back. A
  run never answers on the reader's behalf.

### Definitions travel with the project; switches and history stay on the computer

A task's definition is part of the project: it lives in the project root's
`.schedules.json`, it is copied with a template, and it syncs with the folder. Whether
a task is switched on, and the record of its runs, belong to the computer that runs it.

- Copying a template never switches its tasks on, so nothing spends Agent credits
  until the reader decides it should.
- A folder synced to two computers is not run twice: each computer has its own switch.
- A task the reader creates starts switched off, even when an earlier task once used
  the same id.

### The file is the source; the list is its view

The reader reads and changes tasks through the task list, never through the JSON. The
list and the file stay one thing:

- The list follows the file while it is open, so a task a template or the Agent wrote
  appears without reopening anything.
- An edit in the list rewrites only its own task, against the version it read. It
  keeps every field it does not know, at the top level and in the task, so templates
  can carry their own notes.
- A file the list cannot read as tasks is never overwritten from the list. The list
  says what is wrong; a task the file states badly is listed with the reason it
  cannot run, and the rest still run.
- The file is hidden in Files unless hidden files are shown, and is never searchable
  project material. Agents write it with the ordinary file tools.

### Control comes from seeing everything

The common failure of scheduled work is not knowing: whether it ran, how it went, and
whether it will run tomorrow. The task list answers all three at a glance, so a reader
never has to open a chat or a log to find out.

- The task list is always a list that stands in the chat's place, from **Scheduled
  tasks** in the Chats sidebar or its button in the chat pane's header beside
  Documents. With no tasks it is an empty list, never a prompt saying there is
  nothing. Opening any chat brings the chat back.
- Each task says when it runs next, or that it is off and will not run.
- Each task says what became of its latest run: starting its chat, working, waiting
  for the reader's approval, finished, did not finish, did not run, or missed, with
  the reason. While this window holds the run's chat, its state is live.
- A finished run quotes the start of the Agent's last reply. A turn can end normally
  and still say it could not do the work, so "finished" alone would claim more than
  the app knows.
- A run history lists every recent run with its time, its outcome, its reason when it
  failed, and a way into its chat. A run that started late says it was due earlier
  and StashBase was closed or asleep then. Days a task missed are one entry that says
  which days.
- A chat a task started carries a clock in the chat list, so it reads as the task's
  and not as one the reader started.
- How a run's first turn ended is kept once it settles, so the outcome is still there
  after a restart. A run whose window closed before then reads as started, and points
  to its chat for how it ended.

### Quiet by design

A scheduled run must never interrupt. The reader may be typing in another app when it
starts.

- A run never takes focus and never takes over the chat the reader is writing in.
- When the project has no window, one opens out of sight and appears, still without
  focus, the next time the reader comes back to StashBase.
- There are no system notifications and no unread markers. A daily task runs at a
  known time; the day's chat at the top of the list, and the task list itself, are
  where results are found.

### Runs happen only while StashBase is open

StashBase runs no background service, tray process, or operating-system scheduler.
This keeps every run inside the app the reader can see and control, with the same
permissions and windows as their own work.

- The form says so beside the time.
- A run missed earlier the same day, while the app was closed or the computer slept,
  starts once when the reader comes back. One missed on an earlier day does not run
  late: its result would be stale, and it would take the place of that day's own run.
  It is listed as missed, and the task runs at its next time. A task runs at most once
  a local day, and never for a time before it was switched on, so turning a task on in
  the afternoon does not run the morning's occurrence.

### Nothing asks a reader who is not there

A run cannot open a sign-in prompt, an installer, or a dialog. When it cannot start,
it fails and says why, and the reason waits in the list:

- An Agent that needs sign-in or setup.
- A send the ordinary checks refuse, such as a mentioned file no longer in the project.
- A chat that does not start in time, or a window that closed first.

A failed run is never retried automatically. **Run now** starts a run on request and
does not move the task's next scheduled run.

### Each occurrence runs at most once

A run that might have started is never sent again. Each scheduled occurrence is
claimed once before anything starts, a run's outcome only moves forward, and a run
left starting when StashBase closed reads as failed rather than as one to repeat.

## Task File

`.schedules.json` at the project root holds a `tasks` list. Each task has:

| Field | Meaning |
|---|---|
| `id` | Stable within the file. The list derives it from a new task's name. |
| `name` | What the list and the run's chat title call it. |
| `time` | Local 24-hour `HH:MM`, every day. |
| `prompt` | The request, which may mention files with `@`. |
| `files` | Project-relative paths the request follows. |
| `agent` | `default`, `claude`, or `codex`; absent means the project's Agent. |

Other fields are kept as they are. [Using StashBase](../../docs/using-stashbase.md#schedule-tasks)
shows the format to readers.

## Limits and Open Questions

- Tasks run every day; there are no weekday or interval schedules yet.
- A run's outcome after its window closed is not followed; the chat holds it.
- Agents learn the file format from the user guide or an existing file; StashBase's
  own Agent instructions do not describe it, which keeps every session's prompt
  unchanged. Whether a short description is worth that cost is open.

## Related Journeys

[J14](../journeys/README.md#j14-run-a-scheduled-task-in-a-project).

[Agent Sessions](agent-sessions.md) owns how every chat runs; [Project Files](project-files.md)
owns file rules; [Project Entry](project-entry.md) owns which window shows a project.
