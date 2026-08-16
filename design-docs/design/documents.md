# Documents

## User Outcome

People can read, inspect, edit, and navigate supported local source files while
the source remains the durable object shared with other tools and Agents.

## Scope and Non-goals

This area owns document tabs and format-appropriate reading or editing
experiences. Together with the Workspace area, it forms the Document
Workbench. It includes Markdown, source-authoritative JSON, HTML, PDF, DOCX,
images, audio, and supported video containers. Preparation and indexing are
separate areas.

StashBase is not an unrestricted browser, a script host, a pixel-perfect Word
editor, a media editor, or a proprietary document format.

## Current Experience

- The five most-recently-used open Markdown tabs retain their ready document
  surfaces while inactive, so common switches reveal the existing document
  without a blank initialization frame. Reopening an evicted tab shows its
  opening state, and activating a clean tab refreshes external changes from
  disk. A document that is still opening or failed to open shows an explicit,
  recoverable status instead of an empty editor shell.
- Markdown uses one Milkdown surface. Writer Mode and Reading View retain the
  same document model while changing the interaction boundary.
- CommonMark, GFM, frontmatter preservation, alerts, LaTeX, local images,
  links, Find, anchors, search highlights, and a sidebar heading outline work
  without turning generated HTML into source truth.
- A Markdown document may serve as a [Canvas](../glossary.md#canvas): Chat is
  for exploring, while accepted decisions are explicitly written into the
  ordinary source file.
- Valid strict JSON opens as a searchable, keyboard-accessible tree by default;
  Source mode exposes the exact live text. Explicit editing enables scalar,
  key, property, array, and validated raw-subtree operations that patch source
  spans without serializing the document. Invalid, incomplete, empty,
  duplicate-key, or bounded-out JSON explains why Tree mode is unavailable and
  remains editable and saveable as source. Saving preserves BOM, line endings,
  untouched whitespace, escapes, order, numeric lexemes, and trailing newline.
- Valid CSV opens in an interactive, virtualized Table view by default;
  Source mode exposes the exact raw text. Explicit editing enables in-cell edits,
  row insertions, row deletions, and rectangular paste that patch minimal source
  spans without serializing the document. Invalid or bounded-out CSV explains
  why Table mode is unavailable and remains editable and saveable as source.
  Saving preserves BOM, line endings, delimiters, quotes, leading zeros, and
  ragged rows.
- HTML is viewed as source content; the current compatibility preview executes
  local document scripts in a same-origin iframe. PDF uses its source document
  in the native preview surface with page, zoom, fit, and session position
  controls. DOCX uses a sanitized source-based preview with a prepared
  fallback. Images use the shared lightbox. Audio and supported video
  containers expose playback and synchronized transcript evidence when
  available.
- Safe workspace-relative links stay in StashBase. HTTP(S) links use the
  system browser. Markdown, DOCX, and Agent-rendered executable content stays
  inert.

## Experience Contract

- A visible source file is always the identity for tabs, links, search results,
  and Agent artifacts.
- Editable documents use the shared save/version path. An external-write
  conflict never silently overwrites either the dirty buffer or newer disk
  content.
- Reading and editing mode changes preserve selection, history, navigation,
  and unsaved content.
- Parsing or preview failure keeps the source identity visible and offers a
  truthful recovery path.
- A structured JSON view is a controller over source text, never a second
  document model or persistence path.
- Rendering untrusted document content never grants application privileges or
  loads arbitrary remote resources.

## Known Gaps

- The renderer currently retries a version-conflicted editor save without its
  base version, so a concurrent external or Agent write can be overwritten.
  Required recovery and the missing regression are owned by
  [File Transactions](../../code-review/file-transactions.md#known-gap--renderer-conflict-recovery).
- Executable local HTML and its remote subresources currently have a weaker
  boundary than the experience contract. The compatibility tradeoff and
  required confinement work are owned by
  [Document Viewers](../../code-review/document-viewers.md#trust-boundary).

## Cross-area Seams

- [Workspace](workspace.md) owns tabs, file operations, and window durability.
- [Preparation](preparation.md) owns derived text used by search and Agents.
- [Search](search.md) owns result evidence and navigation into a document.
- [Agent Panel](agent-panel.md) owns Agent response Markdown, which is a
  separate renderer from source-document Markdown.

## Contribution Direction

### Next

- Improve narrow layouts, large tables, image captions, and large-document
  continuity.
- Improve navigation continuity among outlines, anchors, Find, and search.
- Improve format-specific fallback and accessibility without hiding source
  identity.

### Coordinate First

- Schema, serializer, local asset, raw HTML, or link-handling changes.
- Save/version semantics or a new editable source format.
- Executable content, remote resource loading, or trust-boundary changes.

### Not Planned

- Replacing Markdown or JSON with a managed document model.
- Treating generated representations as user-managed source files.
- Turning preview into a general web or media editing environment.

## Related Journeys and Contracts

Journeys: [J03](../user-journeys.md#j03-read-and-edit-source-documents) and
[J07](../user-journeys.md#j07-converge-chat-into-a-document).

Contracts: [Markdown Rendering](../../code-review/markdown-rendering.md),
[File Transactions](../../code-review/file-transactions.md), and
[Document Viewers](../../code-review/document-viewers.md).
