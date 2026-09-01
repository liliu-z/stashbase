# Overview

StashBase is a Wiki for local files.

People already keep valuable context in folders: notes, documents, research,
media, and the work produced by earlier agents. These files are difficult for
an agent to reuse reliably: some are not readable as text, and finding the
right material depends too much on filenames, paths, and human memory.

The Wiki brings together the user's original Sources, visible source-linked
Wiki Pages, Search, and Agent work. It turns ordinary folders into reusable
knowledge without replacing the files themselves. StashBase keeps Sources in
local files, prepares the formats that need help, and exposes authorized
context through MCP. Local browsing, editing, preview, and Exact Search do not
require a cloud account. When a user explicitly configures hosted Similarity
Search, extracted text may be sent to that provider for indexing or retrieval.
The included Built-in Agent runs locally and sends only prompts and necessary
model context through its hosted model gateway. In both cases the Sources
remain locally owned.

## Product Promise

StashBase makes local knowledge usable by agents without asking people to move
their source of truth into a closed cloud workspace or adopt a new file model.

The core loop is simple:

```text
Choose local folders → build linked Wiki Pages → search or work with an Agent
```

Wiki Pages start at Agent-written `wiki/index.md`, with focused pages beside it
only when useful. Those ordinary visible files enter the same preparation and
search loop, becoming context for later work.

## Who It Is For

StashBase starts with people who already work with local folders and AI agents:
developers, researchers, founders, and knowledge workers who want an agent to
find and use their existing material without repeatedly uploading and
re-explaining it.

## Product Shape

- A VS Code-like **Document Workbench** for browsing, reading, editing, and
  navigating ordinary local files.
- A Codex-like **Agent Panel** whose Chat leads before a document is opened and
  docks beside active source work, with the zero-install Built-in Agent while
  preserving bring-your-own-agent workflows.
- A **Wiki** that brings together Sources, visible source-linked Wiki Pages,
  and a local RAG layer that prepares difficult formats and retrieves
  source-grounded evidence for built-in and external Agents.

For the durable decision rules, see [Principles](principles.md). For the
intended product shape, see [Product Direction](product-direction.md). For the
system contracts, see [Architecture](architecture.md). For current product
areas and contribution opportunities, start at the [design-docs guide](README.md).
