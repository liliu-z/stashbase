# Glossary

Use these terms consistently in product copy, design docs, review contracts,
and tests. Implementation identifiers may retain established names when a
rename would not improve the user-facing model.

## Active-folder workspace

The renderer-owned working context for one currently opened local folder:
visible files, tabs, document durability, retrieval readiness, and refresh
lifecycle. It excludes shell presentation and Agent conversation state.

Avoid: `global store`, `app state` when this narrower meaning is intended.

## Agent Panel

The built-in Agent capability for working against an explicit library or
folder scope. **Chat** is the Agent Panel's visible conversation surface: it
leads before a document is opened and docks beside the Document Workbench when
a source is active. The Agent Panel may run Claude or Codex; it is not itself
synonymous with either runtime.

## AI Index

The user-facing name for the optional meaning-based index within the local RAG
layer. It enables semantic retrieval when an embedding source is configured,
but it is not the whole RAG layer: preparation and exact retrieval remain
useful without it. Use `semantic indexing`, `semantic retrieval`, and
`embedding` only in engineering contracts or a disclosure that needs the
technical mechanism.

## Canvas

A role played by a normal user-visible Markdown document that holds the
accepted state of long-running human-Agent work: confirmed decisions, live
alternatives, open questions, and next focus. Conversation may branch, but only
conclusions explicitly written back become part of the Canvas.

Canvas is not a separate file type, editor, automatic transcript summary, or
whiteboard.

## Document Workbench

The product capability for browsing, reading, editing, navigating, and
organizing documents across ordinary local folders. It combines the Workspace
and Documents product areas. A **workspace** may still name the current window
or folder context; it is not a competing name for the whole capability.

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

Creating a new text source, importing a binary source, previewing it, editing
its contents, and mutating its file identity are separate capabilities. The
canonical Shipping matrix lives in the
[Documents area](design/documents.md#format-capability-matrix).

## Derived data

Rebuildable text, assets, indexes, checkpoints, and status records that
StashBase creates from source files. Derived data stays outside the visible
workspace and never replaces source-file identity.

## Library

The set of local folders the user has authorized in one StashBase
installation. Search and MCP retrieval default to the library and may narrow
to a member folder or path.

## Local RAG layer

The product capability that turns authorized local documents into
source-grounded Agent context. It combines Preparation with exact and
meaning-based retrieval. **Local** describes ownership of sources, derived
state, and index lifecycle; configured embedding capacity may be hosted.

AI Index is the optional meaning-based index inside this layer, not a synonym
for the whole layer.

## Preparation

Format-specific work that makes a source usable for search or Agent reading,
such as PDF extraction, image OCR, DOCX text derivation, or media
transcription. Preparation and AI Index readiness are separate states.

## Product scenario

A durable, high-level reason someone uses StashBase. A scenario explains
motivation and desired outcome; it does not prescribe screens or test steps.

## Source file

The user-owned file that remains visible, openable, and authoritative. Search
evidence and Agent-readable derived text always resolve back to this identity.

## User journey

A stable, observable shipping workflow identified by `Jxx`. Journeys connect
product behavior to coverage without duplicating exact test setup or
assertions.
