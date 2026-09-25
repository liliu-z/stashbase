# Working in Documents

Read, draft, and revise ordinary project files while keeping other work available.
This journey owns navigation and the user's conflict decisions.
[Project Files](../capabilities/project-files.md) owns format capabilities,
source mutations, saving, and release guarantees.

## Flow

1. Browse Files, Quick Open, a link, or a search result through the same document
   navigation. Reuse an open tab; otherwise open a replaceable preview. A failed
   open preserves the last usable view. Search navigation locates the supported match.
2. Keep a preview or start editing to retain its tab. New draft creates an ordinary
   Markdown file; New tab creates only a starting point. Import copies files into
   the current project and refreshes the list without taking document focus.
3. Read/edit and move between documents, outline, search, and Agent assistance.
   Commands act on the visible surface. Opening a document never attaches it to Chat.
   Review a proposed Markdown revision in the prose, accepting or rejecting each
   change or the remaining set. The Chat card reflects the same review.
   Select prose and choose Humanize to receive Hemmingway-1's rewrite as such a
   proposal; a refusal names its reason and leaves the document as it was.
   Select any Markdown and choose Ask Agent to bind that passage to the chat
   beside the document; the chat pane opens if it was hidden. The pane also
   suggests the document in front, which attaches only on a click.
4. Return to live work with edits, undo, selection, and reading position intact.
   Relaunch restores kept tabs from saved files and reports missing files individually.

Browsing does not wait for a successful save. Closing or leaving dirty work follows
[Saving and Release](../capabilities/project-files.md#saving-and-release).
Background file changes refresh clean views and leave dirty drafts for comparison.

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
[Chat](chat.md) supplies optional Agent assistance; [J03 evidence](../../code-review/journey-coverage.md#j03-documents)
records implementation and validation limits.
