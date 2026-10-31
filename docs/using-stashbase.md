# Using StashBase

Start with [Start Writing](../README.md#start-writing): enter a project,
brainstorm with an agent, and begin drafting when ready.

## Choose a Folder and an Agent

The first launch opens at Welcome. Later launches, including a restart to
update, reopen the projects you had open. Open an existing folder, create an empty
project, import a public GitHub repository, or choose **Make a copy** in the
Gallery. Chat becomes available inside the project, even if it contains no
files. An entry's **Copy prompt** copies its build request for you to paste;
it does not start a conversation automatically.

Choose Claude, Codex, or Antigravity and sign in with your provider account.
A missing runtime waits for **Connect Claude**, **Connect Codex**, or
**Connect Antigravity** before installation. If Claude is too old for the model
you chose, the failed turn offers **Update Claude**. When a newer release of
your runtime is out, the model menu offers **Update** for it. **Settings → Agents**
shows each installed runtime's version, any newer release, and an **Update**
that runs the runtime's own updater in place. Release checks follow
**Check for updates automatically**.

Antigravity asks before changing files or running commands the same way the
others do, and offers Auto, Ask, Edit, and Plan. Its Auto is StashBase's: it
also runs commands that only read, searches the web, and reads pages, and still
asks before other commands. Its chat list lives in StashBase: removing a chat
there leaves the conversation in Antigravity.

If you can't use any of them, the built-in **Default Agent** provides a fallback
with free credits. Sign in to StashBase from the bottom of the sidebar or
**Settings → Account**; no separate agent installation or model API key is required.

After upgrading to 2.16.15, sign in to StashBase again with the **same Google
account** you used before. This release switches account authentication to
Better Auth. Your existing subscription and credits stay linked to that account;
your local projects and files are unchanged. Older releases remain compatible
during the transition, and upgrading is optional. New users should install the
latest release before signing in.

Start with an idea or question in the project's Chat. When ready, ask the
agent to create an outline or draft, or write directly in a new document.
References and search are available when useful; neither a wiki nor a
completed index is required to brainstorm.

For a source-filled project, you can ask your agent to organize references
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
- **Enter while the agent works:** with Claude or Codex, your message joins the
  work in progress and the agent reads it at its next step. **Option/Alt+Enter**
  keeps it for after the reply instead. Other agents always keep it for after.

Tool calls and file edits can be reviewed in Chat. Use **Persona** in the
composer to choose who the agent is when it talks and writes in this chat. Your
personas are shared by every project: Builder, Marketer, Journalist, and
Storyteller to start, any you write with **New persona…**, and any you add from
**Browse personas…**. Hover a persona to edit or delete it. A choice applies
from your next message in that chat, and new chats in the project start with
the persona you chose last. How the agent works belongs in your own `AGENTS.md`
or `CLAUDE.md`; StashBase never creates or rewrites them.

Default offers **Ask** (confirm changes and commands), **Edit** (allow ordinary
document writes in this project; confirm other actions), and **Plan** (read and
explore without writes or commands). Choose a mode between turns. Default has
no **Auto** option because its runtime has no automatic risk reviewer.

Drafting, editing, agent file-change reports, and save-conflict comparisons are
available, and so is the document diff: after the agent writes, choose
**Review** in **Changed in this turn** to undo or keep each change in the document.
Changes are already saved when you review them. **Keep all** leaves the saved
file unchanged; **Undo all** restores the earlier text. New files offer **Open**
instead of Review.

Select text in a Markdown document and choose **Heading** on the selection
toolbar to turn it into Text, Heading 1, Heading 2 or Heading 3. Deeper
headings, lists and quotes are in the `/` menu.

Formulas in a Markdown document follow a per-project **Math** switch, immediately
right of the document's font menu. It is off by default, so an amount like `$4`
stays ordinary text and a formula is written with `$$…$$` or a `math` / `latex`
fence. Turn it on and `$x^2$` opens a formula too, while `\$` keeps a literal
dollar sign. The switch changes only how the project reads a dollar sign on
screen: it rewrites no document and no stored Chat message, keeps undo, selection,
and reading position where they were, and is remembered for the project across a
reopen or restart. Chat follows the same switch, and it renders `\( … \)` and
`\[ … \]` either way.

Some files can be listed without being searchable or editable. Muted files
are excluded from Search and automatic Chat context. Preview, editing,
retrieval text, and agent file access vary by format; see the canonical
[Format Capability Matrix](../design-docs/capabilities/project-files.md#format-capability-matrix).

## Schedule Tasks

A scheduled task starts a new chat in its project at a set time every day, as if you
had written the request and pressed Send. Use it for recurring work such as a daily
brief.

Choose **Scheduled tasks** under **New chat** in the Chats sidebar, or its calendar
button in the chat pane's header beside a document. The project's task list takes the
chat's place; open any chat to go back. Each task has a name, a time, the agent that
runs it, and what to do: a sentence, a project file mentioned with `@` (such as a
workflow), or both. A task that only mentions a file asks the agent to follow it. The
file is read as it is when the task runs.

The list shows each task's next run, or that it is off, and what became of its latest
run: starting, working, waiting for your approval, finished, did not finish, did not run,
or missed, with the reason. A finished run quotes the start of the agent's last reply,
so you can see whether it did the work without opening the chat. **Run history** below
lists every recent run with its time, outcome, and chat, and the days a task missed
because StashBase was closed or asleep. A run's chat shows a clock in the chat list.

- Tasks run only while StashBase is open. A run that cannot start within five minutes
  of its time, because StashBase was closed or the computer slept, never runs late. It
  is listed as missed, and the task runs at its next time.
- The switch beside a task belongs to this computer. Copying a project or a template,
  or syncing the folder to another computer, never switches a task on.
- **Run now** starts a run right away without moving the task's next run.
- A run's chat is titled with the task and the day, such as "Daily brief · Oct 16", and
  appears at the top of the chat list. If the agent asks for approval or asks a
  question, the chat waits for you there. StashBase does not take focus. Like any
  chat, it can notify you while StashBase is in the background, as your notification
  settings allow.
- When the project has no open window, StashBase opens one out of sight and shows it
  the next time you come back to the app.

Tasks are saved in `.schedules.json` at the project root, hidden in Files unless hidden
files are shown. A template can ship one, and an agent can write it with its file tools:

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
`default`, `claude`, `codex`, or `antigravity`; leave it out to use the project's agent. Fields the
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
work is separate from an agent writing visible Wiki Pages. An OpenAI
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
menu at the bottom of the sidebar or **Settings → Account** for the remaining
percentage and refill date.

## Preview Recordings

Audio and video files play directly when their codec is supported. Unsupported
files can be opened externally. Media is not prepared, searchable, or readable
as agent/MCP content.

## Manage Access

Folders join the project registry only when you explicitly add or open them,
including making a Gallery copy.
Removing a folder clears StashBase's state for it without deleting its files.

For an external agent client, keep StashBase running and register the
configuration from **Settings → Advanced → External apps (MCP)**. See
[MCP Configuration](mcp-configuration.md) for setup and access boundaries, and
[Your Files and Your Data](../README.md#your-files-and-your-data) for local and
cloud processing boundaries.

## Fillable HTML Forms

In **New tab**, choose **Create text note** for a blank Markdown document, or
**Create interactive note** for a page you can fill in immediately. Both create
beside the Files selection. Name the new file or folder in Files.

An interactive note has its own folder with `index.html` and `assets/note.json`.
Enter a title and body. Changes save automatically, and the status reports
**Saved** only after saving finishes. Closing the note also settles its accepted draft. Move or copy
the whole folder to keep the page with its data. `assets` starts collapsed; opening
the page does not add a JSON tab. You can open the data file from Files when needed.

You can also ask an Agent to create an interactive note. Its
`create_interactive_note` tool takes an existing project directory and an optional
note name, creates the same blank starter, and returns the entry and data paths.
The Agent can then customize the page with ordinary file tools. This entry currently
provides the blank starter; there is no template picker.

Pages run in a sandbox: `alert`, `confirm`, and `prompt` are ignored (`confirm`
answers false), so build dialogs into the page itself. StashBase shows the page's own markup unchanged, and
error line numbers match the file.

Authored HTML can use any JSON filename or subdirectory under its own `assets/`.
Supply its relative path to `load`; later updates and saves use that same binding.
A no-argument `load()` uses the same-stem JSON sibling. A loaded page cannot switch
its data file without reopening.

Form authors can use the injected API directly, including in an early script:

```js
const data = (await window.stashbase.data.load('./assets/records.json')) ?? { rows: [] };
renderTable(data);

// Call from a user input handler. Await acknowledgement and show errors.
async function onTableChange(nextData) {
  await window.stashbase.data.update(nextData);
}

// Optional: confirm that the file has been written.
async function onSaveClick() {
  await window.stashbase.data.save();
  showSaved();
}
```

`update` changes the shared draft, and StashBase writes it to the file about half
a second later. `save` resolves only when saving succeeds, and rejects on failure
or conflict. Update and Save must come from a user interaction with the form. Closing the form or leaving the
project also settles its data draft through the normal document save barrier.
A missing JSON loads as `null`; the first write creates it without replacing a
file another writer created in the meantime. Invalid JSON is an error, not an empty form.
Use JSON-compatible values (no `undefined`, functions, or non-finite numbers).
Forms use the JSON tree limits: 500 KiB, 20,000 nodes, and 80 levels of nesting.
Duplicate object keys are refused so neither value is silently discarded.

Valid changes saved in the JSON editor automatically reload the HTML with the new
data. External JSON changes appear within about two seconds while the form is
visible, or when you return to it. The form's own updates and saves do not reset
it. Unsaved data stays in place, and invalid JSON keeps the last usable preview.
If saving conflicts with a disk change, StashBase opens the JSON comparison; your
draft remains available. A change to the HTML file reloads the form at once with
the same data. Anything typed that the page has not passed to `update` is lost.
Renaming the HTML or moving its whole directory
preserves explicit relative references. If you rename a resource, update its
reference in the HTML too. The interface is supplied only inside StashBase; opening
the HTML in an ordinary browser does not supply it. No localStorage is used.
