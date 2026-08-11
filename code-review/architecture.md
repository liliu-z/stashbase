# Architecture

> Cross-cutting engineering map. Product-level boundaries live in
> [design-docs/architecture.md](../design-docs/architecture.md); focused
> invariants live in the contracts linked below.

## Runtime Shape

```text
Electron renderer windows
        │ per-window identity over HTTP / WebSocket
        ▼
Node application server
  ├─ local file operations and preparation orchestration
  ├─ built-in Agent bridge
  ├─ MCP transports and library operations
  └─ Supabase session and loopback embedding broker
        │
        ▼
Python indexing daemon → one local Milvus Lite store
        │ hosted source only: process-ephemeral localhost credential
        ▼
StashBase hosted embedding API
```

One application session may own several renderer windows. They share the Node
server, Python daemon, library membership, settings, derived state, and MCP
service. Each renderer retains its own active folder, documents, search
presentation, and Agent tabs.

## Ownership Boundaries

- The user owns source files and visible `AGENTS.md` / `CLAUDE.md` files.
- The Node server owns authorized filesystem operations, format preparation,
  reconcile orchestration, Settings writes, MCP, and Agent adapters.
- The Python daemon owns chunking, embeddings, vector storage, and semantic
  retrieval. It receives text and source identity; it never decides how a
  source format is converted. For hosted embeddings it calls a Node-owned
  OpenAI-compatible loopback broker and never receives Supabase tokens.
- The Node server alone stores and refreshes the optional account session. It
  assigns hosted request idempotency keys, labels index versus query purpose,
  and exposes only display/quota state to renderer windows.
- Renderer state is presentation and request coordination, not durable data
  truth. It cannot define preparation completion, index currency, file
  versions, or library membership.
- Settings is the only product surface for BYOK credentials. Account OAuth may
  start from explicit setup, Settings, or account-menu Sign in actions; its
  refreshable session remains Node-owned. Environment variables may select
  isolated test/runtime seams but are never the user's credential source of
  truth.
- Settings persistence remains atomic and fails closed when its path is not
  writable. The application reports the failure but never repairs filesystem
  ownership, flags, or ACLs on the user's behalf.

## Primary Data Flow
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

Search defaults to the whole library for MCP callers and for the in-app search
popup alike. Either can narrow scope by folder root or path prefix; file-type
categories are an agent-facing parameter the in-app popup does not expose. The
detailed filtering contract lives in [§6.2](#62-scope).

On server boot, StashBase binds every library folder into the daemon and then reconciles them in the background. The sidebar library list also reconciles the non-current library folders with a short cooldown and polls their status while it is visible and idle. While a folder is actively opening, that polling and reconcile are deferred so navigation does not compete with preparation work.

Opening a folder is a navigation action first and a preparation action second. Once the server accepts the target folder, the renderer enters the folder view before recursive file listing, file ordering, or index status finish. Those follow in the background. There is no landing page: a window that boots without a current folder auto-opens the most recent library folder, and an empty library leaves the window on the no-folder workspace with the sidebar's add-folder affordance.

Each opened folder can carry a short optional description in app config. The description is orientation metadata for humans and Agents: it explains what the folder is for, but it is not indexed content and it does not define access scope. It can be written by the user first and later generated or refreshed by AI. Removing a folder from "Your Folders" removes its description with the folder membership record.

Renderer state orchestration lives under `web-src/src/store/`. `state.ts` is the stable state-model and action-contract facade, `stateHelpers.ts` owns reusable pure transitions and layout bounds, and `stateReducer.ts` applies the action union. `useActiveFolderWorkspace.ts` is the active-folder workspace module: it owns folder, document, retrieval, and lifecycle ordering, including polling, focus reconciliation, binary refresh, and context-release persistence. It composes `useDocumentActions.ts`, `useFileActions.ts`, `useSearchActions.ts`, and `useFolderActions.ts` as private implementation details; presentation callers must use the workspace interface rather than coordinate those actions or freshness guards themselves. The interface must retain its identity when its commands are unchanged: document surfaces use it in effects, and a replacement while Find is open re-registers the controller and can create a render loop. Its lifecycle seam has two adapters: Electron context-release callbacks and the browser unload fallback. `AppContext.tsx` composes that workspace with shell-owned chat, feedback, and Find interaction. `useFindActions.ts` and `useFeedbackActions.ts` remain shell presentation protocols; search-hit navigation remains in the workspace. `indexStatusRequest.ts` is the narrow request-lifecycle seam that classifies status responses against folder-transition state without owning scheduling, recovery, or renderer state. `web-src/src/components/MainPane.tsx` dynamically imports format- and mode-specific heavy viewers/editors, including audio, PDF, DOCX, Markdown preview, and the Markdown editor, so the initial renderer chunk carries the common browsing surface first. `web-src/src/App.tsx` also dynamically imports the chat pane; the sidebar's New Chat entry stays in the initial shell, while Agent transcript rendering and the CodeMirror mention composer load only after chat is opened. The library search popup follows the Quick Open loading shape: `LibrarySearch.tsx` keeps the open-event listener eager and dynamically imports `LibrarySearchDialog.tsx` on request. Its remembered query, mode, scope, and results live in module memory (`web-src/src/librarySearch.ts`), deliberately outside the reducer: both folder-switch reset paths wipe reducer search fields, and the popup's own cross-folder result-opens must not clear it. The sidebar dynamically imports the document-outline list when a Markdown outline is visible. Its eager files surface checks semantic-indexing and unsupported-file state before importing those normally absent disclosures. Quick Open keeps its shortcut listener in the initial shell but dynamically imports ranking and picker rendering after an open request, so the first shortcut cannot race module loading. Context-menu and image-lightbox implementations also load only after their state-backed requests exist. The embedder-key gate keeps folder probing and overlay ownership eager, then loads its form only when setup must open. `scripts/check-renderer-chunks.mjs` requires these twelve designated dynamic entries and caps the entry chunk plus its recursive static imports at 416 KiB. `web-src/src/components/ErrorBoundary.tsx` retries each dynamic import once and contains a persistent failure inside the affected interaction, chat, search, Quick Open, or document surface; a changed request, document identity/version, chat surface, or sidebar view clears that local failure, while the root boundary remains the final recovery path for unrelated renderer errors. `web-src/src/components/ChatPane.tsx` keeps tab navigation outside one boundary per mounted Agent session, so a render failure in one tab cannot hide the controls needed to switch or close it.

Toast lifecycle is intentionally not reducer state: the shared Base UI toast
manager owns timeout, close, announcement priority, and viewport navigation.
`useFeedbackActions.ts` preserves the stable `actions.toast` interface, while
the UI adapter preserves duplicate collapsing.

Blocking renderer surfaces register with the shared overlay stack before any
lazy implementation loads. The stack is the single topmost-owner seam for
sibling and nested dialogs; Base UI still owns focus trapping and dismissal
inside a loaded surface, while the native-modal loading adapter preserves the
same modality during chunk loading. Feature code must gate close intent through
the layer result rather than add document-level Escape listeners.

Quick Open is a renderer-only active-folder navigation surface. It ranks the
already visible source-file list and accepts through `selectFile`; it must not
bypass that action's save guard, folder-generation check, or preview-tab
semantics. Its keyboard owner is active only while topmost: Settings announces
its separate local blocking state to the picker, while reducer-backed confirms,
cascade prompts, context menus, inline rename, modal veils, and explicitly
marked local dialogs prevent invocation. Open-file recency is folder-local and
separate from tab-strip order. Dismissal restores the element that invoked the
picker. Its `>` provider is Command Palette, also entered directly with
Cmd/Ctrl+Shift+P or F1. Command definitions have stable identities and
availability predicates, call established renderer actions, and keep command
recency in picker-local session memory only. Do not turn either provider into a
retrieval, cross-library, Agent-permission, or destructive-operation surface.
Content retrieval has its own surface: the library search popup
(`LibrarySearch.tsx` / `LibrarySearchDialog.tsx`) shares the picker chrome and
the same topmost/blocking rules (its veil carries `quick-open-blocking`) and
opens results through `openLibraryFile` — same-folder hits route to
`selectFileWithHighlight`, cross-folder hits open an out-of-folder tab, and
NEITHER path may switch the window's folder (only the no-folder workspace
binds the picked folder). Save guards and generation checks stay intact.

Out-of-folder tabs (`OpenFile.folder` set — a search hit viewed without
switching the window's folder) carry hard invariants: document identity is
(folder, rel name), never rel name alone (`isFolderFileTab` excludes them);
they are strictly read-only (`FILE_OPEN` never arms Live Editing,
`EDIT_MODE`/`toggleEditMode`/`flushSave` all refuse, the palette hides Toggle
Editing) because every write route resolves against the WINDOW's folder; they
never enter `selectedPath`, `recentFilePaths`, `PRUNE_MISSING_FILE_TABS`, or
`REMAP_PATHS`/delete cascades keyed on active-folder rel paths; and every
fetch they cause carries the folder explicitly — `?folder=` on the file
read/stat/audio JSON routes, the reserved `__folder/<double-encoded-abs>/`
path token after `__window/<id>/` on `/asset*` URLs (path-carried because
`<base href>`, iframe sub-assets, and the pdfjs worker cannot send headers).
The server validates membership on both forms and scopes resolution with the
refcounted `runWithFolderRoot` binding; write routes never accept either.
Links inside such a document resolve back to its own folder via the same
token (`resolveMilkdownLink` folder capture, preview-iframe `stashbase-nav`
`folder` field). The document banner's "Open Folder in New Window" is the
escape hatch to full editing.

Transient external tabs (`OpenFile.isExternal` set) represent files opened from outside the library (via drag-and-drop or native OS requests). They carry the following invariants:
- The desktop main process owns the preview grant registry (`activePreviewGrants` mapping `grantId` to `{ windowId, filePath }`).
- The Express server acts as the validator, verifying that the request's window ID (`currentWindowId()`) matches the grant's window ID before serving the file under `/asset-preview-grant/:grantId` or `/api/grant/:grantId/text`. Sibling files in the same directory are blocked.
- Closing the tab in the renderer or closing the window in the main process revokes the grant, making the file inaccessible.
- Transient tabs are strictly read-only: editing, saving, renaming, deleting, and reprocessing are disabled.
- They are completely isolated from library membership, search indexes, Quick Open, recents, MCP, and Agent context unless explicitly imported by the user.
- During a drag-and-drop event, `useGlobalDragDrop` distinguishes the Files sidebar (copy/import) from the main document pane (open temporarily) using the `.sidebar` CSS class target, setting the cursor dropEffect to `copy` or `link` respectively. The DropVeil visualizes these zones side-by-side using the `sidebarWidth` state.
- Native open requests (macOS `open-file`, CLI arguments, second-instance args) are queued by the main process until the renderer registers readiness via `renderer:ready-for-native-files`, preventing race conditions. Subsequent requests are dispatched to the most recently focused window.
- Directories dropped on the main pane or app icon are rejected and not recursively imported.


Editor History (`state.editorHistory`, `web-src/src/editorHistory.ts`,
`EditorHistoryNavigator.tsx`) is `state.tabs`' id-level most-recently-activated
order, separate from `recentFilePaths` (Quick Open's folder-local file recency,
which can outlive a closed tab) and from tab-strip order (`TABS_REORDER` never
touches it). Every tab-creating or tab-activating action records itself;
`CLOSE_TAB` / `PRUNE_MISSING_FILE_TABS` / `TABS_RESET` drop entries so the
navigator never offers a tab that no longer exists. The Ctrl+Tab chord binds
the literal Control key on every platform, including macOS, matching VS
Code's own default — Cmd+Tab is the OS application switcher and never reaches
an Electron window.

Hotkeys owns the raw keydown for the chord (mirroring how it dispatches
Quick Open's Cmd+O) and dispatches `stashbase-open-editor-history` on every
qualifying Tab press while Ctrl is held, not just the first. The navigator
tells opening from cycling apart by an internal `closed`/`pending`/`open`
phase: the first press arms a pending switch (list computed, index picked)
without rendering anything; releasing Control within `REVEAL_DELAY_MS`
(150ms) commits that pending switch directly, so a quick tap never paints
the overlay. Only a hold past that window, or a second Tab tap arriving
first, reveals the overlay and enters cycling mode. While pending, nothing
owns keyboard focus yet, so a `document`-level listener handles release-to-
commit and Escape-to-cancel; once open, the navigator's focused root owns
Tab/Shift+Tab (cycle)/Enter/Escape/Control-release through React's synthetic
handlers and stops propagation, the same topmost-owns-input contract Quick
Open follows. It carries Quick Open's `quick-open-blocking` marker class for
mutual exclusion and reuses `activateTab` to commit, preserving that
action's dirty-buffer save guard. There are no editor groups, so this is one
navigator over one list, not a per-group picker.

The renderer's local HTTP boundary keeps `web-src/src/api.ts` as the stable endpoint facade. `shared/conversion.ts` and `shared/transcription.ts` own the preparation and transcription contracts consumed on both sides of that boundary; `apiTypes.ts` re-exports them and owns the remaining renderer-only request/response shapes. `apiTransport.ts` owns per-window request identity, JSON/error normalization, retry policy, and folder-relative path encoding. `web-src/src/preparation-copy.ts` translates queued and yielded preparation waits into shared user-facing copy without exposing scheduler lanes or positions. `web-src/src/audio-transcript.ts` maps semantic text or an explicit keyword-result millisecond timestamp back to the exact structured transcript segment and owns the remaining transcription-specific status copy, while `web-src/src/audio-playback.ts` retains logical playback position across direct-to-fallback source replacement.

Electron assigns each `BrowserWindow` a stable identity through its preload
arguments. The renderer uses that identity for HTTP headers, asset URLs, and
Agent WebSockets, and reports folder transitions back to the main process. The
main-process registry uses those transitions to focus an existing matching
folder window, excluding the sender when the user explicitly asks to open its
current folder in another window. Native close first requests an awaited
renderer save acknowledgement; failure or timeout leaves the window open.
Only then does close remove the registry entry and retry server cleanup. The
server retires the identity with a bounded tombstone before clearing its
folder and Agent context, so a late open request cannot recreate a ghost
window. Folder removal uses the same save barrier for every matching window,
then broadcasts the committed membership change so those renderers return
Home; 412 recovery checks durable membership before attempting a restart
rebind. An individual close never tears down the shared server. A
single-instance lock plus a single-flight initial-window operation prevents a
second launch during startup from creating a duplicate. The application menu
owns the window lifecycle commands using the platform mappings documented in
[Local File Workspace](../design-docs/design/library.md). The renderer must
yield those native window chords without narrowing the established modifier
handling of unrelated document commands. The menu advertises the platform
accelerator, while the `BrowserWindow` input boundary dispatches it and owns
the secondary non-macOS binding that cannot fit on the same menu item. macOS
activation recreates a window after the last one closes, while non-macOS
platforms quit after the last window closes. The real Electron lifecycle smoke
must send the platform accelerator input, enforce a parent-owned deadline, and
delete its isolated profile only after the child process exits.

The preload marks the renderer with both `is-electron` and the exact
`platform-${process.platform}` class. The HTML chrome remains draggable on all
desktop platforms, but macOS traffic-light spacing and fullscreen compensation
must be selected through `platform-darwin`; Windows and Linux must not inherit
that inset.

Electron owns the child server through a random per-launch shutdown token.
Quit sends an authenticated loopback shutdown request and waits for the server
cleanup ladder to exit before terminating Electron. Signals are timeout
fallbacks only, because Windows child-process signals are forceful rather than
graceful.

---

# 3. Storage

The file system is the source of truth. Converted content, indexes, and app state are derived from local files.

## 3.1 Source and Derived Data

User-visible files stay in the folder tree. StashBase has one user-level config file under the user's home directory. Derived state stays in AppData.
>>>>>>> cbf1692 (docs(desktop): document transient external files and preview grant invariants)

```text
source file
  → direct text or format preparation
  → exact retrieval and optional semantic index
  → visible-source evidence
  → built-in or external Agent through the same MCP operations
  → explicit source-file write
  → reconcile into future context
```

Generated text and index rows are rebuildable. Every read, result, and mutation
that crosses a product boundary retains or resolves to an authorized visible
source file.

The desktop popup's semantic path uses the same ungated
`POST /api/library/search` that powers MCP `search_library`; its exact path
uses `POST /api/library/keyword-search`, a library-operations sweep that runs
the per-folder ripgrep + derived-text search across every member folder
(bounded concurrency, one shared delivered-match cap) and returns
folder-qualified relative paths. A folder scope (with an optional escape-safe
subfolder prefix) narrows either call; `normalizeLibrarySearchScope` rejects a
prefix outside the requested folder instead of silently widening and derives
the owning member for a prefix-only scope. File-type category chips are
agent-facing only (`shared/search-types.ts` defines and validates the
`notes` / `pdf` / `image` / `docx` / `audio` vocabulary; `server/format.ts`
maps categories to source extensions). Scope and type narrowing compose; the
semantic path filters daemon results back to `top_k`, the keyword path
restricts ripgrep and the derived-text walk to the scoped subtree, and both
report partial availability when a bound omitted matches. Display-path
remapping is unchanged: filters act on source paths, and derived notes never
surface.

## Cross-process Contracts

- Every renderer request carries a stable window identity. Folder context is a
  server-side binding, never a global current-folder variable.
- Shared services outlive an individual window. Window retirement cannot close
  the server, daemon, settings, or MCP resources while peers remain.
- The server is the only owner allowed to bind folders into the daemon. Callers
  use folder-explicit operations instead of temporarily changing global
  context.
- Application quit is an authenticated owner-to-server shutdown handshake.
  Signals are timeout fallbacks, not the normal cleanup path.
- The shutdown ladder closes hosted-broker listening, active, and idle sockets
  independently of MCP, Agent-install, conversion, database, and indexer
  cleanup failures.
- Static renderer serving must bypass every API and asset route before serving
  the web bundle.

## Durable Seams

The main ownership seams are intentionally narrower than this map:

- [Window Lifecycle](window-lifecycle.md) — renderer readiness, save barriers,
  identity retirement, multi-window behavior, and shutdown.
- [Bug Reporting](bug-reporting.md) — local collection, sender-bound review,
  immutable approval, artifact handoff, and privacy.
- [Renderer Workspace](renderer-workspace.md) — per-window folder, document,
  retrieval, and shell transition ownership.
- [Data Lifecycle](data-lifecycle.md) — preparation, indexing, reconcile,
  cancellation, and derived-state cleanup.
- [File Transactions](file-transactions.md) — path safety and durable source
  mutations.
- [Document Viewers](document-viewers.md) — non-Markdown preview and content
  trust boundaries.
- [Settings and Config](settings-config.md) — durable configuration and
  runtime reconfiguration.
- [MCP Access](mcp-access.md) — external and built-in library access.
- [Agent Runtime](agent-runtime.md) — CLI discovery, preparation, native
  sessions, and history.
- [Release Pipeline](release-pipeline.md) — CI and packaged native ownership.

## Implementation Map

| Role | Stable entry points |
|---|---|
| Renderer workspace Interface | `ActiveFolderWorkspace` in `web-src/src/store/useActiveFolderWorkspace.ts` |
| Window/context owners | `electron/main.cjs`, `electron/multi-window.cjs`, `server/folder.ts`, `server/routes/window-context.ts` |
| Application server composition | `server/index.ts`, with focused behavior behind route and service Modules |
| Data lifecycle Interfaces | `server/conversion-dispatch.ts`, `server/conversion-scheduler.ts`, `server/indexer.ts`, `server/mfs-daemon.ts` |
| Library/MCP Interface | `LibraryOperations` in `server/library-operations/index.ts` |
| Agent Interface | `AgentAdapter` and normalized events in `server/agent-contract.ts` |
| Process Adapters | Electron preload/HTTP, MCP stdio/HTTP, Agent native protocols, the Python daemon protocol, and the hosted embedding loopback broker |

This map names ownership Seams, not every runtime file. Follow the focused
contract before reading an owner Module's internals.

## Architectural Review Questions

- Has an owner changed, or has a second owner been introduced for the same
  state?
- Can a window, request, task, or process finish after its identity is stale?
- Can derived or renderer state be mistaken for source truth?
- Can a folder-explicit operation accidentally depend on whichever folder a
  window currently shows?
- Does a failure release every resource while preserving a recoverable source?
- Does a new surface bypass the library membership, path, credential, or
  permission boundary?

## Validation

Run `pnpm typecheck` for every implementation change. Cross-process ownership
changes also run `pnpm test:electron` and `pnpm test:electron:smoke`; renderer
boundary changes run `pnpm build:web`. Add the exact suites from every focused
contract crossed by the change. Use [Journey Coverage](journey-coverage.md)
before adding broad E2E coverage.
