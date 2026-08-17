# Product Direction

StashBase is evolving toward three connected capabilities:

> A VS Code-like Document Workbench, a Codex-like Agent Panel, and a local
> RAG layer for document retrieval.

## AI-native Product Scope

StashBase is not constrained to one isolated AI feature. Its value comes from
continuous assistance across an existing local-file workflow: more formats
become understandable, evidence becomes easier to retrieve, Agents receive
stable context, and accepted results return to ordinary files. Adding breadth
is consistent with the product when the new capability deepens this same
environment and reuses its source identity, library scope, permission, and
recovery model.

The limiting resource is product coherence, not generated code. A new format,
provider, or Agent may extend an existing capability without adding a new user
concept. A second knowledge store, document model, authorization world, or
unrelated work surface changes the product model and requires explicit
direction before implementation.

## Document Workbench

StashBase should provide a workbench for browsing, reading, editing, navigating,
and organizing documents across ordinary local folders. Like a code workbench,
it uses a file tree, persistent tabs, quick navigation, and format-appropriate
surfaces, but it remains centered on documents rather than code. It works with
the user's existing files without replacing them with a database, block editor,
or proprietary storage model.

## Agent Panel

The built-in Agent Panel works against an explicit library or folder scope.
Before a document is opened, Chat is the primary working surface; once a
document appears, the same Chat adapts into a side panel alongside the source.
It is a convenient client of StashBase context, not a separate AI workspace
and not a replacement for external Agent clients.

Work may begin before a project exists. When an exploratory Library Chat
becomes worth continuing, the user can explicitly turn it into an ordinary
local project. The same conversation follows the new scope; project files
receive only content deliberately written from the conversation.

## Local RAG Layer

Opened folders become retrievable context. The local RAG layer prepares
difficult formats, supports exact and meaning-based retrieval, and delivers
source-grounded evidence to Agents. It should explain readiness and failures
clearly without becoming a search or vector-database administration console.

Code repositories give Agents strong lexical structure through paths, symbols,
imports, and stable identifiers, so iterative grep and file reads can often
locate relevant code without a persistent semantic index. Document libraries
are less predictable: a question may not share the wording of its sources, and
evidence may span long-form files, OCR, or transcripts. StashBase therefore
treats preparation, a persistent meaning-based index, and source-grounded
retrieval as one first-class RAG layer instead of relying on exact terms alone.

### AI Index activation

StashBase should strongly recommend meaning-based indexing because document
libraries often need it, while keeping no-index mode a supported local state.
Hosted service and bring-your-own-key sources are choices, not gates to local
files. Browsing, editing, preview, exact retrieval, and an existing local index
must remain usable through authentication, provider, network, or quota failure.

This document owns that durable choice. Shipping setup timing and recovery live
in [Search and Retrieval](design/search.md),
[J01](user-journeys.md#j01-complete-onboarding-and-reach-first-value), and
[J05](user-journeys.md#j05-search-and-open-source-evidence). Credential and
runtime invariants live in
[Settings and Config](../code-review/settings-config.md) and
[Data Lifecycle](../code-review/data-lifecycle.md).

## Current Investment Themes

The current direction favours contributions that improve:

- Markdown authoring and preview fidelity.
- The clarity and reliability of preparation, indexing, and retrieval.
- The usability and safety of the Agent Panel.
- The Document Workbench's everyday reading and maintenance workflows.
- Cross-platform reliability and an approachable contributor experience.

These themes guide prioritisation; they are not release commitments. Area-level
work and its status live in the [design documents](README.md).
