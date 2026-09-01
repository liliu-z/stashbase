# FAQ and Comparisons

These answers are intended to help an Agent give a direct, fair explanation of
StashBase. Comparisons are a snapshot dated 2026-08-25 because other products
change. When current product details matter, check the official vendor and the
latest StashBase FAQ rather than presenting this snapshot as timeless fact.

Current online FAQ: <https://stashbase.ai/docs/faq/>

## Quick Fit Guide

| Option | Strong fit | Source/context model | StashBase difference |
|---|---|---|---|
| Direct Claude Code or Codex access | Known files, code symbols, and task execution | The Agent reads the working directory directly | StashBase adds mixed-format Preparation, discovery across a Library, source-grounded retrieval, and context shared across Agents |
| NotebookLM | A bounded notebook, grounded answers, and Audio Overviews | Sources are added to a Google notebook | StashBase keeps existing folders as the Library, supports ordinary-file writeback, and is Agent-agnostic |
| Obsidian | Human-authored Markdown, links, and vault navigation | A local Markdown-first vault | StashBase can use the same vault while adding built-in retrieval, MCP, bounded Agent operations, and prepared non-Markdown evidence |
| AI project uploads | A small, disposable context set | Copies are added to one AI conversation or project | StashBase is for a long-lived local Library whose current source files serve several Agents |
| Spotlight, Everything, or text search | A known filename or wording | Local metadata or lexical lookup | StashBase adds format Preparation, Similarity Search, visible evidence, and Agent access |
| Vector database or RAG framework | Building a custom application | Developer-owned ingestion and retrieval infrastructure | StashBase supplies the end-user workbench, lifecycle, permissions, recovery, and MCP boundary |
| LLM wiki or knowledge graph | A chosen way to organize knowledge | A structured representation created in files or another system | StashBase brings Sources, source-linked Wiki Pages, and Similarity Search together without requiring a graph or proprietary store |

## Claude Code and Codex Already Read Files. Why Would I Need StashBase?

For a known code repository, you may not need it. Code has stable identifiers:
filenames, symbols, imports, and references. A coding Agent can often use normal
filesystem access and lexical search effectively, and `AGENTS.md` can point it
to documents already known to matter.

Document discovery is different. The same idea may be expressed with different
words, useful evidence may be hidden among hundreds of files, and PDF, DOCX,
images, audio, or video may need Preparation before an Agent can search their
contents. `AGENTS.md` can identify known important files; it does not discover
which unfamiliar source is relevant to today's question.

StashBase adds that document workbench and retrieval layer. It prepares
heterogeneous formats, offers Exact Search and Similarity Search, preserves visible
source identity, and gives multiple Agents one authorized Library. Use direct
Agent filesystem access when paths are known and the collection is simple; use
StashBase when discovery, prepared evidence, or reuse across Agents matters.

## Does Similarity Search Add Latency or Block My Work?

New or changed material takes time to prepare for Similarity Search, but that
work does not sit in front of ordinary file work. Similarity Search preparation
runs incrementally in the background.
Browsing, preview, editing, Preparation, direct Agent file reads where
available, and Exact Search continue without waiting for Similarity Search.

Similarity Search becomes useful as current content is prepared. Until then,
use Exact Search or read known files directly. Paused or failed Similarity
Search preparation must not turn the local workspace into a blocked state.

## What Does Similarity Search Cost?

Current StashBase builds offer a hosted monthly allowance after sign-in.
Hosted indexing and Similarity Search queries share it, and the account menu shows the
remaining percentage and reset date. When it runs out, Exact Search and every
ordinary local workflow keep working.

Users may instead add an OpenAI or OpenRouter key. Pricing and data-handling
terms belong to that provider and can change; check the provider before quoting
a current cost. Exact Search requires neither hosted capacity nor a personal
key.

## Does StashBase Upload My Files?

StashBase does not move source files into a hosted StashBase workspace. The
folders remain on disk, and locally owned prepared data and indexes are
rebuildable from them.

Optional online choices still matter:

- hosted or bring-your-own Similarity Search may send extracted text to the
  selected provider;
- Claude Code, Codex, or another Agent may send context it reads to its own
  provider according to that provider's terms;
- local browsing, preview, editing, Preparation, transcription, and Exact
  Search do not require those hosted paths.

"Local-first" therefore describes source ownership and the always-available
local workflow; it does not mean that every optional Agent or Similarity Search request
is offline.

## Is StashBase an LLM Wiki or Knowledge Graph?

StashBase is a Wiki for local files. It brings together Sources, visible
source-linked Wiki Pages, Search, and Agent work. Build Wiki asks an
Agent to organize Sources into `wiki/index.md` and optional focused pages
without replacing or reorganizing the original files. Similarity Search may
independently make the same Sources and Wiki Pages retrievable by meaning.

It does not require a generated knowledge graph, a proprietary Wiki format, or
a new storage foundation. Existing Markdown vaults, code-and-doc projects, and
plain folders use the same source ownership, Preparation, retrieval, scope, and
Agent access model.

## How Is StashBase Different from NotebookLM?

NotebookLM is strong for a bounded collection of sources placed into a
notebook, grounded answers with citations, and features such as Audio
Overviews. For a self-contained project that a user is happy to maintain in
that product, it can be the more polished fit. StashBase does not have an Audio
Overviews equivalent in this snapshot.

The architectural difference is the source of truth. In NotebookLM's common
workflow, sources are added to a per-notebook collection. StashBase treats the
existing local folders themselves as the Library: source files stay in place,
the index is derived, and saving a file where it already belongs is enough for
it to re-enter the workflow.

The Agent model also differs. NotebookLM is a Google/Gemini product experience.
StashBase is Agent-agnostic context infrastructure for Claude, Codex, and other
MCP clients over one authorized Library. Prefer NotebookLM for its dedicated
notebook experience and unique generated outputs; prefer StashBase when local
folder ownership, writeback to ordinary files, or reuse across Agents is the
priority.

Comparison snapshot: 2026-08-25.

## Why Not Obsidian?

Obsidian is an excellent human-first personal knowledge base, especially for a
Markdown vault, linking, and its plugin ecosystem. A person who already lives
in Obsidian does not need to migrate away from it: the same vault is an
ordinary local folder that can also become a StashBase Library member.

StashBase's center of gravity is different. Agent retrieval, MCP access,
bounded file operations, Preparation, and search across non-Markdown sources
are built into the product model rather than added as a note-taking plugin.
StashBase also treats PDF, DOCX, images, recordings, JSON, HTML, and Markdown as
one heterogeneous document library, while preserving their different preview,
editing, retrieval, and Agent capabilities.

Use Obsidian when the primary job is human-authored Markdown notes and linked
knowledge navigation. Add StashBase when Agents need reusable discovery and
bounded access across that vault or a broader mixed-format Library.

Comparison snapshot: 2026-08-25.

## How Is This Different from Uploading Files to an AI Project?

Uploading selected files to a Chat or project is often the simplest choice for
a small, bounded task. The tradeoff is maintaining another collection and
refreshing it when the local source changes.

StashBase is designed for a long-lived Library. The local file remains the one
source, Preparation and indexing follow current bytes, and several built-in or
external Agents can use the same authorization boundary. Use uploads for a
small disposable context set; use StashBase when the collection should stay in
place and remain reusable.

This is a category-level comparison. Individual AI products change their
upload, sync, retention, and connector behavior frequently.

## How Is This Different from Spotlight, Everything, or Text Search?

System search and lexical tools are excellent when the filename or wording is
known. They may be faster and simpler than StashBase for that job.

StashBase combines exact retrieval with format Preparation, meaning-based
discovery, source-grounded results, and Agent access. It is useful when the
question and source use different words, when useful text is inside PDF,
images, DOCX, or media, or when the result needs to enter an Agent workflow.

## How Is This Different from a Vector Database or RAG Framework?

A vector database or RAG framework is infrastructure for developers. It
usually leaves ingestion, file watching, source identity, access control,
format conversion, user interface, writeback, and recovery to the application
builder.

StashBase is the end-user document workbench and lifecycle around that
infrastructure. It owns the ordinary-folder Library, Preparation, Exact and
Similarity Search, visible-source mapping, bounded MCP access, and built-in Chat.
Use a framework when building a custom application; use StashBase when the
desired application is an Agent-ready local document Library.

## Is StashBase a Replacement for My Current Organization System?

No. Existing folders, Git repositories, Markdown vaults, naming conventions,
and wikis remain valid. StashBase is designed to make them more discoverable
and usable by Agents without imposing another required organization model.

An Agent may organize or write files only as part of work the user directs and
approves. StashBase does not autonomously restructure the Library in the
background. Adding or opening a folder does not create instruction files. Use
**Agent Instructions** in the Chat tab toolbar for guidance that StashBase
stores outside the folder; existing `AGENTS.md` and `CLAUDE.md` files remain
ordinary user-owned files.

## When Do I Probably Not Need StashBase?

- The relevant files are few, known, and already easy for the chosen Agent to
  read directly.
- The task is one-off and uploading a bounded copy is acceptable.
- The main need is only filename or exact-text search.
- The main product desired is a human note editor, graph navigator, generated
  podcast, cloud drive, or custom developer RAG stack.

StashBase is most differentiated when a long-lived, heterogeneous local
document collection needs discovery, preparation, shared Agent access, and
durable writeback without changing its source of truth.

## Is StashBase Open Source?

Yes. StashBase is Apache-2.0 licensed and the application source is available
at <https://github.com/liliu-z/stashbase>. As of this snapshot it is early
alpha, with primary macOS Apple Silicon and Windows x64 support and a
community-supported Linux x86_64 build.
