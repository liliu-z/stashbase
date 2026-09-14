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

- Keyword search works without any setup over the direct Source or current
  prepared representation declared by the
  [Documents format matrix](documents.md#format-capability-matrix), including
  raw JSON, valid UTF-8 plain text, and current prepared text. Plain-text files
  with unsupported encodings are excluded from exact and semantic evidence
  rather than decoded lossily. Whole-token search applies its result cap
  after token filtering, so substring-heavy files do not hide later eligible
  evidence.
- With an embedding key added under Settings, retrieval can also search by
  meaning. It is off until then, and nothing outside Settings names it before
  it is on. Product copy keeps the phrase lowercase; engineering terms such as
  semantic indexing and embeddings appear only where technically necessary.
- A failed meaning-based search reports its error instead of returning an
  empty match list. Slow indexing or meaning-based searches leave capacity
  for status requests; keyword search remains independent.
- Agent retrieval combines meaning-based similarity with text matching for
  every Chat whose folder has a key on, and uses text matching alone
  otherwise, including current prepared PDF, DOCX, image, and media
  text. The strategy is per lookup and never pauses background Preparation or
  semantic indexing.
- Turning search by meaning on is one action: adding an OpenAI or OpenRouter
  key under **Settings → Search by Meaning**, billed to the person who adds
  it. There is no hosted source and no account path; the StashBase account
  buys OpenQuill's credits and nothing for search. Removing the key turns
  search by meaning off again and keeps keyword search.
- Library search is a panel in the sidebar, reached from its navigator tab or
  a keyboard shortcut. Both modes are folder-explicit. They search the active
  folder, and a match outside it is not offered. The panel keeps its query and
  mode while another panel is on screen and across folder switches, then
  refreshes results against current content.
- MCP retrieval uses one `search_library` operation across the whole library
  for Library Chats and external clients. In an attributed folder Chat it
  defaults to that Chat's folder; global search requires an explicit request
  (`scope: "library"`). Empty results do not automatically broaden scope.
  Meaning-based and text-only strategies share the same visible
  source-hit shape and may both narrow by folder root, path prefix, and source
  file-type categories. An attributed panel Chat's own retrieval policy
  resolves the operation's strategy without asking the Agent to select a
  different tool.
- Search is keyword search alone until a key is on: one field, no mode
  chooser, and nothing that names the other mode. Once a key is on, the **By
  keyword** and **By meaning** modes share one query surface. Results
  preserve rank while grouping evidence by folder when needed.
- A result always identifies a source file. Evidence may come from PDF, DOCX,
  OCR, or transcript text, but opening it never exposes AppData, and opening
  one never switches the active folder.
- Readiness distinguishes preparing, partial, paused, failed, and ready
  states once a key is on; before that the search panel says nothing about
  search by meaning at all. Keyword search remains usable throughout.
- Nothing offers the setup. A window with no folder open stays quiet, a
  folder that resolves stays quiet, and the search panel carries no route into
  Settings for a mode it does not show. Settings is the one place search by
  meaning is turned on, and Build Wiki
  ([J12](../user-journeys.md#j12-build-wiki-pages-from-a-local-folder)) never
  opens or waits for it. The observable path lives in
  [J05](../user-journeys.md#j05-search-and-open-source-evidence).
- Deferring a large first index build for one folder leaves the key in place
  and shows that folder as paused; **Not now** there is about that folder's
  build, never about the key.
- Semantic runtime refreshes after key changes remain background work.
  Overlapping refresh and folder-removal activity does not interrupt local
  browsing or surface native process errors as user actions.
- Meaning-based indexing and queries are billed by the key's provider to the
  person who added the key. StashBase shows no quota for search; **credits**
  names OpenQuill's free quota and nothing about search.
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
- Searching by meaning is a use-time retrieval choice. Turning it off must
  neither make prepared documents unreadable nor stop, remove, or foreground
  the background semantic-index lifecycle.
- The embedding key is managed only through Settings. Signing in to the
  StashBase account is not a search action and never changes the source.
  Browsing local files and serving an existing local index never depends on
  online authentication.
- No surface outside Settings offers, names, or explains search by meaning
  while it is off. A person who wants it finds it where the other
  bring-your-own capabilities live, and the mode appears the moment the key
  is on.
- Account and credential ownership remains outside renderer and indexing
  presentation. Persistence and process-boundary invariants live in
  [Settings and Config](../../code-review/settings-config.md).
- MCP is context infrastructure over authorized folders, not a general host
  filesystem interface.

## Known Gaps

- In-app search no longer reaches the whole library. Both modes are bound to
  the active folder, with no scope control, while
  [J05](../user-journeys.md#j05-search-and-open-source-evidence) and the
  [J10](../user-journeys.md#j10-turn-a-local-project-into-durable-agent-assisted-work)
  core loop describe finding evidence across authorized folders. MCP retrieval
  still defaults to the whole library, so a person's reach is now narrower
  than an Agent's.
- The server still resolves a signed-in account session to a hosted
  embedding source of its own when no key is stored, may index with it in the
  background, and still accepts that source and an embedding-purpose sign-in
  on its routes. The renderer treats that source as not set up, so nothing on
  screen offers or names it, but hosted indexing can still run and spend the
  account's search quota until the server side of this change lands.
  [Settings and Config](../../code-review/settings-config.md) records the
  server follow-ups.

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

- Requiring search by meaning for the basic local workflow.
- A hosted source for search by meaning, or a sign-in that turns it on.
- Offering search by meaning unprompted, on any surface.
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
