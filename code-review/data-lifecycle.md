# Data Lifecycle

> Correctness and liveness contract for preparation, indexing, reconcile, and
> AppData-owned derived state. Source mutation transactions live in
> [File Transactions](file-transactions.md).

## State Ownership

| State | Owner | Truth rule |
|---|---|---|
| Source files and Agent instruction files | User filesystem | Durable source of truth |
| Library membership, credentials, preferences | App config | Durable product configuration |
| Prepared text and assets | AppData | Rebuildable; valid only for the current source |
| Preparation failures and explicit cancellation | AppData state database | Durable attention and user intent |
| Queued, yielded, and running work | Process-wide scheduler | Disposable; reconcile must rediscover loss |
| Semantic rows | Python daemon / Milvus Lite | Rebuildable; daemon status owns semantic readiness |
| Renderer readiness snapshots | Renderer memory | Explanatory only; never completion truth |

## Format Completion

- Markdown, HTML, and JSON use source-owned text paths. JSON validity is not an
  admission gate and JSON never joins note bundles or legacy-derived hiding.
- Image OCR is complete only when current, searchable derived text carries its
  completion marker. Empty OCR is a failure, not success.
- PDF text is complete only when current derived Markdown has the terminal
  completion marker. Batch scratch is resumable work, never truth.
- Durable DOCX text is complete only when current sanitized derived HTML has
  extractable text and its marker. The direct renderer preview has no durable
  completion state and does not wait for this path.
- Media preparation requires both validated structured transcript JSON and
  timestamped Markdown with the terminal marker. Chunk checkpoints and the
  lazy compatible playback preview never establish transcript completion.
- Conversion completion is independent of semantic indexing. Current prepared
  text can serve exact retrieval while semantic indexing is disabled, pending,
  paused, or failed.

## Scheduler and Cancellation

- One process-wide scheduler owns light, heavy, and auxiliary classification
  capacity. Format modules provide work and cost; they do not own private
  queues.
- Ordering is explicit interaction, any open-folder work, then library
  background work. Background aging may rise only to open-folder urgency.
  Running tasks are not preempted except for the explicit same-source media
  preview handoff.
- Work identity retains the filesystem spelling used for I/O and display while
  a separate platform-aware comparison identity handles deduplication and
  subtree matching.
- Cooperative yield is allowed only at a durable work-unit boundary. It keeps
  task identity and completion promise while releasing capacity; partial
  output remains incomplete.
- User Cancel is durable and blocks rediscovery until Reprocess. Shutdown,
  source mutation, folder removal, or native failure are typed transient
  interruptions unless their owner explicitly records a failure.
- Cancelling native work owns the descendant process tree and waits for
  process/output-handle retirement before reporting the task released.

## Reconcile

Reconcile is folder-explicit and is the only operation that catches storage up
with disk reality. It runs after server boot, folder entry, visible idle
library maintenance, focus return, manual Sync, MCP reindex, Agent turn
completion, and relevant configuration changes.

For one folder it must:

- discover added, changed, moved, and deleted sources;
- validate current format-specific derived output;
- preserve durable failure or cancellation gates;
- schedule missing work without blocking navigation;
- add, update, reuse, or remove semantic rows by content identity;
- hide unavailable or orphaned evidence from retrieval.

No-op reconcile spends no embedding work. Without an embedding source it still
maintains prepared text and exact retrieval.

Adding or removing a BYOK key, signing in or out, or explicitly switching the
embedding source resets and rebinds the single daemon so stale runtime
credentials cannot survive. Compatible vectors remain reusable. Hosted index
and query calls carry distinct purpose labels but consume one quota ledger;
quota exhaustion disables only hosted semantic work and never exact retrieval.
The availability gate is checked before and between embedding calls so one
quota response stops the remainder of a batch. Pending work remains
reconcilable and resumes after a quota refresh/reset or an available source
switch.

Large semantic workloads use the same authoritative content-hash diff. Known
stale rows become unavailable before a durable awaiting/paused decision is
published. A pause never delays browsing, preparation, editing, or exact
search; only explicit Start clears it.

## Freshness and Visibility

- Format dispatch must preserve the product capability classes in the
  [Documents matrix](../design-docs/design/documents.md#format-capability-matrix).
  Direct-text sources remain usable without durable Preparation; prepared-text
  sources become readable only through current, format-owned output; a
  preview-only surface never changes either classification.
- A newly queued source invalidates stale final output immediately, then the
  extractor repeats cleanup at execution.
- Content-addressed prepared output carries the source hash into the indexing
  handoff. Old derived text cannot be rebound to replacement bytes.
- Daemon mutation acknowledgements are visibility barriers: after a completed
  delete or move, immediate status/search cannot observe rows reported removed.
- Process readiness is a configured barrier, not merely a child-process event:
  current admission rules and every retained folder binding are acknowledged
  before a public daemon operation can run after initial spawn or respawn.
- An existing local collection may reopen without an embedding credential for
  list/delete cleanup. Store deletion failures propagate across the daemon
  boundary; they are never converted into a successful zero-row result.
- Retrieval filters unavailable sources and always remaps evidence to a live
  visible source before it crosses HTTP or MCP.
- Exact retrieval applies whole-token filtering before its per-file result cap;
  raw substring density cannot hide later eligible evidence.
- Local Milvus collect-all reads use a complete scalar snapshot. Segment order
  cannot be treated as a globally ordered primary-key cursor.
- Closing or failing to open the store releases the client, shared pymilvus
  connection, and local Milvus server before cleanup returns.

## Cleanup and Recovery

- Library removal cancels all work under the member root, removes index rows,
  derived artifacts, preparation records, ordering, runtime bindings, and
  membership, but never deletes the user folder. A process-local removal intent
  rejects concurrent reopen/register attempts, and durable membership is
  removed last so an interrupted cleanup remains recoverable by reconcile.
- Source delete removes its derived text, manifests, resumable work, playback
  preview, attention rows, and index rows.
- Move/rename retires the old source identity. Direct text may reuse index
  content; prepared formats clean old ownership and prepare under the new path.
- Reprocess validates optional dependencies before destructive reset, clears
  stale final output and attention, and queues interactive work. Media manual
  retry clears inference checkpoints but may retain a current model-independent
  playback preview.
- A missing native helper, model, or optional state store degrades to warning,
  blocked, or retryable status. It never blocks source browsing.
- A source development runtime prefers the repository's live Python environment
  and helper scripts even when Electron serves a built renderer without Vite.
  Packaged launches instead resolve only their explicit bundled runtime paths.
- Startup recovery runs only after the process owns the server port, preventing
  a losing startup contender from deleting the active owner's temporary work.

## Resource Bounds

These constants are review-significant because they define liveness or memory
contracts, not because every tuning value belongs in prose:

- scheduler capacity is two light tasks, one heavy task, and four classifier
  tasks; background work ages after `60 s` but never above active-folder
  urgency;
- direct-text semantic admission is capped at `8 MiB` per source in both Node
  and Python;
- media transcription uses ten-minute durable work units with `1.5 s` overlap;
- durable DOCX extraction has a `60 s` worker deadline.

Keep the Node/Python admission bound synchronized. A change to capacity,
chunking, or deadlines requires the focused liveness tests and an explanation
of the resource tradeoff.

## Implementation Map

| Role | Stable entry points |
|---|---|
| Scheduling Interface | `ConversionScheduler` in `server/conversion-scheduler.ts` |
| Format dispatch Interface | `server/conversion-dispatch.ts` and `server/conversion.ts` |
| Reconcile owner | `server/sync.ts`, `server/state.ts`, `server/semantic-workload.ts` |
| Index Interface | `server/indexer.ts`, implemented by `server/indexer.mfs.ts` |
| Daemon Adapter | `server/mfs-daemon.ts` ↔ `python/stashbase_daemon.py` |
| Retrieval Interface | `server/retrieval/index.ts`, with keyword, semantic, and evidence Modules beside it |
| Format owners | PDF, OCR, DOCX, and audio Modules under `server/` plus their native/Python Adapters |
| Focused evidence | `server/conversion-scheduler.test.ts`, `server/conversion.test.ts`, `server/conversion-status.test.ts`, `server/semantic-workload.test.ts`, `server/index-status.test.ts`, `server/indexer-mfs-path.test.ts`, `server/audio-transcription.test.ts`, `server/retrieval/index.test.ts`, and `python/stashbase_daemon_test.py` |

## Review Checklist

- Is completion explicit and format-specific?
- Can stale or partial output be read during queue wait, retry, or source
  replacement?
- Can lost process memory leave work permanently stuck?
- Is cancellation classified as user intent or transient interruption?
- Does folder-explicit work avoid the current-window dependency?
- Can cleanup delete a user source or an ambiguously owned destination?
- Are expensive filesystem, hashing, parsing, and native operations bounded off
  the Node event loop?
- Does the UI treat status as explanation rather than truth?

## Validation

Run:

```bash
pnpm typecheck
pnpm test:conversion-scheduler
pnpm test:retrieval
pnpm test:python
```

Add `pnpm test:library-files` for mutation/reconcile changes and
`pnpm test:electron:smoke` when native process or store retirement changes.

Related journeys: [J02](../design-docs/user-journeys.md#j02-add-and-open-a-folder),
[J04](../design-docs/user-journeys.md#j04-prepare-a-hard-to-read-file),
[J05](../design-docs/user-journeys.md#j05-search-and-open-source-evidence), and
[J08](../design-docs/user-journeys.md#j08-connect-an-external-agent-through-mcp),
plus the [J10](../design-docs/user-journeys.md#j10-turn-a-local-project-into-durable-agent-assisted-work)
core loop and
[J11](../design-docs/user-journeys.md#j11-turn-a-conversation-into-a-project)
for registration and initial sync of an Agent-created member.
Related contracts: [File Transactions](file-transactions.md),
[MCP Access](mcp-access.md), and [Release Pipeline](release-pipeline.md).
