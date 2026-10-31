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
| Node server | Registered projects, authorized file operations, preparation, Settings, MCP operations, agent adapters |
| Python/MFS | Completed text projections, revisions, chunking, embeddings, status, and retrieval through public APIs |
| Native agent runtime | Sessions, conversation history, native capabilities and tool execution |
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
| [Project files](../design-docs/capabilities/project-files.md) | Renderer owns live drafts; Node owns source/version transactions shared by HTTP, agent, and MCP; Electron gates window release. See [source transactions](#source-transactions) and [draft durability](#draft-durability). |
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
  Entry and agent startup never seed or rewrite user-owned instruction files.
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
  exclusions for preparation and retrieval. A listing reads directory entries and
  `lstat` only and never opens a source: a cloud-only file downloads on its
  first read, so one read per row made the tree wait on the network. Workspace listings apply the browsing
  preference with either explicit project scope or window scope; agent/MCP directory
  discovery uses the separate Project Operations surface.

The shared entry experience is owned by [Entering a Project](../design-docs/capabilities/project-entry.md).
The renderer owns one acquisition/entry operation per window. Electron serializes
window selection, includes the initiating window in identity matching, and waits
for the destination renderer's workspace acknowledgement. Entry cancellation and
window closure retire the handoff; an occupied window keeps its existing work.
Session restoration restores presentation only and never initiates project entry.

## Source Transactions

HTTP, agent, and MCP adapters share file/version authorities. Source capability
follows the [format matrix](../design-docs/capabilities/project-files.md#format-capability-matrix);
preview, content editing, and rename/delete are separate permissions.

- Agent/MCP `read_file`, `write_file`, and `edit_file` accept explicitly addressed
  UTF-8 text independently of document extension membership. Project writes use
  `saveTextFileContent`; Documents keeps its format gate in `saveFileContent`.
  Both use the same bounded, strict UTF-8 snapshots and versioned transaction.
  Known binary containers and binary control bytes are refused before text
  replacement; atomic writes preserve existing file permissions. Generic text
  never enters indexing or automatic context merely because a tool can edit it.
  Paths remain literal; tools never complete a filename with a document suffix.
- XLSX remains a generic file to the editor. `spreadsheet-preview.ts` parses a
  bounded source snapshot in a cancellable worker and returns display strings and
  formula cells to the generic preview route, including exact-file external grants,
  and to `read_file` in `project-file-reader.ts`, which renders that same parse as
  Markdown tables (`spreadsheetAgentText`) marked as derived. Archive expansion,
  parsing time, worker heap, worksheet count, cell range and output text are bounded.
  The end-of-directory record must end the file, since SheetJS reads the last one.
  The worker counts each worksheet's cells from its XML before parsing, asks
  SheetJS (dense) for only the first 1,000 rows, and refuses more than 500,000
  cells there, because a worker out of heap can abort the host. Sheet extents
  cover the declared range, the listed cells and the parsed cells.
  A bounded content-hash cache reuses unchanged parses across both. The renderer
  displays text, never workbook HTML, hyperlinks or executable formulas. Neither
  path widens the binary-file write gate, preparation or retrieval; `edit_file`
  refuses the derived text, and Claude's native `Read` of a project workbook is
  redirected once to `read_file`, as for prepared PDF and DOCX.
- CSV and TSV are editable text outside `detectFormat`, which stays the indexing
  and retrieval test: `detectEditableTextFormat` admits them to the versioned text
  read/save routes and external-file grants. `delimited-table.ts` owns the quoting
  rules in one resumable byte-level record reader shared by the full-file scan
  (strict UTF-8, a checkpoint every 256 records, the widest record) and page reads
  that seek to the nearest checkpoint. Scans yield between 1 MiB chunks, stop at
  512 MiB, are cached by stat identity and shared by concurrent reads, stop once
  no read waits for them, and run again when the file changes
  underneath; one response is bounded in rows and characters. A non-UTF-8 file
  reports a likely encoding instead of being decoded. A CSV save restores the line
  endings of unchanged lines (`keepUnchangedLineEndings`), matched by a bounded
  patience line diff; other formats keep the dominant-ending rule.
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
  wraps every agent socket bound to a folder: a prompt and everything after it
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
  Workbench mutations do not broaden agent content permissions.
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

`server/state-db.ts` owns the startup preparation-storage check: load the native
addon in the actual server runtime, round-trip a disposable WAL database in app
data, and verify the existing status database permits a write transaction without
changing records. The write probe waits at most 250 ms: a lock held by another
process counts as in use, not failed, and scratch cleanup never changes the
result. The health response carries this startup snapshot separately
from server identity. Electron relays only a verified server's bounded warning,
once on a foreground window; unavailable preparation does not block editing.
Checks never replace damaged state or rebuild dependencies inside the running app.

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
  handle release. A Windows extractor launch returning `UNKNOWN` retries once
  after a cancellable 250 ms delay; no successfully started extraction is replayed.
  Persistent launch failure retains its cause, errno/syscall and attempt count.
  Extractor stdout is drained even though artifacts are written to files.
  macOS PDF batches use fresh spawned interpreters rather than inheriting native
  PDF/OCR state through fork. The combined frozen entry calls freeze_support
  before dispatch; batch workers and PDF/OCR entry points enable native fault
  tracebacks on stderr. A crash still fails conversion and cannot publish empty
  success or silently retry uncertain work.
  Optional helpers must not block browsing or steal native focus.
- Reconcile is folder-explicit and rediscovers lost in-memory work. Boot binds
  every registered folder and reconciles none; a folder reconciles when a window
  opens it, offering sources in bounded batches that yield the shared event loop.
  Apply common hidden/dependency exclusions to paths relative to the owning
  registered folder before traversal and mutation-triggered scheduling. The
  MFS adapter repeats that check against its longest bound folder; ancestors
  outside the project must not affect eligibility.
  A child directory denied with `EACCES` or `EPERM` is recorded as a partial-scan
  failure. Reconciliation preserves index rows, derived artifacts and preparation
  state beneath that directory while processing readable peers, including their
  confirmed removals. Root scan failures and unexpected traversal errors still
  fail reconciliation before cleanup. The next readable scan reconciles the
  retained subtree normally. Status polling clears durable preparation problems
  only after `ENOENT`/`ENOTDIR` confirms absence; permission and I/O errors retain
  failed and cancelled records. Folder-scoped index warnings name skipped paths and
  reach Search even without an embedding key. Queuing invalidates stale final
  output; confirmed source removal retires all owned artifacts.
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
- MFS startup has one shared readiness/retirement promise. Its ninety-second
  deadline retains the timeout and last observed startup phase, then retires
  the whole process tree. Timeout evidence separates command preparation,
  synchronous process creation, readiness waiting and watchdog callback lateness;
  a late callback does not establish slow Python initialization. Close waits for
  pipe/group release, using Windows
  taskkill or a dedicated POSIX process group. A 3.5-second close deadline
  rejects without allowing replacement; actual late closure releases the fence.
  A retired or timed-out generation cannot publish late readiness or replies.
- Resource ceilings must stay finite and aligned across Node/Python. No-op reconcile
  spends no embeddings but still transfers text for MFS revision classification.
  A rename is not a zero-reembedding guarantee. Ranking-quality evidence and
  the deferred evaluation are tracked in [J05](journey-coverage.md#j05-search).

### Optional Local Components

One PDF/OCR installation owner shares demand and waiters. Cost/status reads never
start downloads. PDF cost probes discover already installed components through
that owner and return unknown cost while unavailable; packaged probes never fall
back to development scripts. Waiting conversions yield their lane. A process makes one
automatic demand attempt; failure has no timer retry. A durable demand latch
permits one next-launch attempt; Retry beside a waiting PDF starts one shared
attempt. Image viewers do not render preparation or component recovery;
OCR affects search text only. PDF and DOCX retain their preparation status rows.
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
  readiness check of the old executable. Every explicit bootstrap verifies a
  discovered executable with the same bounded `--version` probe the installer
  requires, including one installed outside StashBase meanwhile. A broken
  launcher follows installation in that first attempt, without depending on
  a prior failed startup/authentication check. Working copies skip installation.
  Antigravity's check asks Google, so an unanswered check retries through
  sign-in when its executable runs; a broken launcher offers bootstrap repair.
  The chat catalog maps the host's `retryAction: login` to its
  sign-in prerequisite, so first-send and Settings follow the same recovery.
  Stop ends only a running sign-in; a stop that finds another
  run in its place leaves that run alone and answers at once.
  While a flight runs, its status carries the step sentence the service wrote
  and, during browser sign-in, the complete `https` page the login command
  printed when its OAuth redirect stays on loopback; the first-send prompt and
  Settings both present them. Claude prints a page that redirects to its
  provider for a pasted code, and login stdin is not relayed, so it carries none.
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
  browser sign-in. A runtime whose status reads signed in starts no login.
  During login the status check runs beside it; the first signed-in reading
  completes sign-in and retires the login process, so a login command that
  keeps waiting after the browser step cannot hold setup to its deadline.
  Native authentication refusals restore the sign-in action;
  they never delete credentials. The chat workspace refreshes its readiness
  catalog when a turn or terminal connection reports `auth-expired`; either names the sign-in
  prerequisite and opens Agents settings through app composition. It preserves
  the raw diagnostic and draft, and never replays the failed request.
  A refusal survives concurrent and later local status checks, even when the
  CLI reports cached credentials as signed in. Only an explicit successful
  sign-in clears it; that sign-in waits for the login command itself. Sign-in failures keep the login's last output with URL query strings
  removed. A provider that refuses a signed-in account
  (`AgentAccountRefusedError`, code `account-refused`) offers a recheck
  instead, because signing in again cannot change its answer. Setup errors retain bounded stdout/stderr and
  nested network causes, with agent/action/stage context. Settings and chat
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
  Its stdio `env_vars` explicitly forwards `STASHBASE_WINDOW_ID` and
  `STASHBASE_AGENT_SESSION_ID`; Codex filters custom parent variables otherwise.
  Configuration stores variable names, never a live chat's identity or folder.
  `server/agent-config-paths.ts` owns configuration identity for setup and Claude
  model metadata; MCP writes respect the same `CODEX_HOME` / `CLAUDE_CONFIG_DIR`
  inherited by provider processes.
- Antigravity has no configuration-directory override, so its StashBase MCP and
  hook entries live in `~/.gemini/config/mcp_config.json` and
  `~/.gemini/config/hooks.json`, which its CLI, IDE, and app share. Setup replaces only the `stashbase` entry
  in each and leaves an unparseable file untouched; an empty file, which an
  earlier install can leave behind, counts as an empty configuration. The generated `PreToolUse`
  launcher (`~/.stashbase/bin/stashbase-antigravity-hook`) answers `allow` when
  no StashBase session id is in its environment, which leaves that run's own
  permission rules in charge. Inside a StashBase chat it asks the generating
  host and denies when the host cannot answer.
- `server/agent-cli-launch.ts` owns how agent CLI processes start: probes,
  login, installer verification, and every session runtime. Windows `.cmd` and
  `.bat` launchers, such as npm shims, run through cmd.exe with cross-spawn's
  escaping; Node's `shell: true` joins an unquoted command line and splits a
  profile path with a space.
- `server/native-agents.ts` owns each bring-your-own CLI's names, executable
  overrides, npm package, official installer, and Windows bin directory.
  Discovery, installation, readiness, and the CLI listing read them there.
  Antigravity readiness runs `agy --output-format json -p /usage`, which needs
  the cached sign-in but starts no turn. Its sign-in entry runs that same check
  before starting a terminal: a signed-in account returns immediately and a
  refused account keeps its error without opening login. A check that cannot
  answer starts the terminal, because an answer it does not recognize may be a
  signed-out account, and the readiness failure it leaves names sign-in as its
  retry action. Cancellation
  during that check cannot start a terminal or report success.
  `agy` has no login command, so its
  sign-in gives an interactive `agy` a pseudo-terminal (`script`) or, on Windows,
  its own console, polls readiness, and retires that run after success,
  cancellation, or the shared ten-minute deadline.
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
  History readers have separate ownership. OpenCode and Codex app-server
  owners share retirement that waits for pipe closure and process-tree exit,
  escalating termination when needed. OpenCode startup remains single-flight
  through cleanup; failed cleanup fences further starts. Only the history-list
  entry requests one startup retry for timeout/early exit, after retirement.
  Preparation failures, cancellation, chat dispatch and history mutations never
  receive this retry. Startup listeners are removed on every outcome;
  startup telemetry measures preparation (including private environment/config),
  process creation, readiness waiting and failed-process retirement separately.
  A phase that was never entered is absent, not a zero-duration observation;
  shutdown also awaits readers and already-retiring processes.
  Detached session and spare cleanup must observe their own rejection, including
  promises created by async wrappers; a handler on the underlying process promise
  is not sufficient. Cleanup failures remain diagnostic and reject awaited
  retirement without escaping into an unhandled host exception. The process owner
  retains a timed-out child until final pipe/group closure; OpenCode releases its
  runtime only after that closure and startup settlement, preserving the original
  failed promise. Shutdown attempts every runtime and broker despite a failed peer.
  Normal EOF of an owned OpenCode event stream is also terminal unless the
  session is already disposing. It reports once, retires the runtime and socket,
  and never replays a prompt; late initialization failures cannot report again.
  Process death settles pending RPCs/turns, and generation guards reject late
  messages. An ambiguous timed-out start retires its generation before retry.
  Claude replacement waits for native iterator/query cleanup after verifying scope.
- Codex accepts a follow-up through `turn/steer` at once but reads it at the
  turn's next step, recording a `userMessage` item whose `clientId` is the
  `clientUserMessageId` sent with it. The turn's own prompt is sent with a
  client id too, and its recorded item shows whether the app-server keeps ids.
  A follow-up waits until `turn/start` or `turn/started` names the turn and that
  item arrives. Where ids are kept, only the follow-up's item confirms it, and
  one still unread when the turn ends or stops is returned, since Codex drops
  it; an app-server that drops ids confirms it on acceptance. A timed-out
  `turn/steer` is left for that item or the turn's end to decide.
- Each Antigravity chat owns one `agy` stream-json process, started by its
  first prompt with the chat's mode, model, and effort as launch flags. A change
  to any of them, Stop, or process exit retires it, and the next prompt resumes
  the same conversation with `--conversation`. `agy` accepts no caller system
  prompt, so the agent role, persona, and routing policy ride ahead of each
  process's first message. Like a Claude session, each chat reads the runtime's current models
  when it starts; because one `agy` read takes 10–20 seconds, it opens on the
  remembered list and replaces it when the read lands, and chats opened within
  a minute share one read. A `SUCCESS` result with no text, response, or tool fails the turn;
  `AGY_ERROR` and `error:` stderr lines supply a failed turn's message.
- Claude requests native session-state events and ends a turn at `idle`, using
  its latest result for success/failure. Intermediate results while background
  agents run do not release the turn or its queue. Native runtimes that emit no
  state events retain the result boundary. Stop still requires native completion
  and interrupt acknowledgement; process death remains a failed session exit.
  The turn's prompt carries a uuid. A follow-up joins the running turn as a
  uuid-tagged `priority: 'next'` input only once the CLI has reported session
  state and a `command_lifecycle` frame, held until then; its `started` frame
  confirms it. A CLI that never reports reading input returns held follow-ups
  at the turn's end, so one it read unannounced is never sent twice. Claude reads it at a tool boundary or runs it after the reply,
  both inside the turn that ends at idle. One a Stop or the turn's end overtook
  is interrupted as it starts and returned. Replay restores follow-ups read
  mid-turn, stored as `queued_command` attachments the SDK reader omits.
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
- Project agent preferences are explicit choices in Node-owned app config, keyed
  by registered project scope. Readiness and history restore never write them.
  Model and thinking effort are stored separately per agent in that project.
  Explicit changes atomically update the project and user-wide `lastSelectedModels`
  / `lastSelectedEfforts` maps. The preferences response supplies `defaultModels`
  and `defaultEfforts`, using existing remembered project choices where an agent
  has no user-wide value. Renderer seeding overlays project choices on those maps;
  explicit null resets override inherited values. Switching agents, restoring
  history, and persona changes do not replace another agent's defaults. Removing
  a project retains the user-wide choices. Composer choices
  update the window cache immediately and persist in order; new/blank chats seed
  from that cache, while history clears the new-chat model before resuming and
  restores its native effort. Cached catalogs only populate the picker; they do
  not validate or clear pending choices. Codex reconnects honor the model carried
  by the renderer; history clears project defaults before connecting. Its native
  thread response publishes effective effort before ready, separately from catalog
  defaults. Missing catalog entries and rejected turns never substitute another
  Codex model. Other adapters may explicitly report catalog fallback without
  overwriting preferences. An effort reset or a model change that changes effort
  reconnects with the intended effort, so native resume cannot retain the old one.
  Model and effort writes preserve the
  preferred agent, persona, and other runtimes' choices.
  An explicit agent selection atomically saves both the project choice and the
  user-wide `lastSelectedAgent`. The preferences response supplies the fallback
  for unchosen projects: that selection, an existing remembered project choice,
  or Default when neither exists. Model, effort and persona writes preserve it;
  removing a project does not clear it. The renderer reads preferences on project
  entry, so an already open Welcome window sees another window's later choice.
  Failed preference reads/writes remain visible.
  Access requested on Send retains a scope/session/draft snapshot and cancellation
  owner. Only confirmed readiness may continue that same submission once; navigation,
  edits, cancellation, and disposal reject late completions. Setup HTTP 202 is an
  acknowledgement to poll, not permission to initialize or send early.
- Unstarted means no session/transcript/turn; blank also means no pending user work.
  Blank chats may follow the window and be reused; user work pins scope. Runtime
  adoption preserves drafts, source bindings, and transient upload bytes. Catalog
  connections before the first request may be replaced when changing agent. Mode changes
  never remount ongoing work merely to change presentation.
- Started sessions survive window folder switches. Member removal retires only
  bound sessions, reports a structured scope-removed event before closure, preserves
  transcripts, and rejects queued/late work. Expected retirement never reconnects.
- History restore joins repeated requests for the same project/agent/native id.
  Mounted titles carry a manual-rename flag; first submissions supply a fallback
  title hint. Rename mutations serialize before publishing confirmed titles.
- Native history is authoritative. Native cwd determines project ownership; no
  override store or live session migration exists. Antigravity is the exception:
  it exposes no history interface, so `server/antigravity-history.ts` records the
  conversations StashBase chats start, keyed by native conversation id and scoped
  by project. Remove deletes only that record. History and WebSocket startup
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
  with the shared role and internal conversation and tool-routing policy in
  `server/agent-runtime-instructions.ts`. Default and native adapters use that
  same composition; provider-native prompts remain in place. The policy owns
  the default to answer in Chat and the requirement for a user request or
  applicable loaded project workflow before file output. It guides model
  decisions; it does not enforce a write gate. Discovery has no mandatory
  tool preflight, and insufficient prepared text permits native source
  inspection within runtime permissions. The same policy requires that
  existing text files use `edit_file` while new text files use `write_file`,
  including requested source code and configuration; a tool description alone
  cannot own a rule, because a runtime may defer it. Neither is a permission,
  skill contents, or a project-file edit. Product authoring guidance distinguishes
  Markdown text notes from HTML interactive notes and directs blank HTML creation
  through `create_interactive_note`; other workflows belong to loaded project instructions.
  `server/agent-persona.ts` owns the library: one Markdown file per persona in
  app data, seeded once from `assets/agent-personas/`, plus the record of each
  native session's persona. The Chat's persona id travels on its connection;
  the shared Agent Contract records it against the `session-id` every runtime
  announces, and replay returns it. The project's choice for new Chats is an
  agent preference. A change never mutates a running native prompt: the
  renderer resumes the Chat's own conversation, as it does for effort, so the
  persona applies from the next turn. Gallery personas are Gallery index data;
  the composition layer adds them through the agent's library, since the
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
- Hosted multimodal admission belongs to the adjacent stashbase-api repository's
  estimator: text and framing are separate from media's financial fallback. Only
  the text estimate drives local context refusal; provider media usage remains
  authoritative. Admission never parses/decompresses PDFs or fetches remote media,
  and forwarded bytes stay intact. Content-free refusals record both estimates,
  the limit and attachment sizes. Transport and context have separate limits.
  Under the account lock, uncertain media cost uses remaining user capacity
  after text and a useful output budget; it cannot impose an unaffordable user
  input floor. Provider-day admission retains the complete media estimate, while
  confirmed user charges remain capped by the immutable user reservation.
  `hosted-agent-broker.ts` turns a media-bearing HTTP 413 into a non-retryable
  attachment recovery error before OpenCode can discard media during compaction.
  Upload-size refusal is also terminal. Saved history retains original files and
  the failed turn pauses the queue. Text-only overflow can compact:
  `OpenCodeEventTranslator` keeps it pending until a successful non-summary
  completion; failed summaries and idle without continuation still fail.
- Attachment age cleanup excludes batches created by the active server process;
  drafts, queues, and retries may retain them until process exit. They remain
  temporary files, not durable historical attachments. History restoration only
  offers a preview URL after checking the real path within transient storage;
  the preview route repeats that check. Remote context tiles fall back to a named
  card on load failure, covering deletion between restoration and image loading.
- Context/attachments are explicit. Validate source identity before send; stale
  context blocks it. The queue captures prompt, context, skill, and id, and Retry
  uses that exact submission after checking locally available context. Sessions,
  not mounted composers, hold follow-ups sent into a running turn as pending
  `steers` until the runtime's `steer-result`. One sent while the prompt that
  starts the turn is still preparing or connecting is held until that prompt
  submits, and returned if it never does. A taken one becomes a user block
  at that point, and a refused one, or one a turn or connection ended without,
  goes to the head of the queue. Sessions advance queues after a completed or confirmed-stopped
  turn; failure and connection loss hold them until a later turn completes or an
  uncertain outcome is confirmed. Transport refusal retains the queued
  request; uncertain delivery retains the visible submission and forbids automatic
  resend. Clear only the accepted draft snapshot, never newer input. Explicit
  queue/message reuse refuses to overwrite another draft. A reused prompt starts a new turn rather
  than truncating history. Historical metadata cannot restore attachment bytes.
- Models/effort/modes follow runtime capabilities. Catalogs seed drafts, not live
  identity. No catalog-order default or global CLI rewrite; active turns freeze
  changes. Skills use native invocation, not concatenated skill-file contents.
- `electron/notifications/center.ts` owns notification lifetime, background-only
  delivery, coalescing and deduplication by owner, kind and ID. Each producer
  replaces only its own kind's snapshot; retiring a window clears every kind.
  `ipc.ts` authorizes main-frame/capability senders and binds them to windows;
  `preferences.ts` atomically persists the user-wide master and category switches;
  IPC applies one field per update so peer windows cannot overwrite unrelated
  choices. The typed
  protocol registers bounded event variants, and `catalog.ts` owns presentation.
  To add a notification kind, register its wire variant and presentation, then
  wire its producer's snapshot and activation handler in composition. Keep its
  live target validation in the owning feature; delivery needs no new routing
  rules. Do not accept arbitrary URLs, permission decisions or tool/document data.
- The agent producer observes all retained sessions through
  `agent/application/attention.ts`. Its opaque notification IDs map to pending
  session/request identities inside the agent feature. Clicks restore the owner
  and return only kind/ID; the feature rechecks the pending target before navigation
  and focus. Stop, resolution, navigation, renderer loss and window close revoke
  stale targets. Notification delivery never grants permission.
- `agent/application/observe-sessions.ts` owns retained-session subscriptions for
  both attention and outcome projections. `outcome-notifications.ts` observes
  submission/live-turn transitions, never transcript history alone. It retains
  the latest outcome per chat with a distinct ID for each run/retry and a result
  block target. Stop intent remains latched through cancellation timeout/failure;
  startup failure settles after synchronous cancellation transitions. Closing,
  replacing or retiring a session revokes its targets. Outcome clicks recheck the
  result block, expose its transcript page and focus it; startup failures retain
  the composer. Pending notifications may wait for background; event notifications
  are consumed while foreground or disabled, without later replay. The catalog
  selects this delivery policy; the center implements it independently of agent
  state. All variants use the existing renderer platform adapter and native driver.
- `electron/notifications/native.ts` uses Electron's common title/body,
  show/close and click APIs on macOS, Windows and Linux. Windows sets the AUMID to
  the packaged `build.appId`; NSIS creates the corresponding Start Menu shortcut.
  Linux uses the desktop notification service (deb declares `libnotify4`), while
  macOS uses system notification authorization for the signed app. No platform-only
  actions or custom toast markup form the contract. Support and delivery events do
  not establish OS authorization or visible banners. Native presentation and click
  behavior remain platform package checks in the release checklist.
  `system-settings.ts` selects fixed OS settings destinations and detects
  supported Linux launchers. The no-argument settings IPC uses the same sender
  authorization as notification preferences; renderer input cannot supply URLs
  or commands. Window focus republishes fresh service/launcher availability and
  preserves delivery evidence and app preferences. The existing renderer
  platform adapter translates the typed settings target into instructions and
  an open capability; Settings contains no OS branches. Electron's common API
  cannot read notification authorization, so this flow never claims granted or
  denied status. Unsupported desktops and launch failures retain manual recovery.
- `agent/application/desktop-sessions.ts` projects existing session selectors
  into bounded activity snapshots through the existing notification platform
  adapter. It deduplicates summary-equivalent streaming updates and validates
  session/request identity again on activation. Main stores activity per owning
  window and retires it on navigation, renderer loss and close. Activity has its
  own typed channel, independent of notification eligibility and unread state;
  callbacks carry only session identity and cannot approve work.
  `notifications/center.ts` owns the background attention count: pending items
  remain until resolved, while owner focus acknowledges outcome items. Opt-out
  and retirement clear counts without replay. `indicators.ts` projects these
  counts and ordered host-owned sections into native menus and badges. Sections
  have stable IDs and identity-bearing rows; the presenter omits empty sections,
  bounds visible rows and re-resolves section/row identity before activation.
  IPC currently composes only Running from live session activity. Future producers
  (for example a scheduler) must own their data, ordering and live activation;
  add their section at composition rather than teaching the native presenter
  scheduling rules or introducing arbitrary renderer actions. No scheduler or
  upcoming-task IPC exists yet. All OS branches remain in the native notification
  boundary. Tray loss must not fail agent work or alter window-close semantics.
  Tray images derive from the application mark through `scripts/icons/status.mjs`
  and ship inside `electron/notifications/icons`; macOS uses Retina templates.
- Pending approvals require the exact request id; abort/disposal denies them.
  Codex advertises supported approval scopes to the renderer. Session decisions
  map to native command/file decisions or permission grants; MCP persistence
  reads the request's `_meta.persist` and returns only an offered scope in response
  metadata. Codex owns remembered grants; StashBase does not cache blanket tool
  authorization. Native automatic-review denials remain visible and are not replayed.
  Read/orientation/reindex may use the low-risk path. Document writes remain
  permissioned and Review never grants a write in advance. Edit policy grants only its
  bounded writes; move/delete/commands/network/broader access require their own
  authority. `create_project` needs an explicit request or visible approval.
- Shared instructions require StashBase `edit_file` for existing project
  documents and `write_file` for creation, including after a failed native attempt.
  Explicitly requested external writes use native tools under runtime permissions;
  project MCP scope, conversation ownership, and project turn review do not expand.
  Claude exposes native Edit/MultiEdit/Write/NotebookEdit for external targets;
  a PreToolUse hook in `server/agent-native-write-guard.ts` denies them when the
  target's realpath (nearest existing ancestor, with links and directory aliases
  followed) is inside the bound project. Hooks run before Claude's permission
  modes and inside subagents, so Edit and Auto cannot approve that write first.
  OpenQuill asks for the native edit permission shared by edit/write/patch and
  denies it in Plan. Native writes do not receive the shared bounded MCP
  Edit-mode grant in `server/agent-file-permissions.ts`. Shell writes and other
  runtimes' native tools follow routing guidance, which is not a filesystem
  isolation guarantee. Turn review continues to detect all scanned
  Markdown changes regardless of the writing tool. External MCP clients have no
  app-owned turn socket and do not receive Chat turn-review cards.
- Codex modes use on-request approval with mode-specific sandbox/review policy;
  each `turn/start` carries the selected reviewer, including after a mode change
  on an existing thread. Reviewer-only changes preserve the native sandbox;
  leaving Plan restores the resolved workspace sandbox when available. Mode
  changes during an active turn are ignored.
  Claude maps native modes. Headless `agy` cannot ask the reader, so Antigravity
  runs with `--dangerously-skip-permissions` and every tool call passes the
  approval hook. `server/routes/antigravity-hook.ts` reviews a call only for the
  live Antigravity session named by the private attribution id its process
  inherited, from that session's conversation, during its running turn; an
  unknown or retired id is denied, and another runtime's id is left to that
  run's own rules. `server/antigravity-protocol.ts` owns the policy: reads pass,
  Edit passes ordinary writes inside the bound project through
  `agent-file-permissions.ts`, Auto adds read-only command lines
  (`isReadOnlyCommand`: known programs, pipes only, no chaining, substitution
  or redirection), web searches and query-free page reads, Plan denies anything
  that could change the project, and the rest becomes an approval card. A card
  withdrawn by the hook, Stop, turn end, or disposal denies. Auto launches
  `agy` like Edit; native Auto is never used, because it decides inside the CLI
  past the hook and refuses StashBase's MCP tools. Default maps Ask/Edit/Plan to OpenCode profiles;
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
  remaining drains; late answers cannot approve a later turn's action. Main agent
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
  explicit sign-in, outdated native runtimes need their own updater,
  `app-outdated` opens General settings for the StashBase updater through app
  composition, credits/restrictions need account recovery, transient
  failures may resend. Raw socket loss has bounded retry then manual recovery.
  The optional structured failure also travels on terminal `exit` events;
  pre-ready errors and a following empty exit retain their repair action.
  Classification never turns interrupted work into a safe automatic resend.
  A runtime update that reaches authentication refreshes readiness and offers
  sign-in from every update entry, including the model menu. Continuing after
  sign-in checks readiness before reconnecting and never reruns the installer.
  A terminal sign-in failure also retains explicit reconnect after Settings.
  First-send preserves the host-selected setup retry action, including
  `update`, instead of silently substituting bootstrap.
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
  The model picker exposes an updater only when the host advertises `updatable`
  and an `availableVersion`. `server/agent-runtime-releases.ts` owns that
  answer: discovery reads its last result for the installed `--version` and
  starts the next feed read when due (hourly, 15 minutes after a failure),
  never waiting on the network, and only while automatic update checks are on.
  The first discovery after launch therefore answers before any reading, so the
  chat's runtime catalog is read again whenever the model control opens; it
  keeps its own query, separate from Settings', and the app does not refetch
  on window focus.
  `use-agent-catalog.ts` also follows host-reported preparation until it settles,
  so the first listing cannot strand a mounted composer before startup checks
  finish. Only running preparation is polled; ready, missing, signed-out and
  failed runtimes stop it. A read failure retains the last catalog and stops
  automatic reads until explicit Retry; unmount cancels outstanding reads.
  Readiness refreshes never launch a session, send a draft or change its agent.
  Each feed is the one the provider's installer reads (Claude's channel from
  its own user settings). Test runners never reach the feeds. This explicit action shares the failed-turn update owner, but has no request
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
| Renderer agent feature | Starts the run's chat through the session's ordinary send path, answers whether its request was accepted, and reports how its first turn ended. Shows the task list in the chat's place. |

- `shared/scheduled-task-timing.ts` is the one due rule: main decides what to claim
  with it, the list's adapter reads each task's next run and its missed days from it,
  and the server records the missed days with it when a claim follows them. Both
  place the entry in the history with the same helper, so the list's pending entry
  and the recorded one never disagree in content or in place. A run that cannot start
  within the rule's on-time window is missed, never run late.
- Claims are at most once. The server refuses an occurrence at or before the one last
  claimed and a second run of a task still running in this process; a run left running
  by an earlier process reads as failed. A lost answer never causes a second dispatch.
- Each task keeps a bounded run history. A run moves forward only: main's report
  applies only to a run still starting, and the window's first-turn report only to a
  sent run, so a late or repeated report never rewrites an outcome. The first-turn
  report carries a bounded excerpt of the agent's last reply, kept with the outcome.
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
  agent pinned against a late preference load, title marked as renamed. The run checks
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
  indexing; agent and MCP writes follow the ordinary editable-file rules.

## Credentials and External Access

Node is the sole atomic app-config writer. Strict writes fail on malformed or
unwritable current state rather than saving fallback defaults; preserve unrelated
current domains. Never repair filesystem ownership/ACLs automatically. Historical
data migration is not required by [maintenance policy](../MAINTENANCE.md#previous-version-data-policy).

- BYOK keys enter through Settings, never environment or projects. Renderer input
  is transient; Node owns account-token persistence and never exposes tokens to
  the renderer. Electron may handle them transiently only for the fixed Auth
  transport described below. Account state does not configure
  embeddings. Reconfigure only the dependent runtime; a runtime failure does not
  undo a successfully persisted key. Later key mutations supersede pending
  validations; runtime changes serialize in the same owner.
- Account OAuth uses Node-owned PKCE and window-bound opaque flows. The fixed
  app-return deep link carries no code/token/flow id; authenticated native
  acknowledgement proves focus handoff. Cancelled polling is not OAuth revocation.
  Only packaged Electron registers the OS return protocol. The callback emits
  a protocol link and its return script only for a packaged host; source and
  standalone Node runs retain the result page with manual switch-back guidance.
  On macOS/Linux, registering generic Electron cannot preserve the source entry
  path, and development must not steal the installed application's handler.
  One renderer account provider owns the browser wait for all window surfaces.
  New OAuth attempts and successful local sign-out retire earlier unfinished
  flows across windows; exchange must recheck flow identity/state after awaiting
  the provider and before persistence. Refresh is single-flight and can update
  only the session it began with; stale work cannot borrow a newer account token.
  Agent allowance reads own a twenty-second deadline across token acquisition,
  HTTP headers/body and the one 401-triggered refresh. An expired reader stops
  waiting for a shared token refresh without cancelling other readers' work;
  its late continuation cannot send another usage request. Body cancellation is
  an error, never a successful null allowance. Network failure preserves the
  saved session and a later explicit/polled read can recover.
  Only an authenticated service rejection (401) or an explicit null session
  may clear matching saved credentials. Malformed successful responses are not
  evidence of revocation. Network, timeout, rate-limit, and server failures preserve them.
  Credits and billing return 401 when authentication is lost during their request,
  as they do for a request begun signed out; other upstream failures remain 502.
  Unreadable Auth responses retain upstream status, content type, request ID and
  safe parse/transport causes. Parser body excerpts never enter diagnostics.
- `server/hosted-auth-transport.ts` sends desktop Auth exchange, refresh, profile
  and logout requests through `electron/account/auth-network.ts`. Electron owns
  an in-memory Chromium session in system-proxy mode; Node retains PKCE, session
  persistence and flow retirement. The process-private relay binds IPv4 loopback
  on an ephemeral port, requires a per-launch capability, rejects browser Origins,
    and admits only the fixed Better Auth operations listed in
  `shared/hosted-auth-network.ts` on `api.stashbase.ai`: desktop exchange,
  session/token reads, logout, email-code login, and explicit account linking.
  Its separate usage route forwards analytics batches only to the ingestion URL
  derived from `server/telemetry-destination.json`; it refuses that route when the
  destination is unset and never accepts a caller-supplied host.
  Email attempts carry host-owned flow IDs. Cancel, a new login, or sign-out
  retires older continuations; late issued sessions are revoked before they can
  replace the current account. Browser-link permissions contain no session token
  and require fresh session-bound mailbox proof. It forbids redirects,
  cookies and arbitrary hosts, bounds concurrency/body sizes/time, and aborts on
  disconnect or shutdown. The host consumes and removes the capability from its
  environment before spawning tools. A missing/failed desktop relay never falls
  back to direct fetch. Standalone Node development (including a separately
  started Vite host reused by Electron) has no native transport and retains Node
  fetch. `shared/hosted-auth-network.ts` converts transport causes to safe codes
  and explanations; raw messages containing credentials/URLs are not relayed.
  Only bounded content type and request ID response headers cross the relay;
  cookies and other provider headers do not.
  OAuth failure telemetry retains this structured error rather than just its
  outer message. No automatic retry consumes an uncertain one-time code.
- Better Auth owns Google OAuth and creates a separate desktop session through
  a one-use PKCE transfer. Node persists that opaque `sessionToken` and a short-lived
  API JWT; it renews the session with `get-session` before minting each replacement
  JWT. The loopback callback validates `state` against its pending flow. Expired
  API tokens, shared refreshes and account replacement keep the same flow guards.
  Old Supabase refresh tokens are never sent to Better Auth; upgraded clients
  require a fresh sign-in. Trusted server-side identity import preserves the
  business user UUID and subscription ownership, without email-based auto-linking.
- Avatar proxying is restricted to validated HTTPS provider hosts with bounded
  redirects/time/bytes/type; it is not a general fetch endpoint.
- OpenQuill receives a random session-local model broker credential, not
  account secrets. Model calls require an active submitted turn, retain its
  id/idempotency across the one auth-refresh retry, and cannot expose account
  tokens in history. Turn/channel retirement cancels main agent/Crew body reads
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
  agent's profiles, cached per account with the service's ETag (304 reuses it,
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
  billing stay external; the API owns monthly credit grants and first-subscription
  offer eligibility. Confirmed native trial access and paid invoice coverage share
  the monthly ledger; the existing `paidThrough` field is the confirmed access
  end for either. The API keeps trials recognizable as `active` in the legacy
  `status` field and supplies their actual state in `subscriptionStatus`; the
  renderer prefers the latter and falls back for older servers. Ledger decisions
  remain server-owned. The desktop displays the published monthly amount and terms
  without deciding eligibility; it exposes bounded usage, plans, and
  subscription status. The host requests Checkout and Portal pages with the
  account session and hands the renderer only a verified Stripe-hosted URL;
  desktop account tokens never appear in links or Stripe configuration.
  Downgrade, withdrawal, cancellation, and resumption use authenticated host/API
  commands with strict action schemas. The API persists and serializes change
  intents, owns Stripe schedules, and reconstructs paid-period funding; renderer
  confirmation and pending indicators do not grant rights or select invoice amounts.
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
  bypass source admission. Native coding-agent tools have separate runtime permissions.
- Readiness alone writes the built-in CLIs' MCP config; OpenQuill injects config
  per process. Claude's entry asks the runtime to always load StashBase's tools,
  because Claude otherwise defers MCP definitions behind its tool search once a
  user's other connectors grow, leaving the model a tool name with no description. External clients copy their setup manually. No second client-config
  or credentials store belongs in StashBase.

Settings sections are presentation boundaries: Appearance and Editor share one
appearance query, window-scoped save queue and host record. Accepted preference
writes survive pane disposal, run in order, and rebase pending field patches on
the latest confirmed record after success or failure. Account owns sign-in-method interaction and
billing presentation independently of the runtime catalog; moving a shortcut
does not create another account session or credential store.

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
  Distribution (`source` or `packaged`) is host-owned event metadata, persisted
  at capture and retained by offline replay, pending-turn recovery and native
  diagnostic spooling; it never comes from renderer event input.
  Diagnostic messages, paths, causes, stacks and bounded process output are retained;
  arbitrary request/provider objects, documents, prompts and whole logs are excluded.
  CLI probe timeouts keep separate output tails and termination evidence after
  process-tree cleanup. PDF/OCR failures retain their exit signal independently
  of cancellation; diagnostic enrichment does not change their retry policy.
  The public ingestion token is build configuration, not a user credential.
- Queue envelopes preserve UUID, occurrence time, installation, anonymous/account
  identity and source version through retry/restart. Identity links share durable
  admission with their events. Full queues refuse later work; expiry and permanent
  ingestion refusal remain observable-data limitations. One serial drain sends
  bounded batches, re-reads current preferences/queue after every await and
  removes only acknowledged UUIDs. A refused multi-event batch is retried singly
  before anything is dropped. Desktop delivery uses the proxy-aware native relay
  (`hostedUsageFetch`) and never falls back to direct Node fetch; envelopes stay
  queued for 30 days because weeks between uses are normal.
  Bounded retry never waits in the user's writing operation or shutdown. Diagnostics/progress
  observations and operation results have separate per-minute admission budgets;
  core activity facts that already have their own bound are exempt, so diagnostic
  or stage bursts cannot suppress saves, project entry or core use.
- Renderer intake acknowledges persisted admission separately from duplicates,
  disabled/stale collection and temporary refusal. Short, bounded in-memory
  retries retain event UUID/time; the existing Node queue is the only durable
  delivery owner. Host receipts suppress replay after delivery; account/privacy
  transitions and host replacement retire earlier renderer requests. Renderer
  event envelopes cannot choose identity or claim host observations.
- Delivery health uses bounded cumulative checkpoints with a series UUID and
  start time. The host persists capture/admission, refusal, storage, transport,
  expiry and queue-validation counters; each admitted envelope pins its snapshot
  through retry/restart. Renderer recorder counters are in-memory and pin their
  snapshot at first send. Disabled/discarded and explicit reset receipts retire
  that renderer period; the host excludes checkpoints spanning a retired period.
  Existing event metadata carries checkpoints;
  no heartbeat or additional durable queue is introduced. The local delivery
  endpoint exposes the latest readable host snapshot. Counter deltas are compared
  within a series, never summed across event snapshots or interpreted as activity.
  Capture attempts and delivered identity/recovery envelopes have different
  populations; there is no loss conservation equation. Final-close intervals,
  unreadable storage and absent later reports remain incomplete evidence.
- Foreground input and document/agent engagement establish activity, not timers,
  background work or streamed output. All windows share category suppression and
  sessions. Electron's main-process input observer supplies content-free input
  presence across opaque HTML frames; visible/focused window checks and the active
  reading surface gate app/read engagement. Authored DOM events and postMessage
  cannot manufacture this bridge signal; keys, text and coordinates do not cross it.
  Shared project read/write/edit results belong to `project-operations`, with
  identity captured before await and origin supplied by the accepted transport or
  a live attributed Agent session. Source transactions supply changed/unchanged;
  internal edit reads do not add another operation. Native filesystem/shell work
  that bypasses this owner remains outside the file counts. Neither file operations
  nor tool workload establish foreground activity.
  Save/project/billing work captures initiating identity before await;
  turn correlation persists identity/session, original version and observation times.
  Each admitted pending turn reserves a terminal queue slot; terminal insertion
  and pending removal are one atomic config write and bypass ordinary event rate
  limiting. Renderer preparation and host execution facts converge by turn ID.
  An adapter's actual `host_accepted` observation can establish a missing start
  using its registered runtime, host time and `source: host`. A late renderer
  start cannot rewrite or recount it; arbitrary stages/results cannot create starts.
  Restart recovery reports an interrupted unknown result, never inferred success
  or a fabricated end time/duration. Unknown terminal IDs cannot manufacture starts;
  opt-out clears pending turns and bounded recent-completion IDs.
  Host acceptance also initializes a zero tool summary. The pending-turn owner
  persists distinct tool-result counts and call-ID deduplication, and owns the
  summary copied to the terminal, including recovery. It counts success/failure
  by fixed category for at most 1,000 unique results; later or invalid-ID results
  mark the summary limited. Successful tools add no individual queue event.
  Renderer terminals cannot supply or replace this summary. Tool success is not
  a file-change fact or proof of the user's goal, and turn IDs do not correlate
  the same task across later turns.
- Settings General discloses account linking and controls both usage and errors.
  Opt-out stops this process even if saving fails, cancels transport, and on a
  successful save removes the queue and all local analytics state. There is no
  final network notification. Re-enable creates new local IDs without backfill;
  a still-signed-in account may link again. Already received provider events are
  not deleted by this switch.
- `STASHBASE_TELEMETRY_DISABLED=1` suppresses collection and queue delivery before
  startup without changing saved preferences/identity. Electron passes it to Node;
  Settings cannot override it. Source and packaged launches follow the same
  default-on preference and opt-out. The host, Electron
  and MCP native entry points share `server/telemetry-environment.ts`: Node test
  workers, `NODE_ENV=test`, Vitest and Jest markers suppress admission even with
  an inherited packaged flag. The isolated host-test fixture also sets the override
  for descendants. Manual source/development and packaged checks must still set it; collection tests
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
  reports request/response boundaries and failures directly. Stage transitions
  and tool-result summaries persist, never each streamed token; last stage is
  evidence, not inferred cause.
  Tool failures contain bounded call IDs/categories and a fixed failure kind,
  never inputs or results. The host recognizes only bounded error prefixes for
  missing files, permissions, invalid arguments and timeouts; unmatched output
  stays unknown. Classification does not establish the underlying cause or
  settle a turn. Setup stages share attempt
  and retry IDs. Background diagnostics retain the operation sentence. HTTP, agent,
  background and renderer failures converge here without throwing into operations,
  recursively reporting analytics failures, or creating another privacy setting.
  A runtime error immediately followed by an exit with the same explanation
  contributes one diagnostic, retaining the original cause; both protocol events
  still reach the renderer. Closed sessions cannot publish late discovery failures.
  Allowance-query diagnostics retain the original network cause or upstream
  status/request ID separately from the local HTTP result. Unexpected daemon
  and agent startup exits retain bounded, credential-filtered stderr and the
  available exit code/signal, without serializing process configuration.
  Managed agent retirement reports one typed result per attempt, linked to its
  process-start identity, purpose and first initiating reason. Timeout retains
  exit/pipe state and Windows taskkill/fallback evidence; a later confirmed close
  is a separate recovery result, never a rewritten success. The original timeout
  Error is already reported by this owner and outer collectors do not recount it.
  Windows pipe closure does not prove escaped descendants are gone.
  OpenCode reports each physical startup attempt, including success/cancellation,
  with purpose (history/chat/prewarm), pinned version, attempt/retry identity,
  stage, elapsed time and first output time. Ready means the expected loopback
  address was announced on stdout, not that a model request succeeded. WARN
  native logs also go to stderr; startup failure keeps bounded separate output
  tails. Codex carries its original exit Error through the session boundary;
  socket diagnostics retain process start/generation, close initiator/reason and
  at most twenty pending RPC method names, never RPC parameters. Connection
  closure is an observation separate from turn outcome, including idle/intentional
  closure. These observations cannot retroactively fail a completed turn.
  Every runtime marks deliberate disposal before closing its socket. Cleanup
  after an observed socket error must not relabel transport loss as cancellation.
  A clean 1000 close with the shared `session_disposed` reason also tells the
  renderer that retirement was deliberate. A bare 1000 or unclean 1006 remains
  unexpected; a prior terminal failure keeps its original explanation.
  A versioned save's `FILE_CHANGED` outcome is a conflict, matching its HTTP 409,
  even when the underlying source error has no HTTP status property.
  Agent sockets retain the authorized window UUID and host instance UUID. Main
  records renderer load/exit and actual window closure with that window UUID,
  an ephemeral app-session UUID, available renderer PID and webContents ID;
  host exits carry the same host instance UUID even for unexpected code-zero
  exits. Socket errors retain bounded code/errno, never frames. Normal lifecycle
  observations use `native_lifecycle`, not failure counters. They share consent,
  identity, delivery and the native spool, with admission capped at 25 pending
  observations so errors can use the remaining slots in its 50-record limit.
  Main identifies Chromium's network service by its fixed service identifier;
  its exits retain the app/host identity and exit reason separately from generic
  utilities. Clean network-service exits are lifecycle observations too, since
  they may close sockets while renderer and host survive. Arbitrary utility
  names are not collected; socket code alone never establishes that cause.
  Renderer JSON-body failures retain the original cause, status (including 2xx),
  content type and host-issued response request ID. Requested cancellation stays
  cancellation; empty HEAD/204/205 responses are not decode failures. The agent
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
  return definitions, IP-retention setup and delivery limits. An absent event
  proves neither abandonment nor continued use after opt-out; subscription rights
  observed by a desktop are not a hosted payment ledger.

## Renderer Boundaries

`app` binds adapters and coordinates features through public interfaces.
Features do not import siblings: domain is pure; application owns Ports/runtimes;
infrastructure maps wire/errors; hooks/UI adapt and present. Shared code is a
leaf, platform owns host mechanisms, and the installed kit reaches no product
policy. `test-support.ts` is test-only. Repository contracts/wire schemas cross
registered host boundaries; renderer shared types are a different layer.

- Desktop notification transport belongs to
  `renderer/src/platform/electron/notifications.ts`, alongside the existing host
  adapters. App composition injects its shared ports into notification producers
  and Settings; features and UI never select operating systems or access the
  Electron bridge. Native OS operations stay behind this adapter in Electron main
  (`electron/notifications/native.ts`), where Windows application identity and
  notification availability are handled. New notification kinds reuse this
  platform boundary rather than adding platform branches to product code.
- Capture scope and generation before await; reject stale completion even for
  same-folder subtree mutation. Separate request lanes cannot cancel unrelated work.
  Stores, query caches, timers, subscriptions, workers, and URLs have explicit
  owners and disposal. One window has one query client, not durable authority.
  Local JSON API requests bypass Chromium's HTTP cache. If a GET still exposes
  a bare 304, the HTTP adapter retries that read once with cache reload, preserving
  cancellation. Writes and other failures are never replayed by this recovery.
  The PDF page owner caps each raster backing store at four megapixels and
  4096 pixels per edge, independently of CSS zoom and text-layer coordinates.
  The visible canvas is reset when its page leaves view or unmounts, even after
  React detaches it, but not on a zoom, which keeps its pixels until the new
  rendering replaces them;
  scratch storage is reset after rendering or cancellation settles.
- Main's one-shot folder claim and server binding decide entry, not saved layout.
  The startup window, and each window a launch reopens a project in, claims
  restoration. Native session persistence serializes
  changed records against each window's baseline, preserving peer changes;
  failed writes retain the last valid file and do not advance the baseline.
- Tabs stay unique across asynchronous opens. First edit keeps a preview; only
  kept tabs persist. History advances after open succeeds. Hidden panes are inert;
  mode/visibility changes preserve drafts, transcripts, focus, and session identity.
  App composition chooses the root `index.html` preview once the first folder
  listing arrives, only if restoration and user navigation have left no document.
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
  Documents owns its external-source refresh in `use-document-refresh.ts`:
  only the active, visible document polls, with an immediate check on activation,
  window focus, and return from hidden. App composition also deactivates viewers
  while Chat mode or New tab covers the retained workspace. Text, generic previews,
  and versioned assets share this trigger; derived DOCX conversion remains version-keyed.
  Checks share a pending read rather than restarting it. Publishing an accepted
  source write cancels older reads before updating the cache, so a late response
  cannot roll a newly clean editor back to its previous disk text.
  `server/document-asset-version.ts` owns HTML preview invalidation: its bounded
  HTML read collects up to 256 directly declared local scripts/stylesheets,
  resolves their URLs (including `base`) within the same project, and includes
  their stat identities or absence in the preview version. It does not change
  source-write versions or fetch remote dependencies. Asset transfers revalidate
  with the high-resolution filesystem identity so an HTML reload cannot reuse a
  same-size script through a coarse mtime validator; Range support remains intact.
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
- Markdown's `math.ts` owns the Math-mode parser and code-block preview. The
  workspace session owns its per-project Boolean: single-dollar prices remain
  prose when it is off, while paired `$...$` is inline math when it is on.
  Math serialization retains double-dollar blocks and explicit `math` / `latex`
  fences. The transcript's `markdown.tsx`
  rewrites `\[ \]` and `\( \)` outside code to double-dollar math before parsing.
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
- Tables (`features/documents/ui/table/`) draw a fixed-row-height window of rows
  and columns with sticky headers; column widths start from a sample and only
  widen. Past 15 million pixels of rows, below Chromium's layout ceiling, the
  scroll range maps to rows in proportion (`verticalScale`). CSV rows arrive through version-keyed page queries
  (`use-delimited-table.ts`): the first page carries the shape and follows the
  file, and a page from a newer version refetches the shape instead of mixing
  files. Copy and Ask agent read the selection's rows asynchronously, refuse
  before reading when the selection cannot fit, and check Ask agent's text against
  `shared/domain/passage.ts`, the limit the agent feature validates at send.
- Chat passage membership comes from the active session's draft, queue, unread
  follow-ups, and user-message context; app composition passes source-scoped snapshots into
  Documents. Membership is selected by item identity, so a streamed reply
  re-renders neither app composition nor the transcript's memoized messages. Markdown owns transient passage anchors and decorations, mapping
  positions through editor transactions, mapping a whole-document reload by the
  span that changed, and invalidating changed text. These
  decorations never serialize into user files. Reference clicks use the active
  viewer's navigation claim with an explicit Markdown quote format; ordinary
  text citations and Find keep their own search path. Removing references and
  switching chats update marks without recreating the editor or its undo state.
- Surface recovery remounts the smallest boundary. Shell remount loses live buffers
  and reloads only saved source files. HTTP loss must not reload the app.
  Raw failures are mapped to feature-owned messages and recovery kinds.

### Document and Window Trust

Sandboxed, context-isolated windows have no Node integration and load the bundled
application origin (explicit Vite development is separate). Main authorizes live
main-frame origin and capability for each parsed IPC call and stamps HTTP/socket
identity itself. Canonical API/agent paths only; asset requests carry no window
authority and retain server path checks. CSP/root containment, navigation/popup/
webview denial, and narrow preload methods cannot be weakened by document content.
Only sanitized clipboard write is granted to the application origin; paste needs
no background clipboard-read permission.
The production image CSP admits project previews only through the configured
server's `/asset/` route and temporary attachment previews through
`/api/agent/attachment-preview`, alongside bundled/data/blob images and the
Gallery proxy. Asset reads retain the server's project membership and path checks.

External files (`server/external-files.ts`, `server/routes/external-files.ts`)
are read only through an exact-file grant. `DocumentDropZone` wraps the whole
content row; it leaves drops on the composer (`data-file-drop="attach"`) to the
composer and lets preview frames pass drag events through while a file is dragged. Preload's `externalFiles` methods take a
dropped `File` and read its location with `webUtils.getPathForFile`, so the
renderer never names a path. Main registers that path for the sender's window
through the process-private `/api/internal/external-files` route. A development
server that Electron did not start writes its token to an owner-only file under
`~/.stashbase`, which a source launch reads after its own token is refused. The server
resolves the real path and refuses files under `~/.stashbase` and the app-data
root. It answers with the project file when the file lies inside the window's
project or another registered project (the latter opening read-only), matching
each root by real path, or by directory identity for a spelling realpath keeps,
such as a macOS `/System/Volumes/Data` firmlink. Otherwise it issues an opaque
token only for the formats `shared/file-formats.ts` admits. The server deletes
the registration token from its environment once read, so no process it spawns
inherits it, and agent CLIs are launched without it. Its initial environment
stays readable to same-user tools such as `ps eww`, so the token keeps out other
local clients, not a process that already shares the user's file access. Token routes serve that one file, re-check its
real path on every read, save Markdown, text, JSON, and CSV against the version read
(preserving BOM, line endings, and permissions, never indexing), are bound to the
window for `/api/` reads and saves, and serve
browser-loaded PDF and image bytes under `/asset/__external/`, inside the
existing CSP. Revocation follows the tab, project switch, and window close. A
grant never reaches preparation, indexing, upload, MCP, or agent-context
resolution; the renderer marks the source with an `external:` folder marker that
every project route refuses.

Markdown renders schema nodes; DOCX is sanitized inside its worker with the shared
policy. Local HTML's scripts run in an opaque sandbox without same-origin/preload,
form, popup, modal dialog, or navigation authority. `server/html.ts` serves authored
markup unchanged, so scripts, styles, and in-page links keep their own ids; the
injected frame chrome adds no lines ahead of authored code, keeping error line
numbers those of the file. Frame messages validate source, shape, and
user activation for external links (server-produced DOCX has its narrow exception).
The host accepts the opaque `null` origin only for GET/HEAD of `/asset/`,
`/asset-derived/`, and `/pdfjs-assets/`, so fonts/modules can load with CORS.
Resource membership/path checks still apply; this grants no API or write access.
`server/html-data.ts` injects a separate data client into source HTML before
its authored scripts. The frame's source-checked messages carry only an operation
and JSON content, plus an optional page-relative data path, never window
credentials or the application preload.
`ui/html/use-data-bridge.ts` requires user activation for update/save and bounds
pending requests. `domain/html-data.ts` admits an explicit JSON path below the
HTML's own `assets/`, rejecting traversal and URL paths; omission uses a same-stem
JSON sibling. `application/html-data-session.ts` binds one source per live HTML
owner in its project. Rebind retires that session before accepting new requests.
Its background JSON document has no tab until explicitly opened or revealed for
recovery, and uses ordinary source transactions, autosave, and release barriers. A form
update compares the shared draft it last read, so a second editor cannot be
silently overwritten. `absent` is the explicit expected-version token for a
first create; host writes still recheck absence before publication. HTML asset
changes remount the frame like any other preview; the new page's load returns the
shared draft, which reconciliation never replaces while dirty or saving.
The data session observes clean, valid JSON revisions from the shared editor and
checks disk on the active preview's focus/two-second refresh cycle. These changes
remount the form to rerun its existing load call; its own updates/saves do not.
Refresh reads compare the captured editor and scope before reconciliation, so
late results cannot roll back edits or saves. Dirty drafts and invalid JSON keep
the current frame; source conflicts remain owned by the JSON document runtime.
Accepted form reads also replace the source query cache, preventing a reopened
JSON editor from replaying older cached bytes over refreshed data.
`server/interactive-note.ts` owns blank interactive-note creation for Files and
Agent/MCP. The Agent adapter resolves an existing absolute parent through Project
Operations and retains session/project membership checks. `create_interactive_note`
is an ordinary scoped creation grant, never a read-only tool. An exclusive directory claim chooses a free name, writes initial data
under `assets/`, then publishes `index.html`. It never merges an existing directory;
failure cleanup removes only unchanged owned output and empty owned directories.
The HTTP adapter uses the ordinary window/project-scoped mutation receipts.
New tab routes creation through Workspace, which opens the entry and names its
containing directory without expanding `assets/`.
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
Each health probe uses a fresh connection and a bounded whole-response deadline.
Port arbitration uses a short 300 ms probe; once a child is owned, a health
response may take up to one second, capped by the remaining startup budget.
Slow valid responses must not be repeatedly discarded by the arbitration timeout.
The packaged ten-second and source thirty-second startup budgets remain unchanged.
Startup failures retain the last probe result/duration/status or mismatched
identity field, probe count and total elapsed time. Refusal, connect/response
timeout, transport failure, HTTP failure and invalid JSON remain distinguishable;
health bodies and actual identity paths are not added to probe metadata.
Single-instance and startup arbitration prevent duplicate initial windows.
Packaged launches own their server; bounded POSIX orphan reclaim verifies sibling
identity and a dead parent before killing. Foreign/live-parented listeners remain untouched.
During a packaged relaunch, a compatible server owned by the previous instance
gets a bounded shutdown window before the replacement starts its own server.
If it stays live, startup reports the occupied port instead of racing a second bind.
The Linux deb updater defers relaunch scheduling until the owned server has
exited during main's quit sequence.

The packaged local service and stdio MCP launcher depend on Electron's embedded
Node runtime (`ELECTRON_RUN_AS_NODE=1`). Keep that capability until both launch
owners are deliberately replaced and verified. The
[release fuse policy](release-pipeline.md#native-packaging) owns binary settings,
certificate compatibility, and the limits of main-process debug hardening.

- Main records which projects its windows show (`electron/window-restore.cjs`,
  a record in Electron user data) on every folder, focus, and close change,
  the focused project last. Quit and update installation close every window
  without rewriting it, so it keeps what those windows showed; with no window
  left, the last project closed stands in. Launch reads it before writing,
  then enters each project through the same one-shot claim as a reader's
  request. A refused entry leaves its window for the next project, and a
  leftover window closes unless it is the only one, which stays on Welcome.
- Close asks the owning loaded renderer and stays open on failure/timeout.
  After successful saves, including update-approved closes, main attempts host
  window retirement before destroying the renderer and its sockets. That request
  has a one-second deadline; an unavailable host cannot pin a saved window, and
  the closed handler retains its bounded cleanup retry.
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
  requests and retires the timer. Ready downloads can be rechecked; the manager
  retains the ready version through a failed metadata check, reuses it for a
  matching release, and invalidates it when another release is selected.
  The entire native download promise stays exclusive even after its downloaded
  event, and installation cannot race a metadata check or replacement download.
  The ready snapshot carries only a failed-recheck flag, never native error prose.
  Restart refreshes an unflagged offer and awaits any replacement download before
  the save/install barrier. A failed refresh returns the flagged ready offer
  without installing; a subsequent explicit restart can accept that disclosed
  version without another network request.
  The macOS install adapter owns its native completion listener: failure retires
  that attempt, and only a payload URL from the current loopback feed can finish
  its explicit restart. Each restart prepares the current feed instead of trusting
  the dependency's versionless Squirrel-ready flag.
  `electron/updates/network-timeout.cjs` installs a 60-second response-idle
  deadline on the native updater's HTTP executor. Electron does not emit the
  Node socket event used by the dependency's inherited timeout. Response headers
  and data reset the deadline; response completion, error or explicit abort
  retires it. Request `close` alone cannot retire it because Electron's writable
  request can close before its response arrives. The executor retains ownership
  of redirects, proxy authentication, cancellation, download pipes and checksums.
  A timeout aborts only its request and reaches the manager's existing error and
  retry path; the deadline does not bound total download or installation time.
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
ongoing agent instructions. Personas ride the
same index as an optional array; an index without it keeps the bundled persona
snapshot. The overlay frame is shared, but its entrance fixes one shop: the
sidebar's Gallery shows projects and the picker's Browse personas shows
personas, with no switch between them. Adding one copies it into the reader's library through the agent's
library port and chooses it for no Chat.

## Validation

J01 is the default local acceptance: project entry, Agent preparation/sign-in,
a completed reply, applicable native update, and reuse after reopening.
`pnpm check` owns the core selection; `pnpm check:all` and CI own the complete
source audit. Extend an existing flow before adding a regression file. Keep
focused coverage for source loss, scope, permissions, cancellation and duplicate
delivery when the normal flow cannot establish those rules.

`scripts/testing/environment.ts` owns private validation state and clears
inherited native CLI overrides. With `STASHBASE_ISOLATED_AGENTS=1`,
`server/agent-cli.ts` discovers only private-home installations and explicit
fixture executables, without host PATH/global or login-shell fallback.
Host tests and profiling use this boundary. Explicit real-provider verification
uses `scripts/verify-onboarding.mjs` with a persistent profile; controlled tests
do not establish OAuth or upstream model availability.

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
