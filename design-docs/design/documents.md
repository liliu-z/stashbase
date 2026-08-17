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

- Recent Markdown tabs retain ready surfaces across common switches; other tabs
  reopen through an explicit loading state. Activating a clean tab observes
  external changes, and failed opens remain identifiable and retryable.
- Markdown uses one Milkdown surface. Writer Mode and Reading View retain the
  same document model while changing the interaction boundary.
- Common Markdown structures, local assets, links, Find, outlines, and search
  navigation work without turning rendered output into source truth.
- A Markdown document may serve as a [Canvas](../glossary.md#canvas): Chat is
  for exploring, while accepted decisions are explicitly written into the
  ordinary source file.
- Valid JSON offers an accessible tree over the exact source text. Source mode
  remains available for malformed, incomplete, duplicate-key, or bounded-out
  content. Structured edits use the shared source-preserving save path rather
  than a second serialized document model.
- When a source changes on disk during an edit, StashBase keeps both versions,
  shows their differences, and waits for the user to reload, overwrite, or
  merge. An unresolved comparison blocks leaving; a merge returns as an
  unsaved draft.
- HTML is viewed as source content; the current compatibility preview executes
  local document scripts in a same-origin iframe. PDF uses its source document
  in the preview surface. DOCX uses a sanitized source-based preview with a
  prepared fallback. Image and media viewers keep source identity while adding
  format-appropriate navigation, playback, or transcript evidence.
- Safe workspace-relative links stay in StashBase. HTTP(S) links use the
  system browser. Markdown, DOCX, and Agent-rendered executable content stays
  inert.

## Format Capability Matrix

This is the canonical product-facing account of Shipping format behavior.
Capabilities are qualified using the [Glossary](../glossary.md#format-capability)
because preview, content editing, retrieval text, and Agent access are not
interchangeable. Exact extension membership is implemented by the shared
cross-process format vocabulary; tests own representative fixtures and
assertions.

| Source family | Extensions | Workbench surface | Workbench authoring | Retrieval text | Agent and MCP file access |
|---|---|---|---|---|---|
| Markdown | `.md`, `.markdown` | Writer Mode and Reading View | New notes and existing sources are content-editable | Direct source text | `read_file`, `write_file`, and `edit_file` use the source text |
| JSON | `.json` | Source-preserving Tree and Source views | Existing sources are content-editable; New Note creates Markdown | Direct source text | `read_file`, `write_file`, and `edit_file` use the source text |
| HTML | `.html`, `.htm` | Compatibility preview | Preview-only in the Workbench | In-memory text derived from the source without durable Preparation | `read_file`, `write_file`, and `edit_file` use raw HTML source |
| PDF | `.pdf` | Source PDF preview | Preview-only | Prepared Markdown | `read_file` returns current prepared Markdown; content writes are rejected |
| Image | `.png`, `.jpg`, `.jpeg`, `.webp` | Source image preview and lightbox | Preview-only; accepted imports create visible image sources | Prepared OCR evidence | Search consumes OCR; external MCP `read_file` does not return image bytes; a built-in Agent may consume an explicitly supplied source image |
| DOCX | `.docx` | Sanitized source-based preview with a prepared fallback | Preview-only | Prepared HTML | `read_file` returns current prepared HTML; content writes are rejected |
| Audio | `.mp3`, `.wav`, `.m4a`, `.flac`, `.ogg`, `.opus`, `.aac`, `.aiff`, `.aif` | Source playback or compatible local audio preview | Preview-only | Prepared timestamped transcript Markdown | `read_file` returns the current transcript; content writes are rejected |
| Video container | `.mp4`, `.mov`, `.m4v`, `.webm`, `.mkv`, `.avi` | Media playback when compatible, otherwise a local audio preview | Preview-only | Audio track prepared as timestamped transcript Markdown | `read_file` returns the current transcript; content writes are rejected |

Rename, move, and delete are file-mutation capabilities over recognized visible
sources; they do not make a preview-only format content-editable. Unsupported
formats remain outside these viewer and content-read paths and must be reported
truthfully rather than opened as lossy text.

## Experience Contract

- A visible source file is always the identity for tabs, links, search results,
  and Agent artifacts.
- Every format exposes only the capabilities in the matrix above. A
  preview-only source never shows a content-editing affordance, and a surface
  must not call prepared text the editable source.
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
- Product copy, Agent tool descriptions, and tests qualify format access by
  surface when Workbench and MCP capabilities differ.

## Known Gaps

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

Journeys: [J03](../user-journeys.md#j03-read-and-edit-source-documents),
[J07](../user-journeys.md#j07-converge-chat-into-a-document), and the
[J10](../user-journeys.md#j10-turn-a-local-project-into-durable-agent-assisted-work)
core loop.

Contracts: [Markdown Rendering](../../code-review/markdown-rendering.md),
[File Transactions](../../code-review/file-transactions.md), and
[Document Viewers](../../code-review/document-viewers.md).
