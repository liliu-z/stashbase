# StashBase: Product and Mental Model

This guide describes the durable product model behind StashBase. It is written
for Agents answering product questions as well as people who want the detail.
It reflects Shipping behavior as of 2026-08-31.

## The Short Answer

StashBase is a Wiki for local files.

People already keep valuable context in ordinary folders: notes, papers,
contracts, project data, scanned documents, recordings, and work produced by
earlier Agents. StashBase works with those folders in place, builds visible
source-linked Wiki Pages, prepares formats that need help, and retrieves
relevant evidence for built-in or external Agents.

The folders remain the source of truth. StashBase does not require a second
proprietary workspace or a new file model.

```text
Sources ────────────────→ Document Workbench
   ├→ Build Wiki → Wiki Pages ───────────────────┐
   └→ Prepare → Exact / Similarity Search ───────┴→ Agents
```

## Who It Is For

StashBase starts with people who already use local folders and AI Agents:
developers, researchers, founders, students, and knowledge workers who want an
Agent to discover and reuse existing material without repeatedly uploading and
re-explaining it.

Typical uses include:

- taking an engineering project from requirements to delivery;
- combining papers, slides, recordings, experiments, and notes for research;
- turning a personal archive into reusable long-term Agent context;
- working with Markdown, JSON, documents, images, and media in one local
  project;
- beginning with a Library conversation and creating an ordinary project only
  when the idea becomes worth keeping.

## The Wiki and Three Product Capabilities

The Wiki brings together **Sources**, visible source-linked **Wiki Pages**,
Search, and Agent work. Wiki Pages begin at `wiki/index.md`, with optional
focused pages beside it. Similarity Search adds meaning-based retrieval without
becoming a second knowledge store.

### Document Workbench

Browse, open, navigate, and—where the format allows—edit ordinary source files.
The Files sidebar, persistent tabs, Quick Open, Find, outlines, and
format-specific viewers keep source work in the same workspace as Chat.

### Local RAG Layer

Preparation turns hard-to-read formats into current derived text. Exact Search
finds matching words without additional setup. Similarity Search finds related
meaning even when the wording differs. Search evidence always resolves back to
the visible Source.

"Local" describes ownership of source files, derived state, and index
lifecycle. A configured hosted Similarity Search may process extracted text outside the
computer; that choice must remain explicit.

### Agent Panel

The built-in Chat runs a supported Claude Code or Codex runtime against an
explicit Library or folder scope. The same authorized Library can also be used
by external MCP clients. StashBase is context infrastructure shared by Agents,
not a closed StashBase-only Agent service.

## The Core Concepts

### Library

The Library is the set of local folders the user has explicitly added or
opened. Member folders may live anywhere on disk. Search and Library-scoped
Agent work may cover all members; a user can narrow them to one folder.

### Current folder

One window may have one current folder. It owns that window's file tree,
editable documents, and folder-specific navigation. Multiple windows can use
different current folders while sharing the same Library.

### Chat scope

Every built-in conversation is scoped to the whole Library or one member
folder. Once a draft, attachment, turn, or restored conversation has started,
switching the window's current folder does not silently rebind that Chat.

### Source

A Source is the user-owned, visible, authoritative original file on disk. Tabs,
links, search results, and Agent artifacts resolve to this identity.

### Derived data

Extracted text, OCR, transcripts, compatible previews, indexes, checkpoints,
and readiness records are rebuildable support data. They stay outside the
visible workspace and never become replacement source files.

### Preparation

Preparation is the format-specific work that makes PDF, DOCX, images, audio,
and video useful as search or Agent context. It is separate from Similarity Search
readiness. A file may be previewable before its derived text is ready.

### Similarity Search

Similarity Search is optional meaning-based retrieval across Sources and Wiki
Pages. It can use hosted StashBase capacity after sign-in or a user-provided
OpenAI/OpenRouter key. Exact Search and ordinary local file work do not require
it.

### Wiki Pages

Build Wiki is the explicit folder-level action that asks the selected
Agent to create or improve `wiki/index.md` and focused pages under `wiki/`.
These are ordinary user-owned Markdown files. The action links to Sources and
modifies only `wiki/`; moving, renaming, deleting, or broadly rewriting Sources
requires a separate explicit decision.

### Canvas

A Canvas is an ordinary Markdown document used to hold accepted project state:
confirmed decisions, current conclusions, open questions, and next steps. It is
not a special file type or an automatic transcript summary. Chat can branch and
explore; only conclusions explicitly written to a source file become durable
project state.

## Ownership and Privacy

| Item | Owner | Meaning |
|---|---|---|
| Local folders and source files | User | They remain ordinary files and the source of truth. |
| Prepared text, previews, indexes, and status | StashBase | Rebuildable application-owned state outside the workspace. |
| StashBase account session and Similarity Search credentials | StashBase Settings | Used only for the selected provider. |
| Claude Code or Codex credentials and history | The selected Agent runtime | Separate from StashBase sign-in and Similarity Search configuration. |
| Wiki Pages and other Agent-created source files | User after an explicit write | Visible ordinary files that re-enter browsing, search, and future Agent work. |

Local browsing, preview, editing, Preparation, and Exact Search do not require
a cloud account. When hosted Similarity Search is selected, extracted text may
be sent to that provider for indexing and retrieval. When an Agent is used, the
context it reads is handled according to that Agent provider's account and
data terms.

StashBase MCP tools remain bounded to Library folders. Built-in coding Agents
can also propose commands, network access, deletion, or broader filesystem
access through their own runtime; those remain explicit permission decisions
rather than hidden expansion of the Library boundary.

## What StashBase Is Not

- It is not a database-first or block-first knowledge base.
- It is not a replacement for ordinary folders, Git, or an existing Markdown
  vault.
- It is not a general web browser, Word-compatible editor, or media editor.
- It does not expose generated chunks, transcripts, or vector records as files
  the user must organize.
- It does not ask an Agent to reorganize files autonomously in the background.
- It does not require a knowledge graph, tagging discipline, proprietary Wiki
  format, or one preferred Agent.
- Its MCP tools are not a general-purpose host filesystem API.

## What Makes Work Durable

A conversation is useful exploration but is not the lasting project model.
Durable work ends in a reviewed ordinary file. That file can later be opened,
searched, linked, edited by another tool, or used as context by another Agent
without depending on the original conversation or StashBase-specific storage.
