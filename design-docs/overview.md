# Overview

StashBase turns local files into Agent-ready context.

People already keep valuable context in folders: notes, documents, research,
media, and the work produced by earlier agents. These files are difficult for
an agent to reuse reliably: some are not readable as text, and finding the
right material depends too much on filenames, paths, and human memory.

StashBase keeps source ownership in local files, prepares the formats that need
help, indexes them, and exposes authorized context through MCP. Local browsing,
editing, preview, and exact retrieval do not require a cloud account. When a
user explicitly selects hosted AI Index, extracted text may be sent to that
provider for indexing or retrieval; the source files remain locally owned.

## Product Promise

StashBase makes local knowledge usable by agents without asking people to move
their source of truth into a closed cloud workspace or adopt a new file model.

The core loop is simple:

```text
Choose local folders → make files readable → index them → retrieve them in an Agent
```

Agent-written files can enter that same loop, becoming context for later work.

## Who It Is For

StashBase starts with people who already work with local folders and AI agents:
developers, researchers, founders, and knowledge workers who want an agent to
find and use their existing material without repeatedly uploading and
re-explaining it.

## Product Shape

- A VS Code-like **Document Workbench** for browsing, reading, editing, and
  navigating ordinary local files.
- A Codex-like **Agent Panel** whose Chat leads before a document is opened and
  docks beside active source work, while complementing bring-your-own-agent
  workflows.
- A **local RAG layer** that prepares difficult formats and retrieves
  source-grounded evidence for built-in and external Agents.

For the durable decision rules, see [Principles](principles.md). For the
intended product shape, see [Product Direction](product-direction.md). For the
system contracts, see [Architecture](architecture.md). For current product
areas and contribution opportunities, start at the [design-docs guide](README.md).
