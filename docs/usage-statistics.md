# Usage statistics

Official desktop builds send product activity and redacted error diagnostics to
PostHog by default. **Settings → General → Privacy → Share usage statistics**
controls both. All features remain available when collection is off. Development
builds and builds without a destination do not send. Website activity is outside
this desktop collection.

## Identity and sign-in

The desktop creates a random installation ID and a separate anonymous ID. Neither
comes from hardware. Both survive launches. When you sign in, the host links the
current anonymous history to your stable StashBase account ID. Signing in to that
account on another installation links its activity to the same person, while the
installation property keeps their origins distinguishable. Your email, name,
avatar, tokens and provider account identities are not sent.

Signing out or changing accounts creates a new anonymous identity. An installation
is a property, never an alias used to merge all accounts on that computer.
Anonymous activity is attributed to the next verified sign-in in that anonymous
period; this is an attribution convention, not proof that a shared computer had
only one human operator. Unidentified installations cannot be reliably combined
into a person. Reinstalling or clearing application settings can create a new
installation identity.

## Events and interpretation

Schema version 3 carries an event UUID, occurrence time, app version, OS,
installation ID, anonymous ID, installation first-observed time, and, when signed
in, the account ID. Active work also establishes a session ID shared across
windows; 30 minutes without reported activity starts another session. The first
observed time means entry into this measurement, not a proven download/install
date. Older builds do not supply the same activity or identity evidence.

| Event | Meaning | Additional fields |
|---|---|---|
| `app_opened` | Workspace mounts, once per host lifetime | None |
| `app_active` | Trusted pointer, keyboard or wheel input in a visible, focused app window | `mode`: welcome / documents / chat |
| `document_engaged` | Interaction inside the active document surface, or an actual editor change | `activity`: read / edit; allowlisted `format` |
| `project_entry_result` | Host project-open operation settles | `outcome` |
| `agent_turn_started` | User submission or manual retry begins preparation | `runtime`, random `turn_id` |
| `agent_turn_finished` | Submission completes, fails, is blocked or cancelled | `runtime`, `turn_id`, `outcome`, duration bucket |
| `document_write_result` | Versioned editor save settles | `outcome`; success includes `changed` |
| `account_login_started` | A browser sign-in flow starts | None |
| `account_login_result` | Sign-in completes or fails | `outcome` |
| `account_signed_out` | Local account is signed out | None |
| `$identify` | Verified account links its preceding anonymous identity | `$anon_distinct_id` |
| `billing_checkout_result` | Host obtains a verified Checkout page or fails | `outcome` |
| `billing_portal_result` | Host obtains a verified management page or fails | `outcome` |
| `subscription_observed` | Hosted API confirms subscription rights; unchanged polling is suppressed | bounded `plan`, `paid`, `cancel_at_period_end` |
| `agent_setup_result` | Agent setup settles or connection fails | `runtime`, `stage`, `outcome`, optional failure stage and diagnostic |
| `application_error` | Host, renderer or Agent failure | `source`, controlled `operation`, optional `runtime`, redacted `diagnostic` |

`app_active` and each document activity/format category are limited to once per UTC
minute across windows. They are not heartbeats. Idle background processes,
restored tabs, automatic source refresh, and streamed Agent output alone do not
create active days. Read engagement is a surface-interaction proxy: it cannot
prove comprehension, and silent reading without interaction is not counted.
Editing events contain no text or keystrokes. Unchanged saves report
`changed: false`; changed saves and completed turns are measurable results, not
proof of writing quality or user satisfaction. Agent file writes are not inferred
from generated replies. Project entry excludes picker cancellations and acquisitions
that never reach the open operation.

Runtime values are stashbase, claude and codex. Outcomes are success, failed,
cancelled or blocked; saves use conflict. Durations are under 10 seconds,
10–60 seconds, 1–5 minutes, or over 5 minutes. No model names or exact request
durations are sent. Diagnostics contain controlled summaries, known error codes,
HTTP/exit status and bounded stack line/column locations. Raw messages are
classified locally. Identical diagnostics are suppressed for one minute.

Save, project-open and billing operations retain their initiating identity across
an asynchronous account switch. A turn's random correlation ID retains its
initiating identity and session until its one terminal result in the same host
process. A terminal result with no retained start is not inferred after a host
restart or opt-out. There is no conversation ID or source identity in these events.

Checkout success means a page was obtained, not that payment succeeded.
`subscription_observed` means confirmed rights, not a new charge: the same account
can be observed on multiple devices or after signing back in. Revenue, invoices,
refunds and a complete purchase ledger require the hosted billing service and are
not measured by desktop events.

## Delivery and turning collection off

The host atomically saves bounded, validated event envelopes in the owner-only
application configuration before sending. The queue holds at most 500 events for
seven days. Network failures, timeouts, rate limiting and service failures retry
with bounded backoff; permanent request refusals are dropped. UUIDs, event times,
identities and app versions stay fixed during retry and across process restarts.
PostHog receives the stable event UUID for deduplication. Admission is limited to
120 events per minute. A full queue refuses new events rather than evicting an
identity link and silently accepting its dependent events.

Collection never waits on network delivery to complete a writing operation or
shutdown. The host re-reads current configuration after each outbound request so
an acknowledgement cannot overwrite newer preferences or newly queued work.
Queue expiry, saturation, unavailable local storage, ingestion rejection and
uninstall can still lose events. HTTP acceptance alone does not establish that a
provider's identity merge or dashboard query has completed.

Turning collection off cancels pending requests and removes the queue, all local
analytics identities and suppression markers. There is no final opt-out network
notification. A persistence failure still stops this process and shows failure;
relaunch suppression is guaranteed only once the choice is saved successfully.
Already transmitted events cannot be recalled or deleted by this switch.
Re-enabling starts fresh local IDs and never backfills disabled activity. If still
signed in, new activity is again associated with that account, including its
existing PostHog person history.

## What is never sent

Document/chat contents, prompts, replies, search terms, file/project names or
paths, repository URLs, email addresses, credentials, hardware fingerprints,
screenshots, clipboard contents, raw logs or hashes of private content. There is
no DOM click payload capture, session replay, pageview tracking or AI tracing.
Authenticated activity creates person profiles using the stable account ID;
unidentified events request no profile. IP and GeoIP enrichment are disabled in
payloads. The receiving service still sees the connection IP; operators must
also disable IP retention in PostHog.

## Retention views

Use schema version 3 and later, one fixed UTC calendar, event occurrence time,
and only cohorts whose observation window has elapsed. Keep installation and
person views separate. In person views, use PostHog's resolved person identity
so linked anonymous and authenticated histories count once; do not simply
coalesce each row's user ID with its installation ID. Later identity merges can
change historical cohort membership. Never filter the initial population to
signed-in people only.

Recommended saved views:

- **Observed return retention:** first `app_active` → later `app_active`.
- **Core-use retention:** first `document_engaged` or `agent_turn_started` →
  another event from that same union. Include blocked attempts here, then inspect
  success/failure separately.
- **After first result:** first successful `agent_turn_finished` or successful
  `document_write_result` with `changed = true` → subsequent core use. This
  measures retention after a result, not only among people who log in.
- **Activation funnel:** first active use → successful project entry → core
  attempt → first result. Login is an optional branch, not a universal prerequisite.
- **Account funnel:** login started → login success → subsequent core use.
- **Desktop subscription funnel:** Checkout page obtained → confirmed paid rights.
  Deduplicate by person and label it observed conversion, not payment revenue.

D1, D7 and D30 mean return on exactly that calendar day after cohort entry. W1
means at least one return on days 7–13; W4 means days 28–34. Divide returning
identities by eligible identities in that entry cohort, not all current users.
Use unique installations for installation retention and resolved persons for
person retention. Break down event-time OS, version, mode and Agent runtime;
do not substitute mutable current profile properties for cohort-entry attributes.

These views describe reporting activity, not all users. Missing events can mean
offline use, blocked transport, opt-out, reinstall or abandonment. Do not label
all missing activity as confirmed churn. Historical schema-2 installation counts
are not directly comparable with schema-3 person or foreground retention.

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

### Testing packaged builds

Set `STASHBASE_TELEMETRY_DISABLED=1` before starting an app/server test process.
It suppresses all collection and queue delivery, including identity links,
without changing saved preferences or analytics state. Settings cannot override
it. Verify `/api/telemetry` reports `available: false` before exercising flows.
Smoke launchers set it themselves. For example:

```bash
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
