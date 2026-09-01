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
a source is active. The Agent Panel may run Built-in, Claude Code, or
Codex; it is not itself synonymous with any runtime.

## Agent Instructions

The one StashBase-owned Agent prompt. A plain-language packaged default applies
to every Chat. A concrete working folder may customize it in application
metadata; Library-wide Chats use the packaged default and have no Library-wide
customization. Runtime Adapters inject the resolved text verbatim and do not
prepend or append another StashBase prompt. Saving remounts matching folder
Chats so it applies from their next message. It is guidance, not a security
boundary.

`AGENTS.md`, `CLAUDE.md`, and other runtime-native instruction files remain
ordinary user-owned runtime inputs. StashBase neither creates nor rewrites
them, and does not call those files Agent Instructions in product UI.

## Built-in

The included zero-install Agent shown as **Built-in** in Agent pickers and Chat
chrome, with **Sign in for free credits** under its picker label while signed
out and **Free credits included** after sign-in. It uses
StashBase's pinned local OpenCode runtime and the signed-in account allowance.
`stashbase` remains its implementation identifier.

## Similarity Search

The user-facing name for optional meaning-based retrieval across the Wiki.
When an embedding source is configured, it combines vector similarity with
text matching and always returns evidence through a visible Source. Exact
Search remains available without it.

A Chat's **Similarity Search** control decides whether that Chat uses the
capability. Turning it off keeps retrieval text-only; it does not pause or
delete background search data. Describe background work as preparing or
updating files for Similarity Search. Use `semantic indexing`, `semantic
retrieval`, `vector`, and `embedding` only in engineering contracts or a
disclosure that needs the technical mechanism.

## Wiki

The product-level knowledge space StashBase presents over the Library. A Wiki
brings together user-owned **Sources**, visible source-linked **Wiki Pages**,
Exact Search, Similarity Search, and Agent work without replacing the folders
as source of truth. It is not a separate hosted knowledge store.

## Wiki Pages

Visible Markdown under a folder's `wiki/` directory, with `wiki/index.md` as
the entry page and optional focused pages beside it. Wiki Pages organize and
explain Sources through relative links. They are ordinary user-owned files,
not hidden StashBase derived data, and they re-enter browsing, search, and
future Agent work.

Use **Build Wiki** for the explicit folder-scoped action that asks an
Agent to create or improve these pages from Sources. The action never grants
permission to move, rename, delete, or broadly rewrite Sources.

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
- **Retrieval-eligible** — Search and automatic Chat context may consume direct
  or current prepared text for the source. A muted generic file is explicitly
  not retrieval-eligible even when its bytes can be shown read-only.

Creating a new text source, importing a binary source, previewing it, editing
its contents, and mutating its file identity are separate capabilities. The
canonical Shipping matrix lives in the
[Documents area](design/documents.md#format-capability-matrix).

## Generic workspace file

An ordinary file visible in the active-folder tree that has no declared
retrieval format. Selection may inspect it as bounded strict UTF-8 text or show
an explicit unavailable placeholder, but it remains outside Search, automatic
Chat context, Preparation, and Agent/MCP file access. The muted tree treatment
communicates this capability boundary; it does not mean the file is missing.

## Derived data

Rebuildable text, assets, indexes, checkpoints, and status records that
StashBase creates from source files. Derived data stays outside the visible
workspace and never replaces source-file identity. Do not use this term for
visible, user-owned Wiki Pages.

## Library

The set of local folders the user has authorized in one StashBase
installation. Search and MCP retrieval default to the library and may narrow
to a member folder or path.

## Local RAG layer

The product capability that turns authorized local documents into
source-grounded Agent context. It combines Preparation with exact and
meaning-based retrieval. **Local** describes ownership of sources, derived
state, and index lifecycle; configured embedding capacity may be hosted.

Similarity Search is the optional meaning-based retrieval capability inside
this layer, not a synonym for the whole layer.

## Preparation

Format-specific work that makes a source usable for search or Agent reading,
such as PDF extraction, image OCR, DOCX text derivation, or media
transcription. Preparation and Similarity Search readiness are separate states.

## Product scenario

A durable, high-level reason someone uses StashBase. A scenario explains
motivation and desired outcome; it does not prescribe screens or test steps.

## Source

An original user-owned file that remains visible, openable, and authoritative.
Product headings and controls may use **Source** or **Sources**; explanatory
prose may say source file. Search evidence, prepared text, and Wiki Pages
always resolve or link back to this identity.

## User journey

A stable, observable shipping workflow identified by `Jxx`. Journeys connect
product behavior to coverage without duplicating exact test setup or
assertions.
