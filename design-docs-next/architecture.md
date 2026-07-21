# Architecture

This document records StashBase's high-level system design.

It documents stable system models, boundaries, and invariants. It should not mirror the source tree or explain every file, module, function, route, hook, or component. Source code remains the source of truth for implementation details.

## Core Flow

StashBase's core path:

```text
Local files -> Convert -> Index -> Retrieve -> MCP -> Agents
```

- The user chooses local folders.
- StashBase reads source files from those folders.
- Formats that are hard for agents to use directly are converted.
- Source text or converted text is added to keyword and semantic indexes.
- Retrieval is exposed through app search and MCP.
- Agents can read, search, and write files within the user's authorized scope.

## File Ownership

- Local source files are the source of truth.
- User-visible files belong to the user, including `AGENTS.md` and `CLAUDE.md`.
- Derived text, vector indexes, and preparation state are StashBase-owned app state.
- Derived state can be deleted and rebuilt. It should not become something users need to manage as normal files.
- Search results and UI open targets should point back to user-visible source files.

## Library And Scope

- One installation has one local library.
- The library is made of folders the user has opened or added.
- One window primarily works inside one current folder.
- In-app search defaults to the current folder.
- MCP search can address the whole library and can narrow by folder or path prefix.
- Permission boundaries are based on folders the user has opened or authorized.

## Format Model

- Markdown: read, preview, edit, and index the source file directly.
- HTML: keep the source file visible; extract text for indexing.
- PDF: preview the original PDF; use derived Markdown for agent reading and search.
- DOCX: show a readable preview from the source file; use derived HTML/text for agent reading and search.
- Images: preview the original image; use OCR text as search evidence.

Design implications:

- Keep the source file visible and understandable.
- Introduce derived representations only when agent reading or search needs them.
- Do not expose derived representations as normal user-managed files.

## Conversion And Indexing

- Conversion and indexing are separate stages.
- Conversion completion is not the same as semantic indexing completion.
- Without an embedding key, semantic search is disabled; browsing, preview, editing, and keyword search should still work.
- External file changes need reconcile, sync, or reindex before the index reflects disk state.
- Stale, partial, or incomplete derived text must not be treated as current truth.

## Retrieval

- Retrieval serves both app search and agent context.
- Keyword search supports exact matching and no-embedding scenarios.
- Semantic search supports meaning-based context lookup.
- Search result identity is the source file.
- Derived text can be search evidence, but it does not change the file the user sees and opens.

## MCP Boundary

- MCP is StashBase's context interface for external agents.
- MCP provides library orientation, search, read, reindex, and bounded file operations.
- MCP file helpers are not a general host filesystem.
- MCP can only access folders the user has opened or authorized.
- External agent clients and the built-in Agent Panel use the same library and MCP context.

## Built-In Agent Panel

- The built-in Agent Panel is a convenience client for the same context infrastructure.
- It should not own a separate data path.
- It runs the user's installed or configured agent and works inside the current folder.
- The built-in Agent Panel should not replace the bring-your-own-agent model.

## Correctness And Recovery

- Opening a folder should enter usable UI first; preparation can continue in the background.
- Background conversion and indexing should not block ordinary file browsing.
- Failure states should appear where the user needs to make a decision.
- Retry and reprocess should clear stale failure state and prepare the current source file again.
- Deleting or removing folders must clearly separate user files from app-owned state.

## Architecture Docs Boundary

- This document does not maintain source directory documentation.
- It does not record every module, route, component, hook, or function responsibility.
- If implementation details change, source code is authoritative.
- If system boundaries, data ownership, permission models, or user-visible behavior change, update this document or the relevant `design/` document.
