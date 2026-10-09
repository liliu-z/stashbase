# Project Files

## Scope

Documents, Agent tools, external MCP, and file import operate on ordinary local
files. They share source identity and content-preservation rules; access and
editing capabilities remain explicit for each surface.

## Format Capability Matrix

| Source | Documents mode | Retrieval text | Agent/MCP content access |
|---|---|---|---|
| Markdown | Read/edit; new drafts use Markdown | Source text | Read/write source |
| Plain text | Read/edit valid UTF-8 | Source text | Read/write valid UTF-8 |
| JSON | Source-preserving editing | Source text | Read/write source |
| HTML | Preview only | Extracted in memory | Read/write raw HTML |
| PDF | Source preview | Prepared Markdown | Read prepared text |
| Image | Source preview | Prepared OCR text | Native attachments depend on runtime; MCP does not return image bytes |
| DOCX | Sanitized preview with prepared fallback | Prepared HTML | Read prepared text |
| Audio/video | Playback when supported, otherwise open externally | None | None |
| Generic file | Bounded read-only UTF-8 or explicit unavailable state | None | None |

Playback depends on codecs. Previewability, content editing, file mutation, and
retrieval are independent capabilities. The [glossary](../glossary.md#format-capability)
defines those distinctions; [Project Context](project-context.md) owns preparation.

## Shared Rules and Differences

- Reads, edits, search results, and file links retain project-and-path identity.
  Missing files and invalid encoding never justify substituting another source
  or rewriting bytes lossily.
- Workbench rename/delete applies to ordinary visible files, including generic
  files. Agent/MCP moves and writes require their own authorized capability.
  Protected entries are reveal-only; derived data remains hidden.
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
  a new name. A partial import retries only refused files. Chat attachments are
  temporary context and never become project files merely by being attached.
- Agent writes follow runtime permissions and produce ordinary files, whether
  made through a file tool, a shell command, or a subagent. File refreshes do
  not steal focus or imply a universal accept/reject gate.
- Returning focus to StashBase refreshes the open project's Files tree and
  reconciles external additions, renames, and deletions. Browsing those changes
  does not wait for search indexing, and the refresh preserves open documents.

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

Rename/delete coordinates affected open drafts before mutation and changes their
identities only after confirmation. Cancelling or failing the operation preserves
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

An Agent applies requested document changes directly through StashBase's file
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

**Ask Agent**, last on the selection toolbar, binds the exact selection, as
Markdown, to the chat beside the document and brings that chat into view. It writes
nothing and needs no service; the selection is saved first so the Agent reads
what the reader selected. [Agent Sessions](agent-sessions.md) owns how the
passage is sent.

Markdown frontmatter is outside the prose editor. A turn review that would change it is
refused with a visible reason; its metadata is never silently omitted from a review.

Markdown math uses double-dollar delimiters or `math` / `latex` fenced blocks.
Single-dollar amounts remain ordinary text in Documents and Chat, including
when a Markdown document is saved.

File diffs, save-conflict comparisons, and Agent tool approvals have their own
flows. Other editable formats currently have no inline revision surface.

### Turn Review

After an Agent turn changes Markdown files, the conversation shows what changed
in that turn: each file with its added and removed line counts. Nothing opens on
its own. An edited file offers **Review**, which opens it with the turn's
changes marked in the prose, against the text the file held before the turn.
Each change has Undo and Keep; Undo all and Keep all resolve the remaining set.
Undo restores the earlier text through the document's ordinary versioned save;
keeping every change leaves the file byte-identical. A created file offers Open,
and a deleted file is only named.

This works the same for every Agent runtime and every way a turn writes,
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
[J12](../journeys/README.md#j12-build-wiki-pages-from-a-local-folder).

[Documents journey](../journeys/documents.md) owns navigation and conflict choices.
[Source transactions](../../code-review/architecture.md#source-transactions)
and [document trust](../../code-review/architecture.md#document-and-window-trust)
own implementation constraints and known trust limits.
