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
  mode, returning the same source-hit shape and the strategy actually used.
  Both strategies default to the whole library and `types` accepts the shared
  source categories. Library-wide keyword search fans through member roots at
  the operation boundary rather than exposing that folder-rooted mechanism to
  callers.
- An attributable panel session may resolve any `search_library` request to
  keyword mode while its Similarity Search control is Off. This policy comes
  from trusted transport attribution, never model-controlled tool arguments;
  ambiguous or external callers retain their requested strategy.
- Results retain absolute visible-source identity for Agent tools. Converted
  evidence never exposes an AppData path.
- `library_info` returns folder identity and provider state, not a second
  folder-description or Agent Instructions store. StashBase Chat instructions
  are injected verbatim by the panel Runtime Adapter. The MCP server publishes
  capability and tool descriptions but no second top-level instruction prompt;
  user-owned portable rules may remain visible source in `AGENTS.md`.
- File mutations use the shared transaction/version boundary and schedule or
  reconcile index maintenance after success.
- `list_directory` enumerates only the requested directory surface and does
  not read file bodies. `read_file` has an `8 MiB` response ceiling for source
  and current derived text; oversized content fails explicitly rather than
  consuming unbounded server memory.
- The Workbench tree is intentionally wider than the Agent file surface.
  Generic files, user dotfiles admitted only by the Workbench, excluded-folder
  placeholders, symlinks, and special entries do not appear in
  `list_directory` and cannot be read or mutated by these tools.
- Format capability follows the
  [Documents matrix](../design-docs/design/documents.md#format-capability-matrix):
  `read_file` returns direct Markdown, HTML, JSON, or valid UTF-8 TXT source
  text and current prepared PDF, DOCX, or media text; it does not return image
  bytes. `write_file` and `edit_file` accept those four direct-text families.
  Invalid UTF-8 TXT fails explicitly and is never rewritten. Generic
  workspace-only files are neither listed nor readable through MCP.
  Previewability or built-in image attachment support must not be generalized
  into external MCP text-read capability.
- `create_project` creates only beneath the default folder home or an already
  authorized location. Both the selected location and creatable target must
  remain inside that owned root after symlinks are resolved. The operation
  registers an empty folder and never seeds Agent instruction files.
  Session rebind requires trusted live-session attribution; ambiguous or
  external callers only create and register.

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

StashBase writes durable MCP client configuration only for the bring-your-own
Chat agents: Agent readiness calls `ensureAgentMcp` (Claude Code, Codex), which
regenerates the platform MCP launcher and idempotently rewrites that agent's own
config. Built-in injects the same launcher into each private OpenCode
server with the owning window and live-session attribution; it does not write a
user config file.
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

Built-in Library chats disable native cwd file and command tools because
the Library is a non-contiguous membership set; every file operation therefore
crosses this MCP authorization boundary. A folder chat may use native local
tools only inside its selected member cwd, with external directories denied.

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
| Launcher and built-in agent wiring | `ensureAgentMcp` and `ensureMcpLauncher` in `server/agent-mcp.ts`, with per-session OpenCode injection in `server/opencode-runtime.ts` |
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
