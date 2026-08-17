# Search and Retrieval

## User Outcome

People and Agents can find relevant evidence across authorized local folders
and return to the user-visible source that supports it.

## Scope and Non-goals

This area owns exact and meaning-based retrieval, result presentation,
readiness explanations, scope, and source-evidence identity. Together with
Preparation, it forms the local RAG layer. It does not own source preparation,
general file navigation, or Agent conversation UI.

StashBase does not expose a vector-store console or generated chunks as
user-managed results.

## Current Experience

- Exact text search works without AI Index over the direct source or current
  prepared representation declared by the
  [Documents format matrix](documents.md#format-capability-matrix), including
  raw JSON and current prepared text. Whole-token search applies its result cap
  after token filtering, so substring-heavy files do not hide later eligible
  evidence.
- AI Index provides meaning-based retrieval when an embedding source is
  configured. Product copy says **AI Index**; engineering terms such as
  semantic indexing and embeddings appear only where technically necessary.
- AI Index setup offers hosted account access as the primary path and
  OpenAI/OpenRouter keys as an advanced path. The active source remains
  explicit, and browser sign-in returns to the initiating window or offers a
  deliberate app-return action.
- The search popup searches the whole library by default and can narrow to one
  member folder. It remembers query, mode, options, scope, and results across
  close, reopen, and folder switches, then refreshes against current content.
- MCP retrieval mirrors the popup: semantic search defaults to the whole
  library, while MCP keyword search requires a member folder or a path prefix
  whose owning member can be derived. Both narrow by folder root and path
  prefix; MCP additionally narrows by source file-type categories.
- Exact and Similar modes share one query surface. Results preserve rank while
  grouping evidence by folder when needed.
- A result always identifies a source file. Evidence may come from PDF, DOCX,
  OCR, or transcript text, but opening it never exposes AppData. Cross-folder
  results open read-only without unexpectedly switching an active folder.
- Readiness distinguishes disabled, preparing, partial, paused, failed, and
  ready states. Exact search remains usable while AI Index is absent or
  deferred.
- AI Index setup is strongly recommended but never gates local browsing,
  editing, preview, or exact search. Activation persists, while a deliberate
  skip is local to the current window context and remains reversible. The
  observable setup sequence lives in
  [J01](../user-journeys.md#j01-complete-onboarding-and-reach-first-value).
- Hosted indexing and meaning-based queries draw from one token allowance.
  The account menu shows identity, remaining percentage, and reset date. When
  the allowance is exhausted, hosted semantic work stops while Exact search
  and every local-file workflow remain available. Pending semantic work
  resumes after the allowance refreshes or an available BYOK source is
  selected.
- In-app and MCP retrieval share source identity and access rules. MCP also
  supports validated source-type categories.

## Experience Contract

- Missing results can be explained by scope, mode, preparation, indexing, or
  provider state; those states must not collapse into one generic empty view.
- Known-stale semantic evidence is unavailable before a paused large workload
  is presented. Current indexed files may still provide partial results.
- Result scope never widens silently, and a derived path never crosses the
  product boundary.
- Previewability alone never claims retrievable text. Each result comes from a
  direct-text or current prepared-text capability and resolves to the visible
  source.
- BYOK credentials are managed through Settings. Account login starts only
  from an explicit Sign in action in setup, Settings, or the account menu.
  Browsing local files and serving an existing local index never depends on
  online authentication.
- Account and credential ownership remains outside renderer and indexing
  presentation. Persistence and process-boundary invariants live in
  [Settings and Config](../../code-review/settings-config.md).
- MCP is context infrastructure over authorized folders, not a general host
  filesystem interface.

## Cross-area Seams

- [Preparation](preparation.md) owns the currency of derived evidence.
- [Documents](documents.md) owns navigation after a result opens.
- [Workspace](workspace.md) owns member folders and out-of-folder tabs.
- [Agent Panel](agent-panel.md) consumes the same retrieval through MCP.

## Contribution Direction

### Next

- Clarify modes, partial readiness, paused work, and errors.
- Report library-wide readiness rather than only the active folder.
- Improve ranking, snippets, source navigation, and useful filters.
- Improve MCP and context diagnostics.

### Coordinate First

- Source identity, scope, access control, indexing, embeddings, or reconcile.
- New MCP capabilities that expose or mutate user data.

### Not Planned

- Requiring AI Index for the basic local workflow.
- A chunk or vector administration surface for ordinary users.
- Generated artifacts as normal files or result identities.

## Related Journeys and Contracts

Journeys: [J01](../user-journeys.md#j01-complete-onboarding-and-reach-first-value),
[J05](../user-journeys.md#j05-search-and-open-source-evidence), and
[J08](../user-journeys.md#j08-connect-an-external-agent-through-mcp). The
end-to-end route is the
[J10](../user-journeys.md#j10-turn-a-local-project-into-durable-agent-assisted-work)
core loop.

Contracts: [Data Lifecycle](../../code-review/data-lifecycle.md),
[Renderer Workspace](../../code-review/renderer-workspace.md),
[Settings and Config](../../code-review/settings-config.md), and
[MCP Access](../../code-review/mcp-access.md).
