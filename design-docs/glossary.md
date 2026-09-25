# Glossary

Shared terms for product copy, design, code review, and tests.

## Naming During Review

Start with the meaning and scope, then inspect the name. Product copy, packaged
personas, and guides use the vocabulary here. Code identifiers may use
established technical terms; renaming a persisted field, protocol, or path
requires checking current readers and writers; historical-data-only compatibility follows
the [maintenance policy](../MAINTENANCE.md#previous-version-data-policy).

## IDE for writing

A local project environment for developing ideas with an Agent and writing
documents. [Overview](overview.md) owns product identity and principles.

## Brainstorming

Exploring ideas or alternatives in Chat, with optional references and no
requirement to produce a file.

## Document

An ordinary user-owned file being read or worked on. It can be reference
material, a draft, or a finished piece; these are roles, not separate storage
types. Format capabilities determine whether its body can be edited.

## Document-specific diff

Inline prose revision with individually reviewable suggestions in Markdown.
It is distinct from file/conflict comparisons and Agent action approval.
See [Project Files](capabilities/project-files.md#document-specific-diff).

## Active-folder workspace

The renderer-owned context for one opened folder: files, tabs, document state,
and retrieval readiness. Use this instead of an ambiguous global/app store.

## Documents and Chat modes

**Documents** centers files and editing; **Chat** centers conversation. They share
a project and retain work across switches. These are application modes, distinct
from Agent permissions and document reading/editing controls.

## Agent Panel

The Agent collaboration capability; **Chat** is its conversation surface.
OpenQuill, Claude, and Codex are runtimes, not names for the capability.

## Passage

Selected document text bound to an Agent request with **Ask Agent**. Its words
are sent with the request; it is not a file attachment or a revision.

## Citation

A reply's link to a passage in a project file, carrying a short quoted phrase
that Documents locates on open. A plain file link is not a citation.

## Persona

Who the Agent is when it talks and writes in a project: one of the packaged
personas, the reader's own **Custom** prompt, or none. StashBase stores the
choice per project and resolves it when a session starts. How the Agent works
belongs to the user-owned `AGENTS.md` / `CLAUDE.md` native instruction files;
a persona is distinct from them, from access control, and from internal routing.

## OpenQuill

The included Agent runtime, named **Default** in the app. It uses StashBase
account access and **free Agent credits**, separate from embedding-provider billing.
OpenQuill remains the external/runtime name; `stashbase` is its implementation
identifier. [Agent Sessions](capabilities/agent-sessions.md) owns selection behavior.

## Search by meaning

Optional project retrieval combining text matching and vector similarity,
returning visible source evidence. It uses the embedding key configured in
Settings. [Project Context](capabilities/project-context.md#retrieval-and-access-differences) owns the opt-in
and default-query behavior.

UI labels are **By keyword / By meaning**; full names are **keyword search /
search by meaning**. Engineering names are **grep / hybrid**. HTTP/MCP may
retain **keyword / semantic** at adapter boundaries. Hybrid is not vector-only
similarity, and its ranking score is not a similarity percentage.

The embedding provider bills search to the key owner. **Free credits** belong
only to OpenQuill; `allowance` is an internal protocol/type term, not search copy.

## Wiki

An optional set of source-linked project pages, maintained through requested
Agent work. It is not the product name or a global search scope.

## Wiki Pages

Ordinary Markdown under `wiki/`, following the project's conventions.
**Build Wiki** requests their creation/improvement; no mandatory entry filename
or automatic regeneration is implied. **Gallery** offers ready-made project copies.

## Canvas

An optional role of a Markdown document holding decisions, alternatives, and
open questions. It is not a separate editor, file type, or automatic Chat summary.

## Document Workbench

The browsing, reading, editing, and navigation capability in Documents mode.

## Preview tab

A temporary tab reused by browsing. Editing makes it a **kept tab**; only kept
tabs restore on relaunch. Do not call it pinned.

## Document history

The sequence of documents visited in a project. It records files, not only
currently open tabs, and can return to a replaced preview.

## Draft

Writing in progress in an ordinary document. A live unsaved draft is distinct
from the saved file; it does not imply durable crash recovery.

## Format capability

The user-observable operations available for one source format. Avoid the
unqualified words `supported`, `readable`, and `writable` when the distinction
matters. Use the narrow capability instead:

- **Previewable** — the visible source opens in a format-appropriate Workbench
  surface.
- **Content-editable** — the source body can be changed through a named surface
  and the shared versioned save boundary.
- **Direct-text readable** — retrieval or an Agent reads useful text from the
  source itself without durable Preparation.
- **Prepared-text readable** — retrieval or an Agent reads only a current
  derived representation produced by Preparation.
- **Agent-readable** — a named built-in or external Agent surface can consume
  the source or its current derived representation. Name the surface when
  built-in attachment and external MCP behavior differ.
- **File-mutable** — the visible source can be renamed, moved, or deleted. This
  does not imply that its contents are editable.
- **Retrieval-eligible** — Search and automatic Chat context may consume direct
  or current prepared text for the source. A muted generic file is explicitly
  not retrieval-eligible even when its bytes can be shown read-only.

See the [format matrix](capabilities/project-files.md#format-capability-matrix).

## Generic workspace file

A visible file without declared retrieval/Agent support. Bounded read-only
inspection may be available; visibility does not make it searchable or Agent-readable.

## Derived data

Rebuildable extraction, preview, index, checkpoint, and status data, hidden from
the workspace. Visible Agent-written documents are not derived data.

## Project

One ordinary local folder, possibly empty, defining working scope and an
independent search namespace. The registry remembers projects and authorization.

Entry actions and project history use **project**. Use **folder** when explaining
directory selection, creation, naming, or storage. Open and Create may share the
system directory picker: Create guides the user to create a folder there and
then open it as a project.

A project's display name is not its identity. Different local directories may
have the same name; alternate paths to the same directory refer to one project.

## Project entry

The user operation of choosing a project and reaching its working environment.
It may start with an existing folder or with making a local copy. Making the
copy and entering the project are separate outcomes.

## Unbound Chat

A conversation without project-file access until binding. Its in-app entry is
unavailable; see [J11](journeys/README.md#j11-turn-a-conversation-into-a-project).

## Local RAG layer

Preparation and retrieval that supply project evidence to Agents. Local refers
to source/data ownership; configured embedding requests may use a hosted provider.

## Preparation

Extraction or OCR that makes a source usable for retrieval or
Agent reading. It is separate from vector-index readiness.

## Product scenario

A high-level reason for using StashBase, such as developing an idea into a report.

## Source

A user-owned file as input to preview, preparation, or retrieval. A draft can
be a source; prepared evidence always resolves back to the file.

## User journey

A user outcome with a stable Jxx ID, flow, required results, and recovery.
[Journey Coverage](../code-review/journey-coverage.md) records its evidence.
