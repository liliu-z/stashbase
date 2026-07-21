# Data Correctness & Recovery

> StashBase looks simple at the product surface: open a folder, import files, search the library. The hard part is underneath. Conversion and indexing can be interrupted, partially completed, retried, or made stale by external file changes. This document defines how the system avoids lying to itself.

This is not a second architecture document. `architecture.md` explains where modules live and how flows connect. This document explains the correctness contracts that must hold when user operations meet conversion, indexing, AppData, process memory, and failure recovery.

---

# 1. Operation Risk Map

| User operation | What can go wrong | Data-layer contract |
|-|-|-|
| Open a folder | A previous run was interrupted; derived state may be missing, stale, or partial. Recursive listing or status calls may also be slow for large folders. | Reconcile must rediscover missing or incomplete work, but navigation must not wait for recursive listing or status snapshots before entering the folder view. |
| Open a folder with no `AGENTS.md` | The folder becomes an Agent workspace without a stable local instruction entry. | Create a short root-level `AGENTS.md` if missing. Use create-only writes; never overwrite an existing file. The file is user-owned source content, not app-owned state. |
| Land on Welcome | The user may not open any specific folder, but previous library work may still be incomplete. | Welcome triggers folder-explicit reconcile in the background with a cooldown when idle; status polling alone is not recovery. |
| Go Home / close the active folder | Conversion may still be running, while the UI leaves the folder view. | In-flight work is process-owned. The renderer returns to Welcome immediately; server-side folder close runs in the background and must not block navigation. Welcome may keep a display snapshot, but it is not data truth. |
| Open a library folder from Welcome | Folder opening can fail or hang at the transport/action boundary before the folder view appears. | The Welcome opening overlay is only a UI guard: it does not block library clicks, follows the latest click, clears when the latest open action settles, and has a 20s watchdog so it cannot permanently cover the app. |
| Reopen a folder | Old derived text may exist from a partial or legacy conversion. | Completion must be verified, not inferred from file existence alone. |
| Change a convertible source while its lane is busy | A stale final derived artifact can remain readable during the queue wait. | A newly queued task invalidates final output synchronously; PDF resume batches remain scratch, never completion truth. |
| Import or copy in a large PDF | Some PDF batches may finish before the app exits or the extractor is killed. | Batch scratch can be reused, but the final PDF note is complete only with the completion marker. |
| Import several PDFs, including scans | Scanned PDFs can monopolize conversion time, while one probe per import can itself exhaust subprocess resources. | A capacity-4 scheduler-owned classifier pool probes asynchronously; cheaper text-layer PDFs run first within the same urgency tier, and probe failure/timeout remains conservative heavy work. |
| Open a folder while other library conversions are queued | Background library conversion can delay the folder the user is actively trying to search/read. | One scheduler prefers explicit interaction, then work under any open window's folder, then library background work. Background tasks age only into the open-folder tier; running work is not preempted. |
| Open an unprepared DOCX while OCR is running | Making visible content depend on server preparation can leave the document on “Preparing…” behind unrelated work or a failed scheduler path; parsing a large source on the renderer thread can also freeze navigation. | An on-demand worker converts and sanitizes the source directly, independently of server preparation and the renderer UI thread. A 20s watchdog aborts a stuck direct path and exposes the server-derived fallback. Opening/importing also promotes the durable search/Agent derivation into the capacity-2 light lane; its status never replaces visible content. |
| OCR a scanned PDF or image | OCR libraries may use many native threads and make the desktop UI feel stuck even though work is in a child process. | PDF/image extractor work runs through the capacity-1 heavy lane, with conservative native-thread limits and lower OS priority; OCR may take longer, but UI responsiveness has priority. |
| Open audio before installing a speech model | Treating a missing optional model as a failed file can leave a durable error after the model becomes available. | Audio remains playable. Transcript readiness is dynamically blocked by the selected model; no preparation failure is persisted, and model installation triggers reconcile. |
| Transcribe long audio while other heavy work waits | One uninterrupted native process can monopolize the heavy lane, and an app restart can discard hours of work. | Audio is split into durable ten-minute work units with overlap. Each completed checkpoint is atomic, and the converter cooperatively yields the lane before starting the next unit. |
| Play an audio container Chromium cannot decode | Search preparation and playback can become incorrectly coupled, or a long inference can occupy the heavy lane before the user can generate playable media. | Playback first uses the source with range requests, then lazily generates a model-independent WebM/Opus fallback. Fallback preparation interrupts only that source's visible transcription, preserves its checkpoints, and resumes it behind the preview unless the user cancelled transcription. |
| Cancel a transcription or mutate its source while it runs | Native inference may retain file/model handles, and a transient cancel may be silently rediscovered. | Explicit Cancel waits for task retirement and records durable `cancelled` intent until Reprocess. Rename/delete waits on a non-durable cancellation barrier, performs the filesystem mutation, then rediscovery follows the new source identity only. |
| Run without optional native helpers | A packaged build may be missing the PDF/OCR extractor, or a native status-store dependency may fail to load. | Optional preparation/status layers must degrade to warnings or failed preparation records; opening folders and browsing source files must keep working. |
| Import an image | OCR may fail or produce empty text. | Empty OCR text is a preparation failure for search; the source image remains viewable. |
| Search immediately after import | Conversion completion and semantic indexing completion are different clocks. | Keyword search can use completed derived text; semantic search depends on daemon index status only when embeddings are enabled. |
| Reprocess a failed file | Stale derived artifacts or stale failure rows may poison the next attempt; clearing a usable transcript before discovering that its provider/model is unavailable loses good output. | Reprocess validates audio provider/runtime/model readiness first, then clears the failure row and stale output. PDF/image/DOCX/audio sources queue extraction; audio also clears chunk checkpoints and may use a per-retry language override. Directly readable files trigger reconcile/index from source. |
| Add or remove the OpenAI API key | Folder bindings or semantic readiness may reflect stale daemon runtime config. | Reset/rebind the daemon runtime and reconcile library folders after key changes; without a key, semantic search is disabled, not pending. |
| Edit or replace a source file externally | Existing index rows or derived notes may describe old content. | Reconcile compares source identity and content state; stale derived/index state must not be treated as current. |
| Rename or move a file | Old source identity may leave derived artifacts, failure rows, or index rows behind. | Source identity is absolute path; rename/move must remap or clean old app-owned state. |
| Delete a source file | Derived text, failure rows, and index rows may become orphaned. | Cleanup must remove app-owned state for the deleted source. |
| Remove a folder from the library | User files must remain, but app state for that subtree must disappear. | Cancel queued/running conversions, then clear index rows, derived artifacts, preparation rows, sidebar order, runtime bindings, and library membership. |
| Delete a folder inside the active tree | The user intends a real filesystem delete, but app-owned state can become orphaned. | Delete the folder on disk only through the explicit file-tree delete path, then clean derived state, preparation rows, file order, and index rows for that subtree. |
| App restart | Process-memory in-flight state is gone. | Persisted failures survive; incomplete work is rediscovered by reconcile. |
| Start built-in Claude in a folder | Claude Code expects `CLAUDE.md`, while StashBase uses `AGENTS.md` as the shared folder contract. | Create `CLAUDE.md` only when missing, with `@AGENTS.md` as a bridge. Never overwrite an existing `CLAUDE.md`. |
| MCP `reindex` on an unopened folder | There may be no active UI folder context. | Reindex/status must be folder-explicit and must not depend on the current window. |
| Sync after PDF/image/DOCX/audio conversion | The daemon's direct text-file scan may report a converted source row as deleted because the raw source is not directly indexable. | If the convertible source still exists under the synced folder, sync must preserve the converted index row and its derived artifacts. |

---

# 2. Completion Contracts

Completion is format-specific. A file or row existing somewhere is not always enough.

## Markdown

Markdown is complete when the source file exists and is readable. It is indexed directly from the source file.

## HTML

HTML remains the source file for reading. The extracted text used for indexing is an internal indexing input. HTML extraction is not a user-visible conversion artifact.

## Images

Images remain the source file for viewing and Agent reading. OCR-derived Markdown exists to make image text searchable.

An image conversion is complete when the derived Markdown is current for the source, contains extractable text, and includes the StashBase OCR completion marker. If OCR produces no searchable text, the conversion records a failure instead of pretending the image is searchable.

## PDFs

PDFs are different: the derived Markdown is both the searchable text and the Agent-readable text form.

A PDF conversion is complete only when:

- the derived Markdown exists under `<appData>/derived.nosync/`
- it is current for the source PDF
- it includes the StashBase PDF completion marker

PDF batch scratch is not completion. A marker-less PDF derived note is treated as incomplete and is rediscovered.

## DOCX

DOCX files remain the source files. Because the app does not provide a native Word renderer, the visible preview fetches the source bytes and converts plus sanitizes them in an on-demand worker before rendering. This direct path has no durable completion state, does not wait for the conversion scheduler, and does not parse or sanitize the document on the renderer UI thread. It has a 20-second fetch/worker deadline, resolves relative assets against the source folder, and uses a cheap filesystem version token so external replacements reload both active and reactivated tabs.

A DOCX conversion is complete only when:

- the derived HTML exists under `<appData>/derived.nosync/`
- it is current for the source DOCX
- it includes the StashBase DOCX completion marker
- it contains extractable text

The durable derived HTML is used for Agent text reading, keyword search, semantic indexing, and fallback preview when direct renderer conversion fails. Server-side Mammoth parsing runs in a terminable worker, observes scheduler cancellation, and has a 60-second deadline. Its fragment passes through the same no-scripts sanitizer as direct preview before being committed, so fallback never exposes raw document markup. It is not required for the normal visible preview. Search results still point to the source `.docx`.

## Audio

Audio remains the source file and can be played independently of transcript preparation. A complete transcription requires both a fully validated structured transcript JSON file and timestamped Markdown ending in the audio completion marker under `<appData>/derived.nosync/`. The JSON records a streamed BLAKE3 content hash plus filesystem identity/size/mtime; fast reads reject identity drift, and content-hash reconcile invalidates converted output even when a sync tool preserves size and mtime. Chunk checkpoints and the lazy WebM/Opus playback fallback are work/cache artifacts and never establish completion. The fallback has its own content-hash and filesystem-identity manifest; conversion validates content before publication and identity immediately after it, so source replacement and backwards-moving mtimes cannot make stale media current.

The transcript records provider id/version/model, detected or requested language, source duration/signature, and timestamped segments. A checkpoint is reusable only when its content hash, source size, provider/model/language/chunk contract, and every segment field, duration bound, and half-open chunk-ownership boundary validate. Filesystem metadata-only changes do not discard inference over identical bytes. Final JSON and Markdown are written atomically only after every compatible checkpoint is assembled. Search and Agent reads use the Markdown while the synchronized player uses JSON; both retain the visible source audio path as identity.

## Semantic Index

Conversion completion is not semantic indexing completion.

If embedding is unavailable or a daemon index write fails after extraction, conversion can still be complete: derived text exists and keyword search can use it. Semantic availability is determined by daemon index status. Converted-source indexing computes the source BLAKE3 hash with an asynchronous bounded-memory stream, then rechecks the source signature before declaring the conversion settled.

Without an OpenAI API key, semantic search is disabled, not pending. `/api/index-status` reports semantic readiness separately from conversion readiness so the UI can keep keyword search available while showing semantic setup copy instead of an endless preparing state.

---

# 3. Conversion State & Recovery

Conversion has six practical states:

| State | Stored where | Recovery rule |
|-|-|-|
| Blocked | Computed from selected transcription provider/runtime/model availability | Audio remains playable; restoring the runtime/provider or selecting an available model removes the block without clearing a failure row. |
| Queued | Process memory | Exposed through status for search-readiness accounting; lost on process exit and rediscovered by reconcile. |
| In-flight | Process memory | Lost on process exit; rediscovered if derived output is missing or incomplete. |
| Failed | `<appData>/state/state.db` | Durable until user reprocess or source/folder cleanup. |
| Cancelled | `<appData>/state/state.db` | Explicit user intent; remains stopped until Reprocess or source/folder cleanup. |
| Done | Complete derived output on disk | Reused until source changes or artifacts are deleted. |

System-driven interruption is not durable. App exit, source/folder mutation, model removal, extractor termination, or source replacement clear in-flight state and follow their owning rediscovery rule. An explicit user Cancel is durable `cancelled` state so later reconcile cannot restart the work without Reprocess.

On graceful shutdown, StashBase cancels active extractors before closing state storage. Shutdown cancellation is transient: it must not persist a failure row, and the next reconcile must rediscover incomplete work.

Persistent preparation failures are durable. They are not silently retried forever because repeated automatic retries can burn time, CPU, OCR, or embedding budget. The user can reprocess the file manually.

Preparation status is auxiliary. If the status store cannot load, StashBase may lose durable failure markers for that session, but it must not block folder opening, source browsing, or basic search over already available content.

Reprocess is available for complete, failed, and explicitly cancelled sources. Audio first requires a ready provider/runtime/model so a rejected request cannot clear a useful transcript or durable attention state. Once accepted, Reprocess does this:

- clears the failure row
- for PDF/image/DOCX/audio sources, removes stale final derived artifacts and queues extraction again at interactive priority (or promotes an existing queued task)
- for audio, removes chunk checkpoints, preserves the model-independent playback fallback, and may apply a language override to that attempt
- for directly readable sources, reconciles the folder so the source can be indexed again

For PDFs, reprocess and transient recovery preserve resumable batch scratch when possible, so a large PDF can continue from completed batches instead of starting from page one.

For audio, transient interruption and ordinary conversion failure preserve content-hash-, provider-, model-, and language-compatible checkpoints. The interactive playback fallback may interrupt only the same source's transcription and resumes it from those checkpoints after the preview owns the heavy lane; durable user cancellation suppresses that resume. Manual reprocess removes checkpoints so the requested attempt cannot silently reuse an earlier inference. Changing the global model or language leaves complete transcripts intact; the new preference applies to unprepared or manually retried sources.

Scheduler priority is an optimization, not a source of truth. Tasks retain an absolute POSIX source spelling and deduplicate through a separate comparison identity. The filesystem-path module owns that identity and subtree semantics: Windows folds separators and path case, macOS follows each mounted volume's case behaviour and canonicalizes Unicode, and other POSIX filesystems remain byte-case-sensitive, without changing retained source spelling. Each lane orders queued work by interactive/open-folder/background urgency, then format cost, then enqueue order. After 60 seconds, background work may age to open-folder urgency but never above interactive work. Manual reprocess is interactive; already-running tasks are non-preemptive except that an on-demand audio playback fallback explicitly retires the same source's resumable transcription before taking the heavy lane.

PDF text-layer probing is auxiliary and asynchronous. Enqueue does not wait for it. The scheduler bounds probe concurrency separately from conversion lanes and owns probe cancellation. A successful probe can lower a queued PDF's cost; timeout, spawn failure, or an unavailable helper leaves conservative heavy cost. The conversion attempt records the actual preparation result and must not crash the server.

---

# 4. Incomplete Work & Resume

Incomplete work must never become visible as truth.

PDF extraction is batch-based. Completed batches may exist under AppData while the final derived Markdown is still missing or incomplete. On the next run:

- matching batch scratch can be reused
- stale final note/bundle artifacts are removed before conversion
- the final note is assembled only after all batches complete
- the completion marker is written only at the end

If the app exits halfway through a large PDF, the next open/sync/reindex should resume the remaining work and then assemble a complete final note. Search should not treat partial derived output as complete PDF text.

Images do not have batch resume. If OCR is interrupted before a valid derived note is produced, reconcile queues it again.

Audio extraction is chunk-based. Each ten-minute ownership window is decoded with up to 1.5 seconds of neighboring context on either side. Segment midpoints decide which ownership window keeps overlap text, preventing duplicates at chunk boundaries. A checkpoint is written atomically after one provider call finishes; the heavy lane is then cooperatively released and reacquired before the next chunk. Compatible checkpoints may resume after interruption, but neither they nor a yielded scheduler state are final transcript truth.

---

# 5. Reconcile Rules

Reconcile is the operation that catches the system up with disk reality.

It runs on:

- server boot, after all member folders are bound into the daemon
- Welcome loading the library list, with a per-folder cooldown
- opening or switching a folder
- manual Sync
- MCP `reindex`
- app focus returning
- Agent turn completion
- OpenAI key changes
- transcription model installation or preference changes when the selected model is installed

Reconcile must be folder-explicit. It must not rely on an active window when the caller already names a folder.

For each folder, reconcile checks:

- source files added, modified, deleted, or renamed
- derived text missing, stale, or incomplete
- durable preparation failures that should remain blocked until manual reprocess
- audio sources whose selected model is installed but whose final transcript is missing or stale
- AppData-derived sources whose original source path no longer exists
- daemon index rows that need add/update/delete
- source paths that should no longer surface in search

Only changed content should be embedded. A no-op reconcile should not spend embedding tokens. When no OpenAI key is configured, reconcile still discovers PDF/image/DOCX/audio work and keeps keyword-searchable derived text fresh; semantic indexing is skipped and reported as disabled. Audio without the selected local model is not queued and does not become a durable failure.

External writes are not immediately searchable. Editors, Git, cloud sync, terminal commands, and external Agents change the filesystem outside StashBase's write path. They become searchable after reconcile. StashBase-owned file helper writes should schedule or perform index maintenance as part of the write when possible.

---

# 6. Cleanup Rules

User files belong to the user. Library removal removes only app-owned state.

Removing a folder from the library:

- removes it from `~/.stashbase/config.json` `recentFolders`
- cancels queued/running conversions under that folder path
- clears semantic index rows under that folder path
- deletes AppData-derived text/assets for sources under that folder
- clears preparation records under that path prefix
- removes AppData sidebar ordering for that folder
- unbinds the folder from the daemon
- never deletes the folder on disk

Library removal returns after membership and UI-visible app state are cleared. Conversion cancellation, derived cleanup, index-row deletion, daemon unbind, and runtime-state cleanup continue as background app-owned cleanup so the Welcome screen does not wait on long-running PDF work.

Deleting a folder from inside an opened folder is a separate filesystem operation. It deletes the user folder on disk after confirmation, then removes derived artifacts, preparation rows, file-order state, and index rows for that subtree.

Deleting a PDF/image/DOCX/audio source clears:

- derived Markdown or derived HTML
- derived bundle
- PDF batch scratch
- audio transcript JSON, chunk checkpoints, playback fallback, and its source-signature manifest
- derived source manifest entries
- preparation failure/in-flight rows
- index rows for the source path

Reprocessing a PDF/image/DOCX/audio source clears stale final derived artifacts and failure rows before queueing extraction. Audio validates the selected provider/runtime/model before that destructive boundary, then also clears its checkpoints but retains a reusable playback fallback. Reprocessing a directly readable source clears the failure row and reconciles the folder. It should not leave old output available as if it belonged to the new attempt.

Renames and moves retain absolute source spelling and use comparison identity for matching. `server/filesystem-path.ts` owns that distinction. Windows restores stored member-root and on-disk component spelling; macOS applies mounted-volume case behaviour and canonical Unicode identity. Root-aware operations cover filesystem, drive, and UNC roots. Existing/creatable resolution applies realpath containment to normal file operations, upload, and explicit-folder preparation; creatable targets retain the requested leaf spelling so case-only renames survive case-insensitive filesystems. Lexical resolution performs containment only and must not be used as a symlink-safety claim. A file rename request with a basename target stays in the source file's current parent folder; requests with a folder-relative target path are moves. Case-only file renames are allowed when the existing target path resolves to the same filesystem entry; the disk layer uses a temporary same-directory hop so case-insensitive filesystems persist the new display name. Structured text files can move index rows when the content remains readable. PDF/image/DOCX/audio moves clear old derived artifacts and old index rows, then queue conversion again under the new absolute source path.

---

# 7. State Ownership

| State | Owner | Durable? | Review question |
|-|-|-|-|
| Source files | User filesystem | Yes | Are we ever moving or rewriting user files as app state? |
| Agent rules files | User filesystem (`AGENTS.md`, `CLAUDE.md`) | Yes | Are they created only when missing, never overwritten, and treated as ordinary visible Markdown source files? |
| Library membership | `~/.stashbase/config.json` `recentFolders` | Yes | Does this represent searchable membership, not just MRU? |
| Folder descriptions | `~/.stashbase/config.json` | Yes | Are they treated as orientation metadata, not indexed source content? |
| Transcription model/language preferences | `~/.stashbase/config.json` | Yes | Do preference changes leave complete transcripts intact and avoid treating a missing model as a failure? |
| Downloaded speech models | AppData `models/whisper` | Rebuildable | Are downloads explicit, atomic, size/checksum verified, and managed only through Settings? |
| Derived text/assets | AppData | Rebuildable | Can stale or partial artifacts be mistaken for completion? |
| Derived source manifest | AppData | Rebuildable | Can AppData artifacts still be traced to a source path when semantic indexing is disabled? Is the manifest updated atomically, and do failed cleanups keep enough mapping to reprocess? |
| PDF batch scratch | AppData | Rebuildable/resumable | Is it preserved across transient interruption but removed on source cleanup? |
| Audio chunk checkpoints and playback fallback | AppData | Rebuildable/resumable | Are checkpoints excluded from completion truth, compatibility-checked before reuse, and removed with their source? |
| MCP launcher wrapper | `~/.stashbase/bin/stashbase-mcp` on macOS/Linux; `%USERPROFILE%\.stashbase\bin\stashbase-mcp.cmd` on Windows | Rebuildable | Is generated client setup kept outside app config and regenerated by the server when needed? |
| Client MCP config | Claude/Codex client config files | Yes | Is Settings writing the target client's own config file, not duplicating config state in StashBase? |
| HTTP MCP credential, exposure preference, and Docker port | `~/.stashbase/config.json` `mcpHttp` | Yes | Is the token visible/rotatable only through Settings, checked live on every request, and is Docker exposure explicit opt-in? |
| Vector index | AppData daemon store | Rebuildable | Is the daemon the source of truth for semantic index status? |
| Preparation failures | AppData `state.db` | Yes | Is reprocess possible, and are persistent failures not silently retried forever? |
| Queued/yielded/running conversions | Process memory scheduler | No | Can lost work be rediscovered, and do cancellation/rename/remove flows cover every scheduler state? |
| Scheduler revision/per-file versions | Process memory, mirrored in renderer | No | Are they treated only as refresh notifications while derived artifacts remain completion truth? |
| Search readiness snapshot | Renderer memory | No | Is it display-only and reconciled from `/api/index-status`? |

---

# 8. Review Checklist

## 8.1 HTTP MCP credential and listener lifecycle

- The web-server process is the only writer. `server/mcp-http-settings.ts:44-109` validates or creates a 32-byte bearer token inside the single app config and persists the Docker-access preference and port; strict reads fail closed instead of replacing malformed config. The legacy standalone token file is migrated and removed once by `server/mcp-http-settings.ts:120-148`.
- Token reads are live rather than captured in a transport. `server/routes/mcp-http.ts:39-64` asks the service for the current token on every POST, so Settings rotation invalidates the previous value immediately.
- The app server stays bound to `127.0.0.1`. `server/mcp-http-service.ts:114-129` mounts the loopback route and creates a Docker listener only when requested; `server/mcp-http-service.ts:257-291` constructs that listener from a fresh Express app containing only the MCP route and binds the configured port on `0.0.0.0`.
- Desired Docker exposure and port are durable; active listener state is runtime-only. A single promise tail serializes start/enable/disable/port/close transitions (`server/mcp-http-service.ts:71-87`). Enabling exposes a candidate only after preference persistence succeeds and rolls it back on write failure; disabling persists before closing, so a failed write cannot silently remove exposure while leaving the durable preference enabled (`server/mcp-http-service.ts:196-252`).
- Bind and config errors remain observable in Settings. The renderer polls through the short startup transition, and a port collision is recoverable by disabling Docker access, changing the port, and enabling it again. Shutdown keeps the durable preference and uses a failure-isolated cleanup ladder so an MCP close failure cannot skip conversion, state database, or indexer cleanup (`server/shutdown-cleanup.ts:11-36`, `server/index.ts:448-485`).

Review invariants:

- HTTP MCP credentials live in the single app config and are managed through Settings; no environment variable or second credential file is a source of truth.
- Docker access is disabled by default. Enabling it must never expose the app server or non-MCP routes on a host-facing listener.
- A failed Docker bind must not report an active listener or turn a previously disabled preference on.
- Concurrent listener transitions must be serialized; persistence failure must not leave an untracked host-facing listener.
- A malformed app config must disable HTTP MCP management without overwriting unrelated folder or API-key state.
- Browser-origin protections stay intact; URL access is for server-side MCP clients.

## 8.2 Conversion scheduler and renderer notification

- The production scheduler is one process-wide owner with fixed light/heavy capacities `2/1`, a capacity-4 auxiliary classifier pool, a 60-second ageing threshold, and an active-folder classifier that ignores short-lived internal folder bindings (`server/conversion.ts:144-159`). Tests may inject capacities, time, activity classification, and path platform (`server/conversion-scheduler.ts:85-94`, `server/conversion-scheduler.ts:151-164`). Hidden native work has a distinct task identity plus a visible-source scope: it consumes normal lane capacity and queue position but is omitted from source-conversion snapshots (`server/conversion-scheduler.ts:40-58`, `server/conversion-scheduler.ts:329-381`).
- `server/filesystem-path.ts` is the platform-path seam. It produces retained absolute spelling and comparison identity, handles POSIX/drive/UNC roots, rejects ambiguous Windows namespaces, follows mounted macOS volume case behaviour, and separates lexical from realpath-safe existing/creatable resolution; creatable targets preserve their requested leaf spelling (`server/filesystem-path.ts:20-409`). Folder membership and user-input absolute checks use the same seam (`server/folder.ts:105-138`, `server/folder.ts:175-178`, `server/folder.ts:392-402`). `server/folder-relative-path.ts` separately owns normalization and protected-write policy for the POSIX-spelled path inside a folder (`server/folder-relative-path.ts:1-51`); filesystem, HTTP, upload, and MCP write paths consume it through active-folder resolution and writable validation (`server/file-paths.ts:34-41`, `server/active-file-operations.ts:46-93`, `server/file-save.ts:20-33`, `server/library-file-access.ts:94-147`, `server/routes/upload.ts:211-276`). Multipart import uses disk-backed Multer staging with an 8 GiB per-file ceiling and request-owned cancellation; route mount reclaims dead-process or aged staging plus interrupted fallback-publication records (`server/routes/upload.ts:45-66`, `server/routes/upload.ts:88-165`). `server/import-publication.ts` revalidates the writable target and streams asynchronously into a unique same-directory temporary file. Publication uses an atomic no-clobber hard link where supported. Link-restricted filesystems use a durable ownership record: Windows applies its non-replacing rename, while POSIX exclusively reserves the destination and atomically renames the completed temporary over that recorded inode. Recovery removes only a matching abandoned reservation and hidden temporary; a completed or externally replaced destination has a different identity and remains untouched (`server/import-publication.ts:38-226`). Directly indexable text has a separate 8 MiB ceiling; eligible text is read asynchronously after publication, while an oversized or indexing-only read failure leaves the successful import intact (`server/indexable.ts:38-38`, `server/indexable.ts:86-96`, `server/import-publication.ts:76-85`, `server/routes/upload.ts:278-289`).
- An absolute source path is the normal conversion task's retained spelling; auxiliary work may use a derived-output task identity while retaining that source as its cancellation/activity scope. Map identity and scope/subtree operations come from the filesystem-path module (`server/conversion-scheduler.ts:166-321`, `server/conversion-scheduler.ts:586-592`). Duplicate schedules share one completion promise and may only raise urgency or lower cost while waiting. Effective ordering is urgency, then cost, then enqueue sequence (`server/conversion-scheduler.ts:166-220`, `server/conversion-scheduler.ts:383-400`). Ageing transitions bump the lane revision and affected per-file versions (`server/conversion-scheduler.ts:541-584`). In-flight progress uses the source-conversion identity; durable failed and user-cancelled attention records store retained source spelling plus comparison identity, so exact lookup, subtree cleanup, and equivalent filesystem spellings agree without rewriting display/I/O spelling (`server/conversion-status.ts:41-117`, `server/state-db.ts:153-230`, `server/state-db.ts:360-427`).
- A running converter receives one scheduler-owned cooperative-yield function. At a durable work-unit boundary it may release its lane while retaining its source identity, original completion promise, priority, and first-start timestamp. The public state becomes `yielded`; normal queue ordering decides when it reacquires the lane, and renderer/API progress preserves `yielded` instead of collapsing it into `queued`. Cancellation wakes a yielded run so normal task retirement and cleanup still own completion (`server/conversion-scheduler.ts:29-38`, `server/conversion-scheduler.ts:415-484`, `server/index-status.ts:85-101`, `server/routes/transcription.ts:103-139`). The shared conversion module passes the yield function into format implementations without changing completion truth (`server/conversion.ts:343-369`).
- Audio transcription is one heavy-lane conversion with durable ten-minute checkpoints and 1.5-second overlap ownership. It publishes a `0 / total` progress snapshot before the first native chunk, atomically records completed units before cooperative yield, and assembles final JSON and Markdown only after every unit succeeds; `auto` language selection remains automatic for every chunk instead of locking later chunks to the first detection (`server/audio-transcription.ts:130-263`). Reuse is content-addressed and validates source size, provider/model/language/chunk contract, duration, and the complete checkpoint segment schema including half-open ownership bounds; metadata-only touches retain compatible work (`server/audio-transcription.ts:842-970`). Completion requires the Markdown terminal marker plus provider/source/language/segment schema and current filesystem identity, while streamed BLAKE3 validation protects production and reconcile boundaries (`server/audio-transcription.ts:639-765`). The provider registry owns provider-neutral Settings metadata, readiness, and inference shape; selection/scheduling operate only on provider/model ids, and the composition root registers concrete providers without putting local-weight semantics into orchestration (`server/transcription-provider.ts:1-56`, `server/audio-transcription.ts:327-405`, `server/transcription-runtime.ts:21-31`, `server/whisper-cpp-provider.ts:26-89`). A provider switch and its model are validated together, and renderer preference generations keep model-operation polling from restoring stale preferences (`server/routes/transcription.ts:46-66`, `web-src/src/components/settings/TranscriptionPanel.tsx:17-81`).
- Fallback preview conversion is an interactive hidden heavy-lane task rather than a format-owned queue. `AudioPreviewPipeline` owns the model-independent source-signature validation and publication contract and removes a dead owner's source-specific temporary before retry (`server/audio-transcription.ts:266-320`, `server/audio-transcription.ts:674-705`). An exact current manifest returns without disturbing transcription. Otherwise the request retires only the same source's visible transcription task, runs or coalesces preview work, and resumes transcription from checkpoints unless durable failed/cancelled state blocks scheduling (`server/conversion.ts:183-192`, `server/audio-transcription.ts:517-552`). Waiter release is atomic: each request unregisters once, and the last disconnect cancels shared native work even when multiple aborts occur in the same turn (`server/conversion.ts:265-314`). The FFmpeg adapter parses progress into source-scoped runtime state; the status route exposes queued/converting/ready and the renderer's fallback controller polls it while the cancellable prepare request owns completion (`server/audio-media-tools.ts:64-82`, `server/audio-transcription.ts:554-573`, `server/routes/file-assets.ts:72-131`, `web-src/src/components/audio/useAudioFallbackController.ts:18-88`). The controller aborts and resets on folder/path/source changes, and the player is remounted with that identity so same-named audio from another folder cannot reuse an old response. Playback position is retained across the direct-to-fallback swap but reset when folder, path, or source version changes (`web-src/src/components/audio/useAudioFallbackController.ts:18-26`, `web-src/src/audio-playback.ts:5-40`, `web-src/src/components/AudioPreview.tsx:16-88`).
- The configured transcription provider/runtime/model is a dynamic readiness dependency. Discovery skips audio while any selected dependency is unavailable, the transcript route distinguishes verification, absence, failure, and runtime/provider blocks without writing a durable failure, and index status enumerates incomplete blocked audio so Search cannot count it as ready (`server/audio-transcription.ts:327-438`, `server/routes/transcription.ts:95-131`, `server/index-status.ts:21-50`). That enumeration performs asynchronous I/O once per folder tree revision and provider-block key, so status polling does not synchronously rescan a large library (`server/audio-transcription.ts:430-467`, `server/audio-transcription.ts:501-510`, `server/audio-transcription.ts:724-765`). Search and Agent reads independently call the transcript freshness guard, so an old index row cannot surface after a source change while blocked (`server/routes/library-files.ts:75-78`, `server/routes/indexing.ts:269-272`, `server/keyword-search.ts:167-175`, `server/library-file-reader.ts:51-64`, `server/library-file-reader.ts:135-178`, `server/audio-transcription.ts:380-389`). `server/conversion-dispatch.ts` checks provider readiness before manual reset and owns the format-specific reset/queue sequence (`server/conversion-dispatch.ts:34-134`, `server/routes/indexing.ts:115-166`). Explicit Cancel writes the durable audio stop gate before taking and awaiting the source-owned task snapshot; the conversion owner also preserves that record when `user-request` abort retires native work (`server/audio-transcription.ts:407-417`, `server/conversion.ts:174-181`, `server/conversion.ts:455-462`). The renderer preserves `cancelled` as retryable attention distinct from failure at file and folder level (`web-src/src/store/fileReadiness.ts:19-42`, `web-src/src/store/useSearchActions.ts:248-258`, `web-src/src/components/FileTree.tsx:375-385`). Local model files are Settings-owned AppData state: installation requires exact catalog size plus a SHA-256 record bound to the verified file identity. Legacy markers and identity changes enter an unavailable `verifying` state and stream SHA-256 work asynchronously; downloads cannot race that verification, enforce connection/read inactivity deadlines, and enforce a catalog-size byte ceiling before exact size/hash acceptance (`server/transcription-models.ts:137-228`, `server/transcription-models.ts:311-389`, `server/transcription-models.ts:437-504`). Only the server-port winner reclaims unowned model `.part` files and dead-process/aged audio-preview temporaries, so a losing startup contender cannot delete the active daemon's work (`server/index.ts:339-351`, `server/transcription-runtime.ts:33-47`, `server/transcription-models.ts:297-309`, `server/audio-transcription.ts:471-499`). Explicit cancellation and shutdown abort both downloads and verification streams (`server/transcription-models.ts:270-295`). Removal publishes the model as unavailable, cancels and awaits those streams, then calls the composition-root inference-release barrier before deleting files (`server/transcription-models.ts:231-268`, `server/transcription-runtime.ts:21-31`, `server/audio-transcription.ts:576-611`).
- Native transcription helpers resolve from packaged resources before any development-only PATH fallback, run at reduced priority with scheduler cancellation owning the descendant process tree, cap whisper inference at four threads, enforce operation-specific hard deadlines, and settle only after inherited stdout/stderr handles close (`server/transcription-tools.ts:36-176`). The provider-neutral media seam owns one-minute probe, five-minute decode, and thirty-minute preview limits; the local provider owns the thirty-minute whisper chunk limit (`server/audio-media-tools.ts:7-82`, `server/whisper-cpp-provider.ts:22-93`). `native/transcription/toolchain.json` is the shared provider/version/build-baseline source consumed by runtime, build, and package validation. Release builds disable `GGML_NATIVE` and BLAS, fix macOS deployment to 12.0, pin Linux to an Ubuntu 22.04 runner, reject GLIBC above 2.35 or GLIBCXX above 3.4.30, and reject Windows MinGW runtime DLL dependencies (`scripts/build-transcription-sidecar.sh:9-90`, `scripts/build-transcription-sidecar.sh:295-375`, `.github/workflows/release-linux.yml:27-35`). Packaging independently rejects metadata drift, wrong executable formats, empty/license-incomplete artifacts, unacceptable FFmpeg configuration, macOS minimum-version drift, and Linux ABI drift (`scripts/package-unsigned.mjs:32-73`, `scripts/package-unsigned.mjs:294-430`). Every platform's packaged smoke selects and downloads Tiny, checks runtime/model readiness, transcribes a generated WAV through packaged FFmpeg and whisper.cpp, validates the content-hash transcript contract, and prepares/serves WebM before artifact publication. The source CI Windows job provisions the same MSYS2 toolchain and builds the native sidecar explicitly (`scripts/smoke-packaged-server.mjs:412-473`, `scripts/publish-github-release.mjs:186-196`, `.github/workflows/ci.yml:32-47`, `.github/workflows/ci.yml:82-103`, `.github/workflows/release-linux.yml:73-78`, `.github/workflows/release-windows.yml:91-96`).
- Folder membership and Node daemon bindings use the two-channel model: comparison maps retain the first source spelling instead of rewriting it when an equivalent filesystem variant is reopened (`server/folder.ts:495-513`, `server/mfs-daemon.ts:87-138`). Node sends its comparison identity to Python as an opaque binding/upsert key; the sidecar retains source spelling and performs prefix routing without repeating Unicode mapping (`python/stashbase_daemon.py:541-544`, `python/stashbase_daemon.py:599-657`, `python/stashbase_daemon.py:782-784`). The Python adapter centralizes root, child-prefix, join, parent, and relative mechanics so `/`, `C:/`, and UNC roots remain intact during routing, row moves, and disk scans (`python/stashbase_daemon.py:471-504`, `python/stashbase_daemon.py:809`, `python/stashbase_daemon.py:917`, `python/stashbase_daemon.py:1041`). Node selects byte-sensitive legacy rows with the same identity and longest nested-member owner, then the store adapter rebases them onto retained spelling, reusing vectors when possible and otherwise leaving normal scan to rebuild them (`server/indexer.mfs.ts:43-59`, `server/indexer.mfs.ts:394-419`, `python/stashbase_daemon.py:981-996`). Index prefix delete/rename uses root-aware `relative`/`join` operations instead of slicing raw strings (`server/indexer.mfs.ts:215-288`). Local-data canonicalization delegates absolute/realpath rules to the same seam while retaining the legacy native-separator hash bytes (`server/local-data.ts:21-36`).
- Auxiliary cost classification is scheduler-owned and separately bounded. Starting/cancelling a task aborts its classifier; cancellation completions include classifier exit, including a classifier still shutting down after its conversion task retired (`server/conversion-scheduler.ts:252-319`, `server/conversion-scheduler.ts:486-540`). PDF probes settle on child exit/error or after a bounded post-kill grace, so a non-cooperative child cannot permanently consume classifier capacity (`server/pdf.ts:98-153`).
- Typed cancellation reasons distinguish source change, shutdown, folder removal, request abort, interactive preview, explicit user intent, file operation, model removal, and classifier retirement when conversion starts (`server/conversion-scheduler.ts:18-27`, `server/conversion.ts:165-228`). Only folder/source changes automatically rediscover from the generic conversion owner; interactive audio preview resumes explicitly after the preview, user cancellation persists `cancelled`, and file mutations await complete task retirement before touching disk (`server/conversion.ts:343-512`, `server/routes/indexing.ts:190-208`, `server/file-operation-guard.ts:1-8`).
- A newly created task deletes stale final output synchronously at enqueue, then repeats the final-output cleanup before extractor execution (`server/conversion.ts:493-520`, `server/conversion.ts:343-361`). PDF's narrower cleanup keeps batch scratch but removes the final note/bundle (`server/pdf.ts:66-70`). Semantic and keyword search filter unavailable sources (`server/routes/indexing.ts:284-316`, `server/keyword-search.ts:160-178`), and library/Agent reads expose derived text only for a visible member source and return not-ready under the same condition (`server/library-file-access.ts:107-123`, `server/library-file-reader.ts:28-211`).
- Content-addressed audio output contributes the source hash from its validated transcript manifest to the shared indexing handoff. Conversion rejects a missing bound hash and rechecks format completeness after indexing; the boot hook uses the bound value instead of hashing a potentially replaced source, so old transcript text cannot be paired with replacement bytes (`server/audio-transcription.ts:645-649`, `server/audio-transcription.ts:707-746`, `server/conversion.ts:390-442`, `server/index.ts:73-90`).
- Current convertible formats and historical sibling-derived formats are separate vocabularies. The shared catalog owns all extension membership and server/renderer matchers derive from it. Audio participates in conversion/viewing but not compatibility hiding, so a user-owned `.meeting.md` or `.meeting.mp3.md` remains visible beside `meeting.mp3` (`shared/file-formats.ts:8-52`, `server/format.ts:51-72`, `server/format.ts:111-151`, `server/file-listing.ts:140-178`). Private format adapters in the shared dispatch module own queue, discovery, current-output indexing, reset, readiness, and interactive-preparation differences so route/mutation callers do not repeat a format switch (`server/conversion-dispatch.ts:34-134`).
- Packaged renderer static middleware bypasses every API and data-asset prefix, including the dedicated audio-preview asset path, before serving the web bundle (`server/index.ts:235-252`).
- Queue snapshots expose queued, yielded, and running work, same-lane tasks ahead, a process-wide revision, and per-source versions; exact task lookup also exposes hidden preview work without adding it to the public snapshot (`server/conversion-scheduler.ts:329-381`). `/api/index-status` scopes that display state, failed/cancelled attention, and revision-cached dynamic blocked audio to the requested folder (`server/index-status.ts:21-101`); the renderer mirrors it for preparation progress, search readiness, fallback-derived refresh, and distinct cancelled-versus-failed file and folder attention (`web-src/src/store/useSearchActions.ts:166-258`, `web-src/src/store/fileReadiness.ts:19-42`, `web-src/src/components/SearchPanel.tsx:42-125`). Folder-explicit prepare, reprocess, and cancel requests bypass the active-window gate and still validate library membership in the route, so they work while no UI folder is open (`server/http.ts:47-67`, `server/routes/indexing.ts:115-208`). Image preview renders queued/yielded/extracting/indexing state without blocking the source image (`web-src/src/components/ImagePreview.tsx:47-63`, `web-src/src/components/ImagePreview.tsx:141-145`). DOCX independently fetches versioned source bytes with a watchdog and delegates visible conversion plus sanitization to an on-demand worker, while preparation state occupies only a status row and direct failure falls back to the server-derived route (`web-src/src/components/DocxPreview.tsx:19-91`, `web-src/src/components/DocxPreview.tsx:194-233`, `web-src/src/workers/docxPreview.worker.ts:1-35`). Direct and durable DOCX fragments pass through the shared no-scripts sanitizer (`shared/html-sanitization.ts:15-53`); the durable Mammoth worker sanitizes inside the worker, remains cancellable and bounded, and commits only the completed result (`server/docx.ts:39-69`, `server/docx.ts:98-163`, `server/docx.ts:166-183`). Derived artifacts and durable failed/cancelled rows remain truth for the server preparation path.
- Markdown editor sessions are renderer-only caches keyed by tab identity plus document generation (`web-src/src/components/CodeEditor.tsx:128-169`). A path rename retains the generation; replacing a tab's file or reloading a clean tab from an external source update increments it, and closed tabs are pruned by `web-src/src/store/AppContext.tsx:217-224`. `Tab.dirty` tracks user buffer edits independently of Live Editing mode (`web-src/src/store/useDocumentActions.ts:45-122`): only dirty missing files are retained, while a clean tab remains eligible for external-deletion pruning (`web-src/src/store/stateReducer.ts:146-160`).

Review invariants:

- Format modules never own private queues or extractor concurrency.
- Scheduler changes never define conversion completion; only format completeness checks do.
- Interactive priority is non-preemptive; only the explicit same-source audio playback fallback retires resumable transcription before taking the heavy lane.
- Cooperative yield is opt-in at durable work-unit boundaries; it never retires the task identity or makes partial output complete.
- Audio checkpoints never satisfy transcript completion; current final JSON and Markdown must agree with the source signature.
- Audio Markdown must end in the completion marker and structured JSON must pass the full persisted schema before either viewer/search read accepts it.
- Audio Markdown stores each provider segment on one timestamped physical line; keyword hits carry the parsed milliseconds separately from a truncated display snippet.
- Content-addressed derived output supplies its bound source hash to semantic indexing. A later source replacement cannot cause old derived text to be stamped with the replacement's hash.
- Imported files never replace a target created after collision planning; link-restricted publication exposes only a complete same-directory temporary and leaves a recoverable ownership record until commit.
- Fallback preview freshness comes from its source-signature manifest and content validation, not output mtime; metadata-only source changes may refresh that manifest without transcoding.
- Playback position survives only a media fallback for the same logical source version; folder, path, and version changes clear it.
- Retriable and startup recovery remove dead-process audio-preview temporaries; startup-wide recovery runs only after the process owns the server port.
- An unavailable or verifying selected transcription provider/runtime/model is a dynamic block, not a durable preparation failure.
- User-cancelled preparation remains retryable attention and is never rendered or aggregated as a preparation failure.
- A model stream has bounded connect/read inactivity and cannot write beyond its catalog size; cancellation and shutdown remove partial state, while startup recovery does so only after server-port ownership.
- Installed model trust requires verified bytes bound to the current file identity; legacy markers and identity changes remain unavailable during asynchronous verification and never hash model bytes on the Node event loop.
- Model removal makes the provider/model pair unavailable before waiting for every tracked conversion using it to release.
- Every native transcription helper has a bounded runtime and keeps scheduler ownership until its child terminates and inherited output handles close after cancellation or timeout.
- Model preference changes do not invalidate a complete transcript; manual retry is the explicit re-inference boundary.
- Audio manual retry validates provider/runtime/model readiness before clearing final output, checkpoints, or durable attention state.
- Background ageing cannot rise above open-folder urgency.
- Every visible ageing transition bumps scheduler revision and affected per-file versions.
- Auxiliary classifiers have a fixed capacity and share task cancellation ownership.
- Extractor cancellation owns the whole descendant tree: POSIX signals the detached process group, while Windows uses `taskkill /T /F` (`server/extractor-process.ts:38-79`).
- A stale final artifact is unavailable for the entire queued interval; resumable PDF batches and audio checkpoints never count as final artifacts.
- Folder removal, source delete/rename, and shutdown consult the scheduler so queued or native work is not invisible.
- File/folder rename and delete validate the requested mutation before cancelling work, then cancel queued/running source and preview tasks and await handle/lane release before touching disk. Successful operations clean stale derived ownership and rediscover convertible sources at new paths in both the active-folder and library/MCP surfaces (`server/file-operation-guard.ts:1-8`, `server/routes/file-mutations.ts:35-209`, `server/library-file-mutations.ts:78-198`, `server/routes/folders.ts:58-173`, `server/conversion-dispatch.ts:15-51`). Library mutations retain their own folder context and version checks when no window has that folder open; the cross-platform integration gate exercises this through MCP, the library HTTP routes, and the mutation service with isolated application-data roots (`server/library-file-mutations.test.ts:16-155`).
- Disk-backed imports never perform a potentially multi-gigabyte copy or an oversized whole-text read on the Node event loop; disconnect cancellation removes the unpublished same-directory temporary, final publication cannot replace a concurrently created destination, startup reclaims dead staging and incomplete fallback reservations, and the 8 MiB indexing budget never changes whether publication itself succeeded.
- Revision/version counters are disposable notifications and may reset on restart.

## 8.3 Built-in Codex process lifecycle

- Each live Codex chat session owns one app-server process and one persistent thread. The process is created lazily before the first turn; the session owns turn and interrupt state, and disposal rejects pending RPC work before terminating the process (`server/codex-session-runtime.ts:57-340`, `server/codex-session-runtime.ts:620-645`).
- Live sessions and history clients share request correlation and inbound dispatch without sharing process ownership (`server/codex-rpc-transport.ts:20-115`). Their adapters independently own stdin/stdout and process exit (`server/codex-session-runtime.ts:130-188`, `server/codex-history.ts:62-168`). Closing an RPC peer rejects pending requests and discards all later inbound lines. A live-session process generation captures its own RPC and stream handles; only the currently-owned generation can clear session fields, so delayed events from a replaced child cannot release or mutate its successor (`server/codex-session-runtime.ts:130-188`, `server/codex-rpc-transport.ts:64-100`). Module placement is described in [architecture §8](architecture.md#8-built-in-agent-panel).
- History calls share one app-server client per filesystem comparison identity. Active calls increment a reference count; the client stays warm for 15 seconds after the final call, then terminates. Closed clients and transport failures are evicted immediately, so later calls create a fresh process (`server/codex-history.ts:166-221`).

Review invariants:

- A live chat session and a history client never share process ownership.
- Every process exit or explicit dispose rejects pending RPC requests.
- A closed RPC peer cannot dispatch subsequent inbound requests or notifications.
- A stale process generation cannot clear or close the replacement generation.
- History idle timers cannot dispose a client while its reference count is non-zero.
- Approval policy remains in `server/codex-approval.ts`; transport and process modules do not decide which actions are allowed.

## 8.4 Semantic index daemon lifecycle

- The Python daemon owns one local Milvus Lite collection and loads it once
  after the first keyed folder bind. Upserts and vector-preserving copies
  request a synchronous flush before acknowledgement; a flush warning leaves
  the derived write recoverable by later flush/reopen and reconcile
  (`python/stashbase_daemon.py:588-640`,
  `python/stashbase_daemon.py:744-765`).
- Local collect-all reads use one scalar-query snapshot. MFS's native
  `query_iterator` advances with the last primary key in a page, while the
  bundled local adapter may return multiple immutable segments without global
  primary-key ordering. The sidecar applies the local-only snapshot adapter
  before opening the store; remote Milvus URIs keep MFS's iterator
  (`python/stashbase_daemon.py:366-405`,
  `python/stashbase_daemon.py:593-603`).
- Daemon status is computed by comparing the current disk walk with the
  complete indexed-source set. Missing indexed rows become pending; rows whose
  source no longer exists become orphaned. The snapshot is explanatory state,
  while reconcile remains the operation that changes storage
  (`python/stashbase_daemon.py:1423-1451`).

Review invariants:

- A collect-all storage read cannot use a primary-key cursor unless the storage
  response is globally primary-key ordered.
- A successfully flushed row must participate in the next complete status or
  reconcile snapshot; collection size and segment layout cannot hide it.
- A no-op reconcile must not re-embed content merely because index metadata
  pagination omitted an existing row.

When reviewing code that touches conversion, indexing, sync, search, folder membership, or AppData cleanup, check these invariants:

- Completion is explicit. A partial artifact cannot be mistaken for done.
- Conversion completion and semantic indexing completion are separate states.
- In-flight state can be lost without making work permanently stuck.
- Persistent failures are reprocessable but not auto-retried forever.
- Reprocess clears stale output before queueing new work.
- Large PDF interruption can resume completed batches.
- Derived artifacts never appear as user-editable source files.
- Search results point to user-facing source paths, not AppData paths.
- Source paths use absolute POSIX spelling once work enters conversion, indexing, search, or daemon calls; comparison identity is derived separately and never replaces the retained spelling used for I/O or display.
- Folder-explicit routes work even when no folder is open in the UI.
- HTTP static serving must not intercept or redirect `/api/*`, `/asset/*`, or `/asset-audio-preview/*`;
  file paths need to reach data-route handlers unchanged.
- Packaged native helpers such as ripgrep must spawn from the real unpacked
  filesystem, not from virtual `app.asar` paths.
- Vector-index initialization must preserve atomic-overwrite semantics on every
  platform; Windows must not fail folder open because a rebuildable Milvus Lite
  manifest target already exists.
- Removing a folder from the library deletes app-owned state but never deletes user files.
- Deleting a folder in the active file tree is a real filesystem delete and must clean app-owned state for the deleted subtree.
- `AGENTS.md` and `CLAUDE.md` are not hidden config or derived state. They are ordinary root-level Markdown files and create-only writes must not overwrite user edits.
- UI status snapshots do not become data truth.
- Background preparation is quiet by default. Welcome library rows and affected file rows show failure markers only; in-folder headers do not show preparation badges. The Search view is where pending/failed preparation is summarized because that is where incomplete readiness affects the user.

---

# 9. Representative Failure Modes

These are not historical release notes. They are recurring classes of bugs that the data layer and UI liveness rules must keep preventing.

## 9.1 Navigation Blocked By Preparation

Opening a folder, going Home, or clicking another library folder must feel like navigation, not like indexing.

Representative failure:

- A large PDF or scanned PDF is being prepared.
- A user clicks Home or another library folder.
- The UI waits for a folder-close request, recursive file listing, index status, or Welcome reconcile before visually moving.
- The app appears frozen even though the background work is merely slow.

Current contract:

- Opening a folder establishes renderer folder identity and hides Welcome before `/api/files`, file order, or `/api/index-status` finish.
- Folder-switch side effects such as index sync and Agent-session cleanup are scheduled after the open-folder response, so they cannot turn navigation into a failed request.
- Folder-sync queue cleanup consumes rejected promises; an indexer or daemon startup failure records an index warning but must not exit the Node server.
- Going Home resets renderer folder state and shows Welcome before the server-side close request returns.
- Welcome status polling and reconcile are deferred while a folder open is in progress.
- The Welcome opening overlay is visual only: it must not intercept clicks, follows the latest folder click, and has a watchdog fallback.

## 9.2 Search Readiness Leaking Into Browsing

Preparation state is about search completeness, not file availability.

Representative failure:

- A folder contains files that can be opened and read immediately.
- Some files are still being converted or embedded.
- The folder header shows a preparation badge, making the folder look unfinished or partially unavailable.

Current contract:

- Browsing surfaces stay quiet while preparation is pending.
- The in-folder header shows no preparation or failure badge.
- A durable failure is marked on the affected file row, where the user can locate it.
- Welcome can show a lightweight folder-level failure marker because it does not expose file rows.
- Search is the place that explains how many files are ready and how many are still being prepared.

## 9.3 Background Conversion Starving Interactive Work

Conversion order is a liveness concern, not a correctness source of truth.

Representative failure:

- Welcome or startup queues conversions from several library folders.
- A user opens a DOCX while scanned-PDF OCR or a long audio transcription is running, or opens a folder whose searchable text is behind unopened-folder work.
- One global FIFO/slot makes DOCX search/Agent preparation wait on OCR or lets old background work occupy every next slot.

Current contract:

- Visible DOCX preview converts the source in the renderer and never enters the scheduler. Durable DOCX search/Agent preparation uses the light lane (capacity 2); PDF/image OCR and audio transcription use the heavy lane (capacity 1).
- Audio releases and reacquires the heavy lane after each durable ten-minute checkpoint. Source playback and the lazy playback fallback do not wait for transcript completion.
- Interactive work is preferred over work under any open window's folder, which is preferred over other background work.
- Background ageing is bounded at open-folder urgency, so it prevents starvation without overtaking interaction.
- Format cost and original enqueue order break ties inside one urgency tier; text-layer PDFs become cheaper only if the asynchronous probe succeeds before they start.
- Already-running conversions are not preempted; priority changes apply to queued work.

## 9.4 Status Snapshots Becoming Truth

Status exists to explain the system, not to define data correctness.

Representative failure:

- Welcome or the sidebar shows an old readiness snapshot.
- A retry, reprocess, file delete, or folder switch changes the real state.
- The UI treats the old snapshot as authoritative and keeps showing stale readiness.

Current contract:

- Renderer status snapshots are disposable display state.
- Durable failures live in AppData `state.db`.
- Conversion completion is defined by complete derived artifacts and completion markers.
- Semantic readiness is defined by daemon index status.
- Reconcile is the operation that catches storage up with filesystem reality.

## 9.5 Rebuildable Vector State Blocking Folder Open

The vector index is derived state. Initializing it must not prevent browsing a
folder that otherwise exists on disk.

Representative failure:

- A packaged Windows daemon starts with a fresh AppData vector store.
- Milvus Lite creates the collection and then persists index metadata.
- Its manifest update writes `manifest.json.tmp` and renames it over an
  existing `manifest.json`.
- Windows rejects the rename because the target exists, so `bind_folder` fails
  before the server can mark semantic indexing as unavailable or degraded.

Current contract:

- The daemon applies platform compatibility patches before opening Milvus Lite.
- Manifest commits keep the upstream crash-safety shape: write a temporary file,
  keep a `.prev` backup when possible, and atomically replace the current
  manifest.
- If the vector store still fails, the Node server records an index warning; it
  must not turn source-file browsing into a startup crash.

## 9.6 Removed Folder Conversion Work Continuing

Folder membership is a source of truth for background preparation. A conversion
queue snapshot must not outlive the user's library removal.

Representative failure:

- A folder with many convertible files queues background preparation.
- The user removes that folder from the library while one conversion is running.
- Runtime bindings are cleared, so the daemon no longer has a root for that
  path, but the scheduler continues to start later work from the removed folder.
- Extraction logs keep appearing for the removed folder, followed by
  "no bound root matches path" index warnings.

Current contract:

- Removing a library folder cancels active conversions under that path.
- It removes queued tasks under that path through the same scheduler operation,
  so a stale format-specific queue cannot start later work.
- Reopening the folder allows reconcile to rediscover any incomplete derived
  work because cancellation is process state, not a durable failure.
- If removal's bounded wait expires while a non-cooperative conversion is still
  exiting, that task checks membership again after retirement and requeues when
  the folder was already reopened; this closes the cancel/reconcile timing gap.

## 9.7 Indexed Rows Disappearing From Reconcile

The vector store can contain durable rows that an incomplete metadata scan does
not return. Reconcile must not interpret a pagination gap as missing data.

Representative failure:

- The collection spans more than one 1,000-row page and several immutable
  segments.
- A cursor records the last primary key from a page even though the page is not
  globally primary-key ordered.
- Later segments contain lower primary keys, so status omits their sources and
  reports already-indexed files as pending.
- Startup reconcile embeds and upserts those files again while the visible
  indexed count appears stuck.

Current contract:

- Local collect-all index reads use one storage snapshot and do not infer a
  cursor from segment iteration order.
- Status and hash diff consume that complete source set; a stored row is not
  marked pending because it lives after an iterator boundary.
- The regression gate creates separately flushed segments across the 1,000-row
  boundary and requires every source to remain visible
  (`python/stashbase_daemon_test.py:19-89`).
