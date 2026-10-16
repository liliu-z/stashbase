# Engineering Boundaries

Read the sections crossed by a change, not the whole file. Product intent is in
[Design Docs](../design-docs/README.md); code entry points and unresolved gaps are
in [Journey Coverage](journey-coverage.md). Unlabelled invariants are required;
implementation details, exact limits, and protocol variants belong to code/tests.

## Runtime Ownership

```text
Electron windows → shared Node server → Python daemon → one MFS store
                         ├─ native Agent sessions
                         ├─ MCP project operations
                         └─ account/model broker
```

| Owner | Authority |
|---|---|
| User filesystem | Source files, Wiki Pages, and native instruction files |
| Electron main | Window/capability identity, server-child lifetime, native save barriers, updates |
| Node server | Registered projects, authorized file operations, preparation, Settings, MCP operations, Agent adapters |
| Python/MFS | Completed text projections, revisions, chunking, embeddings, status, and retrieval through public APIs |
| Native Agent runtime | Sessions, conversation history, native capabilities and tool execution |
| Renderer | Window-local presentation, live buffers, scoped commands, and caches; no durable data authority |

Closing one window releases its work, not services used by peers. Only Node
binds folders into the daemon. Generation replacement waits for old owners to
retire; late callbacks cannot mutate replacement state. Cleanup attempts every
owner independently, even when one fails.

## Shared Capability Owners

Use this table to start horizontal review, then follow callers in code. These
are responsibility boundaries, not a claim that every path is already unified.
Journey-specific entry points and evidence stay in [Journey Coverage](journey-coverage.md).

| Product capability | Engineering ownership and seams |
|---|---|
| [Project entry and lifetime](../design-docs/capabilities/project-entry.md) | Renderer coordinates entry; Electron selects windows and hands off; Node validates directory identity and membership. See [project scope](#project-scope-and-paths) and [import publication](#import-publication). |
| [Project files](../design-docs/capabilities/project-files.md) | Renderer owns live drafts; Node owns source/version transactions shared by HTTP, Agent, and MCP; Electron gates window release. See [source transactions](#source-transactions) and [draft durability](#draft-durability). |
| [Agent sessions](../design-docs/capabilities/agent-sessions.md) | Renderer owns draft/turn interaction; Node owns session routing and adapter lifetime; native runtimes own their sessions and execution. See [sessions and permissions](#agent-sessions-and-permissions). |
| [Project context](../design-docs/capabilities/project-context.md) | Node schedules preparation and binds project scope; Python/MFS owns published index state and retrieval. See [preparation and retrieval](#preparation-and-retrieval). |
| [Account and settings](../design-docs/capabilities/account-settings.md) | Node owns persistent settings, account state, and external credentials; renderer owns scoped interaction. See [credentials and access](#credentials-and-external-access) and [native lifecycle](#native-lifecycle-and-updates). |

## Project Scope and Paths

- One registered folder is one search namespace. Shared storage is not a global
  Library. Search/reindex never aggregate projects when scope is absent.
- Keep filesystem spelling for I/O and display, including whitespace, case, and
  Unicode. Use comparison identity only for equality and subtree matching.
  Realpath-aware containment protects existing and creatable targets; lexical
  prefix checks alone do not establish symlink safety. Slow probes must yield.
- Requests retain their authorized folder across awaits. Supplied blank or stale
  session identity fails; it is never treated as omitted. Only absent identity
  permits an owning window's sole active turn to supply attribution, never an
  app-wide active turn. External clients select a registered project explicitly.
- Open prepares validation and its registry response before committing membership
  and window binding. A newer open, close, or retirement invalidates pending work.
  Directory absence never silently removes membership or favorites.
- Project creation stays beneath the default home or an authorized location.
  Entry and Agent startup never seed or rewrite user-owned instruction files.
  Startup creates only the default home directory; it never populates it with
  sample content or registers projects automatically.
- Removing membership preserves source files and independently registered nested
  projects, including temporarily missing ones. Gate overlapping removal/open
  operations, retire background work, clean owned state, and remove membership
  last so interrupted cleanup remains recoverable.
- Workbench visibility can include generic files and excluded placeholders.
  That does not grant preparation, retrieval, or MCP access. Derived artifacts
  never become visible source results or writable targets.
  `server/file-listing.ts` owns browsing visibility, including default-visible
  project configuration directories; `server/indexable.ts` retains dot-directory
  exclusions for preparation and retrieval. Workspace listings apply the browsing
  preference with either explicit project scope or window scope; Agent/MCP directory
  discovery uses the separate Project Operations surface.

The shared entry experience is owned by [Entering a Project](../design-docs/capabilities/project-entry.md).
The renderer owns one acquisition/entry operation per window. Electron serializes
window selection, includes the initiating window in identity matching, and waits
for the destination renderer's workspace acknowledgement. Entry cancellation and
window closure retire the handoff; an occupied window keeps its existing work.
Session restoration restores presentation only and never initiates project entry.

## Source Transactions

HTTP, Agent, and MCP adapters share file/version authorities. Source capability
follows the [format matrix](../design-docs/capabilities/project-files.md#format-capability-matrix);
preview, content editing, and rename/delete are separate permissions.

- Read content/version from one bounded snapshot. Hash complete bytes, not mtime.
  Serialize in-process writes, stage, then recheck the expected version before
  publishing. The queue does not provide OS compare-and-swap against external writers.
- A live editor value is save authority before a dirty badge renders. Navigation,
  folder changes, and native context release cannot skip a fresh edit.
- Conflict preserves both dirty and disk text until Use disk version, Keep my
  version, or Merge. Never automatically retry without the base version. Merge
  drafts require explicit completion; competing decisions serialize.
- After publication, save waits for projection acceptance, not embeddings.
  Index failure is a save warning, not rollback. Identical saves retry projection
  maintenance. Empty/excluded/unreadable current text cannot expose an old result
  merely because deleting its index row failed.
- Preserve supported source conventions and untouched JSON lexemes/whitespace.
  Structured edits splice source ranges; replacements treat dollar sequences
  literally. Invalid UTF-8 is never rewritten lossily. Agent text writes reject
  unintended control bytes without consuming valid literal backslashes.
- Turn changes are host state owned by `server/turn-changes.ts`. Native runtime
  writes and shell commands never pass through the host, so `attachAgentRuntime`
  wraps every Agent socket bound to a folder: a prompt and everything after it
  wait until the folder's Markdown baseline exists, and the runtime's `turn-end`
  triggers a rescan and a `turn-changes` event. This is the one seam shared by every
  runtime; adapters carry no tracking of their own. Tracking is best effort: a
  failed scan leaves the turn untracked and never delays or fails it. Scans skip
  hidden derived notes and are bounded by file size, count and bytes; recorded
  turns are bounded per folder and by age, live in memory only, and retire with
  their folder. Anything that changed during a turn is attributed to it, including
  a concurrent session's or the reader's own edit.
- Rename/move/delete validate before cancelling work, await native-handle release,
  mutate, retire current AppData-derived/index identity, then rediscover and notify.
  Retired extraction filenames never authorize sibling-file migration or deletion. Generic
  Workbench mutations do not broaden Agent content permissions.
- Link rewrites plan against versions before rename and apply through the shared
  transaction owner. Rollback restores only bytes it still owns. Current cascade
  covers inline Markdown links/images and HTML anchor hrefs, not reference-style
  definitions or other HTML attributes. MCP file moves stay inside one project.

### Import Publication

File uploads use disk staging and no-clobber publication. GitHub import accepts
only the supported public HTTPS repository URL and a portable direct-child name;
Gallery and GitHub Import share anonymous HTTPS default-branch archive downloads,
without Git execution or source `.git` metadata. Only the GitHub API and archive
hosts may receive redirects. Download bytes, expanded bytes, entries and network
idle time are bounded. Extraction validates portable paths and refuses collisions,
hard links and special entries; regular files are written exclusively before any
symbolic links. Links must resolve inside staging; dangling/cyclic links are
refused. All extraction writes settle before cancellation cleans staging.
Submodules and LFS declarations remain unsupported. Inspection and cancellation
happen before committing registration.

Publication and rollback track owned filesystem identities. Preserve concurrent
edits, replacements, and unrelated additions; never recursively delete an
ambiguously owned target. Register a successful acquisition before returning its
path. A later window-open failure keeps the copy registered and retries entry
without another download. Window-scoped import receipts recover a lost HTTP
response; an unknown receipt never authorizes replaying the copy. Explicit cancel
can overtake POST and remains effective. Recent snapshots retain unavailable
members until explicit removal. Directory publication
and exclusive-copy fallback are not atomically visible; tests prove specific
races, not protection against every adversarial syscall interleaving.

### Draft Durability

Document text becomes durable through ordinary versioned saves. The document
runtime schedules autosave independently of mounted viewers. Browsing and mode
switches retain work without a save barrier; close and project/window release
settle it. Merge drafts stay outside autosave until explicit completion against
the reviewed version; both unresolved markers and save failure retain the draft.
Keep-my-version uses that same version check, never an unconditional overwrite. Close, project
switch, and update barriers must finish those saves or retain the live window
and its dirty buffers. Crash recovery snapshots and their OS-protected key store
are removed: startup never imports or calls Electron safeStorage, and no recovery
key is created or passed to the server. The app does not read or delete existing
keychain entries or old encrypted snapshots.

Unsaved text lives in the document runtime. A process crash or a shell remount can
lose text that has not reached its source file. There is no plaintext snapshot or
local-key replacement. Source transaction rollback and interrupted-operation
recovery remain separate responsibilities.

## Preparation and Retrieval

StashBase owns preparation so previews and readable text work independently of
vector indexing. It sends complete text into MFS Internal namespaces; MFS alone
owns revisions, unchanged classification, chunking, and index status. Do not add
a second projection ledger or query MFS implementation tables.

MFS dependency updates follow published upstream releases. Pin the versioned
release archive in Python requirements and constraints; setup verifies both its
source URL and installed package version.

- Completion is format-specific and current-source-bound: PDF needs its terminal
  marker; DOCX needs sanitized marked output with text. Empty completed PDF/image
  OCR is a successful non-searchable result with no synthetic title. Missing PDF
  page text falls back to native text and then direct local OCR inside the bounded
  batch worker. OCR failure or timeout cannot publish empty success. Checkpoints
  are not completion. Media playback never creates prepared text.
- One process scheduler owns capacity and prioritizes explicit interaction, open
  projects, then background work. Cooperative yield preserves task identity while
  releasing capacity. Status storage errors fail closed and reject cancellation
  acknowledgement. Pending terminal writes retry after storage repair before
  admission resumes; an unrepaired process crash cannot preserve those writes.
  User Cancel is durable until Reprocess; shutdown/mutation
  interruption remains recoverable. Cancel the full native process tree and await
  handle release. Optional helpers must not block browsing or steal native focus.
- Reconcile is folder-explicit and rediscovers lost in-memory work. Boot binds
  every registered folder and reconciles none; a folder reconciles when a window
  opens it, offering sources in bounded batches that yield the shared event loop.
  Apply common hidden/dependency exclusions to paths relative to the owning
  registered folder before traversal and mutation-triggered scheduling. The
  MFS adapter repeats that check against its longest bound folder; ancestors
  outside the project must not affect eligibility.
  An incomplete directory scan fails reconciliation before unseen projections can
  be removed. Queuing invalidates stale final output; source removal retires all
  owned artifacts.
- The longest registered folder owns a source namespace. Nested binding replay
  retires ancestor projections in order with admission. Daemon readiness waits
  for current config/bindings; reset/removal races retry the authoritative operation
  once from bind instead of recording expected retirement as source failure.
- Existing namespaces remain usable for exact retrieval without an embedding key.
  Direct reconcile and prepared-text admission acknowledge accepted revisions
  without awaiting semantic builds; completed parsing releases its lane and text.
  Typed daemon retirement errors cross per-file handlers so the reconcile owner
  can rebind and retry. Configuration changes supersede old
  credentials/generations; store deletion failure must propagate.
- UI **By keyword / By meaning** maps to internal grep/hybrid. Active HTTP/MCP
  `keyword`/`semantic` values remain protocol vocabulary. Omitted mode is resolved
  from key configuration on each lookup; explicit mode and provider failures never
  silently fall back. Key presence is configuration, not health or completion.
- Retrieval and prepared reads share current-source eligibility and complete-output
  checks. Apply namespace/path/type narrowing before bounded results; report
  truncation and partial reads. Remap all evidence to visible sources. A legacy
  derived-path request must resolve through its live source before authorization.
- Node/Python JSON-RPC is UTF-8 in both directions. The launcher pins the
  process encoding; the daemon also configures its standard streams so direct
  and frozen launches cannot inherit a Windows ANSI code page.
- Resource ceilings must stay finite and aligned across Node/Python. No-op reconcile
  spends no embeddings but still transfers text for MFS revision classification.
  A rename is not a zero-reembedding guarantee. Ranking changes need J05 evaluation.

### Optional Local Components

One PDF/OCR installation owner shares demand and waiters. Cost/status reads never
start downloads. PDF cost probes discover already installed components through
that owner and return unknown cost while unavailable; packaged probes never fall
back to development scripts. Waiting conversions yield their lane. A process makes one
automatic demand attempt; failure has no timer retry. A durable demand latch
permits one next-launch attempt; Retry beside a waiting PDF/image starts one shared attempt.
Cancellation removes source demand and clears the durable latch when its last
source waiter leaves. Explicit/startup downloads have component ownership and
survive source cancellation. Shutdown retains unfinished demand.

Only the app's embedded version/platform/asset/size/hash manifest authorizes
bytes. Verify before confined, bounded extraction and atomic versioned publication;
validate links and never execute partial staging. Component identity is independent
of the desktop version: an application update pinning the same component reuses
the verified installation offline. A changed component still requires its exact
embedded manifest; remote release metadata never authorizes runtime bytes.
Signing and release publication belong to [Release Runbook](release-pipeline.md).
Native component compatibility belongs to `server/native-component-support.ts`.
An unsupported component rejects only its own operation; it must not block server
readiness, project entry, or durable file saves. Unsupported extraction returns a
stable status without download, retry, or a new durable demand latch.

## Agent Sessions and Permissions

- Shared runtime instructions default reads/searches to the bound project and
  route explicitly requested external paths through native tools under runtime
  permissions. OpenQuill asks for external-directory access instead of denying
  it unconditionally. The OpenCode adapter routes current `permission.asked`
  events into the shared permission flow alongside `permission.updated`. Claude’s prepared-text redirect applies only inside its
  bound project; external reads must not be routed to project-scoped MCP.
  This guidance does not broaden HTTP/MCP authorization or write permissions.

- Boot performs bounded asynchronous discovery/auth/MCP preparation, never install
  or login. Explicit installation and updates run only the selected runtime's
  official native installer, including when the current copy was installed by
  npm. Preparation/shutdown share one cancellable flight per runtime.
  Stage/code/retryability are structured; the renderer never parses error prose.
  The first-send access prompt preserves the failed setup stage and diagnostic
  through its catalog adapter and application error. It displays the explanation
  as plain text at the failure site; generic transport wording must not replace
  an available setup or service error.
  A failed operation carries its retry action so Update cannot degrade to a
  readiness check of the old executable.
  Only identical explicit actions share a flight; a conflicting action receives
  an HTTP 409 and never observes another operation as its own success. Startup
  discovery may observe an existing flight without changing its intent.
  Installation has an eight-minute host deadline, installer-script downloads a
  one-minute deadline, and browser sign-in a ten-minute deadline. Timeout awaits
  process-tree retirement before releasing the flight. Renderer polling allows
  these host deadlines to report their cause. Version reads and executable
  verification use asynchronous bounded probes; concurrent version readers
  share the per-executable/file-version result.
  Both providers' status commands gate readiness and their login commands own
  browser sign-in. Native authentication refusals restore the sign-in action;
  they never delete credentials. Setup errors retain bounded stdout/stderr and
  nested network causes, with Agent/action/stage context. Settings and chat
  update surfaces preserve HTTP diagnostics as well as bootstrap failures.
- User-installed CLIs keep their native account/history ownership. StashBase discovers provider-owned
  installations and never uninstalls them; AppData stores temporary installer
  scripts, not a second installation. Valid login-shell discoveries remain usable
  while their executable exists. Session failures do not disable the runtime.
  Official native launchers take priority over npm discoveries, while explicit
  executable overrides remain authoritative. Updates preserve old npm copies;
  success requires verification and subsequent discovery of the native launcher.
  Overrides outside the native layout do not offer in-app updates.
- Installer completion means successful native exit plus verified discoverable
  output. Own temporary scripts and descendant cancellation; neither cleanup nor
  shell wrappers may mask failure. Do not redirect official installs into private
  paths or destructively rewrite user PATH. Platform details live beside the installer.
- A proactive offer for a model an installed runtime is too old to run is that runtime's own
  statement, read from its own state and passed through unchanged; StashBase
  compares no versions and infers no requirement, and the renderer only renders
  what the runtime said. A file that is absent, unreadable, or differently
  shaped leaves every runtime unchanged. The offer is advisory and shares the
  existing native update flow; it never gates a turn, a session, or a model
  choice.
- Generated stdio MCP launchers retain the generating host's HTTP port. Explicit
  launcher arguments may override it; a custom-port runtime must never call a
  different app instance on the default port.
- Codex MCP setup parses TOML and replaces only StashBase table ranges, preserving
  unrelated configuration. Invalid or unsupported configuration fails untouched.
  `server/agent-config-paths.ts` owns configuration identity for setup and Claude
  model metadata; MCP writes respect the same `CODEX_HOME` / `CLAUDE_CONFIG_DIR`
  inherited by provider processes.
- Each OpenQuill chat owns an authenticated loopback OpenCode process; each Codex
  chat owns its app-server/thread. After a Default turn, the host may prepare one
  unused OpenCode process and its MCP connection for the next chat. Claiming that
  spare transfers exclusive ownership, including its private attribution id;
  active chats never share it. Window, project, account, persona and instruction
  path must match; a fresh model catalog and current attached tools must match
  its configuration or it is retired and started again. Prewarming creates no
  native chat or model request. Subsequent matching turns refresh its idle
  deadline or replace an expired spare. One app-wide spare expires after two idle minutes
  and is retired on window close, project removal, or shutdown. Startup cancellation
  cannot resurrect a retired process, and shutdown awaits already-retiring servers.
  History readers have separate ownership. All Codex app-server
  owners share retirement that waits for exit and escalates process-tree termination;
  shutdown also awaits readers and already-retiring processes.
  Process death settles pending RPCs/turns, and generation guards reject late
  messages. An ambiguous timed-out start retires its generation before retry.
  Claude replacement waits for native iterator/query cleanup after verifying scope.
- Claude requests native session-state events and ends a turn at `idle`, using
  its latest result for success/failure. Intermediate results while background
  agents run do not release the turn or its queue. Native runtimes that emit no
  state events retain the result boundary. Stop still requires native completion
  and interrupt acknowledgement; process death remains a failed session exit.
- OpenQuill retains native finish reasons; an unknown final completion is a
  failed turn. Native errors during execution wait for idle, and message events
  retain their originating turn so trailing error updates cannot fail a new turn.
  Its translator coalesces identical retry status messages within a turn while
  preserving native retries and distinct causes; the final short-term usage
  refusal, including an accounting-recovery refusal, classifies as a rate limit.
  Retry notices alone do not settle the turn; native idle releases it after failure.
  The hosted broker forwards the gateway's
  `Retry-After` on 429/503 responses to the native runtime.
  `hosted-agent-stream.ts` owns bounded SSE inspection for the broker. Empty
  responses and the gateway's `agent_provider_unavailable` stream errors share
  one recovery attempt before output. Exhaustion becomes HTTP 422; after output,
  that error becomes a terminal SSE envelope whose code cannot trigger native
  overload retries. Original gateway errors remain in diagnostics. The translator
  unwraps only this owned terminal envelope and consumes native text/reasoning
  delta events, reconciling final snapshots without duplicating output. Stale
  deltas cannot cross session, message, or turn boundaries.
- Project Agent preferences are explicit choices in Node-owned app config, keyed
  by registered project scope. Readiness and history restore never write them.
  Thinking effort is stored separately per Agent in that project. Composer choices
  update the window cache immediately and persist in order; new/blank chats seed
  from that cache, while history keeps its native effort. Catalog admission clears
  unsupported effort in the session without overwriting the saved choice. Effort
  writes preserve the preferred Agent and other runtimes' efforts.
  Missing preference means Default; failed preference reads/writes remain visible.
  Access requested on Send retains a scope/session/draft snapshot and cancellation
  owner. Only confirmed readiness may continue that same submission once; navigation,
  edits, cancellation, and disposal reject late completions. Setup HTTP 202 is an
  acknowledgement to poll, not permission to initialize or send early.
- Unstarted means no session/transcript/turn; blank also means no pending user work.
  Blank chats may follow the window and be reused; user work pins scope. Runtime
  adoption preserves drafts, source bindings, and transient upload bytes. Catalog
  connections before the first request may be replaced when changing Agent. Mode changes
  never remount ongoing work merely to change presentation.
- Started sessions survive window folder switches. Member removal retires only
  bound sessions, reports a structured scope-removed event before closure, preserves
  transcripts, and rejects queued/late work. Expected retirement never reconnects.
- History restore joins repeated requests for the same project/Agent/native id.
  Mounted titles carry a manual-rename flag; first submissions supply a fallback
  title hint. Rename mutations serialize before publishing confirmed titles.
- Native history is authoritative. Native cwd determines project ownership; no
  override store or live session migration exists. History and WebSocket startup
  require a registered project; no aggregate history endpoint is exposed.
  A missing Codex executable reports `412 AGENT_NOT_INSTALLED` at its process
  owner; history reads and mutations preserve that prerequisite instead of
  reporting empty history or HTTP 500. Installed-runtime failures still propagate.
- Transcript presentation omits failed tools from activity rows and summaries
  without deleting native history or inferring recovery from later calls.
  Empty activity groups render nothing. Turn failures and permission decisions
  remain separate, and only successful file operations produce changed-file results.
  A settled write reports its paths; a settled turn that ran a command, a
  subagent, or another tool whose writes name no file reports that the folder
  may have changed, and the shell reconciles it the same way. Reads, listings,
  searches, and questions report nothing.
- A persona is per-Chat guidance resolved at native mount and composed
  with internal routing policy. That policy is the one text every runtime always
  sees, so it owns which StashBase tool orients and reads prepared text, and that
  existing documents use `edit_file` while new documents use `write_file`; a tool description alone
  cannot own a rule, because a runtime may defer it. Neither is a permission,
  skill contents, or a project-file edit, and StashBase ships no workflow
  guidance of its own: that is the user's `AGENTS.md` / `CLAUDE.md`.
  `server/agent-persona.ts` owns the library: one Markdown file per persona in
  app data, seeded once from `assets/agent-personas/`, plus the record of each
  native session's persona. The Chat's persona id travels on its connection;
  the shared Agent Contract records it against the `session-id` every runtime
  announces, and replay returns it. The project's choice for new Chats is an
  Agent preference. A change never mutates a running native prompt: the
  renderer resumes the Chat's own conversation, as it does for effort, so the
  persona applies from the next turn. Gallery personas are Gallery index data;
  the composition layer adds them through the Agent's library, since the
  features do not import each other. Brainstorming needs no sources/wiki/index.
- Default receives explicit transient attachment references in the prompt
  protocol. `server/routes/attach.ts` binds uploads to an explicit registered
  project and records their digest; `server/agent-attachments.ts` validates
  ownership and unchanged bytes, bounds preparation, and emits native file parts.
  DOCX extraction reuses the cancellable worker without project import/indexing.
  Stop and disposal retire preparation before another model request can be sent.
  The local hosted broker maps inline PDF file parts to Gemini-compatible
  `image_url` data parts; it does not fetch URLs, store cloud files, or change
  accounting. Native history retains content for follow-ups, while replay hides
  synthetic extraction text and recovers the original attachment cards.
- Attachment age cleanup excludes batches created by the active server process;
  drafts, queues, and retries may retain them until process exit. They remain
  temporary files, not durable historical attachments.
- Context/attachments are explicit. Validate source identity before send; stale
  context blocks it. The queue captures prompt, context, skill, and id, and Retry
  uses that exact submission after checking locally available context. Sessions,
  not mounted composers, advance queues only after normal completion; cancellation,
  failure, and connection loss pause them. Transport refusal retains the queued
  request; uncertain delivery retains the visible submission and forbids automatic
  resend. Clear only the accepted draft snapshot, never newer input. Explicit
  queue/message reuse refuses to overwrite another draft. A reused prompt starts a new turn rather
  than truncating history. Historical metadata cannot restore attachment bytes.
- Models/effort/modes follow runtime capabilities. Catalogs seed drafts, not live
  identity. No catalog-order default or global CLI rewrite; active turns freeze
  changes. Skills use native invocation, not concatenated skill-file contents.
- Pending approvals require the exact request id; abort/disposal denies them.
  Read/orientation/reindex may use the low-risk path. Document writes remain
  permissioned and Review never grants a write in advance. Edit policy grants only its
  bounded writes; move/delete/commands/network/broader access require their own
  authority. `create_project` needs an explicit request or visible approval.
- Shared instructions require StashBase `edit_file` for existing project
  documents and `write_file` for creation, including after a failed native attempt.
  Claude removes native Edit/MultiEdit/Write from its tools and shares the bounded
  MCP Edit-mode approval predicate with Codex in `server/agent-file-permissions.ts`; OpenQuill denies the
  native edit permission shared by edit/write/patch. Codex has no independently
  verified native-edit disable switch in the current app-server integration, so
  its routing remains guidance. Shells and subagents are not a filesystem
  isolation guarantee. Turn review therefore continues to detect all scanned
  Markdown changes regardless of the writing tool. External MCP clients have no
  app-owned turn socket and do not receive Chat turn-review cards.
- Codex modes use on-request approval with mode-specific sandbox/review policy;
  Claude maps native modes. Default maps Ask/Edit/Plan to OpenCode profiles;
  Auto uses the Edit profile with host-owned review. Edit and Auto share
  `agent-file-permissions.ts` with the other adapters, granting only
  ordinary StashBase document writes inside the bound project (including
  realpath checks). Plan denies unlisted tools in the native profile and rejects
  unexpected mutating permission requests. `default-agent-permissions.ts`
  reviews Auto's routine commands, web fetches, and external reads with the
  default hosted model, no tools, and the same turn's accounting. Only an exact
  ALLOW answer grants the pending action; uncertain output, errors, or a
  five-second deadline return to manual approval. Destructive and unfamiliar
  tools bypass review and still ask. Stop, disposal, and turn retirement cancel
  approval authority and undispatched reviews. After dispatch, the broker drains
  the tool-free classification with a 256-token output cap and a 30-second
  transport deadline, retaining its original turn for accounting. The five-second
  decision deadline never aborts that active request. Broker shutdown cancels
  remaining drains; late answers cannot approve a later turn's action. Main Agent
  and Crew requests still abort when their turn ends.
  Approval replies grant once, require a pending request id, and never persist
  an `always` grant across modes. Options stay frozen while a turn runs.
  The bundled runtime filters inherited credentials and injection flags while
  using `agentCliPath` to restore CLI directories omitted by desktop launchers.
  Its private home does not provide the user's interactive shell setup;
  commands still require their dependencies to be installed and discoverable.
- `server/opencode-runtime.ts` owns Default's project-only skill discovery.
  Its private home/config and disabled native external/upward config discovery
  prevent importing user-global and ancestor skills from non-Git writing folders.
  Native skill paths are explicitly relative to the bound project. Because the
  upward config flag also suppresses instruction discovery, the runtime supplies
  the project's first existing `AGENTS.md`, `CLAUDE.md`, or `CONTEXT.md` path;
  OpenCode reads its contents. Project OpenCode configuration cannot add external
  skill sources. Native skill invocation and permission checks remain in OpenCode;
  the Codex and Claude adapters keep their own discovery behavior. On Windows,
  the private OpenCode process receives the packaged ripgrep directory on PATH
  because native skill reads use `rg.exe`; the app does not rely on a user
  installation or an on-demand runtime download.
- Turn failure settles once without destroying a live session. Advisory notices
  never become terminal errors. Recover by structured kind: authentication needs
  process/session refresh, credits/restrictions need account recovery, transient
  failures may resend. Raw socket loss has bounded retry then manual recovery.
  Unknown-outcome presentation retains a closed/failed connection's supplied
  cause with the review action; it never infers a network failure from uncertainty.
  Renderer socket decoding catches only wire validation/translation failures.
  Consumer exceptions retain their original error and must not invoke invalid-frame
  recovery, which would close an otherwise valid native stream.
  The Codex adapter correlates native missing-model-metadata warnings with a
  subsequent ChatGPT model rejection for the same model in that process
  generation, offering the existing `runtime-outdated` update recovery while
  retaining the native error. Neither signal alone changes failure recovery;
  no version minimum or account entitlement is inferred. A replacement process
  starts with no remembered metadata warnings.
  The model picker exposes an updater only when the host advertises `updatable`.
  This explicit action shares the failed-turn update owner, but has no request
  to resend. Reconnection reads models from the replacement native process;
  catalog memory never supplies a fabricated new model. The composer retains
  drafts and blocks Send and provider changes during the update.

## Scheduled Tasks

[Scheduled tasks](../design-docs/capabilities/scheduled-tasks.md) split
across three owners; none keeps another's state.

| Owner | Authority |
|---|---|
| Node `server/scheduled-tasks.ts` | Reads the project task file (.schedules.json) leniently, writes one task per list edit through the shared text transaction, and keeps each task's switch, last claimed occurrence, and last run in app config keyed by project scope. Project removal forgets them. |
| Electron main `electron/scheduled-tasks/` | The clock: checks after launch, every minute, and on resume or unlock; decides what is due in local time; claims through the server; finds or opens the project's window; asks it to start the run; records the outcome. |
| Renderer Agent feature | Starts the run's chat through the session's ordinary send path, answers whether its request was accepted, and reports how its first turn ended. Shows the task list in the chat's place. |

- `shared/scheduled-task-timing.ts` is the one due rule: main decides what to claim
  with it, the list's adapter reads each task's next run and its missed days from it,
  and the server records the missed days with it when a claim follows them, so the
  list's pending entry and the recorded one never disagree.
- Claims are at most once. The server refuses an occurrence at or before the one last
  claimed and a second run of a task still running in this process; a run left running
  by an earlier process reads as failed. A lost answer never causes a second dispatch.
- Each task keeps a bounded run history. A run moves forward only: main's report
  applies only to a run still starting, and the window's first-turn report only to a
  sent run, so a late or repeated report never rewrites an outcome. The first-turn
  report carries a bounded excerpt of the Agent's last reply, kept with the outcome.
- Main reaches state only through the server's task routes, as it does for update
  preferences; it reads neither config nor task files. Every request names its project
  and only registered projects answer.
- A run's window is chosen by folder identity in the shared entry lane. Without one,
  main opens a window with `show: false` and background throttling off, enters the
  folder through the acknowledged project entry handoff, and reveals it with
  `showInactive` on the next app activation or window focus, keeping the focused window
  in front. It never claims session restoration. Where closing the last window quits,
  closing every visible window reveals hidden ones instead of leaving the app unseen.
- Runs stay claimable per window until answered, because a window opened for a run
  subscribes after the first push; the preload starts each request once. Main's
  three-minute deadline outlasts the renderer's own start deadline.
- `startBackgroundChat` mounts the run: never activated, never a reused blank chat,
  Agent pinned against a late preference load, title marked as renamed. The run checks
  catalog readiness instead of opening the access dialog, settles access mode and
  remembered models as the chat pane does for an active chat, binds named files as
  source context with no bound version, and sends. An unsent chat is discarded on
  failure. Once the first turn settles the window reports its outcome against the run
  id main passed with the request, then saves the title through the history rename.
- The list stands in the chat's place through the workspace's `surface`; activating
  any chat restores the chat, while a background run leaves it. The chat stays
  mounted, hidden, so its scroll, draft, and focus survive. A run's live state comes
  from the chat tab whose native id it names.
- The task file stays out of Files unless hidden files are shown, and out of
  indexing; Agent and MCP writes follow the ordinary editable-file rules.

## Credentials and External Access

Node is the sole atomic app-config writer. Strict writes fail on malformed or
unwritable current state rather than saving fallback defaults; preserve unrelated
current domains. Never repair filesystem ownership/ACLs automatically. Historical
data migration is not required by [maintenance policy](../MAINTENANCE.md#previous-version-data-policy).

- BYOK keys enter through Settings, never environment or projects. Renderer input
  is transient; account tokens remain Node-only. Account state does not configure
  embeddings. Reconfigure only the dependent runtime; a runtime failure does not
  undo a successfully persisted key. Later key mutations supersede pending
  validations; runtime changes serialize in the same owner.
- Account OAuth uses Node-owned PKCE and window-bound opaque flows. The fixed
  app-return deep link carries no code/token/flow id; authenticated native
  acknowledgement proves focus handoff. Cancelled polling is not OAuth revocation.
  One renderer account provider owns the browser wait for all window surfaces.
  New OAuth attempts and successful local sign-out retire earlier unfinished
  flows across windows; exchange must recheck flow identity/state after awaiting
  the provider and before persistence. Refresh is single-flight and can update
  only the session it began with; stale work cannot borrow a newer account token.
  Only structured provider errors confirming an invalid session may clear matching
  saved credentials. Network, timeout, rate-limit, and server failures preserve them.
- Avatar proxying is restricted to validated HTTPS provider hosts with bounded
  redirects/time/bytes/type; it is not a general fetch endpoint.
- OpenQuill receives a random session-local model broker credential, not
  account secrets. Model calls require an active submitted turn, retain its
  id/idempotency across the one auth-refresh retry, and cannot expose account
  tokens in history. Turn/channel retirement cancels main Agent/Crew body reads
  and pending upstream work. Already dispatched Auto classifications drain under
  the bounded permission-review lifecycle above; awaited credential acquisition cannot forward a request after
  retirement. The broker buffers a bounded empty SSE prefix and retries an
  empty model call once with the same body and turn, including completed tool
  results. The new model attempt gets a fresh accounting key. Any output,
  tool-call data, provider error, or unrecognized event disables replay;
  ordinary output still streams. Repeated empty responses fail without native
  automatic retries. Cancellation retires both prefix buffering and recovery
  before another upstream call. The hosted ledger sizes output under its
  account lock against available funds. UTF-8 profiles can buffer half the input
  estimate at platform risk when a useful output budget cannot fit; provider-day
  exposure retains the full input estimate and approved output. User charging
  is capped by its separate reservation. Unknown user fees are refunded after
  five minutes from first uncertainty, on recovery sweeps, allowance reads or
  retries; late accounting only adjusts platform cost. Its approved output limit travels to the
  provider; the desktop never computes a budget from the displayed percentage.
  Hosted quota failures distinguish insufficient request credits from
  insufficient turn budget and preserve their recovery classification through
  the native runtime message boundary. `server/hosted-agent-models.ts` reads
  the approved model profiles. Each OpenQuill chat reads them once at start
  and configures its OpenCode process with the same list, so stored prompts
  name their profile and compaction uses that profile's limits. The main agent
  always runs on the service's default profile. `server/agent-tool-catalog.ts`
  reads the tool catalog (`GET /v2/agent/tools`): the tools, their published
  names and descriptions, and a tool model pool independent of the main
  Agent's profiles, cached per account with the service's ETag (304 reuses it,
  a failed refresh keeps a valid copy, sign-out clears it; without a copy,
  selected Crew blocks startup and a chat without Crew can proceed). `server/default-agent-tools.ts` holds no tool of
  its own: it resolves the chat's choices in app config `agentCrewChats` against a catalog.
  `defaultAgentTools` seeds new chats only; a draft key transfers to the native
  session id before it is announced. Deletion removes the chat's choices. It never
  replaces an unusable pick or disabled default with another model, and owns
  the rules every tool shares (the briefing, the brief format, and the tool
  prompt, which uses the published responsibility and output description).
  Shared instructions express the selected division of work, current-task
  precedence, and necessary context, including unsaved drafts and evidence. Each chat takes a
  catalog snapshot at start; each root turn copies it, so every role shares
  one catalog version, and only a turn not yet bound by an accepted call may
  move to a newer catalog, for the same tool on the same model, after
  `agent_tool_version_changed`. An enabled tool reaches the main agent as a
  StashBase MCP tool registered by the stdio host its chat spawns
  (`STASHBASE_AGENT_TOOLS`, the catalog's function names and descriptions; a
  name that collides with a built-in tool is not registered), with the shared
  briefing added to the main agent's instructions; `task` is denied, so
  OpenCode starts no sub-agent. A call goes to
  `/api/project/agent-tools/:tool` under the chat's project scope; it runs far
  longer than the runtime's per-request MCP timeout, so the MCP host sends a
  progress notification every few seconds, which the runtime takes as a reason
  to restart that timeout, and a cancelled request aborts the call. Turn identity and its abort signal
  are captured before file reads and retained through catalog refresh/retry;
  the host reads the named files there and the broker sends one completion to
  `/v2/agent/chat/completions` under the root turn id, selected by the tool,
  tool version, tool model, and tool model version headers and never by a main
  profile. Direct completion requires a stop finish reason and the SSE DONE
  marker; truncated and interrupted output fails instead of becoming a draft.
  `server/agent-crew-history.ts` persists member/model attribution by native
  session and call id in app data, independent of the mutable catalog. The
  WebSocket and history protocols carry that metadata to standalone Crew cards.
  Deleting the native chat removes its attribution. OpenCode's own requests and the Auto permission review run on the
  turn's main profile over v1. Changed or withdrawn main profiles leave the
  broker as 422, outside native retries, and classify as `model-changed`; tool
  refusals keep the service code and never fall back to another model.
  Versions, limits, and upstream identity stay in the host; the listing keeps
  the hosted catalog in memory only. Hosted quota/accounting and Stripe
  billing stay external; the desktop exposes bounded usage, plans, and
  subscription status. The host requests Checkout and Portal pages with the
  account session and hands the renderer only a verified Stripe-hosted URL;
  desktop account tokens never appear in links or Stripe configuration.
  Billing HTTP calls share a twenty-second deadline across retries;
  authentication refresh retains its existing ten-second bound. Native browser
  acknowledgement is bounded to ten seconds; renderer billing retains the
  result to report launch failures. The exact, data-free
  `stashbase://billing-return` link only focuses a window and cannot grant
  rights or acknowledge an OAuth flow. Website billing uses its own browser
  session. Child environment and AppData HOME/config isolate ambient secrets
  and user config.
- Built-in HTTP and external MCP share Project Operations. Streamable HTTP checks
  the current Settings token on every POST; rotation invalidates old tokens.
  Loopback is default; Docker opt-in exposes only the separate MCP listener.
  Browser Origins/CORS stay closed. Listener transitions serialize and roll back
  active exposure if persistence fails. Disable closes active HTTP connections
  so incomplete bodies cannot hold the transition queue. Node alone regenerates
  the atomic stdio launcher on startup/readiness/Settings. Stdio is scoped to its spawning client.
- MCP reads are bounded; line windows omit a version so partial content cannot
  authorize a whole-file overwrite. Generic/derived/unsupported entries never
  bypass source admission. Native coding-Agent tools have separate runtime permissions.
- Readiness alone writes the built-in CLIs' MCP config; OpenQuill injects config
  per process. Claude's entry asks the runtime to always load StashBase's tools,
  because Claude otherwise defers MCP definitions behind its tool search once a
  user's other connectors grow, leaving the model a tool name with no description. External clients copy their setup manually. No second client-config
  or credentials store belongs in StashBase.

Credit snapshots are shared through Settings' query owner. App composition
invalidates that query on Default turn completion independently of telemetry
transport; account-menu opening, focus and bounded polling refresh the same key.
The hosted usage endpoint exposes reservation percentages only with explicit
`include=reservations`, preserving the strict response contract of installed
clients. The percentage includes active and unsettled reservations and never
adds them back to the available balance. Admission refusals carry their locked
allowance snapshot to the gateway so their explanation reflects held capacity.

## Usage Statistics

- Node owns analytics identity, preferences, sessions and a bounded durable queue
  in the strict owner-only app-config store. Missing preferences default on;
  malformed/unreadable state fails closed. Configuration writes remain synchronous
  and atomic; no network response may replace a captured stale config snapshot.
- Installation IDs are random properties, never hardware IDs or aliases between
  people. Separate anonymous IDs link to a verified host account through PostHog
  identify. Logout, confirmed invalidation and direct account switches retire the
  anonymous identity and session before later capture. Renderer input has no
  authority to choose an identity or report authentication/billing outcomes.
- The fixed event schema and persisted-envelope validator are the outbound
  boundary. Only versioned typed facts are queued; transport constructs metadata
  explicitly and filters credential patterns in diagnostics again before sending.
  Diagnostic messages, paths, causes, stacks and bounded process output are retained;
  arbitrary request/provider objects, documents, prompts and whole logs are excluded.
  The public ingestion token is build configuration, not a user credential.
- Queue envelopes preserve UUID, occurrence time, installation, anonymous/account
  identity and source version through retry/restart. Identity links share durable
  admission with their events. Full queues refuse later work; expiry and permanent
  ingestion refusal remain observable-data limitations. One serial drain re-reads
  current preferences/queue after every await and removes only acknowledged UUIDs.
  Bounded retry never waits in the user's writing operation or shutdown.
- Foreground input and document/Agent engagement establish activity, not timers,
  background work or streamed output. All windows share category suppression and
  sessions. Save/project/billing work captures initiating identity before await;
  turn correlation persists identity/session, original version and observation times.
  Each admitted pending turn reserves a terminal queue slot; terminal insertion
  and pending removal are one atomic config write and bypass ordinary event rate
  limiting. Renderer preparation and host execution facts converge by turn ID.
  Restart recovery reports an interrupted unknown result, never inferred success
  or a fabricated end time/duration. Unknown terminal IDs cannot manufacture starts;
  opt-out clears pending turns and bounded recent-completion IDs.
- Settings General discloses account linking and controls both usage and errors.
  Opt-out stops this process even if saving fails, cancels transport, and on a
  successful save removes the queue and all local analytics state. There is no
  final network notification. Re-enable creates new local IDs without backfill;
  a still-signed-in account may link again. Already received provider events are
  not deleted by this switch.
- `STASHBASE_TELEMETRY_DISABLED=1` suppresses collection and queue delivery before
  startup without changing saved preferences/identity. Electron passes it to Node;
  Settings cannot override it. Unpackaged builds never collect. The host, Electron
  and MCP native entry points share `server/telemetry-environment.ts`: Node test
  workers, `NODE_ENV=test`, Vitest and Jest markers suppress admission even with
  an inherited packaged flag. The isolated host-test fixture also sets the override
  for descendants. Manual packaged checks must still set it; collection tests
  explicitly simulate production only with replaced transport.
- Automatic diagnostics use this same owner, suppression and opt-out. Node emits
  bounded original messages, unknown as well as known codes, nested causes and
  actionable stacks through `shared/protocols/diagnostics.ts`. HTTP request IDs and
  method/route context connect failed results with their diagnostic. Agent turns
  carry the renderer turn ID and initiating identity. Shared socket connection IDs
  exist before the first prompt. Context-read HTTP requests explicitly propagate
  their submitting turn ID; unrelated HTTP calls never inherit one globally.
  Native adapters report host acceptance, dispatch, permissions, tool boundaries
  and terminal facts independently of renderer delivery. The owned model broker
  reports request/response boundaries and failures directly. Only stage transitions
  persist, never each streamed token; last stage is evidence, not inferred cause.
  Tool failures contain bounded call IDs/categories, not inputs or results, and do
  not themselves settle a turn. Setup stages share attempt
  and retry IDs. Background diagnostics retain the operation sentence. HTTP, Agent,
  background and renderer failures converge here without throwing into operations,
  recursively reporting analytics failures, or creating another privacy setting.
  A runtime error immediately followed by an exit with the same explanation
  contributes one diagnostic, retaining the original cause; both protocol events
  still reach the renderer. Closed sessions cannot publish late discovery failures.
  Allowance-query diagnostics retain the original network cause or upstream
  status/request ID separately from the local HTTP result. Unexpected daemon
  and Agent startup exits retain bounded, credential-filtered stderr and the
  available exit code/signal, without serializing process configuration.
  Renderer JSON-body failures retain the original cause, status (including 2xx),
  content type and host-issued response request ID. Requested cancellation stays
  cancellation; empty HEAD/204/205 responses are not decode failures. The Agent
  broker observes bounded SSE framing metadata and explicit upstream errors,
  never retains model text/tools, and supplies the current request trace to the
  native adapter's error diagnostic before the turn retires. Unknown completion
  includes the native message ID, finish reason and token counts; no new turn
  inherits a prior request trace.
  Native startup, crash, MCP stdio and updater errors use the bounded private
  `server/native-diagnostics.ts` spool when the host is unavailable. Native code
  never creates analytics identity or sends network requests. The host drains it
  with original UUID/time/version and captured identity, and opt-out clears it.
  An unowned first-launch failure cannot transfer to a later account. The updater
  records the original error in main before projecting its renderer snapshot.
- Host log level is the reported severity. `log.error` means an operation failed
  for the user or data may be inconsistent; `log.warn` means it degraded and
  continued; an expected state (no embedding key, a size limit the UI states,
  cancellation, intentional daemon retirement) is `log.info` and is not reported.
  Pass the caught error as its own argument rather than interpolating its message,
  so the original cause and the surrounding operation both survive. HTTP 4xx responses are
  warnings and 5xx are errors.
- [Usage statistics](../docs/usage-statistics.md) owns event interpretation,
  retention definitions, IP-retention setup and delivery limits. An absent event
  proves neither abandonment nor continued use after opt-out; subscription rights
  observed by a desktop are not a hosted payment ledger.

## Renderer Boundaries

`app` binds adapters and coordinates features through public interfaces.
Features do not import siblings: domain is pure; application owns Ports/runtimes;
infrastructure maps wire/errors; hooks/UI adapt and present. Shared code is a
leaf, platform owns host mechanisms, and the installed kit reaches no product
policy. `test-support.ts` is test-only. Repository contracts/wire schemas cross
registered host boundaries; renderer shared types are a different layer.

- Capture scope and generation before await; reject stale completion even for
  same-folder subtree mutation. Separate request lanes cannot cancel unrelated work.
  Stores, query caches, timers, subscriptions, workers, and URLs have explicit
  owners and disposal. One window has one query client, not durable authority.
- Main's one-shot folder claim and server binding decide entry, not saved layout.
  One startup window claims restoration. Native session persistence serializes
  changed records against each window's baseline, preserving peer changes;
  failed writes retain the last valid file and do not advance the baseline.
- Tabs stay unique across asynchronous opens. First edit keeps a preview; only
  kept tabs persist. History advances after open succeeds. Hidden panes are inert;
  mode/visibility changes preserve drafts, transcripts, focus, and session identity.
  App composition switches to Documents when a user opens a Chat file result or
  local file link, restoring the last Documents sidebar panel.
- Refresh keeps usable content. Clean editors may adopt newer source; dirty ones
  retain drafts for conflict. Optimistic metadata rollback uses the last confirmed
  value and ignores superseded failures. Network failure is not scope retirement.
  Window focus refreshes the current folder listing immediately and requests
  folder-explicit reconciliation through preparation commands. Focus passes are
  throttled and do not overlap; folder switches and closure retire their refresh
  completions and failure notices through a scope lifetime signal. Browsing does
  not depend on reconciliation succeeding. Host tree
  revisions signal app writes and reconciliation, not filesystem events.
- Viewers declare services/capabilities in one registry. Active-owner claims govern
  Find/outline; old cleanup cannot clear new claims. CodeMirror sessions preserve
  serialized history and selection across viewer disposal. Each activated open
  Markdown tab retains its editor, schema, and plugin state together until close;
  switching tabs does not evict undo history. Inactive source queries do not poll.
  Dirty live edits cannot be replaced by late source acknowledgements.
- File mutation coordination saves all affected drafts before changing tabs.
  Rename rebinds existing document runtimes; confirmed deletion disposes them.
  Pending mutations lock affected editors. Unknown outcomes keep that lock and
  are checked using window/project-scoped server receipts, never replayed from
  a lost HTTP response. Receipts are bounded process-lifetime records; missing
  receipts after eviction/restart do not establish failure or permission to retry.
- Milkdown serialization preserves frontmatter outside the body. The surface
  holds an edit until typing pauses instead of serializing per keystroke; the
  document runtime settles a held edit before every save, reconcile, conflict
  resolution, and review start, and view disposal flushes it. A write keeps the
  source text of every top-level block the reader did not edit, and the reference
  definitions the editor resolves away; only edited blocks are serialized, so a
  save neither rewrites unrelated formatting nor costs the document's length.
  Off-screen prose blocks use `content-visibility`. Find/outline use
  the live document without mutating editor DOM. The outline adapter owns heading
  anchors through ProseMirror decorations, replacing Milkdown's heading-id state
  synchronizer; anchor updates must not reparse prose or interrupt IME composition.
  The sole double-cast exemption is its Find controller's structural DOM corpus and guarded
  CSS Highlight probe; other exceptions need their code-owned rationale.
- Markdown's `math.ts` owns the double-dollar math rule and code-block preview.
  Single-dollar prices remain prose; math serialization retains double-dollar
  blocks and explicit `math` / `latex` fences.
- Inline review runs Milkdown's diff plugin, registered directly by
  `revision-adapter.ts`. `@milkdown/plugin-diff` is patched under `patches/` so a
  per-change Reject also resolves a pure deletion, which holds no span in the
  proposal and which upstream's span-keyed rejection never matches. The same
  patch carries the reviewed document's trailing empty paragraph into a parsed
  proposal, which Markdown cannot spell. A Milkdown upgrade carries the patch,
  or retires it against the revision engine test.
- Turn review runs the diff engine in reverse: the
  editor holds the file the turn left, the offer is the text from before it, and
  the offer's base version is the version the turn left, so the existing stale
  gate refuses a file that moved on. Taking a change undoes it through the
  ordinary save; ending the review keeps the source byte-identical. The adapter supplies fixed
  Undo/Keep labels and the surface swaps the colours. The retired proposal
  store, delivery poll, chat controls, and provenance branches have no callers.
- Surface recovery remounts the smallest boundary. Shell remount loses live buffers
  and reloads only saved source files. HTTP loss must not reload the app.
  Raw failures are mapped to feature-owned messages and recovery kinds.

### Document and Window Trust

Sandboxed, context-isolated windows have no Node integration and load the bundled
application origin (explicit Vite development is separate). Main authorizes live
main-frame origin and capability for each parsed IPC call and stamps HTTP/socket
identity itself. Canonical API/Agent paths only; asset requests carry no window
authority and retain server path checks. CSP/root containment, navigation/popup/
webview denial, and narrow preload methods cannot be weakened by document content.
Only sanitized clipboard write is granted to the application origin; paste needs
no background clipboard-read permission.
The production image CSP admits project previews only through the configured
server's `/asset/` route and temporary attachment previews through
`/api/agent/attachment-preview`, alongside bundled/data/blob images and the
Gallery proxy. Asset reads retain the server's project membership and path checks.

Markdown renders schema nodes; DOCX is sanitized inside its worker with the shared
policy. Local HTML's scripts run in an opaque sandbox without same-origin/preload,
form, popup, or navigation authority. Frame messages validate source, shape, and
user activation for external links (server-produced DOCX has its narrow exception).
Relative links resolve inside the source's folder. Executable HTML/remote resources
remain a documented trust gap, not permission to expand the boundary.

### Styling and Tooling

Executable configurations own exact layering, lint, coverage, size, duplication,
and unused-code rules. Do not reproduce their inventories here. Primitive/story
reachability complements unused-code analysis, which counts test-only callers.

One token/geometry/motion system serves app and catalog through shared providers.
Server-rendered pages opened outside the renderer restate those token values
locally and track the token layer when it moves. Bundled kit code never loads
registry/CDN assets at runtime. Overrideable CSS belongs in its layer; scoped
themes resolve their own tokens. Node's Settings own saved appearance through
one wire schema that is also its normalizer. Theme palettes and their token
mapping live in `shared/appearance-themes.ts`; a theme overrides tokens as
`--light-*`/`--dark-*` root properties, and the stylesheet's literals are the
StashBase theme. Electron main keeps only a disposable copy of the applied
appearance for native chrome, the spellchecker, and the next window's first
paint, refreshed by every window on each apply. Main lists installed fonts and
spellcheck languages from the operating system under its own window
capability; windows are never granted Chromium's font-access permission.
Chrome type follows the interface size. Reduced motion (system or Settings) must
settle both JS and CSS lifetimes, including transition-end waiters. Structural
shape, DOM-test, swallowed-error, and third-party token exceptions remain locally
justified and bounded. Stories/axe do not prove painted contrast or composition.

## Native Lifecycle and Updates

Main owns launch identity, save barriers, retirement tombstones, and shutdown.
Readiness must match the spawned instance, not merely a listener or PID.
Single-instance and startup arbitration prevent duplicate initial windows.
Packaged launches own their server; bounded POSIX orphan reclaim verifies sibling
identity and a dead parent before killing. Foreign/live-parented listeners remain untouched.
During a packaged relaunch, a compatible server owned by the previous instance
gets a bounded shutdown window before the replacement starts its own server.
If it stays live, startup reports the occupied port instead of racing a second bind.
The Linux deb updater defers relaunch scheduling until the owned server has
exited during main's quit sequence.

- Close asks the owning loaded renderer and stays open on failure/timeout.
  Confirmed renderer termination releases the barrier because its buffers are
  already lost; reloading establishes a new renderer that must acknowledge. Explicit
  quit retains intent through asynchronous saves and revokes it on refusal.
  Windows/Linux quit after the last window; macOS activation may create another.
- Update installation requires every loaded window's acknowledgement. Main locks
  interaction and new-window creation throughout save/install preparation so
  later edits cannot invalidate approval. Failure restores prior enabled state,
  revokes exactly its approvals, and leaves the download retryable.
- One main-process update manager owns startup and recurring checks plus a
  shared foreground/wake throttle. In-flight requests are shared across windows;
  throttled focus does not postpone periodic checks. Manual checks bypass the
  automatic preference, while timers/focus/wake honor it. Disposal prevents new
  requests and retires the timer.
  The update manager classifies only recognized connectivity failures during
  checking as warnings, including GitHubProvider's known latest-release wrappers.
  Feed XML is never classification evidence; all other phases and failures retain error severity.
  Native diagnostics spool that severity. The host aggregates identical check
  warnings in hourly windows by captured identity, version and diagnostic,
  preserving the first report and counted repeats. Replay follows occurrence
  time, and shutdown drains the spool before flushing repeat counts. Collection
  suppression and opt-out apply to both initial reports and rollups.
- Renderer requests never choose feed, path, or phase. A check that finds a
  release starts its download in main; only an explicit restart from the ready
  phase installs, and a completed download never installs or relaunches on its
  own. Production exposes no development simulator.
  Update offers render in the sidebar footer. The separate development tools
  ask app composition to close their dialog, expand the sidebar, and render an
  Updates-owned visual override in that same slot. Preview state belongs to the
  window, survives closing Settings, and holds no updater port. Dismissal or
  Stop preview drops only the override; the subscribed real state and its
  actions remain intact. Window unmount discards the preview.
- App quit authenticates to the owned server and awaits independent cleanup;
  timeout signals are fallback. Window close cannot terminate shared services.
  Native reload has no bypass around saving; current recovery remounts React.

## Bug Report and Gallery

### Bug Report

Main derives source/review identity from IPC senders. Review windows are independent
of their source and retain narrow capabilities. Collection is allowlisted and
bounded: only the authorized app-window screenshot, diagnostics, and sanitized
log tail. Never collect project files, transcripts, credentials, or raw config.
Unavailable/suspicious resources fail separately; raw resources never cross the
review interface or enter logs.

Preview shows the exact approval-eligible artifact and never changes inclusion.
Final description save precedes approval; unsaved text survives a failed attempt.
Approval freezes selected resources, and handoff atomically claims that snapshot.
Reopening discards approval. Rescan final formatted text before atomic output;
never recollect after approval. One approval has idempotent allocation/copy and
retry, while a fresh approval gets a new destination. Claimed handoff survives
window close. Downloads are user-owned; temporary output is session-owned.
Preparing, downloading, and opening GitHub remain explicit separate actions;
artifact bytes, paths, logs, and internal identities never enter a GitHub URL.

### Gallery

Node proxies a validated whole index and restricted screenshots; the renderer
never contacts arbitrary catalog hosts. Screenshot URLs resolve against the
native-provided server origin, not the bundled `app://renderer` origin. The
production image CSP permits that server’s `/api/gallery/image` proxy in
addition to project `/asset/` previews and bundled/data/blob images; native main-frame request authorization
still applies. Normalize URLs before exact host/path
checks, refuse redirects, validate before caching, and fall back to the bundled
snapshot on malformed/unreachable publications. The index has no version gate;
project entries carry one `screenshot` URL and a plain-text introduction. Index reads carry no project
or composer content. Both entrances share one copy latch. Acquisition uses the
ordinary import transaction; later window failure preserves the registered copy.
Only successful catalog loads remain fresh for the window session. Failed loads
retain any successful catalog (or the bundled fallback) and remain retryable.
The selected entry is an ID resolved against that catalog, not an independent
copy of its metadata. Image retries retain the restricted proxy origin. Gallery metadata never installs
ongoing Agent instructions. Personas ride the
same index as an optional array; an index without it keeps the bundled persona
snapshot. The overlay frame is shared, but its entrance fixes one shop: the
sidebar's Gallery shows projects and the picker's Browse personas shows
personas, with no switch between them. Adding one copies it into the reader's library through the Agent's
library port and chooses it for no Chat.

## Validation

Use [Journey Coverage](journey-coverage.md) for concrete front/back-end entry points
and existing evidence. For a cross-cutting change, start with the owners below.
Run focused checks while editing and the gates required by [AGENTS.md](../AGENTS.md)
before committing. Release-specific evidence stays in the [Release Runbook](release-pipeline.md).

| Boundary | Primary owners | Focused commands |
|---|---|---|
| Window/process lifetime, trust, updates | `electron/main.cjs`, `electron/window/lifecycle.ts`, `electron/renderer/requests.cjs`, `electron/update-window-barrier.cjs` | `pnpm test:electron`, `pnpm test:electron:smoke`, `pnpm test:updates` |
| Project paths, source transactions, import/recovery | `server/folder.ts`, `server/filesystem-path.ts`, `server/text-file-transaction.ts`, `server/project-file-mutations.ts` | `pnpm test:server` |
| Preparation, daemon, retrieval | `server/conversion-scheduler.ts`, `server/sync.ts`, `server/mfs-daemon.ts`, `python/stashbase_daemon.py` | `pnpm test:server`, `pnpm test:python` |
| Agent processes and protocol | `server/agent-contract.ts`, `server/agent-runtime-installer.ts`, `server/agent-adapters.ts` | `pnpm test:server`, `pnpm test:agent:native`, `pnpm test:opencode:native`, `pnpm test:protocols` |
| Settings/account/MCP | `server/app-config.ts`, `server/hosted-account.ts`, `server/mcp-http-settings.ts`, `server/project-operations/index.ts` | `pnpm test:server` |
| Renderer ownership and mechanics | `renderer/src/app/dependencies.ts`, `renderer/renderer-architecture.json`, `scripts/renderer/check-web.mjs` | Focused `pnpm test:renderer <path>`; Story checks `pnpm test:renderer:a11y`; complete `pnpm check:web`; wire changes add `pnpm test:protocols` |
| Bug report / Gallery | `electron/bug-report-service.cjs`, `electron/bug-report-handoff.cjs`, `server/routes/gallery.ts` | `pnpm test:electron`, `pnpm test:electron:smoke`, `pnpm test:server`, focused renderer tests |
| Scheduled tasks | `server/scheduled-tasks.ts`, `electron/scheduled-tasks/scheduler.ts`, `electron/scheduled-tasks/ipc.ts`, `renderer/src/features/agent/application/scheduled-run.ts` | `pnpm test:server`, `pnpm test:electron`, focused `pnpm test:renderer src/features/agent` |

Source tests, controlled native smokes, model quality, and packaged delivery
prove different things. Story accessibility checks execute each story's
interaction once at default/light appearance; happy-dom cannot establish painted
contrast or layout. Theme/density review remains a browser/runtime concern.
Use the [test selection policy](../AGENTS.md#test-selection) and
[command guide](../CONTRIBUTING.md#testing) to avoid duplicate validation.
