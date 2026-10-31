# Project Files

## Scope

Documents, agent tools, external MCP, and file import operate on ordinary local
files. They share source identity and content-preservation rules; access and
editing capabilities remain explicit for each surface.

## Format Capability Matrix

| Source | Documents mode | Retrieval text | Agent/MCP content access |
|---|---|---|---|
| Markdown | Read/edit; new drafts use Markdown | Source text | Read/write source |
| Plain text (`.txt`) | Read/edit valid UTF-8 | Source text | Read/write valid UTF-8 |
| JSON | Read-only outline, or source text editing | Source text | Read/write source |
| HTML | Preview; authored forms edit an associated JSON file | Extracted in memory | Read/write raw HTML |
| PDF | Source preview | Prepared Markdown | Read prepared text |
| Image | Source preview | Prepared OCR text | Native attachments depend on runtime; MCP does not return image bytes |
| DOCX | Sanitized preview with prepared fallback | Prepared HTML | Read prepared text |
| CSV/TSV | Table, or source text editing up to 8 MiB | None | Read/write source |
| XLSX | Read-only worksheet preview | None | Read worksheet tables through `read_file` |
| Audio/video | Playback when supported, otherwise open externally | None | None |
| Other UTF-8 text (code, configuration, dotfiles, extensionless files) | Bounded read-only text | None | Read/write source by exact path |
| Other binary file | Explicit unavailable state | None | None through text tools |

Playback depends on codecs. Previewability, content editing, file mutation, and
retrieval are independent capabilities. The [glossary](../glossary.md#format-capability)
defines those distinctions; [Project Context](project-context.md) owns preparation.

JSON opens as a read-only outline of keys, values, and types. **Preview /
Source** switches to the source text, which is where JSON is edited; the switch
keeps the source's undo history and the outline's selection. JSON that is empty,
invalid, or too complex for the outline opens in Source with the reason.

PDF preview keeps zoomed page geometry and selectable text while bounding raster
resolution. Pages outside the nearby viewport release their canvas storage;
zooming or closing a preview cancels obsolete rendering, and a zoomed page keeps
its last drawing until the new one replaces it. Each page is drawn with at most
four megapixels and 4,096 pixels on its longest side, so on a high-DPI display a
Letter or A4 page is drawn below screen resolution beyond about 140% zoom, and
larger pages sooner.

## Shared Rules and Differences

- Reads, edits, search results, and file links retain project-and-path identity.
  Missing files and invalid encoding never justify substituting another source
  or rewriting bytes lossily.
- Markdown Math mode is a local per-project presentation preference. With it
  off, single-dollar text stays prose; with it on, paired `$...$` is inline
  math. It never changes Markdown source, frontmatter, or project files.
- Agent text tools accept ordinary UTF-8 source code and configuration within
  project and session permissions, independently of editor and search formats.
  They preserve the requested filename, including `.env` and names without an
  extension; a format error never authorizes appending `.md`. Existing binary
  content, known binary containers, invalid encoding, and non-regular files
  cannot be overwritten as text. Saved text retains BOM, line endings, and
  existing file permissions. Generic text does not acquire indexing or automatic
  context eligibility. Directory discovery retains its visibility rules; an
  omitted file can be read explicitly by its exact path.
- Workbench rename, move, and delete apply to ordinary visible files, including
  generic files. Dragging a file or folder onto a folder in Files moves it there
  under its own name; a folder moves with everything inside it and never into
  itself. A file row stands for its folder; the project's row and the rest of
  the column stand for the root. A closed folder opens when a drag rests on it.
  Links follow a move as they do for a rename, including links out of a moved
  folder. A name already taken in the destination refuses the move.
  Agent/MCP moves and writes require their own authorized capability.
  Any entry's context menu shows it in the system file manager: Finder on
  macOS, File Explorer on Windows, its containing folder elsewhere. It also
  copies the entry's path, from the disk root or from the project folder, in
  the platform's own separators. Protected entries offer only these location
  actions; derived data remains hidden.
- Renaming or deleting a source never migrates or deletes neighboring files
  merely because their names match retired extraction formats. Current derived
  data is owned separately in AppData.
- User-maintained project configuration (`.agents`, `.claude`, `.codex`, `.github`,
  and `.vscode`), including skills, is visible by default in Files and Quick Open
  even when hidden-file visibility is off. Other eligible dot-directories follow
  that preference. VCS databases, product state, and derived data stay hidden;
  visible dependency/cache directories remain unexpanded placeholders.
  Hidden-file visibility changes browsing only. It neither widens tool/search
  access nor discards open edits.
- Project import creates source files; same-name imports keep both copies using
  a new name. Desktop files dropped on Files land in the folder the drop targets,
  as a move would, and a dropped folder is refused. A partial import retries
  only refused files, into the same folder. Chat attachments are
  temporary context and never become project files merely by being attached.
- Agent writes follow runtime permissions and produce ordinary files, whether
  made through a file tool, a shell command, or a subagent. File refreshes do
  not steal focus or imply a universal accept/reject gate.
- A project's scheduled tasks live in its root `.schedules.json`, user-owned content
  that agents write with the ordinary file tools. It joins Files only with hidden files
  shown and is never retrieval-eligible. [Scheduled Tasks](scheduled-tasks.md#the-file-is-the-source-the-list-is-its-view)
  owns how the task list reads and edits it.
- Returning focus to StashBase refreshes the open project's Files tree and
  reconciles external additions, renames, and deletions. Browsing those changes
  does not wait for search indexing, and the refresh preserves open documents.
- Files lists names and file metadata only; it never reads a file to show its
  row. A cloud-only file, such as one iCloud's Optimize Mac Storage has moved
  off the disk, downloads when it is opened, not when the tree loads.

## HTML Forms

Interactive notes are ordinary project subdirectories, each with an `index.html`
entry and an `assets/` directory. Creating one supplies an editable title and body,
initial JSON data, and working data loading and automatic saving. Each creation owns a separate
folder; existing names are never merged or overwritten. The resource directory
starts collapsed in Files. A template's filenames and data structure are defaults,
not constraints on authored pages. An ordinary empty project remains empty.

An authored HTML form can load and edit one JSON resource by its explicit relative
path under its own `assets/`, using `stashbase.data.load('./assets/records.json')`,
`update(value)`, and `save()`. Subdirectories and JSON filenames are freely chosen.
The no-argument load interface still addresses a same-directory, same-stem JSON.
Data remains user-owned project content, never browser storage or disposable
extraction output.

- Loading retains a background document without opening a JSON tab. An explicitly
  opened source editor shares that same draft. A missing file loads as `null`;
  the first explicit save can create it, but opening a form alone writes nothing.
  Invalid JSON is reported without replacing the file. A loaded form cannot switch
  to a different data path without reopening.
- Update acknowledges the shared draft, which then saves automatically within about
  half a second, creating a missing file. Save completes only after the file save
  succeeds. Updates and page-requested saves require a user interaction.
  The usual close/project-release save barrier also settles the draft.
- Valid changes saved in the JSON editor automatically reload the form. While
  visible, the form also checks for external JSON changes every two seconds and
  on focus. Its own data updates and saves do not reload it. Dirty drafts and
  invalid JSON retain the current form; stale edits are refused, and conflicting
  saves open the JSON comparison without discarding either version.
- Activated forms remain mounted across document and Chat navigation. An updated
  HTML/script/style reloads the form at once, and the new page loads the same
  shared draft. Input the page has not passed to Update is not kept.
- The interface operates on the bound JSON in the current project only. Closing
  releases data that has no other open owner. Moving or renaming the source retires
  its old binding and reloads relative to the new location; moving the whole note
  directory preserves its internal references. Renaming an HTML file does not
  rename its resources. Save conflicts reveal the shared JSON editor for recovery.

## External Files

A desktop file dropped on the workspace opens in place without being copied. The drop target decides: Files imports, the message box attaches, and the
rest of the content area opens, the document pane and the chat alike, so no
document needs to be open first. A drop in Chats mode brings Documents on screen.
A drop is accepted only while a project is open, and a file whose real path is
inside the current project opens as that project file. A file inside another
registered project opens as that project's file, read-only like any source
from another project folder. Files under StashBase's own data (`~/.stashbase`
and app data) do not open from a drop.

- A file opens in place only when its preview needs nothing but the file itself:
  Markdown, plain text, JSON, CSV/TSV, PDF, images, XLSX, and other UTF-8 text. DOCX falls back
  to prepared output and HTML loads neighbouring resources, so both must be
  copied into the project; audio and video qualify but are not offered. Other
  binary files and folders are refused. One drop reports all its refusals in a
  single message the reader dismisses. It offers no copy of its own: it names
  Files, where a dropped file is copied into the project.
- Each dropped file gets a kept tab of its own, like any other document, with its
  full path in the tab's tooltip. Markdown, plain text, CSV/TSV, and JSON are edited in
  place and saved to the file itself under the same versioned save and conflict
  rules as a project file; the rest are read-only. It is never prepared, indexed,
  or listed in Files, Quick Open, search, document history once closed, or
  restored sessions; dropping it on Files copies it in. A changed source refreshes
  like a project file; a missing one is reported and written back only by the
  reader's explicit choice. Relative
  links in it are not followed.
- Reading or saving it needs a grant for that one file in that window. The grant
  does not widen project scope, MCP, upload, or agent tool access, and it ends
  when the tab closes, the project changes, or the window closes. A deleted file
  is written back only by the reader's explicit choice, into the same folder.

## Tables

CSV, TSV, and XLSX open as tables: column letters stay on top and row numbers on
the left while the reader scrolls either way. Only the rows in view are drawn,
so a long table scrolls as freely as a short one.

- **CSV and TSV.** The first row is the header and stays pinned under the
  column letters. The delimiter is recognized from the file (comma, tab,
  semicolon, or pipe; TSV is always tab). Quoting follows spreadsheet apps: a
  quoted field may hold delimiters, quotes, and line breaks. The file is read
  in segments, so tables up to 512 MiB open; only the saved file is shown.
  **Table / Source** switches to the source text, edited as plain text under
  the ordinary versioned save and conflict handling. Switching back saves the
  source first; until a save lands, the table says it shows the last saved
  version. A file over the 8 MiB text ceiling opens only as a table. A save
  keeps the line endings of the rows it did not change, so a line break inside
  a cell survives an edit elsewhere. A file that is not UTF-8 opens neither
  way: the reader is told so and how to save the file again as CSV UTF-8,
  with UTF-16 named outright and GBK/GB18030, as Excel writes on Chinese
  Windows, offered as a likely encoding. CSV is never indexed or offered as
  automatic chat context.
- **XLSX.** Visible worksheets, row and column coordinates, and formatted cell
  values, read-only. The reader switches sheets. Formulas show saved results
  when present, or their formula text when no result was saved; StashBase does
  not recalculate them. Preview limits are stated beside the table; a sheet's
  size counts the cells the file holds, not the size it declares. Empty,
  damaged, encrypted, and oversized workbooks, including one with more than
  500,000 cells in its sheets' first 1,000 rows, have explicit states. Preview
  never changes the workbook or adds search eligibility.
- **Agent reading.** `read_file` returns an XLSX from the same parse the
  preview uses: Markdown tables of its visible worksheets with each sheet's
  name, column letters, and row numbers, empty rows and columns left out,
  formula cells listed as saved results that were not recalculated, and every
  row or column beyond the preview's limits named as left out. The workbook
  itself is never written. CSV is ordinary text to agent tools.
- **Selection.** The reader selects cells, whole rows, or whole columns by
  pointer or keyboard. **Copy** puts tab-separated values on the clipboard,
  quoted the way spreadsheets paste them. **Ask agent** binds the selection to
  the chat beside the document as a passage: where it is (sheet and range),
  then its rows as a table keeping row numbers, column letters, and a CSV's
  header names, with a worksheet's first row and formula cells noted. A
  selection over the passage limit is refused at once with the request to
  select fewer rows or columns; it is never cut to fit.

## Saving and Release

Save against the version that was read. Preserve source formatting and unrelated
content. A changed source requires conflict handling; completed writes must not
be reported as failed merely because search updates lag.

Document navigation and mode changes retain live work. Autosave is independent of
which document is visible. Closing a dirty document, leaving its project, quitting,
or installing an update must settle affected saves or keep that work available.
A save refused because the source file no longer exists stops that draft's autosave;
nothing rewrites a path that is gone. The draft stays open and unsaved, and the reader
is offered one explicit write that recreates the file at its original path. That write
first checks the source again, so a file that came back is compared, never overwritten.
Closing the tab, quitting, or leaving the project asks about such a draft rather than
discarding it or refusing in silence.
A save acknowledgement clears only the submitted edit, preserving newer changes.
Crash/shell-remount recovery reads saved files; newer unsaved text is not recoverable.

Rename, move, and delete coordinate affected open drafts before mutation and change
their identities only after confirmation. Cancelling or failing the operation preserves
recoverable work. Rollback must not replace newer user or external changes.

## Failure and Recovery

| Situation | Required result |
|---|---|
| Refresh, preview, or save fails | Keep usable content, source identity, and any live draft; offer recovery at the affected surface. |
| Source changed or disappeared | Preserve the draft, report the source state, and stop autosave; never silently recreate or overwrite it. |
| Write conflict | Keep local and disk versions for a deliberate decision; the Documents journey owns the user's resolution flow. |
| Outcome unknown | Establish the result before repeating a mutation; an import may require inspecting the refreshed file list. |
| Search update fails after save | Confirm the save and report search lag separately. |

## Document-specific Diff

An agent applies requested document changes directly through StashBase's file
tools: `edit_file` for existing documents and `write_file` for new ones. Editing
an existing empty file may match empty text only while the source is still empty;
ordinary version checks protect concurrent changes. There is no pending-proposal
tool or Accept/Reject workflow. A request to discuss or preview wording before
applying it stays in Chat until the reader authorizes the write.

The reader chooses whether to review the completed turn as described below.
Review is distinct from permission to write; normal runtime permissions still apply.

The selection toolbar leads with a **Heading** menu: Text, Heading 1, Heading 2
and Heading 3, with the selection's current kind checked. A choice turns every
selected block into that kind. Deeper levels and other block types stay in the
slash menu.

**Ask agent**, last on the selection toolbar, binds the exact selection, as
Markdown, to the chat beside the document and brings that chat into view. It writes
nothing and needs no service; the selection is saved first so the agent reads
what the reader selected. A table selection binds the same way from the table's
footer ([Tables](#tables)). [Agent Sessions](agent-sessions.md) owns how the
passage is sent.

Markdown frontmatter is outside the prose editor. A turn review that would change it is
refused with a visible reason; its metadata is never silently omitted from a review.

Markdown math uses double-dollar delimiters or `math` / `latex` fenced blocks.
Single-dollar amounts remain ordinary text in Documents and Chat, including
when a Markdown document is saved. Chat replies also render LaTeX's `\[ \]` and
`\( \)` delimiters, which many models write, outside code. Documents does not
treat them as math.

File diffs, save-conflict comparisons, and agent tool approvals have their own
flows. Other editable formats currently have no inline revision surface.

### Turn Review

After an agent turn changes Markdown files, the conversation shows what changed
in that turn. The summary shows the total file count and added/removed lines
across all files. Each completed turn starts collapsed to at most three files,
with per-file line counts. A bottom **Show N more files** button reveals the
remaining files and becomes **Collapse files**, which restores the three-file
preview. Lists of three or fewer files need no toggle. Nothing opens on its own. An edited file offers **Review**, which opens it with the turn's
changes marked in the prose, against the text the file held before the turn.
Each change has Undo and Keep; Undo all and Keep all resolve the remaining set.
Undo restores the earlier text through the document's ordinary versioned save;
keeping every change leaves the file byte-identical. A created file offers Open,
and a deleted file is only named.

This works the same for every agent runtime and every way a turn writes,
including shell commands, because the host compares the project's Markdown
before the prompt reaches the runtime with what is on disk when the turn ends.
Anything that changed in between is shown as the turn's, including an edit the
reader or another conversation made meanwhile. A file that changed again after
the turn is refused with a visible reason rather than reviewed against newer
text, as is a turn that changed frontmatter. The earlier text is kept in memory
for a bounded number of recent turns and hours; after that, or after a restart,
the review reports that the turn's changes are no longer available. A
conversation reopened from history does not show its earlier turns' changes.

## Related Journeys

[J02](../journeys/README.md#j02-add-and-open-a-folder),
[J03](../journeys/README.md#j03-read-and-edit-source-documents),
[J05](../journeys/README.md#j05-search-and-open-source-evidence),
[J06](../journeys/README.md#j06-start-and-continue-an-agent-chat),
[J07](../journeys/README.md#j07-converge-chat-into-a-document),
[J08](../journeys/README.md#j08-connect-an-external-agent-through-mcp),
[J10](../journeys/README.md#j10-turn-a-local-project-into-durable-agent-assisted-work),
[J12](../journeys/README.md#j12-build-wiki-pages-from-a-local-folder),
[J14](../journeys/README.md#j14-run-a-scheduled-task-in-a-project).

[Documents journey](../journeys/documents.md) owns navigation and conflict choices.
[Source transactions](../../code-review/architecture.md#source-transactions)
and [document trust](../../code-review/architecture.md#document-and-window-trust)
own implementation constraints and known trust limits.
