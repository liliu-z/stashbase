# User Journeys

Stable Jxx IDs name user outcomes. J01 covers first use; J10 covers the recurring
writing loop. Shared rules live in the linked [capabilities](../README.md#horizontal-designs-capabilities);
[Journey Coverage](../../code-review/journey-coverage.md) records implementation and evidence.

## J01: Complete onboarding and reach first value

### Flow

Enter a project → prepare the selected Agent if needed → discuss an idea → return through Recent.

### Required Results

First value may be discussion in an empty project. No references, wiki, search key, or
file output is required. Local browsing and editing remain available without an account.
Hardware or OS limitations in optional search, extraction, or Agent runtimes must
not prevent application entry on an OS supported by the desktop runtime. Explain
the unavailable capability where it is used; preserve project access and editing.

### Failure and Recovery

Entry and setup failures keep existing files and the unsent idea; recovery resumes the failed stage.

**Capabilities:** [Project Entry](../capabilities/project-entry.md), [Agent Sessions](../capabilities/agent-sessions.md), [Account and Settings](../capabilities/account-settings.md).

**Evidence:** [J01](../../code-review/journey-coverage.md#j01-onboarding).

## J02: Add and open a folder

### Flow

Select or create a folder, or acquire a public GitHub copy → enter → work → optionally
remove registration.

### Required Results

Reach a usable project before optional background work. Keep other windows independent;
removing registration preserves source files and independently registered nested
projects.

### Failure and Recovery

A retained copy survives failed entry. Cancel cleans only owned unfinished work; failed
removal remains recoverable.

**Capabilities:** [Project Entry](../capabilities/project-entry.md), [Project Files](../capabilities/project-files.md).

**Evidence:** [J02](../../code-review/journey-coverage.md#j02-folder).

## J03: Read and edit source documents

### Flow

Open or create a document → read/edit → save → browse other work → return.

### Required Results

The [Documents journey](documents.md) owns navigation and conflict decisions. Source identity, live drafts, and reading/editing state remain available across navigation.

### Failure and Recovery

Resolve save conflicts deliberately; failure blocks releasing dirty work, not browsing.
Relaunch restores saved files, not text lost in a crash.

**Capabilities:** [Project Files](../capabilities/project-files.md).

**Evidence:** [J03](../../code-review/journey-coverage.md#j03-documents).

## J04: Prepare a hard-to-read file

### Flow

Add or open a PDF, DOCX, or image → continue working during preparation → use current
text → reprocess if needed.

### Required Results

Preserve the original and ordinary previews. Distinguish completed preparation from
semantic indexing; only current complete text is evidence.

### Failure and Recovery

Setup/extraction failures remain actionable. Explicit cancellation stays stopped;
interrupted work can recover through its owner.

**Capabilities:** [Project Context](../capabilities/project-context.md).

**Evidence:** [J04](../../code-review/journey-coverage.md#j04-preparation).

## J05: Search and open source evidence

### Flow

Search by keyword or by meaning → inspect results and limitations → open supporting source context.

### Required Results

Use one selected project and identify visible sources. Meaning-based retrieval must find
relevant material beyond literal wording; transport success alone does not establish
quality.

### Failure and Recovery

Distinguish empty, failed, and partial results. Withhold known-stale evidence and repair
the affected provider/preparation/index without blocking local work.

**Capabilities:** [Project Context](../capabilities/project-context.md), [Project Files](../capabilities/project-files.md).

**Evidence:** [J05](../../code-review/journey-coverage.md#j05-search).

## J06: Start and continue an Agent chat

### Flow

Start or restore a chat → send an idea with optional context → inspect replies/actions →
continue or return later.

### Required Results

The [Chat journey](chat.md) owns first-send and conversation interaction. Mode changes preserve sessions and unfinished work. Context and permissions remain explicit.

### Failure and Recovery

Preserve the request through setup failure and partial output through turn failure. Stop
pauses queued work; uncertain delivery cannot trigger automatic replay.

**Capabilities:** [Agent Sessions](../capabilities/agent-sessions.md), [Account and Settings](../capabilities/account-settings.md), [Project Files](../capabilities/project-files.md).

**Evidence:** [J06](../../code-review/journey-coverage.md#j06-agent).

## J07: Converge chat into a document

### Flow

Discuss what to write → request a draft/revision or edit directly → inspect the file →
save → continue the conversation.

### Required Results

Writing creates ordinary local content without stealing document focus. Discussion is
not publication or authorization for unrelated changes. Discussion or a requested
preview stays in Chat until the reader asks to apply it.
A turn's direct Markdown changes can be reviewed in the document on request;
undoing uses ordinary saving and keeping leaves the file as the turn wrote it.

### Failure and Recovery

Retain conversation and drafts after failure. Resolve newer disk content before saving;
an interrupted write cannot claim success.

**Capabilities:** [Agent Sessions](../capabilities/agent-sessions.md), [Project Files](../capabilities/project-files.md).

**Evidence:** [J07](../../code-review/journey-coverage.md#j07-converge).

## J08: Connect an external Agent through MCP

### Flow

Copy connection details from Settings → configure an external MCP client → select a
project → read/search or make authorized edits.

### Required Results

External and built-in operations follow the same source, format, and version rules. Each
request remains within an authorized project; bounded reads identify their extent.

### Failure and Recovery

Configuration, credential, or connection failure cannot broaden access or block the app.
Rotation retires superseded credentials.

**Capabilities:** [Project Context](../capabilities/project-context.md), [Project Files](../capabilities/project-files.md), [Account and Settings](../capabilities/account-settings.md).

**Evidence:** [J08](../../code-review/journey-coverage.md#j08-external-mcp).

## J09: Prepare and hand off a bug report

### Flow

Open reporting from native Help → describe and review artifacts → prepare an
approved snapshot → copy to Downloads → optionally open GitHub.

### Required Results

Preview is not selection. Preparation uses exactly approved inputs; the user completes
submission. Reporting remains available when the main workspace is impaired.

### Failure and Recovery

An unsafe artifact does not discard the rest of the draft. Closing discards temporary
work; completed Downloads copies remain available.

**Capabilities:** [Account and Settings](../capabilities/account-settings.md).

**Evidence:** [J09](../../code-review/journey-coverage.md#j09-bug-report).

## J10: Turn a local project into durable Agent-assisted work

### Flow

Enter a project → brainstorm → consult references when useful → draft/revise → inspect
and save → return later.

### Required Results

Documents and Chat share the project and preserve unfinished work. References and wiki
building are optional; discussion need not produce a file.

### Failure and Recovery

Failures identify their own stage. Optional-service loss does not erase conversation or
block existing files. Complete-loop and writing-quality evidence remain distinct from
component tests.

**Capabilities:** [Project Entry](../capabilities/project-entry.md), [Agent Sessions](../capabilities/agent-sessions.md), [Project Files](../capabilities/project-files.md), [Project Context](../capabilities/project-context.md).

**Evidence:** [J10](../../code-review/journey-coverage.md#j10-core-loop).

## J11: Turn a conversation into a project

**Retired.** StashBase starts conversations inside an open project. There is no
unbound chat, separate persona scope, or conversation migration. The ID stays
reserved so previous review references remain identifiable.

Explicit MCP project creation belongs to J08; opening its result follows J02.

**Capabilities:** [Project Entry](../capabilities/project-entry.md), [Agent Sessions](../capabilities/agent-sessions.md).

**Evidence:** [J11](../../code-review/journey-coverage.md#j11-conversation-to-project).

## J12: Build Wiki Pages from a local folder

### Flow

Draft a Build Wiki request, optionally using Gallery ideas → send explicitly → inspect
pages and source links.

### Required Results

Wiki pages are ordinary requested project files, with no mandatory entry filename or
automatic regeneration. Copying a prompt does not change the persona or authorize
source reorganization.

### Failure and Recovery

Setup failure keeps the request. Partial writes follow ordinary file recovery;
completeness, grounding, and link quality require real-Agent evaluation.

**Capabilities:** [Agent Sessions](../capabilities/agent-sessions.md), [Project Files](../capabilities/project-files.md), [Project Context](../capabilities/project-context.md).

**Evidence:** [J12](../../code-review/journey-coverage.md#j12-build-wiki-pages).

## J13: Download a ready-made Wiki from the Gallery

### Flow

Browse Gallery → inspect the project and generating Prompt → optionally copy the prompt
or make a local project copy → enter.

### Required Results

Browsing requires no project/account. Prompt copying never sends a message or changes
the persona. Use the current catalog entry and shared project-entry rules; a withdrawn
entry cannot still be copied.

### Failure and Recovery

Keep usable offline catalog content and offer retry after loading, screenshot, or
clipboard failure. A registered copy survives failed entry and can be reopened without
downloading again.

**Capabilities:** [Project Entry](../capabilities/project-entry.md).

**Evidence:** [J13](../../code-review/journey-coverage.md#j13-gallery-download).
