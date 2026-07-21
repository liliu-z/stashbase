# Document Indexing

Product design for StashBase's Cursor-like document indexing.

## User-Facing Surfaces

- [Implemented] Search panel.
- [Implemented] Preparation and failure states in file previews.
- [Implemented] Search view summarizes library readiness.
- [Implemented] Welcome / folder list can show lightweight folder-level failure markers.
- [Implemented] Settings exposes embedding and MCP configuration.
- [Implemented] Manual Sync / Reindex entry points exist.
- [Implemented] Agent Panel and external MCP clients use the same index.
- [Planned] Readiness, partial indexing, and failure states can become clearer.

## Supported Inputs

- [Implemented] Markdown reads and indexes the source file directly.
- [Implemented] HTML remains the visible source object and extracts text for indexing.
- [Implemented] PDF shows the original PDF and produces agent-readable / searchable Markdown.
- [Implemented] DOCX shows a readable preview and produces agent-readable / searchable HTML/text.
- [Implemented] Images show the original image and use OCR to produce searchable text.
- [Implemented] Derived text is app-owned state and does not appear as normal user files.
- [Implemented] Search results always point back to the user-visible source file.

## Convert / Preparation

- [Implemented] After a folder is opened or added, StashBase detects files that need conversion.
- [Implemented] PDFs, DOCX files, and images can prepare in the background.
- [Implemented] When a user opens a file, visible preview is prioritized.
- [Implemented] DOCX visible preview does not depend on durable background preparation completing first.
- [Implemented] If conversion fails, the source file can still be opened.
- [Implemented] Conversion failures can be shown to users.
- [Implemented] Users can reprocess / retry failed files.
- [Implemented] Background preparation prioritizes explicit interaction and currently opened folders.
- [Implemented] Stale or incomplete derived text must not be treated as current truth.
- [Planned] Conversion failure, recovery, and diagnostics entry points can become easier to understand.
- [Planned] PDF / OCR fallback choices can become clearer.
- [Planned] More granular conversion progress can be exposed.

## Index

- [Implemented] Index identity is the user-visible source file.
- [Implemented] Semantic search is supported when embeddings are configured.
- [Implemented] Keyword search is supported.
- [Implemented] Without an embedding key, semantic search is disabled while keyword search and basic file workflows still work.
- [Implemented] Added, changed, and deleted files can update through reconcile.
- [Implemented] External changes can be brought into search through reindex / sync.
- [Implemented] Conversion completion and semantic indexing completion are separate states.
- [Planned] Index diagnostics and repair affordances can become clearer.
- [Planned] Ranking controls can be added later.

## Search Panel

- [Implemented] Search box supports natural-language queries.
- [Implemented] Keyword search is supported.
- [Implemented] Semantic search is supported.
- [Implemented] In-app search defaults to the current folder.
- [Implemented] Results show file, path, and snippet.
- [Implemented] PDF results can include page hints.
- [Implemented] Clicking a result opens the source file.
- [Implemented] Opening a result should locate the relevant snippet or page when possible.
- [Implemented] Search view shows the impact of incomplete preparation on results.
- [Implemented] Search panel supports subfolder scope narrowing.
- [Implemented] Search panel supports file-type filters.
- [Planned] Results can expose clearer score, rank, grouping, and sort options.
- [Planned] Saved search scopes can be added.
- [Planned] Empty, partial, indexing, and failure states can be more explainable.

## MCP Retrieval

- [Implemented] MCP provides library orientation.
- [Implemented] MCP supports library search.
- [Implemented] MCP search can narrow by folder or path prefix.
- [Implemented] MCP supports reading files.
- [Implemented] MCP supports reindex.
- [Implemented] MCP supports bounded write / edit / move / delete file operations.
- [Implemented] MCP file operations are limited to folders the user has opened or authorized.
- [Implemented] MCP reads for PDF / DOCX can map to agent-readable derived text.
- [Implemented] MCP file helpers hide app-maintained derived artifacts.
- [Implemented] Claude Code, Codex CLI, and Claude Desktop can use one-click MCP setup.
- [Implemented] HTTP MCP requires a bearer token.
- [Implemented] Docker-access MCP is explicit opt-in.
- [Planned] MCP / context diagnostics inside the Agent Panel can become clearer.

## Result Semantics

- [Implemented] Markdown / HTML hits come from source file text and open the source file.
- [Implemented] PDF hits come from derived Markdown but open the original PDF.
- [Implemented] Image hits come from OCR text but open the original image.
- [Implemented] DOCX hits come from derived HTML/text but open the original DOCX.
- [Implemented] Derived text can be evidence, but it is not a file users manage.
- [Implemented] Search results should avoid implying that StashBase rewrites original files.

## Not In Scope

- [Not planned] General search administration console.
- [Not planned] Exposing vector stores, chunks, or embeddings as ordinary user concepts.
- [Not planned] Requiring users to manually manage derived artifacts.
- [Not planned] Making semantic search a prerequisite for browsing files or using the basic workflow.
