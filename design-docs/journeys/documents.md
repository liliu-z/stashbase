# Working in Documents

Read, draft, and revise ordinary project files while keeping other work available.
This journey owns navigation and the user's conflict decisions.
[Project Files](../capabilities/project-files.md) owns format capabilities,
source mutations, saving, and release guarantees.

## Flow

1. Browse Files, Quick Open, a link, or a search result through the same document
   navigation. Reuse an open tab; otherwise open a replaceable preview. A failed
   open preserves the last usable view. Search navigation locates the supported match.
2. Keep a preview or start editing to retain its tab. New tab offers **Create text
   note**, which opens a blank Markdown file, and **Create interactive note**, which
   opens a usable blank HTML note in its own directory with `index.html` and
   `assets/`. Both create beside the Files selection and offer inline naming.
   New tab itself writes nothing. Import copies files into
   the current project and refreshes the list without taking document focus.
   Desktop files dropped on Files are imported; dropped on the document pane or the
   chat beside it, even with no document open, each opens where it is as an
   [external file](../capabilities/project-files.md#external-files), in a tab of its
   own, without copying.
3. Read/edit and move between documents, outline, search, and agent assistance.
   Commands act on the visible surface. Opening a document never attaches it to Chat.
   Dropping a desktop file there is the reader handing it over, so it attaches to
   the chat beside the document without opening that pane; the attachment leaves
   the draft when the file's tab closes.
   From an agent turn's changes in Chat, review what that turn changed in a
   document, undoing or keeping each change or the remaining set.
   Select prose and choose a Heading menu entry to turn the selected blocks into
   text or a heading.
   Select any Markdown and choose Ask agent to bind that passage to the chat
   beside the document; the chat pane opens if it was hidden. Cells, rows, or
   columns selected in a CSV or XLSX table bind the same way, with their sheet
   and range. The pane also suggests the document in front, which attaches only on a click.
4. Return to live work with edits, undo, selection, and reading position intact.
   Relaunch restores kept tabs from saved files and reports missing files individually.

Browsing does not wait for a successful save. Closing or leaving dirty work follows
[Saving and Release](../capabilities/project-files.md#saving-and-release).
Background file changes refresh clean views and leave dirty drafts for comparison.
The visible document follows external edits while it stays open and catches up
when the reader returns to the window, without requiring a tab switch.
HTML previews also follow changes to local scripts and stylesheets referenced
directly by the page, including a dashboard's separate data script.
The newer page loads behind the one on screen and replaces it once its data
has loaded, at the same scroll position. A brief **Updated** status confirms
the change. A replacement that is slow to load shows **Updating** instead.
[HTML forms](../capabilities/project-files.md#html-forms) retain their live view,
save their JSON data automatically, and share that draft with its source editor;
code changes reload the form at once.

## Conflict Decisions

Keep both versions until the user chooses:

| Choice | Result |
|---|---|
| Use disk version | Deliberately discard local changes and adopt the reviewed disk version. |
| Keep my version | Replace that reviewed version; another disk change requires a new comparison. |
| Merge | Edit a separate merge draft; resume autosave only after explicit completion against the reviewed version. |

Unresolved conflict blocks cannot be published as a finished merge. Navigating
away retains the unfinished merge. Another disk change returns to comparison
without discarding the merge draft.

## Failure and Return

Keep failures attached to their document or operation while other documents remain
usable. A failed preview keeps the source identifiable; save failure keeps the
draft; a missing source is not silently recreated. A draft whose source file is
gone stops autosaving and says so; restoring the file is the reader's explicit choice,
and closing, quitting, or leaving the project asks before discarding the draft.
Deletion requires an explicit choice to remove files, distinct from closing tabs. Shared mutation/unknown-outcome
recovery belongs to [Project Files](../capabilities/project-files.md#failure-and-recovery).

## Related Journeys

[J03](README.md#j03-read-and-edit-source-documents),
[J05](README.md#j05-search-and-open-source-evidence),
[J07](README.md#j07-converge-chat-into-a-document).
[Chat](chat.md) supplies optional agent assistance; [J03 evidence](../../code-review/journey-coverage.md#j03-documents)
records implementation and validation limits.
