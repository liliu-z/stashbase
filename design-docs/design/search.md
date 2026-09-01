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

- Exact Search works without Similarity Search over the direct Source or current
  prepared representation declared by the
  [Documents format matrix](documents.md#format-capability-matrix), including
  raw JSON, valid UTF-8 plain text, and current prepared text. Plain-text files
  with unsupported encodings are excluded from exact and semantic evidence
  rather than decoded lossily. Whole-token search applies its result cap
  after token filtering, so substring-heavy files do not hide later eligible
  evidence.
- Similarity Search provides meaning-based retrieval when an embedding source
  is configured. Product copy says **Similarity Search**; engineering terms
  such as semantic indexing and embeddings appear only where technically
  necessary.
- Chat exposes one product-owned **Similarity Search** control. On lets Agent
  retrieval combine vector similarity with text matching. Off uses text
  matching only, including current prepared PDF, DOCX, image, and media text.
  It changes retrieval for that Chat; it never pauses background Preparation
  or semantic indexing.
- Similarity Search setup offers hosted account access as the primary path and
  OpenAI/OpenRouter keys as an advanced path. The active source remains
  explicit, and browser sign-in returns to the initiating window or offers a
  deliberate app-return action. Upgrades retire a previously selected local
  source before indexing starts: a signed-in account takes priority, then a
  stored BYOK credential, otherwise Similarity Search returns to not set up.
- The search popup searches the whole library by default and can narrow to one
  member folder. It remembers query, mode, options, scope, and results across
  close, reopen, and folder switches, then refreshes against current content.
- MCP retrieval uses one `search_library` operation across the whole library
  by default. Meaning-based and text-only strategies share the same visible
  source-hit shape and may both narrow by folder root, path prefix, and source
  file-type categories. An attributed panel Chat's Similarity Search choice
  resolves the operation's strategy without asking the Agent to select a
  different tool.
- Exact and Similarity modes share one query surface. Results preserve rank
  while grouping evidence by folder when needed.
- A result always identifies a source file. Evidence may come from PDF, DOCX,
  OCR, or transcript text, but opening it never exposes AppData. Cross-folder
  results open read-only without unexpectedly switching an active folder.
- Readiness distinguishes disabled, preparing, partial, paused, failed, and
  ready states. Exact Search remains usable while Similarity Search is absent
  or deferred.
- Similarity Search setup is strongly recommended but never gates local browsing, editing,
  preview, Exact Search, or building Wiki Pages. An empty Library stays
  quiet; the first activated folder offers setup once. Completing it or
  choosing **Not now** is remembered across folders and relaunches, while
  Similarity Search, the persistent Files-panel **Set up** action, and Settings
  remain explicit routes back. Build Wiki never opens or waits for
  Similarity Search setup. The
  observable activation paths live
  in [J01](../user-journeys.md#j01-complete-onboarding-and-reach-first-value)
  and [J12](../user-journeys.md#j12-build-wiki-pages-from-a-local-folder).
- Semantic runtime refreshes after account, quota, or key changes remain
  background work. Overlapping refresh and folder-removal activity does not
  interrupt local browsing or surface native process errors as user actions.
- Hosted indexing and meaning-based queries draw from one token allowance.
  The account menu and Similarity Search Settings show the provider display
  name and avatar when available, retain the full email for account identification, and
  share deterministic fallbacks. They also show remaining percentage and reset
  date. When the allowance is exhausted, hosted semantic work stops while
  Exact Search and every local-file workflow remain available. Pending
  semantic work resumes after the allowance refreshes or an available BYOK
  source is selected.
- In-app and MCP retrieval share source identity and access rules. MCP also
  supports validated source-type categories.
- Representative semantic retrieval quality is measured by a versioned,
  synthetic corpus with paraphrased queries. It is credentialed release
  evidence rather than deterministic source-CI evidence.

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
- Similarity Search is a use-time retrieval choice. Turning it off must neither
  make prepared documents unreadable nor stop, remove, or foreground the
  background semantic-index lifecycle.
- BYOK credentials and account source selection are managed through Settings.
  Account login starts only from an explicit Sign in action in first-folder or
  Similarity Search setup, Settings, or the account menu.
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

- Requiring Similarity Search for the basic local workflow.
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
