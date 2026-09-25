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
- Hidden-file visibility changes browsing only. It neither widens tool/search
  access nor discards open edits.
- Project import creates source files; same-name imports keep both copies using
  a new name. A partial import retries only refused files. Chat attachments are
  temporary context and never become project files merely by being attached.
- Agent writes follow runtime permissions and produce ordinary files, whether
  made through a file tool, a shell command, or a subagent. File refreshes do
  not steal focus or imply a universal accept/reject gate.

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

An Agent can propose a revision to an existing Markdown document without writing
it. The reader sees deletions struck through and additions highlighted in the
document's prose. Each change has Accept and Reject; Accept all and Reject all
resolve the remaining set. The conversation names the document and shows the
same remaining count and whole-set actions as the document.

The proposal is temporary document state. Rejecting every change leaves the
source byte-identical. Accepting changes edits the live document and uses its
ordinary versioned save path. A proposal against an older source version is
refused after a fresh source check; a proposal handed to a window is consumed once, and failed pickup is
reported rather than silently retried. A new proposal cannot replace a review
already open on that document.

An Agent proposes a revision when it changes a few sentences to a few paragraphs
of prose in an existing Markdown document. It writes directly for a new file, a
draft it created in the same conversation, a rewrite of most of a document, one
change repeated across many files, frontmatter, a file that is not Markdown, or
a mechanical change such as a rename or a link update. The reader's stated
preference wins either way, and a refused proposal is reported rather than
written directly. This is standing guidance to the Agent, not a gate: the
runtime's permissions still decide what a write needs.

The selection toolbar leads with a **Heading** menu: Text, Heading 1, Heading 2
and Heading 3, with the selection's current kind checked. A choice turns every
selected block into that kind. Deeper levels and other block types stay in the
slash menu.

The reader can also ask for a rewrite from the document itself. **Humanize** on
the selection toolbar sends the selected prose to Hemmingway-1 through a
StashBase-run service and opens the rewrite as the same review; nothing is
written until a change is accepted. The selection widens to the whole
paragraphs, headings, quotes or lists it touches, up to about 1,000 words;
code, tables, images and raw HTML are refused rather than rewritten. The
rewrite is refused when the document changed while it ran, when the service
cut it short, or when it changes nothing, and a busy or unavailable service
leaves the document as it was. Humanize needs no account today and is free for
a limited time; the service meters by network address, not by account.

**Ask Agent** on the same toolbar binds the exact selection, as Markdown, to
the chat beside the document and brings that chat into view. It writes
nothing and needs no service; the selection is saved first so the Agent reads
what the reader selected. [Agent Sessions](agent-sessions.md) owns how the
passage is sent.

Markdown frontmatter is outside the prose editor. A proposal that changes it is
refused with a visible reason; its metadata is never silently omitted from a review.

File diffs, save-conflict comparisons, and Agent tool approvals have their own
flows. Other editable formats currently have no inline revision surface.

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
