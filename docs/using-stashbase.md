# Using StashBase

Start with [Start Writing](../README.md#start-writing): enter a project,
brainstorm with an Agent, and begin drafting when ready.

## Choose a Folder and an Agent

The first window opens at Welcome. Open an existing folder, create an empty
project, import a public GitHub repository, or choose **Make a copy** in the
Gallery. Chat becomes available inside the project, even if it contains no
files. An entry's **Copy prompt** copies its build request for you to paste;
it does not start a conversation automatically.

Choose Claude or Codex and sign in with your provider account.
A missing runtime waits for **Connect Claude** or **Connect Codex** before
installation. If Claude is too old for the model you chose, the failed turn
offers **Update Claude**. **Settings → Agents** shows each installed runtime's
version with an **Update** that runs the runtime's own updater in place.

If you can't use either, the built-in **Default Agent** provides a fallback
with free credits. Sign in to StashBase from the bottom of the sidebar or
**Settings → Agents**; no separate Agent installation or model API key is required.

Start with an idea or question in the project's Chat. When ready, ask the
Agent to create an outline or draft, or write directly in a new document.
References and search are available when useful; neither a wiki nor a
completed index is required to brainstorm.

For a source-filled project, you can ask your Agent to organize references
into linked wiki pages. Search always targets one project,
and wiki maintenance runs only when requested.

## Read and Work Alongside Chat

Selecting a source opens it alongside the same conversation. The Files sidebar,
persistent tabs, and format-specific viewers let you browse, read, and edit
supported files directly.

- **Cmd/Ctrl+O:** find and open a file in the active folder.
- **Cmd/Ctrl+Shift+P** or **F1:** open the Command Palette.
- **Project name at the top of the sidebar:** switch to a recent project, or
  open, create, or import one. It opens in its own window.
- **File → New Window** or **Cmd/Ctrl+Shift+N:** work in another window.
- **Cmd/Ctrl+W:** close the active document tab.
- **@ mentions in Chat:** find a file or folder and insert its relative path.

Tool calls and file edits can be reviewed in Chat. Use **Persona** in the
composer to choose who the Agent is when it talks and writes in this chat. Your
personas are shared by every project: Builder, Marketer, Journalist, and
Storyteller to start, any you write with **New persona…**, and any you add from
**Browse personas…**. Hover a persona to edit or delete it. A choice applies
from your next message in that chat, and new chats in the project start with
the persona you chose last. How the Agent works belongs in your own `AGENTS.md`
or `CLAUDE.md`; StashBase never creates or rewrites them.

Default offers **Ask** (confirm changes and commands), **Edit** (allow ordinary
document writes in this project; confirm other actions), and **Plan** (read and
explore without writes or commands). Choose a mode between turns. Default has
no **Auto** option because its runtime has no automatic risk reviewer.

Drafting, editing, Agent file-change reports, and save-conflict comparisons are
available, and so is the [document diff](../README.md#document-diff): after the Agent writes, choose
**Review** in **Changed in this turn** to undo or keep each change in the document.
**Keep all** leaves the saved file unchanged; **Undo all** restores the earlier text.

Select text in a Markdown document and choose **Heading** on the selection
toolbar to turn it into Text, Heading 1, Heading 2 or Heading 3. Deeper
headings, lists and quotes are in the `/` menu.

Some files can be listed without being searchable or editable. Muted files
are excluded from Search and automatic Chat context. Preview, editing,
retrieval text, and Agent file access vary by format; see the canonical
[Format Capability Matrix](../design-docs/capabilities/project-files.md#format-capability-matrix).

## Schedule Tasks

A scheduled task starts a new chat in its project at a set time every day, as if you
had written the request and pressed Send. Use it for recurring work such as a daily
brief.

Choose **Scheduled tasks** under **New chat** in the Chats sidebar, or its calendar
button in the chat pane's header beside a document. The project's task list takes the
chat's place; open any chat to go back. Each task has a name, a time, the Agent that
runs it, and what to do: a sentence, a project file mentioned with `@` (such as a
workflow), or both. A task that only mentions a file asks the Agent to follow it. The
file is read as it is when the task runs.

The list shows each task's next run, or that it is off, and what became of its latest
run: starting, working, waiting for your approval, finished, did not finish, did not run,
or missed, with the reason. A finished run quotes the start of the Agent's last reply,
so you can see whether it did the work without opening the chat. **Run history** below
lists every recent run with its time, outcome, and chat, and says when a run started
late because StashBase was closed or asleep. A run's chat shows a clock in the chat
list.

- Tasks run only while StashBase is open. A run missed earlier that day, while it was
  closed or while the computer slept, starts once when you come back. A run missed on
  an earlier day is listed as missed instead of running late, and the task runs at its
  next time.
- The switch beside a task belongs to this computer. Copying a project or a template,
  or syncing the folder to another computer, never switches a task on.
- **Run now** starts a run right away without moving the task's next run.
- A run's chat is titled with the task and the day, such as "Daily brief · Oct 16", and
  appears at the top of the chat list. If the Agent asks for approval or asks a
  question, the chat waits for you there. StashBase does not take focus or send
  notifications.
- When the project has no open window, StashBase opens one out of sight and shows it
  the next time you come back to the app.

Tasks are saved in `.schedules.json` at the project root, hidden in Files unless hidden
files are shown. A template can ship one, and an Agent can write it with its file tools:

```json
{
  "tasks": [
    {
      "id": "daily-brief",
      "name": "Daily brief",
      "time": "08:00",
      "prompt": "",
      "files": ["workflows/daily-brief.md"],
      "agent": "claude"
    }
  ]
}
```

`time` is local 24-hour time and `files` lists project-relative paths. `agent` is
`default`, `claude`, or `codex`; leave it out to use the project's Agent. Fields the
list does not know are kept when you edit a task there.

## Turn On Search by Meaning

Keyword search needs no account or API key and is on from the start. Search
by meaning, which finds files even when the wording differs, is off until you
add an OpenAI or OpenRouter key under **Settings → Advanced → Search by meaning**. The
key is billed to you and is used only for search by meaning; signing in to
StashBase does not turn it on.

Once the key is saved, StashBase prepares registered projects and keeps their
search index synchronized, and the search panel gains a **By meaning** mode
beside **By keyword**. Removing the key turns it off again. This background
work is separate from an Agent writing visible Wiki Pages. An OpenAI
restricted key needs embedding access for `text-embedding-3-small`;
model-list access is not required.

Search covers direct text in supported Markdown, UTF-8 plain text, HTML, and
JSON files, plus prepared text from PDFs, DOCX files, and images.
Results point back to the visible source file. Some material needs preparation
before it can appear; Search reports readiness, and failed preparation can be
retried.

Agents search the same way: text matching always, including prepared
document text, plus meaning-based evidence once a key is on.

Default Agent credits don't cover search by meaning. Check the account
menu at the bottom of the sidebar or **Settings → Agents** for the remaining
percentage and refill date.

## Preview Recordings

Audio and video files play directly when their codec is supported. Unsupported
files can be opened externally. Media is not prepared, searchable, or readable
as Agent/MCP content.

## Manage Access

Folders join the project registry only when you explicitly add or open them,
including making a Gallery copy.
Removing a folder clears StashBase's state for it without deleting its files.

For an external Agent client, keep StashBase running and register the
configuration from **Settings → Advanced → External apps (MCP)**. See
[MCP Configuration](mcp-configuration.md) for setup and access boundaries, and
[Your Files and Your Data](../README.md#your-files-and-your-data) for local and
cloud processing boundaries.
