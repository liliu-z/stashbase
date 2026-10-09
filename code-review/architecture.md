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
  marker; DOCX needs sanitized marked output with text. Empty completed OCR is a
  successful non-searchable result. Checkpoints are not completion. Media playback never creates prepared text.
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
  Apply common hidden/dependency exclusions before traversal and mutation-triggered scheduling.
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
- Resource ceilings must stay finite and aligned across Node/Python. No-op reconcile
  spends no embeddings but still transfers text for MFS revision classification.
  A rename is not a zero-reembedding guarantee. Ranking changes need J05 evaluation.

### Optional Local Components

One PDF/OCR installation owner shares demand and waiters. Cost/status reads never
start downloads. Waiting conversions yield their lane. A process makes one
automatic demand attempt; failure has no timer retry. A durable demand latch
permits one next-launch attempt; Retry beside a waiting PDF/image starts one shared attempt.
Cancellation removes source demand and clears the durable latch when its last
source waiter leaves. Explicit/startup downloads have component ownership and
survive source cancellation. Shutdown retains unfinished demand.

Only the app's embedded version/platform/asset/size/hash manifest authorizes
bytes. Verify before confined, bounded extraction and atomic versioned publication;
validate links and never execute partial staging. Installed versions work offline.
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
- Codex MCP setup parses TOML and replaces only StashBase table ranges, preserving
  unrelated configuration. Invalid or unsupported configuration fails untouched.
  `server/agent-config-paths.ts` owns configuration identity for setup and Claude
  model metadata; MCP writes respect the same `CODEX_HOME` / `CLAUDE_CONFIG_DIR`
  inherited by provider processes.
- Each OpenQuill chat owns an authenticated loopback OpenCode process; each Codex
  chat owns its app-server/thread. History readers have separate ownership. All Codex app-server
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
  Edit shares `agent-file-permissions.ts` with the other adapters, granting only
  ordinary StashBase document writes inside the bound project (including
  realpath checks). Plan denies unlisted tools in the native profile and rejects
  unexpected mutating permission requests. Default offers no Auto reviewer.
  Approval replies grant once, require a pending request id, and never persist
  an `always` grant across modes. Options stay frozen while a turn runs.
  The bundled runtime filters inherited credentials and injection flags while
  using `agentCliPath` to restore CLI directories omitted by desktop launchers.
  Its private home does not provide the user's interactive shell setup;
  commands still require their dependencies to be installed and discoverable.
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
- OpenQuill receives a random session-local model broker credential, not account
  secrets. Model calls require an active submitted turn, retain its id/idempotency
  across the one auth-refresh retry, and cannot expose account tokens in history.
  Turn/channel retirement cancels body reads and pending upstream work; awaited
  credential acquisition cannot forward a request after retirement.
  Hosted quota/accounting and Stripe billing stay external; the desktop exposes
  bounded usage, plans, and subscription status. The host requests Checkout and
  Portal pages with the account session and hands the renderer only a verified
  Stripe-hosted URL; desktop account tokens never appear in links or Stripe
  configuration. Website billing uses its own browser session.
  Child environment and AppData HOME/config isolate ambient secrets and user config.
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
  explicitly and re-redacts diagnostics. No source identities, input contents,
  arbitrary event properties, credentials, raw logs or replay enter the queue.
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
  turn correlation retains identity/session through terminal signals. Unknown
  terminal turns after restart or opt-out cannot manufacture completion.
- Settings General discloses account linking and controls both usage and errors.
  Opt-out stops this process even if saving fails, cancels transport, and on a
  successful save removes the queue and all local analytics state. There is no
  final network notification. Re-enable creates new local IDs without backfill;
  a still-signed-in account may link again. Already received provider events are
  not deleted by this switch.
- `STASHBASE_TELEMETRY_DISABLED=1` suppresses collection and queue delivery before
  startup without changing saved preferences/identity. Electron passes it to Node;
  Settings cannot override it. Unpackaged builds never collect. Automated and
  manual packaged tests use the override; collection tests replace transport and
  never send to production PostHog.
- Automatic diagnostics use this same owner, suppression and opt-out. Node emits
  controlled summaries, known codes and stack line/column locations. HTTP, Agent,
  background and renderer failures converge here without throwing into operations,
  recursively reporting analytics failures, or creating another privacy setting.
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
- Milkdown serialization preserves frontmatter outside the body. Find/outline use
  the live document without mutating editor DOM during change callbacks. The sole
  double-cast exemption is its Find controller's structural DOM corpus and guarded
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

- Close asks the owning loaded renderer and stays open on failure/timeout.
  Confirmed renderer termination releases the barrier because its buffers are
  already lost; reloading establishes a new renderer that must acknowledge. Explicit
  quit retains intent through asynchronous saves and revokes it on refusal.
  Windows/Linux quit after the last window; macOS activation may create another.
- Update installation requires every loaded window's acknowledgement. Main locks
  interaction and new-window creation throughout save/install preparation so
  later edits cannot invalidate approval. Failure restores prior enabled state,
  revokes exactly its approvals, and leaves the download retryable.
- Renderer requests never choose feed, path, or phase. Automatic checks do not
  authorize downloads/install. Production exposes no development simulator.
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
production image CSP permits only that server’s `/api/gallery/image` proxy in
addition to bundled/data/blob images; native main-frame request authorization
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
| Project paths, source transactions, import/recovery | `server/folder.ts`, `server/filesystem-path.ts`, `server/text-file-transaction.ts`, `server/project-file-mutations.ts` | `pnpm test:project-files` |
| Preparation, daemon, retrieval | `server/conversion-scheduler.ts`, `server/sync.ts`, `server/mfs-daemon.ts`, `python/stashbase_daemon.py` | `pnpm test:conversion-scheduler`, `pnpm test:retrieval`, `pnpm test:python` |
| Agent processes and protocol | `server/agent-contract.ts`, `server/agent-runtime-installer.ts`, `server/agent-adapters.ts` | `pnpm test:agent`, `pnpm test:agent:native`, `pnpm test:opencode:native`, `pnpm test:protocols` |
| Settings/account/MCP | `server/app-config.ts`, `server/hosted-account.ts`, `server/mcp-http-settings.ts`, `server/project-operations/index.ts` | `pnpm test:config`, `pnpm test:mcp`, `pnpm test:project-files` |
| Renderer ownership and mechanics | `renderer/src/app/dependencies.ts`, `renderer/renderer-architecture.json`, `scripts/renderer/check-web.mjs` | Focused `pnpm test:renderer <path>`; Story checks `pnpm test:renderer:a11y`; complete `pnpm check:web`; wire changes add `pnpm test:protocols` |
| Bug report / Gallery | `electron/bug-report-service.cjs`, `electron/bug-report-handoff.cjs`, `server/routes/gallery.ts` | `pnpm test:electron`, `pnpm test:electron:smoke`, `pnpm test:project-files`, focused renderer tests |

Source tests, controlled native smokes, model quality, and packaged delivery
prove different things. Story accessibility checks execute each story's
interaction once at default/light appearance; happy-dom cannot establish painted
contrast or layout. Theme/density review remains a browser/runtime concern.
Use the [test selection policy](../AGENTS.md#test-selection) and
[command guide](../CONTRIBUTING.md#testing) to avoid duplicate validation.
