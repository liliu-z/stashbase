# MCP Access

> Review contract for MCP tool behavior, transport exposure, credentials, and
> authorized library scope.

## One Library, One Operation Layer

The built-in Agent panel and external clients call the same library operations.
Stdio, Streamable HTTP, and app HTTP routes are adapters over that operation
layer; none may implement a broader filesystem path or a different source
identity rule.

Core operations provide library orientation, search, reindex, bounded read and
write helpers, and project creation. File helpers exist for sandboxed local
clients and are not a general host-filesystem API.

## Access Invariants

- Every file path resolves under an authorized library member. Hidden derived
  data is not listable or writable; a read may consume manifest-known current
  derived text only through its live visible source.
- Search defaults to the whole library and may narrow to a member folder, safe
  path prefix, and validated source-type category. Invalid narrowing fails; it
  never silently widens.
- `search_library(query, mode?, folder?, path_prefix?, types?, case_strict?,
  whole_word?, top_k?)` searches in semantic mode by default or exact keyword
  mode, returning the same source-hit shape; keyword mode requires `folder` or
  `path_prefix`, and `types` accepts the shared source categories.
- Results retain absolute visible-source identity for Agent tools. Converted
  evidence never exposes an AppData path.
- `library_info` returns folder identity and provider state, not a second
  folder-description store. Durable folder purpose and working instructions
  remain visible, user-owned source in `AGENTS.md`.
- File mutations use the shared transaction/version boundary and schedule or
  reconcile index maintenance after success.
- `list_directory` enumerates only the requested directory surface and does
  not read file bodies. `read_file` has an `8 MiB` response ceiling for source
  and current derived text; oversized content fails explicitly rather than
  consuming unbounded server memory.
- Format capability follows the
  [Documents matrix](../design-docs/design/documents.md#format-capability-matrix):
  `read_file` returns direct Markdown, HTML, or JSON source text and current
  prepared PDF, DOCX, or media text; it does not return image bytes.
  `write_file` and `edit_file` accept Markdown, HTML, and JSON source text only.
  Previewability or built-in image attachment support must not be generalized
  into external MCP text-read capability.
- `create_project` creates only beneath the default folder home or an already
  authorized location. Both the selected location and creatable target must
  remain inside that owned root after symlinks are resolved. The operation
  seeds missing Agent instructions create-only and registers the folder.
  Session rebind requires trusted live-session attribution; ambiguous or
  external callers only create and register.

## Known Gap — JSON Tool Description

Shipping `write_file` and `edit_file` operations accept JSON through the same
versioned text transaction used by Markdown and HTML, and focused mutation
tests exercise that behavior. Their current MCP tool descriptions name only
Markdown/HTML, so clients may underuse a real capability. Until the tool
metadata is corrected and locked by focused evidence, treat the operation and
the product matrix as implementation truth rather than the narrower copy.

## Transports and Credentials

- Local stdio is reachable only by the spawning local client and has no second
  auth protocol.
- Streamable HTTP requires the live bearer token from Settings on every POST.
  Rotation invalidates the old token without restart.
- The application server stays on loopback. Docker access is explicit opt-in
  through a separate host-facing listener whose app mounts only `/mcp` and
  still requires the bearer token.
- Browser Origins and CORS remain closed to page clients. URL access is a
  server-client transport.
- Desired Docker state and port are durable; active listener state is runtime
  only. Listener transitions serialize, report bind/config errors, and roll
  exposure back if persistence fails.
- Credentials live in the single app config and are managed through Settings,
  never environment variables or an untracked second credential file.

## Client Configuration

StashBase writes MCP client configuration only for the built-in Chat agents:
Agent readiness calls `ensureAgentMcp` (Claude Code, Codex), which regenerates
the platform MCP launcher and idempotently rewrites that agent's own config.
StashBase config does not mirror client config. Every external client —
including Claude Desktop — is configured by the user from the read-only
Settings → MCP page (standard stdio config, URL access, token, Docker
opt-in); manual and URL setup are documented in
[docs/mcp-configuration.md](../docs/mcp-configuration.md). No route connects
or disconnects a third-party client. A built-in Agent's MCP failure may link to
this page as a manual recovery reference, but retry remains owned by Agent
readiness.

## Permission Boundary

Read, orientation, search, and StashBase-owned reindex work may use the low-risk
approval path. Ordinary `write_file` and `edit_file` may be accepted only by
the built-in panel's explicit Edit policy. Move, delete, commands, network,
sandbox changes, and broader access remain explicit approval decisions.

`create_project` creates a new source folder and changes Library membership.
A built-in Agent call must follow an explicit user request or a visible
approval that names the action and target; exploratory conversation alone is
not consent. The operation returns the resolved project path. Only an
attributable live Library Chat may rebind to it; folder-bound, stale,
unattributed, and external callers never redirect a built-in session.

## Implementation Map

| Role | Stable entry points |
|---|---|
| Operation Interface | `LibraryOperations` and `createLibraryOperations` in `server/library-operations/index.ts` |
| Operation owners | retrieval, project creation, and `server/library-file-mutations.ts` behind that Interface |
| Stdio Adapter | `mcp/library-server.ts` and `mcp/server.ts` |
| HTTP client Adapter | `mcp/library-operations-http.ts` |
| HTTP server Adapter | `server/routes/mcp-http.ts` and `server/mcp-http-service.ts` |
| Settings Interface | `server/mcp-http-settings.ts` and the narrow read/HTTP routes in `server/routes/mcp.ts` |
| Launcher and built-in agent wiring | `ensureAgentMcp` and `ensureMcpLauncher` in `server/agent-mcp.ts` |
| Focused evidence | `server/library-operations/index.test.ts`, `server/routes/library-files.test.ts`, and `server/__tests__/mcp-http-*.test.ts` |

## Validation

Run:

```bash
pnpm typecheck
pnpm test:mcp
pnpm test:library-files
pnpm test:retrieval
```

Add `pnpm test:config` for persistence changes. Cover token rotation, malformed
config, Docker bind failure/rollback, concurrent listener transitions, invalid
scope, and built-in/external result parity.

Related journeys: [J05](../design-docs/user-journeys.md#j05-search-and-open-source-evidence),
[J06](../design-docs/user-journeys.md#j06-start-and-continue-an-agent-chat),
[J07](../design-docs/user-journeys.md#j07-converge-chat-into-a-document), and
[J08](../design-docs/user-journeys.md#j08-connect-an-external-agent-through-mcp),
plus the [J10](../design-docs/user-journeys.md#j10-turn-a-local-project-into-durable-agent-assisted-work)
core loop and
[J11](../design-docs/user-journeys.md#j11-turn-a-conversation-into-a-project)
conversation-to-project transition.

Related contracts: [File Transactions](file-transactions.md),
[Data Lifecycle](data-lifecycle.md), [Settings and Config](settings-config.md),
and [Agent Runtime](agent-runtime.md).
