# Usage statistics

Packaged desktop builds and source runs (including `pnpm dev` and `pnpm start`)
send product activity and detailed error diagnostics to
PostHog by default. **Settings → General → Privacy → Share usage statistics**
controls both. All features remain available when collection is off. Automated
tests, explicitly suppressed runs and builds without a destination do not send. Website activity is outside
this desktop collection.

## Identity and sign-in

The desktop creates a random installation ID and a separate anonymous ID. Neither
comes from hardware. Both survive launches. When you sign in, the host links the
current anonymous history to your stable StashBase account ID. Signing in to that
account on another installation links its activity to the same person, while the
installation property keeps their origins distinguishable. Identity linking uses the account ID, not profile email, name or avatar.
Diagnostic prose can include names or paths mentioned by a failing operation;
known credential patterns are filtered.

Signing out or changing accounts creates a new anonymous identity. An installation
is a property, never an alias used to merge all accounts on that computer.
Anonymous activity is attributed to the next verified sign-in in that anonymous
period; this is an attribution convention, not proof that a shared computer had
only one human operator. Unidentified installations cannot be reliably combined
into a person. Reinstalling or clearing application settings can create a new
installation identity.

## Events and interpretation

Schema version 8 carries an event UUID, occurrence time, app version, distribution, OS,
installation ID, anonymous ID, installation first-observed time, and, when signed
in, the account ID. Active work also establishes a session ID shared across
windows; 30 minutes without reported activity starts another session. The first
observed time means entry into this measurement, not a proven download/install
date. Older builds do not supply the same activity or identity evidence.

`app_distribution` is `source` for source runs and `packaged` for packaged builds.
It describes the process where the event originated, not the person: source use
can be real writing or development. Filter or break down reports by this property
to compare the two. Offline replay, recovered turns and native diagnostics retain
their original distribution. Events predating this property remain unclassified
in provider history; absence is not evidence of source use.

| Event | Meaning | Additional fields |
|---|---|---|
| `app_opened` | Workspace mounts, once per host lifetime | None |
| `app_active` | Trusted pointer, keyboard or wheel input in a visible, focused app window | `mode`: welcome / documents / chat |
| `document_engaged` | Interaction inside the active document surface, or an actual editor change | `activity`: read / edit; allowlisted `format` |
| `project_entry_result` | Host project-open operation settles | `outcome` |
| `agent_turn_started` | Submission preparation, or first host acceptance when the submission report is missing | `runtime`, random `turn_id`, `source`: renderer / host |
| `agent_turn_stage` | Host observes a significant execution boundary | `runtime`, `turn_id`, `stage`, per-turn `sequence`, bounded correlation context |
| `agent_turn_finished` | Submission completes, fails, is blocked, cancelled or interrupted | `runtime`, `turn_id`, `outcome`, `source`, optional `reason`, last stage, sequence and observation times; duration only for an observed end; host-observed `tool_summary` when available |
| `agent_runtime_start_result` | One Default/OpenCode startup attempt settles, including history and prewarm | `purpose`, `outcome`, `stage`, `attempt_id`, optional `retry_of`, `elapsed_ms`/`first_output_ms`, phase `timings`, runtime version and optional diagnostic |
| `agent_runtime_stop_result` | Managed OpenCode/Codex/Antigravity retirement succeeds, times out, or closes after timeout | `purpose`, initiating `reason`, stop `attempt_id`, original process-start ID, elapsed/deadline, exit/pipe observations and bounded termination evidence |
| `agent_connection_closed` | Host observes socket closure, including idle and intentional closes | `runtime`, shared `context.connection_id`, close code/initiator/reason and available process evidence |
| `http_request_lifecycle` | Host observes a slow local JSON request or a response closing before completion | `request_id`, `state`: pending / finished / closed, `elapsed_ms`, `headers_sent`, optional `http_status`, method, route template and available host instance ID |
| `document_write_result` | Versioned editor save settles | `outcome`; success includes `changed` |
| `project_file_operation` | Shared project file read, write or edit settles | `operation`, `origin`: agent / mcp / http, `outcome`, optional runtime and turn/request correlation; successful writes/edits include `changed` |
| `account_login_started` | A browser sign-in flow starts | None |
| `account_login_result` | Sign-in completes or fails | `outcome` |
| `account_signed_out` | Local account is signed out | None |
| `$identify` | Verified account links its preceding anonymous identity | `$anon_distinct_id` |
| `billing_checkout_result` | Host obtains a verified Checkout page or fails | `outcome` |
| `billing_portal_result` | Host obtains a verified management page or fails | `outcome` |
| `subscription_observed` | Hosted API confirms subscription rights; unchanged polling is suppressed | bounded `plan`, `paid`, `cancel_at_period_end` |
| `agent_setup_result` | Agent setup settles or connection fails | `runtime`, `stage`, `outcome`, optional failure stage and diagnostic |
| `agent_setup_stage` | Discovery, installation, authentication or MCP stage starts or succeeds | `runtime`, `attempt_id`, `stage`, `outcome` |
| `application_error` | Host, renderer, agent or native failure | `source`, `operation`, optional `runtime`, detailed `diagnostic`, `occurrences` |
| `application_warning` | Operation degraded but continued, such as a saved file that could not be indexed, a refused (4xx) request, or an agent that is not ready | Same as `application_error` |

`app_active` and each document activity/format category are limited to once per UTC
minute across windows. They are not heartbeats. Idle background processes,
restored tabs, automatic source refresh, and streamed agent output alone do not
create active days. Read engagement is a surface-interaction proxy: it cannot
prove comprehension, and silent reading without interaction is not counted.
Editing events contain no text or keystrokes. Unchanged saves report
`changed: false`; changed saves and completed turns are measurable results, not
proof of writing quality or user satisfaction. Agent file writes are not inferred
from generated replies. Project entry excludes picker cancellations and acquisitions
that never reach the open operation.

In Electron, genuine keyboard, pointer and wheel input inside focused embedded HTML also
contributes to foreground activity and the active document's read engagement.
The main-process input bridge forwards only the input kind; it does not forward
keys, text, coordinates or document messages. Scripted DOM events, automatic
page changes and background frames do not establish engagement. Browser-only
development lacks this Electron bridge.

`project_file_operation` measures the shared project operation boundary. A live
attributed Agent session supplies `origin: agent` and its runtime; otherwise the
accepted transport supplies `mcp` or `http`. Successful writes/edits use the
actual source transaction's `changed` result. An edit's internal read is not
counted again. Paths, content and content hashes are absent. Native runtime
filesystem operations and shell commands that bypass this boundary remain
outside these file-operation counts. These operations describe workload and
observed source changes; they do not establish human foreground activity.

Runtime values are stashbase, claude, codex and antigravity. Outcomes are success, failed,
cancelled or blocked; saves use conflict. Agent turns additionally use interrupted when execution continuity was lost without a confirmed result. Durations are under 10 seconds,
10–60 seconds, 1–5 minutes, or over 5 minutes. Diagnostic context can include
model/runtime version, native session/connection ID, WebSocket close code/clean flag, tool call ID/category, model call ID/attempt, method and route, target
update version, setup stage, exact elapsed milliseconds and request/turn IDs.
Setup attempts have unique IDs and retries point to the preceding failed attempt.
An installation success followed by authentication failure means the executable
was installed and verified but is not signed in.

Diagnostics preserve original messages, error names and codes, HTTP/exit status,
provider request IDs, causes, stack traces, React component stacks and bounded
process stdout/stderr and error response bodies. They preserve paths and explanations instead of replacing
them with generic summaries. Messages/output are bounded to 8,000 characters,
stacks to 16,000, and causes to four; truncation preserves the beginning and end
and is marked. Each serialized diagnostic also has a 128 KB byte ceiling. Arbitrary provider objects are never serialized. Bearer/basic
credentials, credential assignments, common API keys, private keys, URL passwords
and cookies are filtered at capture and again before sending. This is targeted
filtering, not a promise to remove every personal detail from diagnostic prose.

HTTP response diagnostics include the status even when a 2xx response cannot
be decoded, its content type, the shared request ID, and the original
parsing/read cause. Requested cancellation is excluded. Default Agent failures
can include the native message ID, finish reason and token counts, plus the
current gateway request ID, retry attempt, byte/frame counts, stream-end and
DONE markers, finish reasons and explicit provider/transport errors. Stream
observation retains protocol metadata only, not replies, tool arguments or
prompts. Missing provider explanations remain missing; request IDs support
follow-up investigation rather than implying a known root cause.

The renderer and native scheduled-task HTTP client generate a random UUID before
each request in `x-stashbase-request-id`. The host accepts a valid UUID or replaces
it, returns it as `x-request-id`, and uses it in its diagnostics. A timeout before
response headers can therefore retain the same ID as a host observation. Native
scheduled-task failures retain it in `diagnostic.request_id`; renderer failures
also expose it as the event's `request_id`. This identity grants no access and is
not a replay or deduplication key. Requests are not retried by these diagnostics.

`http_request_lifecycle` is an observation, not an application failure or an
activity event. `pending` means a correlated JSON request has remained open for
ten seconds; it does not establish a hang or impose a new request deadline.
`finished` follows that observation when the host ends its response; it does not
prove that the client received or decoded it. `closed` means the response closed
before it finished, including deliberate cancellation, and does not identify
which process or network component caused it. Each tracked request produces at
most one pending and one terminal observation; ordinary fast completions produce
none. The host tracks at most 100 concurrent requests, excludes assets, diagnostic
delivery and event streams, and uses the existing shared observation admission
budget. Account or consent changes retire these optional observations. Fast
requests create no telemetry storage work. Admission or delivery loss means a
missing record cannot establish that a request never reached the host.
Metadata contains only method, a registered route template or allowlisted service
name, timings, status and ephemeral correlation IDs; it contains no query,
request/response body or user-supplied path components.

Allowance-query failures keep the local response status separate from the
upstream status/request ID or original network cause. Daemon and agent startup
exit diagnostics retain a bounded stderr tail and available exit code/signal.
OpenCode startup stages are `prepare`, `spawn`, `waiting_ready`, `ready`, and
`cleanup` (retirement failed). Elapsed time covers preparation through settlement,
including failed-process retirement; first-output time is absent if no output was
observed. Optional `timings` separates monotonic, rounded-millisecond
`prepare_ms` (including private configuration/directories), `spawn_ms`,
`ready_wait_ms` and `cleanup_ms`. Only entered phases are reported; old builds
omit these measurements. The ready timeout begins after process creation, so
total startup latency alone cannot identify a slow child. MFS timeout messages
likewise retain preparation, spawn and readiness duration, plus `timer_lag_ms`
for watchdog delivery after its deadline. Callback lateness identifies a delayed
observation, not its OS-level cause.
Successful starts are retained as the latency denominator. A listening
announcement confirms the expected local address, not usable models or completed
work. Each physical retry has a new attempt ID and points to its failed attempt;
concurrent callers sharing a startup do not each emit a result. The history-list
entry retries a timeout/early exit once after retirement, without replaying tasks.
Use request ID to join its startup attempts to a terminal HTTP failure. Do not
count a recovered startup attempt as a failed user turn.

Host readiness failures carry `probe_result`, `probe_count`, `probe_duration_ms`,
`elapsed_ms`, and, when available, `probe_http_status`, `probe_mismatch` and
`process_start_id`. Results distinguish connection refusal, connect timeout,
response timeout, transport error, HTTP error, invalid JSON, identity mismatch
and explicit not-ready health. A listening log alone does not establish readiness.

Codex process errors retain stderr and exit code/signal in the original cause.
`process_start_id` and `process_generation` distinguish replacements inside one
connection; `pending_rpc_methods` contains at most twenty method names and no
arguments. Host connection-close observations carry the same connection ID as
renderer errors. Known client/server closures have an explicit reason; unknown
socket loss remains unknown. Closure after a successful turn is not a failed turn.

An agent error immediately followed by an exit with the same explanation is
one diagnostic with the original cause; both notifications still reach the UI.

Tool failures report only fixed failure categories. Explicit codes and message
prefixes, including bounded structured native error envelopes, are classified
locally; tool output and document content are never included in those reports.
Unrecognized failures stay `unknown`, and a tool failure alone is not a failed turn.

An identical diagnostic is reported when first seen. Repeats within its window
(one minute for errors, ten minutes for warnings) are counted locally and sent as
one event when the window closes. `occurrences` is the number of times it happened
since the previous report of that diagnostic, including this one, so summing it
over time gives the real frequency. A failure that persists produces one event
per window; an isolated one produces a single event with `occurrences = 1`.
Counts not yet sent at shutdown join the delivery queue. Older builds omit
`occurrences` and reported warnings as `application_error`.

Native update checks classify recognized offline, network-change, suspended-network
and DNS failures as warnings, including known GitHub latest-release error wrappers.
Release XML contents do not determine severity. Their identical diagnostics use a one-hour window,
since periodic checks are fifteen minutes apart. The first warning is immediate;
later reports carry the repeat count. Identity, source version and diagnostic
remain separate aggregation keys. Download/install failures and unexpected check
failures retain error severity. Queued native reports preserve occurrence order,
and shutdown queues pending repeat counts; opt-out erases them.

Save, project-open and billing operations retain their initiating identity across
an asynchronous account switch. Admitted turns persist their initiating identity,
session, app version, start time and last observed stage. Renderer preparation
outcomes and host runtime outcomes converge on one terminal record. Its UUID is
the turn ID; duplicate terminal signals do not create another result. A bounded
recent-completion record also rejects delayed duplicate starts. Unknown terminal
IDs never manufacture a start.

`agent_turn_started` normally means submission preparation (`source: renderer`).
If that report is missing when the runtime accepts the task, the host establishes
the turn with `source: host` and its actual acceptance time. This is not a recovered
submission time; duration then starts at host acceptance. Earlier events without
`source` describe renderer submission. Late submission reports do not create a
second start or rewrite the recorded origin. Arbitrary stage/terminal observations
cannot establish a missing turn.
Stages are `preparing` (the initial record), `host_accepted`, `runtime_dispatched`,
`model_request_started`, `response_started`, `waiting_permission`, and
`tool_running`. Stages can repeat across model/tool calls; sequence numbers order
observations. Response start can mean received model headers or native output,
not a complete or useful answer. Claude/Codex/Antigravity expose native dispatch/output/tool
boundaries; only Default's owned broker exposes individual model requests.
Stage events remain rate/capacity limited, but the pending turn's last stage is
saved even when a stage event cannot be queued. Streamed tokens do not write
telemetry state. The last stage establishes observation, not causation.

From schema 8, host acceptance initializes a zero `tool_summary`. Each distinct
native tool result updates persisted `success`/`failed` counts and `by_category`
counts for read, write, shell, search, agent or other. The terminal carries that
summary, including on crash recovery; successful tools do not each create a queue
event. Call IDs are retained locally for per-turn deduplication, while tool error
diagnostics retain their existing call-ID correlation. The first 1,000 distinct
results are counted; later or invalid-ID observations set `limited: true`, making
the counts a lower bound. Missing summaries are unobserved coverage, not zero
work. Results reflect what the runtime reports, and successful tools do not prove
file changes or that the user achieved their goal. Renderer terminal reports
cannot supply or replace this host summary.

At the next healthy host launch, a retained unfinished turn becomes
`interrupted` with `reason: host_restarted` and `source: recovery`. Its actual
result and end time remain unknown: `recovered_at` is the observation time,
`last_observed_at` retains the previous host's evidence, and no `finished_at` or
duration is invented. Observed graceful exits distinguish app shutdown, update,
and other host shutdown. Original identity and app version survive recovery.
Turning collection off erases pending and recent turn records too.

Connection IDs are shared across the socket's endpoints from connection creation;
turn IDs bind accepted prompts and request-scoped context reads. Unrelated HTTP
requests never inherit a foreground chat's ID. A WebSocket 1006 is a lost close
handshake, not a diagnosis of network or process failure. Model failures are
reported at the broker even when the native adapter cannot relay them. Tool
failure facts exclude arguments/results and can coexist with a successful turn.
For turn outcome rates, use `agent_turn_finished.outcome`; join tool failures by
`turn_id` to inspect the same turn's subsequent result. Count tool failures
separately by category. A failed meaning-search tool followed by a successful
terminal records tool degradation during a normally ended turn. A turn ID does
not identify a task across retries in later turns, and a successful terminal does
not prove that an earlier difficulty was resolved. Missing terminal evidence is
unknown, not inferred success.
For 1006 investigations, join host connection records to native lifecycle records
by `context.window_id` and `context.host_instance_id`. These are ephemeral UUIDs,
not project paths. Main records renderer load/exit, actual window closure and host
exit, with available PID, webContents ID and app-session UUID. Expected closure
uses `native_lifecycle`; a renderer crash or unexpected host exit remains an
`application_error`. Socket errors retain code/errno if emitted. Their absence
is not proof of a clean exit. OS process IDs alone are not stable join keys.
Extractor launch failures preserve numeric errno, syscall and bounded launch
attempt count, without adding command arguments or environment variables.
Error context may include native session IDs and diagnostic paths; turn events
contain no conversation content.

Checkout success means a page was obtained, not that payment succeeded.
`subscription_observed` means confirmed rights, not a new charge: the same account
can be observed on multiple devices or after signing back in. Revenue, invoices,
refunds and a complete purchase ledger require the hosted billing service and are
not measured by desktop events.

## Delivery and turning collection off

The host atomically saves bounded, validated event envelopes in the owner-only
application configuration before sending. The queue holds at most 500 events for
30 days, so events left unsent when the app closes are delivered at the next
launch even after a gap of several weeks. Desktop delivery follows the operating
system's proxy settings, including automatic proxy configuration, through the same
private network relay as account sign-in; it never falls back to a direct
connection. Standalone source servers without Electron connect directly.
Events leave in batches of up to 50 events or 1 MB, with a 12-second request
deadline. Network failures, timeouts, rate limiting and service failures retry
with bounded backoff. A refused batch is retried one event at a time, so only
the refused events are dropped. UUIDs, event times,
identities, app versions and distributions stay fixed during retry and across process restarts.
PostHog receives the stable event UUID for deduplication. Admission has two
per-minute budgets of 120 events: one for diagnostics and progress observations
(errors, warnings, turn stages, runtime start/stop, connection closes, setup
stages and native lifecycle), and one for operation results such as saves,
project entry, sign-in and billing. A burst of failures therefore cannot hide a
save made in the same minute. `app_opened`, `app_active`, `document_engaged` and
turn starts with a turn ID are bounded by their own suppression or the
pending-turn limit instead. Up to 100 admitted pending turns each reserve
one of the 500 queue slots for their terminal record. Terminals consume that
reservation without ordinary rate limiting; queueing the terminal and removing
the pending record are one atomic write. Full queues refuse new starts and other
events rather than evicting identity links or reserved terminals. Pending records
and up to 500 recent-completion IDs expire after 30 days. Local storage failure,
expiry and permanent ingestion refusal still limit delivery. Independently
arriving host observations other than acceptance can wait briefly for an admitted
start. This bounded race buffer cannot infer a missing submission; actual host
acceptance supplies its own start as described above.

Collection never waits on network delivery to complete a writing operation or
shutdown; an in-flight request is abandoned at shutdown and its events remain queued. The host re-reads current configuration after each outbound request so
an acknowledgement cannot overwrite newer preferences or newly queued work.
Renderer usage delivery keeps at most 100 outstanding reports in memory and makes
at most three attempts, retaining the event UUID and occurrence time. Local intake
confirms saved admission, duplicates, disabled/stale collection or temporary refusal;
only temporary failures retry. Account/privacy changes and host replacement discard
older renderer requests. These short retries do not survive a closed renderer and
never resend an Agent task. There is no second durable renderer queue.
Renderer error delivery queues up to 100 errors and retries each up to three times.
Native processes spool up to 50 bounded diagnostic records for seven days, including startup,
renderer/child-process crashes, MCP startup and actual updater failures. The host
imports them every five seconds or on shutdown, retaining occurrence time and
source version. A crash before any host can run is recoverable only after a later
healthy launch; a full spool can lose further errors. Normal lifecycle observations
stop admission at 25 pending records to leave room for failures.

Queue expiry, saturation, unavailable local storage, ingestion rejection and
uninstall can still lose events. HTTP acceptance alone does not establish that a
provider's identity merge or dashboard query has completed.

Schema 8 adds cumulative delivery checkpoints to event properties. Optional host
`delivery` and renderer `renderer_delivery` each carry `series_id`, `started_at`
and bounded `counters`. The host snapshot is saved at admission and remains
unchanged through retries; the renderer snapshot is fixed at its first send.
Later events can expose newer counts. These are metadata on existing events,
with no heartbeat or second delivery queue.

| Checkpoint counters | Interpretation |
|---|---|
| Host `attempted`, `accepted`, `duplicate`, `invalid` | Capture admission attempts, accepted events, suppressed duplicates and invalid capture input |
| Host `queue_full`, `rate_limited`, `turn_limit`, `missing_start`, `stale` | Refusals caused by capacity, rate, pending-turn count, missing start or stale renderer/identity context |
| Host `storage_failed` | Storage failures observed after collection is known to be enabled; unreadable storage can also prevent recording this count |
| Host `delivered`, `transport_failed`, `rejected` | Acknowledged envelopes, retryable outbound failures and permanent ingestion refusals, counted per envelope in each batch; a refused batch counts only after its events are retried singly |
| Host `expired`, `invalid_queued` | Expired or invalid/excess queued envelopes removed during validation |
| Renderer `generated`, `coalesced`, `invalid`, `overflow` | Recorder calls, activity reports suppressed within the minute, invalid input and reports refused by the outstanding-request limit |
| Renderer `requests`, `accepted`, `duplicate`, `refused`, `exhausted` | Local send attempts, acknowledged admissions/duplicates, permanent local refusals and reports that exhausted three send attempts |

Compare the latest checkpoint or counter deltas within each series; never sum
the snapshots attached to events. `attempted` counts capture admissions,
including retries, while `delivered` also includes identity and recovery
envelopes. These counters do not form a single generated-minus-delivered loss
equation. The local `GET /api/telemetry/delivery` returns the latest readable host
checkpoint, or null when unavailable or collection is off. It can be newer than
the last uploaded snapshot.

Renderer counters live only in memory for their collection period. Disabled,
discarded or explicit host-reset receipts retire that period. The host omits
checkpoints spanning its account/privacy boundary or an earlier host lifetime;
renderer restart creates a new series. A final window close with no later
event, storage failure, opt-out or uninstall can leave the last interval unknown.
These checkpoints help explain missing reports but cannot prove complete receipt.
Treat them as installation/renderer delivery health, never as a person's usage
or active time.

Turning collection off cancels pending requests and removes the queue, all local
analytics identities, native diagnostic files and suppression markers. There is no final opt-out network
notification. A persistence failure still stops this process and shows failure;
relaunch suppression is guaranteed only once the choice is saved successfully.
Already transmitted events cannot be recalled or deleted by this switch.
Re-enabling starts fresh local IDs and never backfills disabled activity. If still
signed in, new activity is again associated with that account, including its
existing PostHog person history.

## What is never sent

Documents, chat transcripts, prompt/reply payloads, search queries, hardware
fingerprints, screenshots, clipboard contents, full raw logs or content hashes are
not collected as analytics fields. Known credentials are filtered from diagnostic
text. File/project paths, URLs and personal details can occur inside an error
message, stack or bounded process output; these diagnostic details are retained.
There is
no DOM click payload capture, session replay, pageview tracking or AI tracing.
Authenticated activity creates person profiles using the stable account ID;
unidentified events request no profile. IP and GeoIP enrichment are disabled in
payloads. The receiving service still sees the connection IP; operators must
also disable IP retention in PostHog.

## Return views

StashBase is used on demand: people open it when they have something to read
or write, and gaps of one to three weeks are normal. These views therefore ask
whether a person came back within a window, not whether they appeared on one
exact day.

Use schema version 3 and later, the UTC calendar and event occurrence time.
Keep installation and person views separate. In person views, use PostHog's
resolved person identity so linked anonymous and authenticated histories count
once; do not simply coalesce each row's user ID with its installation ID. Later
identity merges can change historical cohort membership. Never filter the
initial population to signed-in people only.

**Core use** is `document_engaged` (read or edit) or `agent_turn_started`,
including blocked attempts; inspect success and failure separately. A person's
entry day is their first core-use day, and day N is N calendar days after it.
Entry cohorts group people by the UTC week (starting Monday) of their entry day.

The dashboard has three measures:

| Measure | Population | Counts as returned | Final |
|---|---|---|---|
| 7-day return | Weekly entry cohort | Core use on any of days 1–7 | 14 days after the cohort week starts |
| Next-month return | Weekly entry cohort | Core use on any of days 30–59 | 66 days after the cohort week starts |
| Weekly active people | Everyone | Core use during that UTC week | When the week ends |

A cohort's value is its returned people divided by all of its people, never an
average of daily percentages. Until the last member's window has elapsed, show
the cumulative value so far and mark it in progress. It can only rise, so it is
a lower bound: an in-progress value above the previous cohort's final value
already shows improvement, while a lower one needs the final value. Show no
value before any member has reached the window's first day.

7-day return shows whether first use was worth coming back for. Next-month
return shows who is still using after the first month. Its 30-day window keeps
long gaps from counting as loss, and it excludes people who came back once and
then stopped. Weekly active people shows the overall direction without waiting
for cohorts to finish.

Other saved views:

- **App-open return:** the same windows with `app_active` as both entry and
  return, separating opening the app from core use.
- **After first result:** entry is the first successful `agent_turn_finished` or
  successful `document_write_result` with `changed = true`; return is later core
  use in the same windows. This measures return after a result, not only among
  people who log in.
- **Activation funnel:** first active use → successful project entry → core
  attempt → first result. Login is an optional branch, not a universal prerequisite.
- **Account funnel:** login started → login success → subsequent core use.
- **Desktop subscription funnel:** Checkout page obtained → confirmed paid rights.
  Deduplicate by person and label it observed conversion, not payment revenue.

Use unique installations for installation views and resolved persons for person
views. Break down event-time OS, version, mode and agent runtime; do not
substitute mutable current profile properties for cohort-entry attributes.

These views describe reporting activity, not all users. Missing events can mean
offline use, blocked transport, opt-out, reinstall or abandonment. A person
without next-month return was not observed in that window, which is not
confirmed churn. Historical schema-2 installation counts are not directly
comparable with schema-3 person or foreground return.

For sustained-use reviews, show each resolved person's last 7 and 28 days of
distinct use days, foreground/document interaction, Agent workload and observed
changed writes separately. Add affected turn outcomes, latest occurrence and
delivery coverage. Keep internal users with an explicit label, and compare app
versions and schema coverage before ranking. High turn counts can include retries;
low counts with incomplete delivery are insufficient evidence of low use. File
operations and tool results supplement the existing core-use definition without
turning automated work into human active time.

### Backend activity supplement

The agreed operator reporting extension counts all hosted AI request attempts,
including Agent calls, indexing and semantic search, as activity. Automatic
background requests count under this definition; it does not establish foreground
engagement. This supplement is not yet connected to the saved PostHog views.

Use each request's original creation time and the same UTC calendar. Ledger
settlement, reconciliation, refunds and other updates do not establish another
active day. Include failed attempts that reached the request ledger; activity is
independent of payment or successful completion. Re-reading the same request
does not change its original activity date. A real later call attempt counts on
its own start date; embedding retries can reuse a ledger row, so the original
row's creation time alone is not a complete history of call attempts.

Resolve the backend account's auth subject to its PostHog person before unioning
activity days. Preserve linked anonymous history and deduplicate by person and
day. Backend accounts with no PostHog identity still count once in weekly active
people. For the existing core-entry return view, retain first observed core use
as entry and accept either core use or a backend request in its return windows.
Do not infer new-user entry from the first retained backend request: request
history can be pruned. Label supplemented views explicitly so they are not
mistaken for desktop core-use-only measures.

This is a reporting join over existing operational records, not a change to
desktop collection or its opt-out. Do not manufacture desktop events or replay
disabled client activity to fill gaps. Until the backend source and identity
join are verified, missing PostHog return remains unobserved return, not confirmed
inactivity or churn.

## Turn diagnosis views

For schema 5 and later, join starts, stages, terminal results and diagnostics by `turn_id`,
using `connection_id` for pre-prompt connection failures and request IDs for
specific HTTP/model calls. Inspect sequence and occurrence/observation times,
not ingestion order. Keep the original app version and installation in breakdowns.

Track missing results separately from confirmed failures and recovered unknown
results. A start without `host_accepted` has no evidence of execution; a start
with later stages but no terminal has a different diagnostic scope. A 415 only
belongs to a turn when its originating request carries that turn ID. Tool errors
and recovered request attempts are not themselves terminal turn failures.

Set age thresholds by stage and allow an offline-delivery grace window. Waiting
for permission is user-dependent and must not use a model-response timeout.
These views report missing observed results, never proven hangs, crashes or churn.
Production saved views/alerts and provider receipt require separate operator
verification; local tests use replaced transport.

## Implementation and operator setup

`server/telemetry.ts` owns identity, admission, session attribution, opt-out and
transport. `server/telemetry-state.ts` validates persisted envelopes and maps them
to the Capture API. The event allowlist is
`shared/protocols/http/telemetry.ts`; renderer intake accepts only renderer-owned
facts. Authentication and billing facts cannot be supplied by renderer event
requests. No analytics SDK or remote configuration runs.

`server/telemetry-destination.json` contains the public PostHog ingestion token
and host, never a Personal API key or secret. Forks should clear or replace it.
Disable IP retention in the receiving project and choose its event retention
period independently from the seven-day local delivery limit.

### Testing and development

Node test workers, `NODE_ENV=test`, Vitest and Jest processes automatically disable
production collection and native diagnostic spooling, even if they inherit
`STASHBASE_PACKAGED=1`. The shared host-test fixture also passes
`STASHBASE_TELEMETRY_DISABLED=1` to descendants. Collection unit tests use explicit
fixtures with fake transport; production-admission tests replace transport before import.

For manual checks or development sessions that should not count as usage, set
`STASHBASE_TELEMETRY_DISABLED=1` before starting an app/server process, whether
running from source or a packaged build.

It suppresses all collection and queue delivery, including identity links,
without changing saved preferences or analytics state. Settings cannot override
it. Verify `/api/telemetry` reports `available: false` before exercising flows.
Smoke launchers set it themselves. For example:

```bash
env -u ELECTRON_RUN_AS_NODE STASHBASE_TELEMETRY_DISABLED=1 pnpm dev

env -u ELECTRON_RUN_AS_NODE STASHBASE_TELEMETRY_DISABLED=1 \
  /Applications/StashBase.app/Contents/MacOS/StashBase
```

Windows PowerShell uses `$env:STASHBASE_TELEMETRY_DISABLED = '1'`; Linux sets it
before the AppImage launch. Reapply it for each process, including updater tests.
Use isolated test profiles. Tests of collection replace the transport with a
local sink and never send test events to production PostHog.

Protocol references: [Capture API](https://posthog.com/docs/api/capture),
[identity linking](https://posthog.com/docs/product-analytics/identify),
[anonymous and identified events](https://posthog.com/docs/data/anonymous-vs-identified-events).

### Agent cleanup outcomes

Count `agent_runtime_stop_result` with `outcome=timeout` as cleanup failures.
A later `closed_after_timeout` with the same `attempt_id` confirms final closure;
it is neither another failure nor a successful original operation. The same
caught timeout is not counted again as a generic application warning/error.
Successful closes provide the denominator for timeout rates. Process purpose
separates history, chat, prewarm and model readers; the first initiating reason
identifies expiration, replacement, scope/window closure or shutdown.

Windows termination evidence distinguishes taskkill still pending, spawn failure,
nonzero exit and direct-kill fallback, with bounded credential-filtered errors.
An observed leader exit without pipe closure differs from a leader that has not
exited. Windows does not report process-group presence as if it were observed.
Neither fact alone establishes the cause of a slow close. Returning activity,
editing, and the next successful Agent turn remain separate measures of recovery.
