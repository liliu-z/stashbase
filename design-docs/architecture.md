# Architecture

> This document describes StashBase's core system architecture. For product motivation and positioning, see [overview](overview.md). This document stays on the main path: how local files become Agent-readable, searchable context exposed through MCP.

---

# 1. System Overview

StashBase turns local files into **Agent-ready context**.

The system has two core jobs:

- **Convert**: turn human-facing formats into cleaner Agent-readable text.
- **Index**: build semantic and keyword indexes so Agents can retrieve local knowledge by meaning.

The output is exposed through MCP, so the same local context can be used by Claude, Codex, ChatGPT, Cursor, and other MCP-capable clients.

At the product level this can feel like a personal knowledge base. At the system level it is one local **library**: ordinary folders on disk, plus derived state that makes those folders readable and searchable for Agents.

```text
Local files -> Convert -> Index -> Retrieve -> MCP -> Agents
       ^                                                |
       |                                                v
       +--------------- Agent-written local files <-----+
```

An Agent can write new output back as local files. Once those files are reindexed, they enter the same loop and become future context.

## 1.1 Runtime Shape

One installation has one desktop app and one local library.

```text
Electron renderer
      |
      | HTTP / WebSocket
      v
Node main process
      |-- file system read/write
      |-- format conversion
      |-- MCP server
      |
      v
Python daemon (MFS)
      |
      v
Milvus Lite vector store
```

The **Node process** owns application logic, file operations, conversion orchestration, and MCP.

The **Python daemon** owns chunking, embedding, storage, and search through MFS/Milvus Lite. It does not know how to convert PDFs, images, or HTML; those decisions stay in StashBase.

The **MCP server** is a Node process. It exposes retrieval, reindexing, and bounded file access to AI clients while the StashBase app is running.

---

# 2. Local Files and Scope

StashBase does not introduce a new workspace model. A user points it at ordinary files and folders on disk. Those paths become the input set for conversion and indexing. The files stay where they are.

## 2.1 Input Paths

- Opening a folder adds that local directory to the indexed set.
- Opening a folder also ensures a root-level `AGENTS.md` exists. This is a normal user-visible Markdown file that defines the folder's Agent contract; StashBase creates it only when missing and never overwrites user content.
- Removing a folder from the library clears StashBase-owned state for that folder — index rows, derived text/assets, preparation state, runtime bindings, file-order state, and membership. It never deletes the user's files.
- Deleting a folder from inside an opened folder is different: that is a normal filesystem delete, guarded by the app's confirmation flow.
- New Folder opens the native folder picker at `~/Documents/StashBase`. The picker creates or selects a normal local folder; the location is a default, not a boundary.
- One app window views one folder at a time. This is UI scope, not a separate library.

`server/filesystem-path.ts` is the platform-path seam for user files and folder
roots; `server/folder-relative-path.ts` owns the POSIX-spelled path policy inside
one folder. `server/library-file-access.ts` composes those rules with library
membership, hidden-derived filtering, and writable-path validation for the MCP
and library HTTP surface. `server/library-directory.ts` owns member-folder
listing, `server/library-file-reader.ts` owns direct versus derived reads and
the conversion-not-ready contract, and `server/library-file-mutations.ts` owns
library write, edit, move, and delete transactions. `server/file-save.ts`
provides the shared editable-file save and index-update path, and
`server/markdown-source-format.ts` preserves Markdown UTF-8 BOM and line-ending
conventions at that boundary.
`server/file-operation-guard.ts` establishes the cancellation barrier that
releases conversion-owned file handles before rename/delete, and
`server/file-hash.ts` owns streamed BLAKE3 for large source files.
`server/routes/library-files.ts` keeps request and response
orchestration. The active-folder filesystem facade is `server/files.ts`;
`server/file-paths.ts` owns current-root resolution, portable filename
sanitization, folder-relative containment, and case-only rename hops,
`server/active-file-operations.ts` owns active-folder reads, writes, file/folder
mutations, asset resolution, and legacy derived-artifact cleanup, and
`server/file-listing.ts` owns recursive sidebar listing, preview metadata
caching, attachment-bundle hiding, legacy-derived compatibility hiding, and
folder-rename scan inputs. That compatibility vocabulary excludes audio;
audio writes AppData-derived output and does not own sibling-derived filenames. The
active-folder HTTP surface composes note CRUD and reveal in
`server/routes/files.ts`, rename/delete/preview transactions in
`server/routes/file-mutations.ts`, asset and derived-preview serving in
`server/routes/file-assets.ts`, and sidebar-order HTTP handling in
`server/routes/file-order.ts`. Filesystem, scheduler, membership, state, and
daemon adapters cross these modules. Identity, containment, migration, and protocol invariants live in
[data-layer §8.2](data-layer.md#82-conversion-scheduler-and-renderer-notification).

## 2.2 Library Scope

One installation has **one library**: the set of opened folders indexed into one collection and exposed by one MCP server.

MCP search defaults to the whole library. Calls can narrow scope by folder root or path prefix. The in-app search UI is scoped to the current window's folder and can narrow further to one subfolder and to file-type categories.

On server boot, StashBase binds every library folder into the daemon and then reconciles them in the background. The Welcome screen also reconciles library folders with a short cooldown and polls folder status when it is idle. While a folder is actively opening, Welcome status polling and reconcile are deferred so navigation does not compete with preparation work.

Opening a folder is a navigation action first and a preparation action second. Once the server accepts the target folder, the renderer enters the folder view before recursive file listing, file ordering, or index status finish. Those follow in the background. Going Home follows the same rule in reverse: the renderer returns to Welcome immediately, and the server-side folder close runs in the background.

Each opened folder can carry a short optional description in app config. The description is orientation metadata for humans and Agents: it explains what the folder is for, but it is not indexed content and it does not define access scope. It can be written by the user first and later generated or refreshed by AI. Removing a folder from "Your Folders" removes its description with the folder membership record.

Renderer state orchestration lives under `web-src/src/store/`. `state.ts` is the stable state-model and action-contract facade, `stateHelpers.ts` owns reusable pure transitions and layout bounds, and `stateReducer.ts` applies the action union. `AppContext.tsx` is the composition seam exposed to views. Async behavior is grouped by ownership: document persistence and tabs in `useDocumentActions.ts`, visible file mutations in `useFileActions.ts`, index polling/search/sync in `useSearchActions.ts`, folder-session transitions in `useFolderActions.ts`, and transient find/feedback protocols in `useFindActions.ts` and `useFeedbackActions.ts`. These hooks share refs only through the Provider composition and preserve one `AppActions` interface for renderer callers. `web-src/src/components/MainPane.tsx` dynamically imports format- and mode-specific heavy viewers/editors, including audio, PDF, DOCX, Markdown preview, and the Markdown editor, so the initial renderer chunk carries the common browsing surface first. `web-src/src/App.tsx` also dynamically imports the chat pane; launcher buttons stay in the initial shell, while Agent transcript rendering and the CodeMirror mention composer load only after chat is opened. `scripts/check-renderer-chunks.mjs` requires those six dynamic entries and caps the entry chunk plus its recursive static imports at 400 KiB. `web-src/src/components/ErrorBoundary.tsx` retries each dynamic import once and contains a persistent failure inside the affected chat or document surface; a changed document identity/version or chat surface clears that local failure, while the root boundary remains the final recovery path for unrelated renderer errors. `web-src/src/components/ChatPane.tsx` keeps tab navigation outside one boundary per mounted Agent session, so a render failure in one tab cannot hide the controls needed to switch or close it.

The renderer's local HTTP boundary keeps `web-src/src/api.ts` as the stable endpoint facade. `shared/conversion.ts` and `shared/transcription.ts` own the preparation and transcription contracts consumed on both sides of that boundary; `apiTypes.ts` re-exports them and owns the remaining renderer-only request/response shapes. `apiTransport.ts` owns per-window request identity, JSON/error normalization, retry policy, and folder-relative path encoding. `web-src/src/preparation-copy.ts` translates queued and yielded preparation waits into shared user-facing copy without exposing scheduler lanes or positions. `web-src/src/audio-transcript.ts` maps semantic text or an explicit keyword-result millisecond timestamp back to the exact structured transcript segment and owns the remaining transcription-specific status copy, while `web-src/src/audio-playback.ts` retains logical playback position across direct-to-fallback source replacement.

---

# 3. Storage

The file system is the source of truth. Converted content, indexes, and app state are derived from local files.

## 3.1 Source and Derived Data

User-visible files stay in the folder tree. StashBase has one user-level config file under the user's home directory. Derived state stays in AppData.

```text
~/.stashbase/config.json          # user-level app config: library folders, credentials, transcription preferences
~/.stashbase/bin/stashbase-mcp    # generated MCP launcher wrapper (macOS/Linux)
%USERPROFILE%\.stashbase\bin\stashbase-mcp.cmd  # generated MCP launcher wrapper (Windows)

<folder>/
  paper.pdf                       # user file
  AGENTS.md                       # user-visible folder Agent contract
  CLAUDE.md                       # optional Claude bridge: @AGENTS.md

<appData>/vector-store.nosync/    # Milvus Lite store, per-machine derived data
<appData>/derived.nosync/         # converted text, extracted assets, PDF/audio resumable work, audio previews
<appData>/models/whisper/         # explicitly downloaded, checksum-verified local speech models
<appData>/state/state.db          # durable preparation failures
<appData>/file-order/             # sidebar ordering keyed by folder path
```

The important ownership rule is simple:

- **Original files** belong to the user.
- **Agent rules files** (`AGENTS.md`, `CLAUDE.md`) are original files too: visible, editable, indexable, and never treated as app-owned derived state.
- **Converted text and extracted assets** are caches that make non-text formats Agent-readable.
- **Vector indexes and bookkeeping** are rebuildable machine state.

Deleting derived state may require re-conversion or re-embedding, but it should not destroy original user content.

## 3.2 App Config

`~/.stashbase/config.json` is the only persistent StashBase app config file. It stores user-level configuration such as the folders in the local library, optional folder descriptions, the OpenAI API key, the HTTP MCP bearer token, Docker-access preference and port, the selected transcription provider/model/language, and first-run seed state. Settings is the management surface for credentials and local transcription models. Config writes use owner-only file and directory modes on POSIX; Windows uses the user's profile ACL rather than POSIX mode bits.

MCP client configuration is not stored in StashBase config. The Settings UI calls the server over HTTP; the server writes the target client's own config file when one-click setup is supported and generates the platform launcher command (`~/.stashbase/bin/stashbase-mcp` on macOS/Linux, `%USERPROFILE%\.stashbase\bin\stashbase-mcp.cmd` on Windows).

---

# 4. Format Handling

Different formats have different read and search paths. The product rule is: keep the source file as the user-facing file, and introduce derived representations only when search or Agent reading needs a better text form.

## 4.1 Read Path vs Index Path

| Format | Agent read path | Index input |
|-|-|-|
| Markdown | Source Markdown | Source Markdown |
| HTML | Source HTML | Extracted clean text / Markdown representation |
| Image | Source image | OCR-derived Markdown |
| PDF | Derived Markdown | Derived Markdown |
| DOCX | Derived HTML | Extracted clean text from derived HTML |
| Audio | Timestamped derived Markdown | Timestamped derived Markdown |

Markdown is edited, read, and indexed directly. Renderer callers cross the two-function seam in `web-src/src/markdown.ts`; the document pipeline is implemented under `web-src/src/markdown/` as focused modules for orchestration, sanitization, and preview-document presentation, with package-native Marked extensions for footnotes and heading IDs. The full read-only preview pipeline, iframe boundary, asset resolution, and navigation behavior are described in [markdown-rendering.md](markdown-rendering.md).

HTML stays as the source file. StashBase extracts clean text from HTML only as an indexing representation, so embedding and change tracking can operate on stable text. When an Agent reads an HTML file, it reads the original HTML.

Images stay as source images for viewing and Agent reading. OCR-derived Markdown exists to make image text searchable; it is not a replacement for the image itself.

PDFs are different: StashBase converts the document into derived Markdown, and that derived Markdown is used both for search and for Agent text reading.

DOCX is also different, but not in the same way as PDF. Browsers and Electron do not provide a reliable native DOCX viewer, so the renderer sends the source bytes to an on-demand Mammoth worker, which parses and sanitizes the semantic HTML before a no-scripts iframe displays it. This immediate visible preview does not depend on server preparation or block the renderer UI thread. A 20-second watchdog aborts a stuck fetch/worker and switches to the server-derived fallback instead of leaving the document on an indefinite loading screen. The server independently creates AppData-derived HTML for Agent reading, keyword/semantic indexing, and preview fallback; the original `.docx` remains the source file for both paths.

Audio remains the user-facing source file. `web-src/src/components/AudioPreview.tsx` composes the native player and structured transcript view; `useAudioTranscriptController.ts` owns the transcript request boundary, and `useAudioFallbackController.ts` owns the independent direct/fallback media-source boundary. `web-src/src/audio-transcript.ts` maps search metadata to structured segments, while `web-src/src/audio-playback.ts` separates logical source identity and position from the concrete media URL. Agent reads and both search paths consume the timestamped derived Markdown; the renderer consumes the sibling structured JSON. `shared/file-formats.ts` is the extension-membership source of truth used by server and renderer. Audio scheduler, cancellation, fallback, freshness, and readiness behaviour is specified in [data-layer §8.2](data-layer.md#82-conversion-scheduler-and-renderer-notification).

PDF preview still shows the original PDF, not the derived Markdown. The renderer uses pdf.js against the source PDF, installs the runtime polyfills pdf.js needs in Electron's current Chromium, loads the bundled pdf.js CMaps, fallback fonts, and WASM through same-origin `/pdfjs-assets/*` routes, and asks pdf.js to draw font glyph outlines itself instead of delegating embedded PDF font faces to Chromium. Because search and Agent answers can carry page references from the derived text, `web-src/src/components/PdfPreview.tsx` owns loading, lazy page rendering, retry/status chrome, current-page tracking, and page jumping, while `web-src/src/components/pdfText.ts` owns pdfjs text flattening, Markdown-noise cleanup, chunk matching, y-position mapping, and highlight rectangle calculation. The preview shows the current page, supports direct page jumping, and labels each rendered page with a lightweight page number. `web-src/src/components/MainPane.tsx` dynamically imports the PDF and DOCX viewers so pdfjs and Mammoth-related code stay out of the initial renderer chunk until a user opens those formats.

## 4.2 Derived Representations

PDFs, images, DOCX, and audio produce derived representations stored under AppData:

```text
paper.pdf  -> <appData>/derived.nosync/<source-path-hash>.md
shot.png   -> <appData>/derived.nosync/<source-path-hash>.md
brief.docx -> <appData>/derived.nosync/<source-path-hash>.html
meeting.m4a -> <appData>/derived.nosync/<source-path-hash>.md
             <appData>/derived.nosync/<source-path-hash>.transcript.json
             <appData>/derived.nosync/<source-path-hash>.audio-work/
             <appData>/derived.nosync/<source-path-hash>.preview.webm  # lazy playback fallback
             <appData>/derived.nosync/<source-path-hash>.preview.json # exact source signature
```

Derived content is stored under AppData, but indexed under the original source path when semantic indexing is available. Content-addressed formats pass the source hash bound to the completed derived output through the indexing handoff; the indexer never rebinds old derived text to bytes read from a later replacement. Keyword search can also read the AppData-derived text directly. Search results still point back to the visible source file.

PDF conversion extracts text and layout into Markdown. Image conversion uses OCR. If conversion fails, the original file remains available, but the file is not searchable until conversion succeeds. The failure is visible to the user and can be retried manually.

Both DOCX paths use Mammoth to extract semantic HTML; neither is a pixel-perfect Word renderer. `web-src/src/components/DocxPreview.tsx` owns the direct visible path and watchdog, while `web-src/src/workers/docxPreview.worker.ts` owns renderer-side parsing. `server/docx.ts` owns the durable AppData path and runs Mammoth in a terminable worker with a 60-second watchdog, so two malformed documents cannot retain both light-lane slots forever. Both paths apply the shared no-scripts trust policy from `shared/html-sanitization.ts`; durable fragments are sanitized before they are written and later served as fallback content. The renderer injects the source folder's asset base so relative links resolve consistently. Binary stat-version tokens invalidate an open or reactivated preview after external replacement. Neither path creates a visible `.html` or `.md` file next to the source document, and the durable derived HTML is rebuildable app-owned data.

`server/transcription-provider.ts` owns the provider registry plus the provider-neutral settings, selection, and inference contracts. `server/transcription-runtime.ts` is the composition root that registers built-in providers and connects their lifecycle hooks. `server/audio-transcription.ts` resolves configured selections and owns the provider-independent transcript and preview pipelines. `server/whisper-cpp-provider.ts` contains the local provider's `whisper-cli` and model-path details; `server/audio-media-tools.ts` contains the FFmpeg/ffprobe adapter; `server/transcription-tools.ts` resolves and owns native child processes. This keeps remote providers outside local executable and weight-file semantics. Runtime invariants are specified in [data-layer §8.2](data-layer.md#82-conversion-scheduler-and-renderer-notification).

`server/transcription-models.ts` owns the local model catalog, AppData paths, and model-management interface. `server/routes/transcription.ts` exposes provider-neutral preferences/settings, local model operations, and active-folder transcript reads; `web-src/src/components/settings/TranscriptionPanel.tsx` renders provider metadata and delegates local model actions to that route. `native/transcription/toolchain.json` is the build/runtime/package source of truth for the local provider and pinned native tools.

`server/conversion-dispatch.ts` is the single lifecycle dispatch seam from the shared convertible-source vocabulary to private PDF, image, DOCX, and audio adapters. It owns scheduling, rediscovery, fresh-derived indexing, format-specific manual-reset policy, readiness-before-reset, and interactive preparation/promotion. Upload, rename/move, folder rename, reconcile, and HTTP preparation routes call this seam instead of maintaining independent format switches.

`server/conversion-scheduler.ts` owns when work runs: lane capacity, priority, ageing, task identity/source scope, visibility, cancellation, queue position, and renderer revision tokens. It retains the filesystem spelling supplied by the first task for I/O and display, while delegating comparison identity and subtree matching to `server/filesystem-path.ts`; equivalent drive, UNC, separator, case, or Unicode spellings therefore cannot duplicate work on filesystems that treat them as the same path. `server/conversion.ts` owns conversion correctness and the public hidden-auxiliary scheduling seam: source signatures, artifact freshness, extractor lifecycle, cleanup, durable failure recording, and direct indexing on success. The format modules (`server/pdf.ts`, `server/image.ts`, `server/docx.ts`, and `server/audio-transcription.ts`) provide lane/cost specs and extractor implementations; they do not own queues. Scheduling is auxiliary; completion is still defined only by current format-specific final artifacts.

PDF, image, DOCX, and audio preparation all enter that shared scheduler. Audio preview conversion uses the hidden-auxiliary seam, while direct audio playback and renderer-side DOCX preview remain outside it. Format modules receive scheduler-owned cancellation and cooperative-yield capabilities without acquiring private queues. Capacities, ordering, cancellation, process lifecycle, and completion invariants are documented in [data-layer §8.2](data-layer.md#82-conversion-scheduler-and-renderer-notification).

Drag import streams multipart bodies into OS-temp staging. `server/import-publication.ts` validates the target, copies into a hidden same-directory temporary, and publishes through a no-clobber hard link or an ownership-recorded fallback rename. The recovery record stays beside OS staging so `server/routes/upload.ts` can retire a dead process's hidden temporary or reservation without deleting a completed rename. The route then sends text sources to the indexer and derived formats to `server/conversion-dispatch.ts`. Publication, cancellation, crash recovery, and size-bound invariants are documented in [data-layer §8.2](data-layer.md#82-conversion-scheduler-and-renderer-notification).

## 4.3 Conversion Boundary

StashBase owns format-specific preparation. The indexing layer only receives text.

For PDFs and audio, the prepared text is the Agent-readable text form. For HTML and images, the prepared text is an internal indexing input, not a replacement for the source file.

---

# 5. Index

Indexing makes prepared content searchable.

## 5.1 Indexing Layer

StashBase uses MFS as the indexing layer and Milvus Lite as the local vector store.

The index stores chunks, embeddings, source paths, line ranges, and file hashes. Paths are absolute so search results can be handed directly to an Agent's file tools.

MFS collect-all operations are adapted at the Python boundary for the local
Milvus Lite store. They read one unbounded scalar-query snapshot because local
segment order is not a global primary-key order and therefore cannot safely
drive pymilvus's primary-key cursor. Remote Milvus URIs retain MFS's native
iterator. This keeps status, reconcile, subtree cleanup, and row moves complete
after the collection grows beyond one iterator page.

## 5.2 Embedding

The current embedder is OpenAI `text-embedding-3-small`.

Without an API key, semantic indexing and semantic retrieval are disabled. File browsing, editing, preview, conversion, and keyword search can still work.

This is the main cloud tradeoff: user files remain local, but embedding generation currently uses a cloud model.

## 5.3 Incremental Updates

The index is updated by deterministic reconciliation, not by a global background crawler.

Reconcile compares local files against indexed records using content hashes. It adds new files, updates changed files, removes deleted files, and avoids re-embedding when content has not changed.

Common triggers include:

- server boot
- Welcome loading the library list
- opening or switching a folder
- returning focus to the app
- an Agent turn ending
- manual Sync
- MCP `reindex`
- OpenAI key changes
- transcription model installation or preference changes when the selected model is installed

---

# 6. Retrieve

Retrieval is how Agents and the UI find relevant local context.

## 6.1 Search Types

StashBase supports two retrieval paths:

- **Semantic search**: dense vector retrieval, combined with keyword signal through MFS/Milvus.
- **Keyword search**: literal search over source text plus AppData-derived PDF/OCR/DOCX/audio text, useful when embeddings are unavailable or exact matching is needed. `server/keyword-search.ts` owns the desktop keyword-search implementation: ripgrep JSON parsing for source text, AppData-derived text scanning for convertible sources, UTF-8 to UTF-16 match-range mapping, app-side whole-token filtering, snippet windowing, PDF page hints, exact audio timestamp extraction, subfolder scoping, file-type category filtering, and result merging. `server/routes/indexing.ts` owns HTTP request validation, folder scoping, escape-safe `path_prefix` resolution, `types` validation, and display-path remapping.

## 6.2 Scope

Search defaults to the whole library for MCP callers. It can be narrowed by folder root or path prefix.

The desktop UI search is scoped to the current folder because the UI is showing one folder at a time. The Search panel can narrow further: a subfolder scope (folder-relative, resolved escape-safe against the active folder) and file-type category chips (`shared/search-types.ts` defines the `notes` / `pdf` / `image` / `docx` / `audio` vocabulary; `server/format.ts` maps categories to source extensions). Both narrowing knobs apply to semantic and keyword modes and compose. The semantic path passes the extension filter to the daemon, which over-fetches from MFS (bounded), filters hits by source suffix, and truncates back to `top_k` before returning, so filtering happens before the caller-visible top-k cut; a very sparse type can still return fewer than `top_k` hits. The keyword path restricts the ripgrep target and the derived-text walk to the scoped subtree and enabled categories. Display-path remapping is unchanged: filters act on source paths, and derived notes never surface.

`server/index-status.ts` owns the folder-scoped readiness snapshot behind `/api/index-status`, including semantic pending work, conversion state, durable attention records, tree versions, and index warnings. `web-src/src/store/useSearchActions.ts` mirrors that snapshot for file rows and the Search view. The readiness, caching, failure, and cancellation rules belong to [data-layer §8.2](data-layer.md#82-conversion-scheduler-and-renderer-notification).

## 6.3 Result Mapping

Search results always use the visible source file as the identity and open target.

- **Markdown / HTML**: hits come from the source file text and point to the source file.
- **PDF**: hits come from AppData-derived Markdown. The result points to the original PDF path, but Agent text context should use the derived Markdown.
- **Image**: hits come from AppData OCR Markdown. The result points to the original image path; the OCR text is search evidence, while the image remains the read/view source.
- **DOCX**: hits come from AppData-derived HTML/text. The result points to the original DOCX path, but Agent text context should use the derived HTML.
- **Audio**: hits come from timestamped AppData-derived Markdown. The result points to the original audio path, while Agent reads use the transcript text.

---

# 7. MCP

MCP is the external interface of the library.

StashBase does not embed an LLM. It gives AI clients retrieval tools, explicit reindexing, and sandbox-safe access to opened folders.

## 7.1 Tool Surface

The core MCP tools are:

- **`library_info()`**: returns the default folder home, opened folders, optional folder descriptions, and embedder information so a client can orient itself.
- **`search_library(query, folder?, path_prefix?, top_k?)`**: searches the library and returns source paths, chunks, line ranges, and scores.
- **`reindex(folder?)`**: reconciles disk state with the index after local files change.

StashBase also exposes bounded file helpers:

- **`list_directory(path?)`**
- **`read_file(path)`**
- **`write_file(path, content, baseVersion?)`**
- **`edit_file(path, old_text, new_text, replace_all?, baseVersion?)`**
- **`move_file(path, new_path, cascade?)`**
- **`delete_file(path)`**

These helpers are not a second general-purpose filesystem. They exist because many local Agent clients run in sandboxes where the host user's files are not directly readable or writable. The helpers accept absolute paths under opened folders, hide app-maintained derived artifacts, map PDF/DOCX/audio reads to AppData-derived text, and update the semantic index when possible. The only AppData paths `read_file` accepts are manifest-known derived text files whose source PDF, DOCX, or audio file still belongs to an opened folder.

One-click MCP setup is available only for clients with stable local config files: Claude Code, Codex CLI, and Claude Desktop on macOS. Other MCP-capable clients use the standard JSON config shown in Settings. Codex is configured with prompting as the default approval mode. Low-risk tools that only orient, read, search, or refresh StashBase-owned index state (`library_info`, `list_directory`, `read_file`, `reindex`, `search_library`) are auto-approved. The built-in Codex panel applies its live Access mode at the MCP-approval bridge: in Edit mode it accepts only StashBase `write_file` and `edit_file` calls within the opened folder; moves and deletions remain on the approval-card path. Switching back to Ask restores the approval card. This does not alter the user's global configuration or approval behavior for other MCP servers.

The design boundary is:

- MCP provides orientation, retrieval, explicit reindexing, and sandbox-safe access to opened folders.
- StashBase does not expose arbitrary host paths.
- External file changes made outside StashBase must call `reindex` when the Agent needs those changes to become searchable.

## 7.2 One Library, One MCP Server

One machine runs one StashBase library through one MCP server.

External clients and the built-in Agent panel use the same MCP server while the StashBase app is running. CLI-backed panels rely on the same local client configuration that Settings writes; there is no separate built-in MCP path.

The server is reachable over two transports that share one implementation: `mcp/library-server.ts` owns the tool definitions and handlers, `mcp/server.ts` connects them to stdio for spawned clients, and `server/routes/mcp-http.ts` serves stateless Streamable HTTP at `POST /mcp`. Both paths forward every tool call to the same `/api/library/*` routes. `server/mcp-http-settings.ts` owns the Settings-managed bearer token, Docker preference, and configurable Docker port in `config.json`; `server/mcp-http-service.ts` owns listener lifecycle. The app server always mounts the token-gated endpoint on its loopback port. Docker access is explicit opt-in and uses a separate `0.0.0.0` listener whose Express app mounts only `/mcp`, so enabling it does not expose the rest of the StashBase API. Listener transitions are serialized and persistence failures roll exposure changes back. Settings reports desired/active state and bind/config errors, and token rotation takes effect on the next request without a restart. `server/shutdown-cleanup.ts` isolates listener, conversion, state database, and indexer cleanup so one failed close cannot skip later owners.

If the StashBase app is not running, the MCP server is unavailable in V1. This keeps process ownership simple.

## 7.3 Permissions

The stdio transport has no separate auth layer. This follows the local-first assumption: a spawned stdio server is reachable only by the client that spawned it, which is trusted as the local user. The HTTP transport is different: every `POST /mcp` requires the bearer token shown in Settings. The loopback app server retains its Origin allowlist, and the Docker-only listener does not enable browser CORS, so this is a server-client transport rather than a browser-page API. Enabling Docker access makes the MCP-only port reachable on host interfaces; the explicit toggle and bearer token are therefore both required.

The practical permission boundary in V1 is the opened-folder set. MCP file helpers cannot read or write outside those folders.

Hosted or multi-user versions would need a different permission model.

---

# 8. Built-In Agent Panel

The built-in panel is a convenience client for the same library, not a separate architecture path.

Renderer and visual-design rules for this panel live in [agent-panel.md](agent-panel.md). This architecture section only defines the system boundary and durable state model.

It runs the user's installed Agent CLI in the current folder and relies on the same global MCP configuration used by external clients.

Each opened folder has one root-level `AGENTS.md` file for durable Agent instructions about that folder. Built-in Codex uses it directly through the normal folder context. Built-in Claude uses a root-level `CLAUDE.md` bridge that contains only `@AGENTS.md`; the bridge is created on first Claude launch if missing. Both files are ordinary Markdown source files, so the user can edit or delete them.

Packaged builds resolve the user-installed `claude` and `codex` executables explicitly, including common Homebrew paths, npm global paths, and Windows npm command shims, before launching the built-in panel. This keeps the panel aligned with the user's normal CLI setup instead of depending on optional SDK binaries bundled in `node_modules`.

The key architectural point is:

```text
Built-in Agent panel -> same MCP server -> same library
External AI client   -> same MCP server -> same library
```

The Agent contract suite verifies declared parity and runtime states. Its native companion (`pnpm test:agent:native`) performs no-prompt protocol checks: Claude stream-flag availability and Codex app-server initialization.

The panel uses `server/agent-contract.ts` as its compatibility boundary. It owns the common connection lifecycle, prompts, interruption, normalized transcript events, approvals, history actions, and capability discovery. `server/agent-adapters.ts` declares the two production adapters against that contract; Claude's native bridge remains in `server/agent.ts`. `server/codex-agent.ts` is the stable Codex facade: `server/codex-session-runtime.ts` owns live WebSocket/turn state, `server/codex-history.ts` owns history processes and rollout supplementation, `server/codex-approval.ts` owns access and auto-approval policy, `server/codex-rpc-transport.ts` owns JSON-RPC correlation/dispatch, `server/codex-protocol.ts` owns shared value/tool normalization, and `server/codex-app-server-process.ts` owns executable resolution and process spawning. Runtime discovery probes the installed `claude` or `codex` executable when the catalog is requested, reports `available`, `unavailable`, or the last runtime `failed` state, and returns declared adapter capabilities with the common `/ws/agent` endpoint. `server/__tests__/agent-contract.test.ts` verifies the declared shared surface and runtime states. The renderer selects an adapter by id and uses this metadata rather than assuming a CLI version or adding endpoint-specific branches. Attachments are explicit: the currently open document is not sent as Agent context unless the user adds it by drag/drop, file picker, or mention. Claude and Codex share the same composer controls: Access on the left of the right-side control group, Effort on the right. Access is an action-permission setting and remains available during a chat. Plan uses a read-only session; Ask presents approvals for workspace-changing actions; Edit auto-accepts only ordinary Codex file-change grants and StashBase `write_file`/`edit_file` calls rooted in the opened folder. Network access, sandbox or broader-filesystem grants, commands, renames, and deletion remain on the shared approval-card path. Each adapter applies the selected Access Mode when it creates its native session; Claude applies later changes through the SDK's live permission-mode setter. Effort is a session-start setting, so the control is editable only before a chat has messages. A built-in Agent session still runs one turn at a time; if the user submits a follow-up while a turn is active, the renderer queues it visibly. Claude sends queued follow-ups after the active turn ends. Codex can also steer the active turn through app-server `turn/steer`; steered follow-ups are removed from the next-turn queue after app-server accepts them. Claude SDK permission callbacks and Codex app-server approval requests are normalized into the same renderer permission card. Awaiting permission cards remain outside collapsible tool-activity groups, so their Allow and Reject controls are always visible. A terminal turn event settles any tool still marked running, preventing a missed per-tool notification from leaving stale activity. Tool activity is always collapsed initially, including restored History, so background work stays compact until the user explicitly inspects it. When app-server history omits tool calls from a desktop-origin Codex thread, StashBase supplements only those missing calls from the thread's local rollout file under `~/.codex/sessions`; all other transcript data remains app-server sourced. Local Markdown file links in an agent response use the same folder-safe selection path as artifact Open controls; external URLs and anchors retain their normal behavior. Codex MCP tool approval arrives as an MCP elicitation request; the adapter translates tool-call approvals into the same allow/deny flow and cancels non-approval elicitations. Startup or runtime fatal errors render inside the message area with Retry instead of leaving an empty chat surface. Long user prompts and queued follow-ups are collapsible so sticky turn headers do not dominate the viewport. Historical user prompts expose copy only; when the user stops an active turn, the interrupted prompt becomes editable in place and can be resent as a new prompt.

The Claude and Codex chrome icons are selectors for the open tab of their agent, not new-chat controls. Each agent keeps an in-memory activation order for its open tabs; selecting its icon activates its most recent tab, or creates one when it has none. Selecting the already-active agent collapses the panel without changing tabs. The AgentView header `+` is the explicit new-chat control. Delete Chat permanently removes the native session for either adapter — Codex uses app-server `thread/delete` — then clears the current tab's transcript and restores an untitled fresh chat in that tab. Closing the final tab clears this renderer-only state and closes the panel; no empty panel or persisted history picker is shown.

Claude session titles come from the Claude SDK history metadata. Codex threads are listed through Codex app-server's thread APIs and filtered by the current folder `cwd`, not by Codex's internal source kind. Codex threads are named from the first user prompt when StashBase creates the thread so the tab title and History list do not stay on the placeholder.

---

# 9. Release Pipeline

Source validation and platform packaging are separate GitHub Actions workflows. `.github/workflows/ci.yml` validates pull requests and pushes to `main`. Publishing a GitHub Release, or manually dispatching a platform backfill, starts the existing macOS, Linux, and Windows packaging workflows.

The source CI matrix runs scheduler, cancellation, renderer, server, MCP, and Python gates on macOS, Windows, and Linux. Platform packaging builds pinned `whisper.cpp`, FFmpeg, and Opus sources into a transcription sidecar for macOS arm64, Linux x64, or Windows x64. x64 whisper.cpp builds disable host-native instruction selection and retain runtime dispatch; macOS builds target 12.0 consistently across CMake and FFmpeg, disable the optional BLAS backend whose current SDK surface requires a newer OS, and retain Metal plus the generic CPU backend. Packaging rejects missing or empty binaries/licenses/notices, wrong executable formats, drift in every pinned version/commit/build option, FFmpeg configurations that enable GPL/nonfree components or omit libopus, and macOS helpers whose load-command minimum exceeds 12.0. Platform release smoke tests start the packaged server, exercise the native PDF/OCR helpers, verify and execute the DOCX worker, explicitly download and checksum-verify the Tiny speech model, transcode a WAV fixture through packaged FFmpeg, run packaged whisper.cpp inference, validate the transcript contract, and generate/serve the WebM fallback before an artifact is uploaded.

Each platform workflow calls `.github/workflows/release-ci-gate.yml` before its packaging job. The gate resolves the release tag to its exact commit, including annotated tags, and queries GitHub Actions for a successful `ci.yml` push run with the same commit SHA. It waits for an absent or active run for up to fifteen minutes and blocks packaging when the matching run fails, is cancelled, or never succeeds. The gate implementation is read from the default branch so a manual dispatch can validate an older tag; the platform job still checks out and packages the requested tag.

Version selection, the version-bump commit, tag creation, and GitHub Release publication remain maintainer-controlled.

---

# 10. Boundaries

This architecture document does not try to specify every implementation detail.

Details that belong elsewhere:

- desktop UI layout and interaction details
- PDF/OCR batching, retries, and packaging mechanics
- low-level daemon lifecycle and lock handling
- component/file ownership maps
- built-in Agent panel UI protocol

Those topics can live in engineering notes or module-specific docs. The core architecture remains:

```text
Local files -> Convert -> Index -> Retrieve -> MCP -> Agents
```

StashBase makes local files readable and searchable for Agents.
