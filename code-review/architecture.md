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

Related journey: [J09](../design-docs/user-journeys.md#j09-prepare-and-hand-off-a-bug-report)
for the bug-report review process boundary. Other architectural changes use the
focused journey routes in [Journey Coverage](journey-coverage.md).
