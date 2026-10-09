# Usage statistics

Official desktop builds share basic usage statistics and redacted error diagnostics
with PostHog by default. Automatic diagnostics are a temporary early-access
support strategy for failures that users cannot report directly.
The collection explanation and controls are in Settings. Turn collection off at any time in
**Settings → General → Privacy → Share basic usage statistics**. Local editing,
Agent access, and every other feature work regardless of this choice.
Development builds and builds without a configured destination do not send.

## What is sent

Each event carries a random installation ID, app version, operating system,
schema version, and event time. The ID is unrelated to your account or hardware;
it can link usage from this installation across launches. It is not a claim of
complete anonymity. No person profiles are created.

| Event | Trigger | Additional fields |
|---|---|---|
| `app_opened` | Workspace shell mounts; once per shared server lifetime across windows | None |
| `project_entry_result` | A project-open operation settles in the host | `outcome` |
| `agent_turn_started` | A non-empty user submission begins context/preparation checks, or a manual retry begins | `runtime` |
| `agent_turn_finished` | Submission is blocked, completes, fails, or is stopped/retired | `runtime`, `outcome`, duration bucket |
| `document_write_result` | Editor versioned save succeeds, fails, or conflicts | `outcome` |
| `agent_setup_result` | Native installation, update, login, or connection fails; explicit setup settles; OpenQuill login completes/fails | `runtime`, `stage`, `outcome`, optional `failure_stage` and `diagnostic` |
| `application_error` | Agent runtime/connection failure, failed local API operation, background warning/error, or renderer exception | `source`, fixed `operation`, optional `runtime`, redacted `diagnostic` |
| `telemetry_disabled` | User turns collection off | None |

Runtime values are `stashbase` (OpenQuill), `claude`, and `codex`. Outcomes are
bounded categories (`success`, `failed`, `cancelled`, `blocked`; document saves
use `conflict`). Setup stages are `prepare`, `login`, `update`, and `connect`. Durations are under 10
seconds, 10–60 seconds, 1–5 minutes, or over 5 minutes. No exact model names or
request durations are sent. Schema version 2 adds bounded error diagnostics:
a controlled error summary, up to 12 stack line/column locations, an allowlisted
error name/code, HTTP status, or process exit code when known. Node classifies
raw sentences locally and emits only fixed summaries, so unquoted file/project
names cannot escape through free text. Source paths, function names, arbitrary
objects, request bodies, and raw error sentences are excluded. The original
error remains available locally in the relevant failure UI.

There is one privacy choice for both usage and diagnostics: the existing switch
enables both or disables both. No separate diagnostic permission or switch exists.
Repeated identical errors are suppressed for one minute; the collector retains
at most 100 suppression entries and applies the existing outbound rate and
concurrency limits. Renderer transport, invalid protocol, React render, and global
exception/rejection failures reach the same Node owner through the local error
sink. Agent tool inputs/results and conversation content are excluded from runtime
error collection. Background warnings/errors are classified locally; log text is never uploaded.
Caught native picker/update, workspace persistence, project windows,
attachment/upload, PDF/DOCX preview, and media-resource failures also
reach the same owner. Normal user cancellation is excluded.
Offline delivery and a process that exits before delivery can lose diagnostics;
this is best-effort reporting, not a complete crash recorder or durable log upload.

Editor saves are limited to one event per outcome per installation per UTC day,
including across restarts. No-change HTTP saves can count; this is evidence of
an editor save operation, not a measure of writing quality or word count. Native
Agent file writes are not inferred from generated replies. Background setup
checks, polling, tool calls, token streaming, and automatic retries do not create
separate usage events; failures at these boundaries can create deduplicated error
diagnostics. Project entry counts host open results, not native picker
cancellations or import acquisitions that never reach the open operation.

## What is never sent

Documents, prompts, replies, search terms, file names or paths, project names,
repository URLs, account identity, API credentials, hardware fingerprints,
screenshots, clipboard contents, raw errors, logs, or hashes of private content.
There is no automatic click collection, pageview tracking, session replay,
heartbeat, or AI conversation tracing. Outbound payloads request no person
profile, no IP property, and no GeoIP enrichment. The receiving network service
still sees the connection IP; operators must also disable IP retention in PostHog.

## Turning collection off

The app saves the disabled preference locally before attempting one final
`telemetry_disabled` notification with the previous installation ID. Pending
usage and diagnostic requests are cancelled; already transmitted requests cannot be recalled.
The final notification has a two-second timeout, no retry, and no disk queue.
Network failure never prevents disabling collection. A settings-write failure
is shown and stops collection in the current process, but cannot guarantee that
the preference survives relaunch until it is successfully saved.

Disabling removes the local installation ID and daily save markers. Re-enabling
creates a new ID on the next eligible event and never sends historical activity.
This does not delete events already received by PostHog.

A disabled notification means collection was turned off at that moment, not
that the app remains in use. Missing events can also mean offline use, blocked
network access, uninstall, or abandonment. Dashboards must distinguish observed
activity, explicitly disabled reporting, and unknown inactivity. They describe
reporting installations, not all users.

## Implementation and operator setup

[`server/telemetry.ts`](../server/telemetry.ts) owns collection, strict Settings
persistence, suppression, and direct PostHog Capture API requests. The event
allowlist is [`shared/protocols/http/telemetry.ts`](../shared/protocols/http/telemetry.ts).
There is no analytics SDK or durable event queue. Delivery is best-effort with
bounded concurrency and rate limiting; it never blocks writing or shutdown.

[`server/telemetry-destination.json`](../server/telemetry-destination.json) contains
the public PostHog project ingestion token and host for the distributor. This is
not a user credential or Personal API key. Forks should clear or replace it.
Never embed a PostHog Personal API key or project secret key. No end-user setup
or environment credential is required.

### Testing packaged builds

Set `STASHBASE_TELEMETRY_DISABLED=1` in the launch environment before starting a
test app or server. It suppresses all outbound usage events, including
`app_opened` and `telemetry_disabled`, even in an official packaged build. The
override does not change the saved preference, installation ID, or daily markers;
capture does not create them either. Settings changes cannot enable collection
for that process. `/api/telemetry` reports `available: false` while still exposing
the saved `enabled` preference. A later launch without the override follows the
saved preference normally.

The Electron smoke runner and packaged-server smoke set this override themselves.
For manual packaged UI checks, quit existing test instances first and pass the
variable to the new app process; changing the environment of an already-running
app has no effect. For example, on macOS:

```bash
env -u ELECTRON_RUN_AS_NODE STASHBASE_TELEMETRY_DISABLED=1 \
  /Applications/StashBase.app/Contents/MacOS/StashBase
```

On Windows PowerShell, set `$env:STASHBASE_TELEMETRY_DISABLED = '1'` before starting
the test executable. On Linux, launch the AppImage or installed executable with
`STASHBASE_TELEMETRY_DISABLED=1` in its environment. Use an isolated test profile
for preference-editing checks. The override itself never persists a user opt-out.
For older versions without this override, disable telemetry in the disposable
test configuration before the first launch.

Tests of telemetry delivery must replace the outbound transport with a fake or
local capture sink. They must not send test-marked events to production PostHog.

Before enabling a production destination, disable IP capture in that PostHog
project and choose a retention period appropriate for basic product statistics.
The application does not alter PostHog administration settings. Suggested initial
views: reporting-installation return activity; project entry to discussion or
editor save; setup/turn/save outcomes. A completed turn is a technical outcome,
not evidence that the response was useful. Missing terminal events remain unknown.

Protocol references: [PostHog Capture API](https://posthog.com/docs/api/capture),
[PostHog collection controls](https://posthog.com/docs/privacy/data-collection).
