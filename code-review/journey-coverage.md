# Journey Coverage

Start here for a journey review: choose its boundary and implementation entry
points, then inspect the code and evidence. [User Journeys](../design-docs/journeys/README.md)
states required outcomes; [Engineering Boundaries](architecture.md) owns invariants.
Tests own fixtures and exact assertions. This is not a source inventory or a review-completion percentage.

## Evidence Model

| Evidence | Establishes |
|---|---|
| Contract Test | Deterministic interfaces, invariants, failures, and recovery at the lowest useful layer |
| Driven Runtime Pass | A named observable flow through the built app, within its recorded substitutions and limits |
| AI Eval | Probabilistic retrieval, grounding, or task quality on representative inputs |
| Release Check | Packaged, native, credentialed, or third-party behavior unavailable to source tests |

**Covered** requires decisive evidence for every Required result. **Partial**
means some results lack it. **Release-dependent** reserves named external or
packaged checks. **Gap** identifies contradicted or unproven behavior. These
labels concern evidence, not feature completion. A broad command or passing count is
not proof.

Format evidence follows the [Documents capability matrix](../design-docs/capabilities/project-files.md#format-capability-matrix):
editable prose/structured text, preview-only text, prepared binary documents,
and OCR images. One representation cannot prove another.

For horizontal review, follow a shared capability across these rows and inspect
its [current engineering owners](architecture.md#shared-capability-owners).
The map is navigation, not proof that every caller has been reviewed.

## Traceability Map

| Journey | Shared capabilities | Engineering boundary |
|---|---|---|
| [J01 Onboarding](#j01-onboarding) | [Project Entry](../design-docs/capabilities/project-entry.md), [Agent Sessions](../design-docs/capabilities/agent-sessions.md), [Account and Settings](../design-docs/capabilities/account-settings.md) | [Entry and identity](architecture.md#project-scope-and-paths), [Native lifecycle](architecture.md#native-lifecycle-and-updates) |
| [J02 Folder](#j02-folder) | [Project Entry](../design-docs/capabilities/project-entry.md), [Project Files](../design-docs/capabilities/project-files.md) | [Projects](architecture.md#project-scope-and-paths), [Import](architecture.md#import-publication) |
| [J03 Documents](#j03-documents) | [Project Files](../design-docs/capabilities/project-files.md) | [Source transactions](architecture.md#source-transactions), [Renderer](architecture.md#renderer-boundaries), [Draft durability](architecture.md#draft-durability) |
| [J04 Preparation](#j04-preparation) | [Project Context](../design-docs/capabilities/project-context.md) | [Preparation](architecture.md#preparation-and-retrieval), [Local components](architecture.md#optional-local-components) |
| [J05 Search](#j05-search) | [Project Context](../design-docs/capabilities/project-context.md), [Project Files](../design-docs/capabilities/project-files.md) | [Retrieval](architecture.md#preparation-and-retrieval), [Scope](architecture.md#project-scope-and-paths) |
| [J06 Agent](#j06-agent) | [Agent Sessions](../design-docs/capabilities/agent-sessions.md), [Account and Settings](../design-docs/capabilities/account-settings.md), [Project Files](../design-docs/capabilities/project-files.md) | [Agent sessions](architecture.md#agent-sessions-and-permissions), [Credentials](architecture.md#credentials-and-external-access) |
| [J07 Converge](#j07-converge) | [Agent Sessions](../design-docs/capabilities/agent-sessions.md), [Project Files](../design-docs/capabilities/project-files.md) | [Source transactions](architecture.md#source-transactions), [Agent permissions](architecture.md#agent-sessions-and-permissions) |
| [J08 External MCP](#j08-external-mcp) | [Project Context](../design-docs/capabilities/project-context.md), [Project Files](../design-docs/capabilities/project-files.md), [Account and Settings](../design-docs/capabilities/account-settings.md) | [MCP](architecture.md#credentials-and-external-access), [Scope](architecture.md#project-scope-and-paths) |
| [J09 Bug report](#j09-bug-report) | [Account and Settings](../design-docs/capabilities/account-settings.md) | [Bug report](architecture.md#bug-report), [Native lifecycle](architecture.md#native-lifecycle-and-updates) |
| [J10 Core loop](#j10-core-loop) | [Project Entry](../design-docs/capabilities/project-entry.md), [Agent Sessions](../design-docs/capabilities/agent-sessions.md), [Project Files](../design-docs/capabilities/project-files.md), [Project Context](../design-docs/capabilities/project-context.md) | [Ownership](architecture.md#runtime-ownership), [Agent sessions](architecture.md#agent-sessions-and-permissions), [Source transactions](architecture.md#source-transactions) |
| [J11 Conversation to project](#j11-conversation-to-project) | [Project Entry](../design-docs/capabilities/project-entry.md), [Agent Sessions](../design-docs/capabilities/agent-sessions.md) | [Projects](architecture.md#project-scope-and-paths), [Session ownership](architecture.md#agent-sessions-and-permissions) |
| [J12 Build Wiki Pages](#j12-build-wiki-pages) | [Agent Sessions](../design-docs/capabilities/agent-sessions.md), [Project Files](../design-docs/capabilities/project-files.md), [Project Context](../design-docs/capabilities/project-context.md) | [Agent permissions](architecture.md#agent-sessions-and-permissions), [Preparation](architecture.md#preparation-and-retrieval) |
| [J14 Scheduled tasks](#j14-scheduled-tasks) | [Scheduled Tasks](../design-docs/capabilities/scheduled-tasks.md), [Agent Sessions](../design-docs/capabilities/agent-sessions.md), [Project Files](../design-docs/capabilities/project-files.md), [Project Entry](../design-docs/capabilities/project-entry.md) | [Scheduled tasks](architecture.md#scheduled-tasks), [Agent sessions](architecture.md#agent-sessions-and-permissions), [Native lifecycle](architecture.md#native-lifecycle-and-updates) |
| [J13 Gallery download](#j13-gallery-download) | [Project Entry](../design-docs/capabilities/project-entry.md) | [Gallery](architecture.md#gallery), [Import](architecture.md#import-publication) |

## J01: Onboarding

**Patch release validation (2026-11-10):** The merged sign-in recovery and
ready-only model-catalog changes passed `pnpm check`, 93 focused renderer
checks, 20 host catalog checks, renderer lint/format, documentation validation,
a fresh build and built Electron smoke on macOS. The persistent Antigravity
onboarding profile started its built host; its catalog reported all three
native CLIs absent and Default awaiting account setup. No real installation,
OAuth, first reply or returning-user login was completed. Computer-use could
not reliably target the validation window, and the browser control host was
unavailable, so visual review remains unverified in this pass. These are
controlled source results; packaged and cross-platform residual checks remain
separate. The first source CI rejected `workspace.tsx` at 412 lines while its
other eleven renderer gates passed. Account/Settings refresh effects now live
with their catalog query in `use-agent-catalog.ts`, keeping the workspace under
its 400-line limit without changing recovery behavior.

**Source Python setup paths (2026-11-10):** `scripts/packaging/inputs.test.mjs`
drives the real setup/build script initialization with controlled child commands
under paths containing spaces, apostrophes, Unicode, `%` and `#`. A real pip
no-index dry run reads each checkout's encoded constraint URL without installation.
The test covers unavailable 8.3 names and a spaced temporary directory without
PowerShell or a shared constraint copy. It does not establish a full Python
dependency installation or frozen sidecar build under those special paths.

**Account and startup recovery (2026-11-03):** credits and billing now refresh
host-owned account state after a typed authentication refusal. Confirmed expiry
restores Sign in and invalidates Agent readiness; network errors keep the
identity and Retry. Focused account, billing and panel tests cover stale refusals,
overlapping account reads, new login, cancellation and no mutation replay.
The expired-account and credit-network-failure Stories were inspected in Chrome,
including Sign in and a Retry that preserves the account. Native startup now
distinguishes an ordinary completed signed-out probe from a credential refusal,
unanswered probe or MCP failure: only the ordinary prerequisite avoids failed
setup/MCP diagnostics. Focused installer tests preserve explicit-check reporting
and actual failure diagnostics, including mixed signed-out/401 probe output.
The completion gate passed 118 host, 11 renderer and three controlled bundled
runtime checks. After the final race/precedence corrections, affected account
checks (35), installer checks (11), host/renderer types and target format/lint
passed. Fresh renderer, Electron and service builds, built Electron smoke and
documentation checks passed. The persistent private Claude onboarding profile
opened its empty First essay project; native runtimes were uninstalled and
Default required sign-in. These checks do not verify live account expiry,
provider installation/OAuth, a completed real reply or returning-user login.

**Invalid native credentials (2026-11-03):** a controlled Claude CLI reproduced
`401 / OAuth access token is invalid` being reported as an unanswered sign-in
check. `agentIsAuthenticated` now classifies completed probe output and passes a
typed refusal to `AgentBootstrapCoordinator`, which offers explicit login and
retains the refusal across cached-success rechecks. The existing installer suite
exercises the real probe and login launcher through rejection, recheck and a new
login; connection/503/unsupported-command output still offers check recovery.
The catalog adapter test follows Claude's recovery through `/login` and preserves
the diagnostic. Settings uses its existing Sign in presentation, with an
`InvalidClaudeCredentials` Story for the refused probe.
Host/renderer types, the core gate (114 host checks, 11 renderer checks and three
bundled-runtime checks), 32 focused Settings checks and fresh builds passed.
The isolated Electron Story visibly shows the 401 diagnostic and Sign in.
Built Electron smoke passed across the initial run and resumed scenarios after
dismissing a macOS crash-restoration dialog that had blocked the lifecycle test's
launch. Renderer formatting/lint and documentation checks passed.
The isolated persistent Claude onboarding app reached Welcome; its runtime
catalog reports Claude uninstalled. Real installation, OAuth, invalid-token
reauthentication, a completed provider reply and login reuse remain unverified.

**Codex lifecycle verification (2026-11-02):** the fresh built app and host
launched with `verify:onboarding --agent codex --built` in the persistent private
profile. `/api/terminal/clis` reports Codex uninstalled, with no discovered host
CLI. Real sign-in, a completed first reply and login reuse remain unverified.
J06 records isolated official-binary history reads and the controlled process
fixtures for writer handoff and bounded list recovery; these do not replace that
provider acceptance flow.

**Credit proxy continuity (2026-11-02):** a controlled account flow signs in
through the private Chromium relay while direct Node access is refused. Its
subsequent credit read reproduced a direct-fetch failure. `hosted-account.ts`
now routes that read through `hosted-auth-transport.ts` and the native bridge's
fixed Agent usage endpoint. Regressions retain token/version forwarding, 401
status and request ID, cancellation/deadlines, no direct fallback and rejection
of arbitrary destinations/headers. The native Auth smoke also checks a separate
PAC-selected CONNECT for credits after sign-in; the fixture refuses that tunnel,
so it sends no credentials to a provider. This does not establish real provider
login, the affected user's network, or Windows/Linux OS proxy behavior.

**Codex approval verification (2026-10-29):** a fresh build launched with
`verify:onboarding --agent codex --built` in the persistent private profile.
Welcome and Settings > Agents loaded; Codex reports Not installed. No signed-in
Computer Use turn or persisted app grant was exercised. J06 records the controlled
RPC/renderer and isolated Electron Story evidence for the approval changes.

**Codex selection verification (2026-10-28):** the built app and host were launched
with `verify:onboarding --agent codex --built` using the persistent private profile.
Its runtime listing reports Codex uninstalled; no provider sign-in or completed
reply was available. Model/effort continuity is covered by the controlled J06
checks below, not a passing real-provider restore/reconnect verification.

**Account request recovery (2026-10-27):** credits and billing distinguish
authentication lost during a request (401) from an unavailable service (502).
Controlled route checks cover expired sessions, concurrent sign-out and network
failure without revoking valid saved credentials. A real private Auth relay
fixture preserves upstream status/content type/request ID through malformed
JSON, without logging response excerpts. The renderer HTTP adapter bypasses
HTTP cache and retries an exposed 304 once for GET only; regressions cover
cancellation, repeated 304 and refusing to replay writes. A real Electron fixture
recovers a bare 304 and confirms subsequent reads reach the local server. These checks do not
establish availability of the real sign-in or credits service; a fresh external
provider login and reply remain unverified for this change.

**CLI probe diagnostics (2026-10-27):** `server/agent-probe.ts` retains bounded
stdout/stderr and exit evidence when a probe times out, after reaping its process
tree. `extractor-process.test.ts` runs a stalled child and verifies the captured,
credential-filtered diagnostic. Probe deadlines and login behavior are unchanged;
this controlled failure does not establish provider authentication availability.

**Settings scroll containment (2026-10-27):** `settings/ui/shell.tsx` makes the
settings content scroller its accessibility labels' containing block. The
`InSettingsWindow` MCP Story exercises URL controls and expanded Docker port
settings. At a real-browser 928 by 480 viewport, the old layout scrolled the
outer dialog by 92.5px; the fix held it at zero with both client and scroll
heights of 374px, preserving the header and close action. DOM-only Story checks
do not establish this geometry.

**Ready update rechecks (2026-10-27):** `electron/update-manager.cjs` permits
manual and automatic checks after a download, reuses matching releases, and
replaces the install target when a different release is selected. Failed checks
retain an explicitly labelled ready installer; failed replacement downloads
cannot install the superseded package. Update-manager regressions cover reuse,
replacement, periodic checks, failure recovery, and concurrent checks/restarts.
`electron/renderer/update-install-smoke.cjs` exercises the real MacUpdater proxy
with controlled payloads, then the built renderer save barrier and delayed native
handoff, including native failure rollback and ignoring old-feed completions
before and during a replacement retry. Settings exposes Check again beside Restart; the hook and IPC/adapter
checks preserve the failed-recheck flag without native diagnostics. These are
controlled update checks, not verification of a real signed installer upgrade.

**Core acceptance (2026-10-26):** `renderer/src/app.onboarding.test.tsx` drives
the whole window from Welcome through opening an empty project, choosing each
of Default/Claude/Codex/Antigravity, declining access without losing the draft,
signing in, and displaying one completed reply. Native rows also exercise a
refused outdated-runtime turn, update, and one resend. Remounting the app reuses
the fixture's project/preferences/account state and sends without another login.
The native scenarios also select a model and thinking effort, switch agents,
then reopen in a second project and switch back before sending with those choices
(see [J06](#j06-agent), 2026-10-29).
These four scenarios use controlled ports, not real HTTP, OAuth or provider
processes. They join focused host setup/source-preservation tests and the pinned
OpenCode fake-gateway smoke in `pnpm test:core`; `pnpm check` adds types.
The old vocabulary-array count test was removed; it established no user outcome.

**Antigravity configuration recovery (2026-11-10):** The existing
`__tests__/antigravity-setup.test.ts` now runs a controlled CLI under a path with
spaces through the real probe, coordinator and login entry. The production
Gemini-backend/missing-credential diagnostic stays a failed check with bootstrap
recheck; explicit login starts neither a terminal nor browser. Repairing the
fixture configuration reaches Ready without reinstalling. Unknown checks retain
their sign-in recovery. A macOS built-host pass on Node 26.13.0 repeats the
failure, explicit login refusal and repair-to-Ready through the real HTTP routes,
with isolated native configuration and telemetry disabled. Desktop inspection
could not complete because the computer-use app target was unavailable. These
fixtures do not establish fresh Google OAuth, real-provider first replies, or
Windows runtime behavior; those remain unverified for this change.

The native scenarios also cover a turn whose authentication is refused after
the catalog had reported ready: the failure offers sign-in settings, preserves
the next draft, refreshes readiness, and gates the next send on sign-in. The
refused turn is never automatically replayed. `ui/work-status.tsx` refreshes the
catalog and `transcript/turn-failure.tsx` owns the visible sign-in recovery;
the existing first-send gate still owns connecting before sending. Once a
reading after the refusal reports the agent ready, the refused turn's card
says it is signed in again instead of asking (`hooks/use-agent-sign-in-recovery.ts`);
J01 checks this after the in-chat sign-in, and `workspace.recovery.test.tsx`
after signing in through Settings, whose closing re-reads the chat catalog. This is
controlled recovery coverage, not evidence of why a particular fresh install
passed its initial login check or of a real provider's OAuth exchange.
The core gate, focused transcript/catalog checks, lint, formatting and build
passed; the sign-in recovery Story was visually inspected. The isolated macOS
Codex onboarding app reached Welcome, but desktop automation could not target
its window for input. Native installation, OAuth and a real completed reply
remain unverified by this follow-up.

**Recovery audit (2026-10-26):** terminal adapter exits and pre-ready errors now
retain authentication/version classification through the shared protocol and
session state. Workspace recovery coverage exercises sign-in, native updates,
application updates, draft preservation and uncertain-turn queue pausing. The
existing Codex adapter test exercises a refused startup; installer coverage
reproduces a provider refusal racing a local auth check and requires explicit
sign-in before readiness can return. Catalog/first-send coverage preserves the
host-selected update retry, and update-hook coverage follows an update that
stops at authentication without reconnecting or resending. Known Default
sign-in and `client_upgrade_required` messages are classified at the host,
with application updates routed through composition to General settings.
These controlled paths do not prove fresh OAuth or official update delivery
on a real provider/OS, or establish the original reported user's initial bypass.
The core gate, 183 adapter/protocol checks, final installer checks, renderer
regressions, types, lint, formatting, docs, fresh builds and built Electron
smoke passed. Five renderer tests initially timed out during parallel validation;
all passed on the two-worker recheck. The final recovery/onboarding run passed
23 checks, including the four whole-window scenarios. Startup sign-in, update
followed by sign-in, and application-update Stories were visually inspected.
The repeated isolated Codex launch reached Welcome, but desktop input still
failed to target its Electron window; real install, OAuth and first reply
remain unverified. Continuing an update after sign-in checks readiness without
reinstalling, while startup sign-in retains explicit reconnect and Send.
Release preparation rebased this evidence onto the current Settings composition:
the core gate passed, all renderer gates passed after correcting the recovery
component extraction, and the full two-worker renderer run passed 1,883 tests
across 370 files plus 190 Story accessibility checks. Fresh application/service
builds, built Electron smoke and the three recovery Story inspections passed.

`scripts/testing/environment.ts` and isolated CLI discovery prevent host tests
and ordinary profiling from starting developer-installed providers. The existing
CLI tests now exercise that isolation. `pnpm verify:onboarding --agent <id>`
opens the built app with a persistent private profile for explicit real-provider
acceptance; `--fresh` creates a separate app/home profile but does not clear
OS keychain or browser accounts. The first-install matrix and clean OS-user/VM
requirement live in [Real Agent Onboarding](../CONTRIBUTING.md#real-agent-onboarding).
**Unproven:** fresh
OAuth through all four providers, real model replies and official update delivery
in this change. The controlled gate cannot close those evidence gaps.

**Validation:** the core gate passed all four window scenarios, 110 focused
host checks and three bundled-runtime checks. A full renderer audit passed
after the new scenario's lint fixes; the host audit's login-shell fixture was
adapted to opt out of isolation and its eight-test suite passed. Documentation,
test inventory, CI/check runners and built Electron smoke passed. A driven
macOS built-app pass opened the empty folder via the real project bridge,
selected Antigravity, reached its connection confirmation, and declined it
with the draft intact. No native provider was installed or signed in during
that pass; the native folder picker was bypassed. Relaunching restored the
project and provider choice; `--fresh` returned to Welcome and retained the
previous profile in its archive.

**First connection follow-up (2026-10-26):** explicit bootstrap now verifies
every discovered CLI before authentication and repairs broken launchers in
that attempt. The existing installer tests exercise all three native agents
with and without startup discovery; production-path fixtures run Claude/Codex
installer scripts and preserve the broken npm copies. Antigravity's unanswered
auth check offers login only when its executable runs; the chat catalog follows
that recovery action, covered by its existing adapter/connection test in the
core gate (seven checks in addition to the four window scenarios).
A driven macOS built-app pass found that Node's piped stdin makes `script`
exit with `tcgetattr/ioctl: Operation not supported on socket` before launching
Antigravity. The launcher now supplies null input to `script`, which creates
the CLI's pseudo-terminal. The existing login test now uses the production
launcher with a controlled executable, checks terminal input/output, completes
sign-in and verifies process retirement. It failed before the fix and passed
afterward. The repeated built-app pass used a private home with spaces and
non-ASCII characters, opened an empty folder through the project bridge,
started one controlled login and continued the held message exactly once to
a completed visible reply. This covers actual host/renderer/terminal wiring,
not real provider authorization; the native picker was bypassed. Fresh OAuth,
manual-code entry, real downloads and Windows/Linux runtime behavior remain
unproven by this pass.

**Owned startup probe (2026-10-25):** a real loopback fixture reproduced a
healthy service taking 450 ms per response being repeatedly abandoned by the
300 ms port probe until startup failed. `electron/main-probe.cjs` now supplies
an owned probe budget of at most one second, capped by the remaining startup
deadline; `electron/main.cjs` forwards that budget. The same fixture succeeds
with one request, while a stalled probe remains bounded and existing wrong-instance,
spawn-failure and child-exit regressions remain enforced. The Windows 2.16.14
production report had already logged listening and ended with `response_timeout`;
this is a plausible contributor, not proof of that unavailable device's cause.
Its later MFS 90-second and OpenCode 15-second startup timeouts remain unproven.
Follow-up correlation found about 116 seconds between the MFS pre-spawn log and
its ninety-second watchdog, while the first OpenCode attempt took about 33 seconds
including retirement. Those totals cannot distinguish process creation from a
late host callback. The current MFS timeout separates these intervals; OpenCode
startup results separate preparation, spawn, readiness and retirement. A
controlled clock verifies late MFS watchdog evidence through error serialization,
and the pinned native OpenCode smoke verifies a shared failed history startup,
one successful retry and separate phase timings through protocol validation.
Local isolated MFS store contention failed promptly, and a held OpenCode SQLite
write transaction did not prevent its ready announcement. These exclude those
local scenarios, not Windows-specific initialization or storage failures.
The follow-up built-host pass used a private project and a local telemetry
collector that blocked external delivery. A shortened first MFS watchdog returned
HTTP 500 with the measured phases, then the real Python daemon returned HTTP 200.
A shortened first native OpenCode deadline produced separate readiness/retirement
measurements, one linked successful retry and HTTP 200 history. The source draft
remained unchanged. Host tests (938), native OpenCode checks (3), protocol/Electron
tests (362), host/renderer types, service/renderer builds, docs/inventory and native
Electron smoke passed. The smoke again correlated three 1006 closes with an
injected network-service exit and reconnected; it does not identify the cause of
the historical macOS incident. No Windows device reproduction or new packaged
release was performed.
An isolated source Electron main launched its own host with every health response
delayed by 450 ms, reached the built Welcome renderer, and opened Settings.
Validation passed 935 host tests, 360 protocol/Electron tests, host/renderer types,
documentation/inventory checks, service/renderer builds and the native smoke suite.
The local host suite used the current Python daemon explicitly because a stale
ignored sidecar lacked current operations. Signed Windows execution remains unproven.

**Electron fuse review (2026-10-23, release validation pending):** SHA-256-verified
2.16.17 macOS arm64/x64, Windows x64, and Linux x64 artifacts all enable
RunAsNode, Node environment options, and Node CLI inspection. The
[packaging policy](release-pipeline.md#native-packaging) retains the first two
and disables Electron main-process inspection. Native regression exercises
working and blocked inspectors plus preserved Node/environment behavior.
An isolated, ad-hoc-signed copy of the published macOS arm64 app with the new
fuses passed packaged service, file, daemon, extractor, OpenCode, and stdio MCP
checks. This establishes compatibility with that published payload, not a new
release: changed Windows/Linux/Intel runtime behavior, final distribution
signatures, and packaged desktop interaction remain release checks.

**Installer CDN (2026-10-22, source deployment pending):** the
[release mirror](release-pipeline.md#installer-download-cdn) adds Cloudflare R2
delivery for website installer downloads. The mirror suite covers checksum
rejection, immutable conflicts, interrupted upload recovery and publish-last
discovery. The website's download suite covers complete-manifest validation and
CDN/GitHub failure recovery. The live R2 mirror contains all five 2.16.17
installers. Public Range/CORS checks passed for each; the Apple Silicon DMG
passed a full public SHA-256 check and returned a cache hit. A built website
preview resolved all four download buttons to the live CDN and updated their
analytics destinations. Production website deployment and the first hosted
mirror workflow run remain pending; app updates and Homebrew still use GitHub.

**Preparation storage preflight (2026-10-22):** `server/state-db.ts` checks the
actual native addon, temporary database persistence, and existing state access
before the host listens. `/api/health` retains liveness/identity and includes a
separate startup storage result. `electron/main-probe.cjs` carries an actionable
warning from the verified instance to one foreground desktop window, including
source-server reuse; background windows defer it until shown. Source failures
identify the running Node/ABI and rebuild command; packaged failures recommend
reinstallation rather than asking readers to manage Node.
`server/preparation-storage.test.ts` exercises real SQLite read/write/reopen,
injected ABI/permission/disk-full failures, corrupt/read-only existing state,
preserved cancellation records, cleanup, a cleanup failure that leaves the
result unchanged, a write lock held by another process (no wait beyond 250 ms,
with the full timeout restored for ordinary writes), and repair. `main-probe.test.cjs` drives
real loopback warning handoff while retaining identity and launch availability.
An isolated built-server runtime pass exercised healthy and injected ABI-failure
starts, project open, Markdown read, versioned save, and saved-byte verification.
A source Electron pass loaded the built renderer, intercepted one warning dialog
with recovery detail and Continue, and reached a visually inspected Welcome
window. The dialog adapter was substituted; native dialog appearance and signed
packaged execution remain release checks. Telemetry was disabled for both passes.
Validation passed the server suite (850), Electron suites (350), host types,
documentation and test-inventory checks, and the server build.

**Readiness evidence (2026-10-18):** `electron/main-probe.cjs` owns bounded fresh
loopback probes and preserves the final result, identity mismatch field, count
and timing in startup diagnostics. `main-probe.test.cjs` drives real HTTP
refusal/stall/status/JSON/identity cases and verifies timeout evidence without
weakening spawned-instance ownership. The production Windows 8.5-second listen
followed by a ten-second readiness timeout remains unexplained; the new evidence
separates its possible causes on subsequent occurrences.

**Native update timeout (2026-10-24):** the real Electron HTTP executor reproduced
an indefinitely pending metadata request despite an explicit timeout. Its
inherited Node socket timeout does not run for Electron requests. Main now
installs the response-idle deadline in `electron/updates/network-timeout.cjs`.
The registered `network-timeout-smoke.cjs` runs local HTTP through Electron net:
header and body stalls time out; a redirected, continuously progressing download
outlives the idle deadline and keeps its exact bytes; checksum rejection and
cancellation still settle. The real update manager moves a stalled download to
error, then a successful retry to ready without installing or receiving a late
timeout. This verifies native network and state recovery with controlled release
discovery, not GitHub availability or a signed-package installation. Historical
`net::ERR_TIMED_OUT` records do not identify the stalled host or network cause.
Pre-commit verification passed host/renderer type checks, 54 update tests,
358 protocol/Electron tests, documentation/inventory checks, and the built
Electron smoke including native download recovery and two-window save/install
rollback. Renderer source was unchanged.

**Diagnostic follow-up (2026-10-16):** updater regressions cover recognized network
errors inside GitHub's latest-release/feed wrappers, while certificate, integrity
and genuine feed errors remain errors; strings inside feed XML cannot downgrade
them. An isolated allowance-route HTTP regression preserves local 502 separately
from upstream 404/request ID/content type and retains nested network causes without
adding credentials or response bodies to diagnostics or the renderer response.
The production allowance 404/network failures still require upstream evidence.
Validation passed `pnpm test:updates` (49 tests), `pnpm test:agent` (345),
the allowance/indexer/telemetry/diagnostic/client-error suites (70), host types,
documentation checks and the server build. This host/main change did not include
a packaged UI pass or production diagnostic-delivery verification.

**Intel entry (2026-09-17):** macOS build and source CI include native x64,
with dual-architecture update metadata and Homebrew selection owned by the
[Release Runbook](release-pipeline.md#macos-developer-id-distribution).
`server/native-component-support.ts` limits native search/extraction on older
Intel systems without raising the application's macOS 12 minimum.
`indexer-mfs-path.test.ts` proves no daemon is spawned on an unsupported system;
`extractor-runtime.test.ts` covers no download/demand/retry there and supported
Intel offline reuse. Hosted Intel macOS 15 packaged daemon, component, and OpenCode execution passed
the [native release checks](release-pipeline.md#macos-developer-id-distribution).
Actual desktop interaction and old-OS editing remain release checks; controlled
platform substitution does not establish those.
A built-server pass with isolated app data and substituted Intel/macOS 12
identity returns the unsupported component status, opens a real project, lists
and reads its Markdown, saves revised content with a search warning, and reads
the saved bytes back while health stays available. Provider CLI execution is
disabled in this pass; it establishes service isolation, not Intel binary or
agent compatibility.

**Settings organization (2026-10-26):** Account owns identity, Google connection status, modal mailbox proof, credits and billing; Appearance and Editor split the
same persisted preferences; Agents owns runtime setup; Notifications owns delivery
preferences; General owns updates/privacy; Advanced owns optional connections.
`renderer/src/features/settings/ui/managed-settings.tsx` owns routing;
`managed-settings.test.tsx` exercises section navigation, retained editor choices,
the runtime-to-account shortcut and direct search setup. `account-methods.test.tsx`
covers mailbox proof, connection results, cancellation and failed status reads.
`account-email-dialog.tsx` shares the login modal with email sign-in verification
and Google connection proof, while `account-email-fields.tsx` owns the fields.
Settings keeps status and entry buttons only. Verification fixes the current email,
reveals the focused code after sending, and omits the Google login alternative.
Email verification uses authenticated `/api/account/email-proof` operations without
an activation flag or session replacement; the API consumes a separate session-bound
mailbox proof. Google connection proof retains its existing current-account endpoint. Tests cover
modal closure during requests, ignored late completion, reset errors/results and
the correct endpoint for each purpose. `use-appearance.test.ts` exercises saves
across pane disposal, failure rollback and queued preferences.
`server/hosted-account.test.ts` verifies authenticated proof preserves the session
and ordinary email login still refuses an already signed-in account.
`account-panel.test.tsx` covers account recovery and billing independently of
runtime readiness. `editor-panel.test.tsx` owns font and writing preference checks.
The sidebar's account-method and billing entries both route to Account. Development
revision review lives in Advanced; runtime simulators retain their separate entry.
Validation: all 12 `pnpm check:web` gates and `pnpm test:docs` passed. Focused
account tests cover the modal and sign-in paths, and sidebar/navigation
tests cover account entry. A driven built-Storybook pass showed the independent
email verification dialog above Account, with the fixed email, focused code,
trailing resend countdown, full-width Verify email action, and no Google alternative.
A macOS Electron source-development pass opened Account from Sign-in methods and
inspected Appearance, Editor and Notifications. The refreshed native window showed
the Email verification entry while the user took over. No real mailbox proof,
account disconnection or billing mutation was performed. Packaged composition and
live-provider verification remain unverified; UI proof flows and billing commands
use controlled ports in tests. Review fixes additionally passed host route and
session-preservation tests, renderer gates, host types, Electron unit/smoke checks,
and a built-Storybook mailbox-proof completion followed by a Google operation
showing its own result. The sibling API's real PostgreSQL integration suite covers
single-use mailbox proof, session/purpose isolation, throttling and unchanged
sessions. API migration 31 and its endpoints must deploy before the client;
these local checks did not deploy production or send real email.

**Settings persistence (2026-09-16):** model catalog caching uses strict
read-modify-write and remains best-effort without replacing malformed settings.
Embedding key changes retire older validations and serialize runtime changes.
The catalog and embedder route tests exercise malformed storage and a delayed
PUT overtaken by DELETE with isolated configuration and controlled validation.

**Desktop analytics:** `server/telemetry.ts` owns admission, identity, sessions,
opt-out and durable delivery; `server/telemetry-state.ts` validates envelopes and
maps PostHog payloads. `server/routes/telemetry.ts` restricts renderer intake to
renderer-owned activity. `server/hosted-account.ts` supplies verified sign-in,
sign-out and hosted subscription facts. File/project routes capture identity
before work; `file-save.ts` distinguishes unchanged saves. Renderer foreground
input is observed by `platform/telemetry.ts` through `app/composition/use-desktop-usage.ts`.
Document runtime changes and active reading-surface interaction report content-free
engagement; agent usage correlates start/terminal results with a random turn ID.
Settings General discloses account linking and the shared usage/error opt-out.

Schema 8 adds bounded cumulative delivery checkpoints in
`shared/protocols/telemetry-delivery.ts`. Renderer envelopes keep one immutable
checkpoint through retries; host admission attaches its own persisted checkpoint.
`GET /api/telemetry/delivery` exposes the newer local counters. Invalid input,
queue/rate refusal, failed storage, expiry, transport retries and permanent
ingestion refusal remain distinct. Checkpoints are not activity events and must
not be summed. Receipt-directed reset and host filtering prevent renderer
counters spanning an account/privacy transition or host replacement from being
backfilled. Missing final checkpoints remain unknown, especially after abrupt
renderer closure or unavailable storage; production PostHog receipt and Li's
reported mismatch still require actual-device evidence.
The focused host delivery/native-diagnostic/operation checks, renderer delivery
checks, protocol checks, documentation checks and builds passed. Core host checks
and the controlled bundled runtime passed. All 1,899 renderer tests and coverage
passed with native-CI concurrency and timeout settings after two tests timed out
under default concurrency. Fresh built-output Electron smoke also passed.

Renderer intake returns explicit admission receipts. Bounded renderer retries keep
one event ID/time, while Node owns short receipt deduplication and rejects requests
from before an account/privacy transition or host replacement. The telemetry route
test exercises failed storage followed by successful admission and a lost receipt;
renderer tests cover transient refusal, retry exhaustion and per-turn ordering.
The core gate, focused telemetry/native-diagnostic suites, affected renderer tests,
formatting/lint and documentation checks passed. These checks use controlled
transport and do not establish production delivery.

`server/telemetry.test.ts` covers anonymous-to-account links, restart continuity,
logout/direct account switching, delayed outcomes, offline queue replay, stable
UUID/time/version, retryable/permanent refusals, batching with single-event
isolation of a refused batch, delivery after a three-week absence, core activity
and operation results admitted through diagnostic bursts, capacity/expiry, corrupt config,
opt-out cancellation, active days without restart, session expiry and subscription
poll suppression. Its subprocess routes delivery through a local native relay with a replaced
upstream (direct Node fetch fails the test) before importing the
production owner and exercises source, Vite-development and packaged collection,
distribution attribution, opt-out, and Electron's test-suppression environment.
Node, Vitest, Jest and `NODE_ENV=test` markers suppress both distributions,
including inherited packaged flags, without changing saved preferences.
Offline replay, turn recovery and native-diagnostic tests verify the originating
distribution survives a later host running through the other distribution.
`server/telemetry-environment.ts` shares runtime admission with Electron/MCP native
diagnostics; the isolated host-test fixture suppresses descendants as well.
Renderer telemetry tests exercise trusted foreground input, quiet background days,
listener disposal, bounded edit reporting and refusal of host-only facts.
Document lifecycle tests distinguish editing from reconciliation/no-change callbacks;
agent usage tests cover correlation and terminal coalescing. All collection tests
use isolated configuration and fake/local transport, never production PostHog.
`server/hosted-auth-transport.test.ts` limits the relay's usage route to its fixed
destination, and `electron/account/auth-network-smoke.cjs` proves in real Chromium
that usage batches follow the PAC-selected proxy (the proxy refuses the tunnel).
On 2026-10-30 these suites, `pnpm check`, Electron boundary tests and the built
Electron smoke passed. Production PostHog receipt through a real user proxy
remains unverified.

On 2026-10-22, the telemetry/native-diagnostic/account suites (69 tests), host and
renderer types, documentation checks, service/renderer builds, Electron boundary
tests and built Electron smoke passed against the updated main branch. The
2026-10-21 driven source Electron window used the real main/preload,
built renderer and built host with isolated settings and intercepted capture
transport; native-main collection was suppressed separately. Welcome startup and
trusted input produced `source` events. Settings opt-out cleared identity/queue
and stopped collection; re-enable resumed input collection under a fresh anonymous
identity after the normal minute suppression window. This does not establish
production PostHog receipt or a Vite-HMR desktop pass.

Diagnostic serialization is shared in `shared/protocols/diagnostics.ts`; host/renderer error
adapters feed the same collector. Tests cover bounded causes/codes, unquoted private
names, stack paths, non-JSON asset failures and HTTP response failures without
request payloads. Diagnostic tests also cover separate warning/error severity,
counted repeats, shutdown queueing, and account identity across a switch; the
updater test covers one original report across an emitted and rejected error. Known gaps:
real PostHog person-merge/deduplication behavior has
not been exercised with this schema, signed multi-window account changes remain a
packaged check, and bounded delivery cannot prove all real-user activity. Silent
reading is unobserved; completed turns do not establish usefulness; subscription
observations do not establish new payment revenue.

On 2026-10-12, `pnpm check` passed the complete source gate, including the built
Electron smoke that drove a two-window update save, delayed install and rollback.
That run disabled telemetry before launch and establishes updater recovery, not
production diagnostic delivery or a packaged N→N+1 update.

**Detailed diagnostics (2026-10-12):** schema 4 preserves bounded original errors,
unknown codes, cause chains, stack frames and process output with targeted
credential filtering. HTTP request IDs, agent turn IDs and setup attempt/retry
IDs connect outcomes with their failure details. Native updater, startup and
process failures spool for later host delivery. Collector and spool tests cover
retry/restart, original occurrence/version, opt-out, credential filtering and
account changes; renderer tests cover bounded delivery and component/resource
context. Production PostHog receipt and every possible provider error shape are
not established by these controlled tests. Native startup errors require a later
healthy host; queue/rate/expiry limits still permit loss.

**Response diagnosis (2026-10-13):** renderer HTTP regressions exercise an
original JSON parse failure through the files adapter and distinguish requested
body cancellation. Host tests join the returned request ID to its diagnostic.
The broker's real loopback tests preserve response bytes while observing unknown
finish, malformed framing, in-band provider errors and a reset after streaming;
conversation content and credentials are excluded and traces reset on new turns.
The panel regression carries native completion metadata and an upstream cause
through turn-scoped telemetry. These controlled tests do not recover old events
or establish production-provider root causes.

The built-source macOS runtime was driven through Settings and an actual
renderer error event with isolated configuration and collection disabled. Its
local HTTP diagnostic retained the original code, nested provider status/request
ID and stack while filtering a fixture credential. The settled Settings surface
was reviewed by eye. The generated MCP launcher was also run as a real subprocess
against the built entry with host-pinned consent/spool locations: malformed JSON
produced a protocol diagnostic and initialization still succeeded; opt-out,
startup suppression and malformed configuration each produced no diagnostic.
These fixtures establish the local paths, not production ingestion. The complete
renderer gate, affected host suites, native OpenCode fixture, Electron boundaries
and built cross-process smoke passed. Host startup/crash diagnostics additionally
retain the final bounded 8 KB of the Electron-managed service log when the host
collector cannot initialize.

**Update connectivity diagnostics (2026-10-14):** `electron/update-manager.cjs`
reports recognized offline, network-change, suspended-network and DNS failures
during checking as warnings. `server/native-diagnostics.ts` preserves severity
and replays the spool in occurrence order; `server/telemetry.ts` counts identical
native check warnings in hourly windows with original identity/version/time.
Updater tests cover emit/rejection deduplication, retry/recovery and retained
download/install/certificate/integrity errors. Native diagnostic tests exercise
hourly aggregation, offline replay, shutdown/restart, account changes and opt-out.
These controlled failures do not establish the cause of a user's network outage.
A macOS Electron runtime pass used an isolated network session to trigger three
real Chromium DNS failures, observed one immediate warning and two queued repeats,
then recovered against a local update feed. The production update manager, built
native spool and bundled collector ran with isolated configuration and replaced
telemetry transport. Updated host tests, type checks, update contracts and real
Electron lifecycle smoke passed; Windows packaged networking remains unverified.



A 2026-10-09 built-source desktop pass used an isolated application/profile,
temporary project and intercepted outbound transport. Native document editing
and saving emitted foreground, engagement and changed-save events. Settings
showed the account-linking disclosure and one shared switch. After disabling it,
another edit saved successfully while capture count stayed fixed; persisted
analytics state contained only `enabled: false`. Captures contained neither the
fixture text nor its path. The complete renderer gate, host boundary suites,
types, services build and real Electron smoke passed. This local sink establishes
desktop wiring, not provider ingestion or signed-package identity merging.

**Resident update checks:** `electron/update-manager.cjs` owns startup, 15-minute
checks and a shared five-minute foreground/wake throttle. `electron/main.cjs`
binds native focus and power-resume events. Manager tests cover discovering a
release without restarting, concurrent windows, in-flight announcements, opt-out,
manual override, disposal and explicit-only installation. Ready-state regressions
cover timer/foreground replacement across several skipped releases, same-version
download reuse, and a restart that refreshes and downloads the latest release
before saving windows. Failed refreshes return a disclosed ready offer without
installing; an explicit restart from that warning retains the existing offline
installation choice. Failed replacements, concurrent restart clicks,
download-event/promise ordering and disposal cannot silently install a stale offer.
A 2026-10-27 isolated macOS Electron pass used the installed MacUpdater and its
HTTP executor, metadata parsing, checksum/cache handling and native proxy with a
local feed. A ready 2.1.0 download was replaced by 2.4.0 without installation;
the restart refresh fetched 2.7.3 and handed only its bytes to the controlled
native installer once. The built two-window smoke also passed save barriers,
delayed handoff and failure rollback. Feed publication and native installation
were controlled; no installed application was replaced.
Real multi-version package replacement and post-update provider/session reuse
remain unverified for this change; actual package updates remain the release
checklist's platform-specific evidence.

The Linux deb install path defers relaunch until the owned server exits;
packaged startup also waits for a compatible previous server to release its port
before spawning the replacement. `electron/update-install-strategy.test.cjs`
checks the install/quit order and `electron/main-probe.test.cjs` checks the port
handoff and bounded failure when the previous instance stays live. These
controlled ownership tests do not establish an actual Linux package replacement.
The 2026-10-12 built Electron smoke passed the real two-window save barrier,
delayed native updater handoff, and rollback; it did not replace a Linux package.

A later 2026-09-15 source-desktop startup pass used an empty temporary HOME and
isolated profile, with any application access to Electron safeStorage made fatal.
It reached the real welcome screen, showed no statistics banner, and exited
cleanly. This proves the source startup path no longer needs OS key storage;
it does not establish the next signed installer or third-party agent login UI.


**Intent:** [J01](../design-docs/journeys/README.md#j01-complete-onboarding-and-reach-first-value).

**Implementation:** Renderer: `renderer/src/app/bootstrap/startup.tsx`, `renderer/src/features/workspace/ui/welcome.tsx`.
Host/services: `electron/main.cjs`, `server/folder.ts`.

**Status:** Release-dependent.

- **Contract Test:** startup ownership/readiness, native activation and window
  isolation, empty-home startup/registry/restart, Settings persistence, account entry,
  agent preparation, and update state/authorization. Entry points:
  `pnpm test:renderer`, `pnpm test:server`,
  `pnpm test:updates`, `pnpm test:electron`, and `pnpm test:electron:smoke`. Key persistence survives daemon reconfiguration
  failure; these tests do not prove rollback of saved configuration.
  `scripts/electron/dev.test.mjs` builds real boundary sources in an isolated
  fixture and loads them in a substitute desktop child, covering missing/stale
  development output and refusing launch after a build failure. It does not
  establish native Electron or renderer behavior.
- **Driven Runtime Pass:** a 2026-09-16 isolated built-server pass verified that
  first launch creates an empty default home and no project membership; restart
  preserves existing unregistered files, and explicit open registers only the
  requested project. `server/folder-startup.test.ts` owns these startup
  regressions. This pass does not establish packaged Welcome composition.
  Earlier isolated macOS built-app passes cover Welcome/Recent,
  independent windows, orphan recovery,
  delayed-start activation, save-refused quit and later reopen,
  and theme writes. OS URL registration/key protection are substitutes.
  Account identity/menu is tested; a seeded session did not prove live sign-in.
  A 2026-09-15 isolated Chromium pass renders the server-owned sign-in success
  and failure pages in light and dark modes, with visible return buttons and
  no horizontal overflow. Screenshots verify composition; this pass does not
  exercise a real OAuth provider or native protocol handoff.
  A built-server delayed fake-Codex pass (2026-09-15) kept health requests
  responsive and issued one probe; it proves liveness, not a model turn.
  The development tools dialog triggers a preview in the sidebar footer.
  `sidebar-update-preview.test.tsx` covers developer-dialog dismissal, footer placement,
  inert preview installation, and restoration of real update actions.
  `update-preview.test.tsx` covers selecting a state before starting the preview.
  An isolated Electron/Vite pass (2026-09-15) opens the developer controls,
  starts the default ready-to-install preview, and visually verifies the card
  above Gallery in the expanded sidebar with Settings closed. Clicking the
  preview's restart action leaves the window running; the close icon removes the preview.
  Controlled updater passes cover a found release downloading in the background
  and waiting at ready until an explicit restart, dismissed notices, Settings
  actions, native input locking, save barriers, and handoff failure rollback,
  not replacement. A built-app pass (2026-10-17) set main's development update
  simulation through the window's preload bridge: available and downloading left
  the sidebar footer empty, ready showed Restart to update above Gallery, and
  clicking it left the unpackaged window running.
- **AI Eval:** first-discussion quality belongs to J10; retrieval quality to J05.
- **Release Check:** signed/notarized first launch, offline startup, actual
  native picker, first-session-to-returning-session flow, and N→N+1 updates on
  supported platforms.
- **Gap:** no full pass demonstrates understanding local/derived/hosted data,
  entering an empty project, useful brainstorming, and returning without
  unnecessary onboarding. Real update download, replacement, and relaunch remain
  unproven by controlled handoff; unpackaged builds report unsupported.
- **Appearance at launch (2026-09-27):** Electron main keeps the last applied
  appearance beside the workspace session, sets `nativeTheme` and the
  spellchecker before the first window opens, and hands the record to each new
  window, which applies it before its first render. The window background,
  native chrome, theme tokens, fonts, and sizes therefore match on first paint.
  `electron/window/appearance.test.cjs` covers restore, refusal, spellcheck, and
  repaint; `electron/renderer/runtime.test.cjs` covers the first-paint argument;
  `use-appearance-surface.test.ts` covers handing each applied record to the desktop.
- **Appearance customization (2026-09-27):** themes, fonts, reading layout,
  page texture, reduce motion, and editor aids. `shared/protocols/http/appearance.test.ts`
  holds every theme to WCAG AA text contrast; `server/routes/appearance.test.ts`
  covers persistence, per-field fallback, and refusal of font names that could
  escape CSS; `electron/text-services/text-services.test.cjs` covers font listing,
  capability refusal, and the spelling menu; `appearance-panel.test.tsx`, `editor-panel.test.tsx`, and
  `writing-aids.test.ts` cover the Settings rows, font picker, word count, and
  focus-mode marking. `appearance-menu.test.tsx` covers the page texture write,
  the note that grain shows only on light pages, and filling, keeping and
  reopening the menu's custom font. The painted textures are
  stylesheet-only (`markdown/document.css`); an isolated built Electron pass
  (2026-11-06) captured None, Dots and Grain on White and Paper in light and
  dark. **Gap:** font enumeration on macOS and Windows and native
  spellcheck suggestions are unproven by a driven pass on those platforms.
- **Sign-in recovery (2026-09-15):** `settings/hooks/account-context.tsx` owns
  one browser wait shared by sidebar, composer, and Account Settings.
  `use-account.test.ts`, `account-panel.test.tsx`, and
  `app/composition/layout/workspace-sidebar.test.tsx` cover read failure/retry,
  duplicate command suppression, shared waiting across Settings reopening, and
  stopping local polling. `server/hosted-account.test.ts` and
  `server/account-route.test.ts` cover transient refresh preservation, confirmed
  revocation, stale refresh isolation, late OAuth after sign-out/new attempts,
  and callback/native-return contracts. These focused suites pass 45 tests.
  An isolated built Electron pass with controlled account responses exercises
  initial-read retry, shared waiting, Settings reopening, and Stop waiting; native
  boundary smoke also passes. Host/renderer types and builds pass. The full renderer
  gate encountered the existing 401-line file-tree limit and a J07 test timeout
  (its focused rerun passed); the new duplicate lifecycle check was removed and
  duplication passed on recheck. Real Google/Supabase login and packaged protocol
  handoff remain unproven.

**Desktop sign-in proxy recovery (2026-10-18):** Auth requests now use
`server/hosted-auth-transport.ts` and the private
`electron/account/auth-network.ts` Chromium relay. `hosted-auth-transport.test.ts`
covers fixed-target authority, request/response bounds, exchange/refresh/profile/
logout, provider refusals, cancellation, shutdown and no direct fallback.
`hosted-account.test.ts` reproduces the callback's former generic `fetch failed`
and checks DNS, reset, certificate, proxy and timeout explanations without
credentials. The native `electron/account/auth-network-smoke.cjs` exercises real
Chromium PAC-selected HTTPS CONNECT and a proxy change to an unavailable listener.
An isolated built-host/Electron pass used a local TLS Auth fixture and CONNECT
proxy: PKCE completed, a later rejected tunnel produced the specific callback
error, and the prior session survived. The rendered callback was inspected in a
browser; the full diagnostic and return button fit the card. These controlled
fixtures do not establish live Google/Supabase login, authenticated corporate
proxies, OS settings on Windows/Linux, or the reporting user's network.

**Email login and explicit linking (local, unreleased):**
The shared account dialog provides in-app email OTP login and sign-in method
management. The host owns email flow retirement and durable sessions; its focused
checks exercise cancellation after verification and safe renderer state. API
integration tests use real disposable PostgreSQL and captured delivery, exercising
single-use codes, expiry/attempt limits, failed delivery, retained identity/customer
association, Google protocol linking, conflicting identities, disconnect and revoked
link sessions. Google responses in these tests are fixtures, not real consent.
A driven built-renderer/host/Electron relay pass completed in-app email login
against that local API and retained the original UUID and Plus subscription.
The website dialog completed email login and explicit Google fixture linking;
website logout left the desktop session active. Both dialogs were visually
inspected. Production email delivery, live provider linking and packaged upgrade
behavior for this change require release verification. Regression checks also
cover browser-launch failure recovery, explicit connect/disconnect intent, and
retired website polling responses. Desktop dialog regression checks also cover
returning to a completed overview after Google connect/disconnect, hiding the
spent-code countdown there while preserving the send limit for a new change,
and opening sign-in methods without implicitly starting verification. A built
Storybook browser pass checked the overview and explicit entry to email
verification; it used fixture account ports, not a live mailbox or Google consent.
The email-code step has a dedicated Story for accessibility and visual review.
Dialog tests exercise code focus, the directly editable destination and Google
alternative, and changing the email with the old attempt retired.
A browser pass through the email-code Story inspected both light and dark
layouts and confirmed the expanded fields and inline resend control. Direct
email-edit regression checks cover retiring the old attempt and preserving the
resend cooldown.

**Better Auth client integration (2026-10-21, local only):**
`server/hosted-account.ts` now uses the API's PKCE desktop transfer, opaque host
session, cookie-free native relay, and short-lived API JWTs. Its focused tests
cover exchange, renewal, revocation, stale refreshes, post-exchange sign-out,
legacy-token refusal, profile failure and safe renderer state. The native PAC
smoke passes against the new fixed API host. An isolated built-host/Electron
runtime pass used the actual API with disposable PostgreSQL and a Google protocol
fixture: login completed through the real loopback route, the imported UUID kept
its Plus subscription, an expired JWT renewed the database session, and sign-out
revoked the JWT. The website passed its own Google-button/callback, reload,
session-renewal, subscription and logout flow against that same local API;
website logout left the independent desktop session active. No production state
was changed by that local pass.

**Production desktop authentication verification (2026-10-21):** An isolated
profile of the released macOS 2.16.14 app completed a fresh real Google login
through Supabase after new Supabase sign-ups were disabled. Its refreshed
session retained the original imported user ID and active Pro subscription.
The updated source Electron app with its built renderer completed real Google
login through the production Better Auth API and loopback callback, retained
the same user ID, subscription period and cancellation state, and renewed its
API JWT through its opaque desktop session. Only the isolated profiles' local
expiry timestamps were expired to exercise renewal; production subscription,
credits and session expiry were not edited. Test telemetry was disabled.
The new desktop kept its signed-in account and Pro state after a full restart;
the rendered Sign out action returned the app to its signed-out state.
Existing users can continue signing in on old releases while the API accepts
Supabase sessions. New users need the updated client. The 2.16.15 upgrade notice
asks users to sign in again with their original Google account; this rollout
does not force an update. Packaged 2.16.15 installation, OS protocol return and
cross-platform manual checks remain separate release evidence.

**Development callback return (2026-10-21):** A source launch registered generic
Electron as the `stashbase://` handler, then the callback opened that scheme.
On macOS the additional project argument is not supported, so this could open
Electron's default page. `multi-window.test.cjs` now exercises the entrypoint's
registration and proves source launches leave the OS handler untouched while
packaged launches register it. `hosted-account.test.ts` verifies source callback
pages contain neither a protocol link nor redirect/close script, and retain
manual return guidance. Packaged callbacks retain their authenticated native
acknowledgement and fallback button. These regressions do not substitute for a
real packaged OS protocol handoff. A real Google sign-in in an isolated source
Electron profile then passed: the browser visibly retained its success page
and manual return guidance, the existing desktop showed the signed-in account
and active Pro subscription, and no generic Electron page opened.

## J02: Folder

**Intent:** [J02](../design-docs/journeys/README.md#j02-add-and-open-a-folder).

**Root landing page (2026-10-29):** App composition's
`use-document-workspace.ts` opens root `index.html` as the initial preview when
no tabs are restored and no document navigation has started. Its composition
tests cover delayed listings, restored work, nested-only and empty projects,
unreadable files, and no reopening after closure or refresh; `app.test.tsx`
exercises the tab and Files selection in the mounted shell. An isolated macOS
Electron source pass visually confirmed the HTML preview, closure through a
focus refresh, kept-tab restoration, and no default for a nested-only project.
Packaged and Windows/Linux behavior remains unverified.

**Implementation:** Renderer: `renderer/src/features/workspace/hooks/use-project-entry.ts`, `renderer/src/features/workspace/hooks/use-project-entry-receiver.ts`, `renderer/src/features/workspace/ui/sidebar.tsx`, `renderer/src/features/workspace/application/open-folder.ts`, `renderer/src/features/workspace/application/remove-folder.ts`.
Host/services: `server/folder.ts`, `server/github-import.ts`, `server/project-file-mutations.ts`, `electron/window-restore.cjs`.

**Status:** Partial and release-dependent.

- **Launch reopens the last projects (2026-10-18):** main records the projects
  its windows show and reopens them, one window each, through the project-entry
  claim. `electron/window-restore.test.cjs` covers the record's round trip and
  damage, failed writes, focus order, the last-closed stand-in, window reuse
  after a refused entry, and Welcome when nothing reopens. Four isolated macOS
  built-app launches (scratch HOME and userData, port 8097) verified: two
  project windows recorded with the focused one last and kept through a real
  `app.quit()`; the relaunch reopened both, the second window restoring its
  open document tab; closing both windows with the app running kept the last one
  closed, which the next launch reopened alone; with that folder deleted, the
  launch stayed on Welcome, Recent kept the row, and the record cleared. An
  update installation closes windows through Electron's installer before
  `before-quit`; main's gate that keeps the record then (the update barrier
  being active) has no test and was not driven, since no real update was
  installed. Windows briefly show
  Welcome before their project enters. After integrating the 2.16.10 mainline,
  the complete source gate passed (the renderer size violation was corrected
  and its affected gates rerun). A fresh isolated macOS built-app pass on port
  18111 opened a disposable project with the native folder picker, opened a
  kept Markdown tab, quit cleanly, and restored both project and tab on relaunch.
  Telemetry reported unavailable, and both exits released the test port.

- **Sidebar project switcher (2026-10-14):** the folder header's name opens a
  menu of recent projects plus Open, Create, and Import from GitHub, driving the
  window's shared `useProjectEntry`; the leading folder glyph owns the fold.
  `sidebar.test.tsx` covers the routing to entry, the current project as a
  no-op, same-name disambiguation, the failure line, and Show in Finder
  revealing the current project (with its failure line). `routes/project.test.ts`
  refuses to reveal an unregistered or missing folder; a successful reveal
  opens the OS file manager and is not exercised by any test or driven pass. An isolated macOS
  built-app pass opened a seeded project, chose another recent project from the
  switcher, and got a second window on it while the first kept its project and
  closed the menu. Open, Create, and Import through the switcher reuse the
  entry flow's existing evidence and were not driven again.
- **Linux project entry (2026-10-13):** Main windows now keep the native menu
  visible on Linux, exposing File → New Window from an occupied project. The
  Electron menu contract covers this chrome option and the New Window action;
  a packaged Linux desktop check remains needed to confirm the painted menu.
- **Contract Test:** `pnpm test:renderer`, `pnpm test:server`, and `pnpm test:electron` cover asynchronous
  open/commit, cancellation, GitHub staging/publication rollback, project
  retirement, retained nested projects and preparation, and distinct path
  whitespace/case/Unicode identities. Scoped HTTP/agent regressions now preserve
  a trailing-space project through reads, saves, and index status. Shared entry
  tests cover copy/entry retry separation, explicit folder conflicts, cancellation
  before late results, retained Recent records, receipt recovery, and workspace
  readiness. GitHub/Gallery acquisition now uses file snapshots; the J13 archive
  tests own transport/extraction evidence. Native tests cover Welcome reuse,
  self/peer focus, occupied-window
  isolation, serialized allocation, and stale acknowledgements.
- **Driven Runtime Pass:** isolated macOS built app/server (2026-09-14): existing
  open, failed-open retention, alias focus, empty creation, duplicate rejection,
  registration without unrelated window rebind, and a real
  shallow `octocat/Hello-World` clone. Picker selection/creation, URL registration,
  and key protection are substituted. The Git pass does not prove background
  listing/index completion. A 2026-09-15 built-service HTTP pass with the real
  Python/MFS daemon additionally preserved a trailing-space project through
  open/read/save/search and rejected a save from another window request scope.
  This is API evidence, not a new full UI pass; desktop control permission was
  unavailable during the v2.7.0 retry. An isolated built-renderer Electron pass
  (2026-09-15) drove real pointer input across a Welcome recent row: the drag
  selected the project's name and path and sent no open request, a plain click
  still posted `/api/projects/open` for that path, and the row's remove control
  faded once the pointer left instead of standing on an untinted row.
  A further isolated built-app pass (2026-09-15) exercises Open, Create, Recent,
  GitHub Import, and Gallery Copy through the shared entry flow. Welcome is
  reused; self/peer requests focus the existing project; an occupied source
  keeps its project while a new window opens. A real shallow `octocat/Hello-World`
  copy survives an injected handoff refusal, and network observation confirms
  Retry sends no second import POST. Explicit Open existing folder resolves the
  Gallery destination conflict. System picker choices and Gallery index bytes
  are controlled; source/server builds and native window routing are real.
- **Boot and open reconcile pass (2026-09-21):** an isolated macOS built app
  with a real Python/MFS daemon and no embedding key started with two registered
  projects. Boot bound both and reconciled neither: the server log held no
  project reconcile, and the project that was never opened still reported zero
  documents at exit. Opening the other through a window-origin
  `/api/projects/open` reconciled its 300 Markdown sources in about four
  seconds, and a concurrent window-origin request loop saw no response slower
  than 22 ms across the first second and a half of it. This is API evidence
  from the desktop window's origin, not a UI pass, and it does not establish
  behavior for large mixed-format folders or with an embedding provider.
- **AI Eval:** not required.
- **Release Check:** real OS folder picker, file drop, and packaged public Git import.
- **External tree refresh (updated 2026-11-02):**
  `renderer/src/app/composition/folder/use-folder-refresh.ts` refreshes the active
  listing on every window focus before throttling explicit-folder reconciliation.
  One five-second listing poll also discovers external changes while the page
  stays visible; hiding pauses it, and becoming visible refreshes immediately.
  Polling never starts search reconciliation. `use-folder-focus-refresh.test.tsx`
  covers additions/renames/deletions without focus, quick returns within the sync
  throttle, hidden/visible transitions, shared slow reads, sync failure,
  project switch/closure, late success/failure completion, and timer/listener cleanup.
  Scope retirement aborts the focus request so a retired project's failure cannot
  replace the current project's notice. An isolated macOS Electron pass against
  the source host and renderer observed real external additions, renames and
  deletions within the next listing poll, with no focus events. The open Markdown
  document and its unsaved text survived every update; the test held its save
  request so disk bytes remained unchanged. Repeated synthetic window-focus
  events refreshed a new file during the sync throttle without another sync.
  The rendered tree and retained draft were visually checked. Native Windows
  external edits, physical rapid app switching and packaged behavior remain
  unverified. The earlier focus-refresh regression was
  reproduced in the running macOS app: `li-kb/journal` existed on disk and in
  the host listing, but the Files tree retained its earlier three entries.
  A built macOS runtime pass opened a temporary project and kept its Markdown
  document open. After external additions and native window switching, the host
  logged reconciliation of the new source; both the accessibility tree and a
  screenshot confirmed the new directory, empty directory, and binary in Files
  with the original document still open. Rename/deletion coverage is automated;
  real-provider indexing quality and large-project reconciliation cost remain unproven.
  A 2026-10-09 integrated built-app pass repeated external directory/source and
  empty-directory additions with a Markdown document open. Hiding and returning
  to the isolated macOS window refreshed Files and retained the open document.
  The 20 focused refresh/preparation tests, all 12 renderer gates, host types,
  Electron contracts, and documentation validation passed after adding failure
  retirement on project switch and closure.
- **File import (2026-09-16):** Files exposes `FileImport` through
  `useFileImport` and `createUploadAdapter`. The file tree's empty-space context
  menu offers Import files; no idle import row precedes the file list.
  `file-import.test.tsx` exercises menu-to-picker wiring and pending/completed
  feedback alongside an existing file listing. Picking files copies them into the
  captured project root; a drop lands in the folder the tree resolves under the
  pointer (see J03's move by drag). Partial results retain successful paths
  and allow retry of refused files only, into the same folder; lost responses
  require checking the refreshed listing. Adapter/hook tests cover partial retry and project retirement.
  An isolated built Electron pass supplies browser File objects through the input
  and a DOM drop, verifies actual server publication, preserves a colliding source,
  and observes confirmation/tree refresh. The context-menu follow-up also verifies
  chooser activation and visually checks the idle list without an import row.
  The native OS chooser/drop remains a release check.
- **Gap:** no cross-platform atomic no-replace directory publication primitive;
  concurrent user additions/edits must survive rollback. See
  [File Transactions](architecture.md#import-publication).
  Cross-platform native-picker and signed-installer validation remain release checks.

## J03: Documents

Host text saves now start the same restricted write diagnostic trace described in
[J07](#j07-converge). This observes the existing source/version transaction and
keeps its original permissions and save result; it does not add source reads.

**Files follows the open document (2026-11-05):** App composition's
`use-tree-follows-document.ts` calls the workspace runtime's `revealPath` when a
document from this folder comes in front. `domain/workspace.ts`
(`revealTreePath`) selects the row, opens its folders and leaves a
`pendingReveal` naming the folders it opened. Workspace UI's `file-tree-page.ts`
owns the rendered page and takes the request up: it extends the page to the row,
waits for a listing that does not show the file yet, and waits for a hidden
Files pane through a `ResizeObserver`. It then scrolls with `block: 'nearest'`.
Rows carry a scroll margin equal to `--scroll-fade-size`, and groups the reveal
opened skip their opening animation, so the scroll lands on the row's final
position. `workspace.test.ts`, `use-tree-follows-document.test.tsx` and
`file-tree.test.tsx` cover ancestor expansion, page extension and the wait for a
newly listed file. An isolated macOS Electron source pass (renderer through
Vite) opened deep files with Quick Open, Back, from behind Document outline and
from Chats mode. Each time the folders opened and the row was selected and fully
visible. A folder folded by the reader stayed folded. A chat file link uses the
same `openSource` navigation but was not driven with a live agent. Packaged and
Windows/Linux behavior remain unverified.

**Math source preservation (2026-11-02):**
`shared/runtime/markdown-math.ts` tokenizes formulas before Markdown consumes
TeX escapes and retains source positions. Documents' `ui/markdown/math.ts`
keeps complete inline source where dollar delimiters overlap ordinary Markdown;
`math-prose.ts` presents ordinary formatting with the existing parser and schema,
and `math-commands.ts` routes formatting through existing editor transactions.
The existing math/source-save tests cover braces, matrix row separators, literal
escapes/entities, typing, paste, save/reopen, untouched blocks, code, and repaired
delimiters. Focused prose/command checks cover formatting across price delimiters,
links/images, existing link-edit controls, formatting shortcuts and caret typing;
clipboard references, paragraph joins and block-prefix input retain source
meaning. A built macOS Electron pass verified rendered TeX braces and matrix row
separators, literal inline code, normal bold text across prices, a save
changing only the edited paragraph and reopening the saved file; that pass
predates the single-dollar rule below. The rendered document was
visually inspected. These checks do not establish external clipboard
interoperability or packaged distribution behavior.
Documents' `ui/markdown/math-blocks.ts` now presents block formulas without code
chrome, retaining the native CodeMirror source editor while the caret is inside
the formula. `document-input.test.tsx` exercises default disclosure, read/write mode
transitions without saves, ordinary code isolation, source edits, closing and
reopening source with arrow keys, and Undo/Redo from both the source and the
collapsed formula. A Storybook-in-Electron pass of the math workflow composition
checked clicking in and out, arrowing through consecutive formulas with only the
caret's formula open, and Escape. `math.test.ts` covers restored
native input after a formula receives an external source update while reading.
An isolated macOS Electron source
pass visually checked fractions, integrals and matrices in narrow and wide panes,
compact spacing and wrapped long TeX source. It verified byte-identical mode
toggles, native keyboard edits, Undo/Redo after closing source and changing mode,
and the saved formula after reopening. A follow-up external file update while
reading retained the same editors, refreshed the formula and allowed native
input and saving on return to editing. This is source-runtime evidence, not
packaged distribution acceptance.
The shared Chat-to-document fixture and save/reopen evidence are owned by
[J07](#j07-converge).

**Single-dollar rule (2026-11-02):** single-dollar
math follows `dollarOpens` / `dollarCloses` in Chat and Documents. Transcript
Markdown tests cover prices, ranges such as `$50-$100`, a price beside a formula,
spaces inside the dollars and a digit after the closing dollar. `math.test.ts`
covers the same text opened and typed, bold typed after a price, and Show as
text / Show all as text with one Undo, for opened and typed formulas. The Chat
to Documents workflow keeps unescaped prices as text in both surfaces and on
save. An isolated macOS Electron source pass (renderer from the working tree
through Vite) opened a note with prices, `$HOME/$PATH` and two formulas: prices
stayed text, the caret in the misread formula showed the offer above it in light
and dark themes, and Show as text saved `\$HOME/\$PATH` with the other formulas
intact. Packaged distribution behavior is not established.

**HTML engagement:** native `electron/window/lifecycle.ts` input-presence events
cross the narrow window preload/adapter without keys, positions or document
content. The active reading surface credits only its focused iframe, with pointer
hover checked for pointer/wheel input. Application composition counts foreground
app activity through the same native subscription. Authored scripts and frame
messages cannot manufacture this input signal; sandbox permissions are unchanged.
The macOS built Electron smoke exercised first-click focus, keyboard, wheel,
adjacent-pane exclusion, synthetic input refusal and disposal against the real
opaque frame. Mounted HTML activity and existing form-data tests passed in a
focused rerun. Windows/Linux input behavior and production event receipt remain
unverified.

**Interactive-note creation (2026-10-28):** New tab offers text and interactive
notes. Workspace reuses Markdown creation for text and calls
`server/interactive-note.ts` for an exclusively owned directory containing
`index.html` and an `assets/` directory with initial JSON data. The generated title/body form uses the shared
data bridge. The existing shell composition scenario exercises both entries;
host checks cover concurrent names, existing-content preservation, traversal and
symlink refusal, partial-failure cleanup, and operation receipts. Data-session
checks cover hidden drafts, directory rename/rebind, and save/release. An isolated macOS Electron source pass created both note types through New tab,
renamed the new note directory, entered and saved English/Chinese content using
native input, confirmed no JSON tab
opened, and restored the saved content after renderer reload. The New tab and note
were visually inspected. A pre-release source pass also verified the current
starter's automatic saving, restored the values after renderer reload, and
retained them through a live HTML-change remount. Packaged Windows/Linux behavior
remains unverified.

**HTML form data (2026-10-28):** Source HTML receives `stashbase.data.load`,
`update`, and `save` from `server/html-data.ts`. `application/html-data-session.ts`
and `html-data-documents.ts` bind an explicitly named JSON under the page's
`assets/` (or its same-stem sibling for no-argument calls) to a shared background
document. Loading data does not open a JSON tab; explicit opens and conflict
recovery reveal that same runtime. The frame bridge requires source identity and user activation for
changes; ordinary project/version checks remain at the file owner. Activated HTML
frames are retained across navigation; HTML changes remount bound forms too.
Focused session and mounted-workspace tests cover autosaved updates, shared drafts,
source preservation, first create, close/release refusal on conflict, stale editor
updates, pending-save edits, source disposal, and cross-project refusal.
Saved JSON edits and active-preview disk refreshes remount the HTML without an
extra data-file label; the form's own writes keep its frame. Session and mounted
tests cover reverse refresh, malformed JSON, reads racing pending input, and
reopening a JSON editor with a retained query cache after a form refresh.
Host tests exercise client injection and absent-version no-clobber writes. An isolated
macOS Electron source run loaded the API before an early authored script,
loaded a real JSON sibling, accepted native input, left disk unchanged until
Save, preserved an untouched numeric lexeme, automatically reflected an external
JSON edit without a data-file label, and recovered the saved value after renderer
reload. The rendered form was inspected by eye. The later pre-release Electron
pass above exercised autosaved updates, the starter's automatic save, and
HTML-change remounts. Packaged and Windows/Linux form flows remain unverified.

**Authored HTML fidelity (2026-10-28):** `server/html.ts` no longer replaces heading
ids with `h-N`, which broke scripts and in-page links addressing their own heading
ids; no outline or other caller consumed them. The scrollbar style and data client join
existing lines. `server/html.test.ts` covers unchanged authored ids and matching
line numbers; a real authored page in Electron remains unexercised.

**Preview fonts and save-conflict reporting (2026-10-27):** the renderer-origin
policy admits opaque-origin GET/HEAD only on scoped resource routes. Route tests
load a font with `Origin: null`, refuse unregistered folders and API/write access,
and preserve the exact application-origin checks. The Electron request smoke
loads a real font inside an opaque HTML iframe and verifies that API access is
still denied. Versioned-save coverage checks HTTP 409, preserved external bytes,
and a `conflict` telemetry outcome for stale source versions.

**Tables: CSV/TSV and XLSX (2026-10-23):** `csv` is a viewer format of its own
(`shared/file-formats.ts`), editable through `detectEditableTextFormat` and kept
out of `detectFormat`, indexing, Quick Open and automatic context.
`server/delimited-table.ts` reads it in pages for `/api/file-table/*` and the
external grant's `/table` route; `features/documents/ui/csv/document.tsx` shows
the table or the plain-text source (`ui/source/plain-text-source.tsx`) by the
runtime's `tableMode`, saving the source before it returns to the table.
`features/documents/ui/table/` is the virtual grid both CSV and XLSX use, with
selection, Copy through the clipboard event or the button, and Ask agent;
`domain/table.ts` owns coordinates, TSV and the passage text, checked against
`shared/domain/passage.ts`. `read_file` serves XLSX from the preview's parse
(`spreadsheetAgentText`). `delimited-table.test.ts` covers quoting, embedded
line breaks, lone CR, BOM, delimiter choice, checkpoint pages across 1 MiB scan
chunks, rescans after a change, and encoding guesses; `markdown-source-format.test.ts`
the line endings a CSV save keeps; `routes/files.test.ts` and
`routes/external-files.test.ts` the routes, text save, index exclusion and grant
ownership; `spreadsheet-preview.test.ts` the agent text, its stated limits and
refused edits; `agent.test.ts` the one-time native Read redirect;
`opencode-agent.test.ts` table passages replayed as chips. Renderer tests cover
the table domain, geometry, adapter, CSV view (pages on scroll, source save,
the text ceiling, encodings, Ask agent) and the worksheet grid (virtual rows,
selection, Copy, oversize refusal). A 121 MB, 2,000,001-row CSV scanned in 331 ms
on this Mac and served a middle page in 1 ms.
An isolated macOS Electron pass (built renderer, source host, scratch HOME) opened
an Excel-style CSV (CRLF records, a quoted cell with an LF, quoted commas and
quotes), a 300,001-row semicolon CSV over the text ceiling, a GBK CSV and a
workbook with formulas. It confirmed the pinned header, 32 of 3,002 rows drawn,
scrolling to row 2,402 and to the large file's last row with its column widened
to fit, B2:D4 copied as TSV through the menu's copy command, Ask agent binding
"Cells B2:D4" and "Sheet 销售, cells A2:D4" chips with formula notes, a refused
whole-file selection, a typed source row saved with every other record's CRLF
and the cell's LF intact and then shown in the table, the disabled Source on the
large file, the GBK notice, the formula's title, and `/api/project/file`
returning the workbook's tables. Light and dark themes were inspected by eye.
Not driven: a desktop CSV drop, a real agent turn reading the passage or
`read_file` output, packaged builds, Windows and Linux.
A review then fixed: unchanged rows keep their endings beside blank or repeated
lines (a patience line match, bounded in work, replaced a look-ahead that let a
blank line pull later rows to the dominant ending); tables past Chromium's
layout ceiling scroll to their last row in proportion; Shift+Arrow extends whole
rows and columns as such; a possible GBK file is offered as a hint, not named;
a password-protected workbook says so; the parser resolves on first use, so
the MCP bundle cannot fail to load over it; formula text counts toward the
workbook's text bound. **Gaps:** one huge CSV record is checked against the
response budget only once it is decoded; XLSX workers have no concurrency cap;
Copy of a narrow column in a wide CSV reads whole pages; an attached or
mentioned XLSX gets no `read_file` hint in the prompt; hidden rows and columns
appear in the preview and agent text.
A release review (2026-10-24) found that a dense 120,000 × 12 workbook (3.9 MB)
aborted the whole process under Electron 39's Node 22 when its preview worker
ran out of heap. Parsing now reads only the first 1,000 rows and refuses more
than 500,000 cells there. A built-host pass (2026-10-24) ran the bundled server
under Electron's Node with an isolated HOME: `/api/file-preview` returned the
60,000- and 120,000-row workbooks at their true sizes with 1,000 rows shown
(0.5 s and 1.0 s), `/api/project/file` returned derived text stating that only
rows 1–1000 are included, and the host stayed up.
`spreadsheet-preview.test.ts` covers a dense 80,000-row sheet under an
understated dimension, cells starting after row 1,000, a refused wide sheet and
the end-record checks, and `delimited-table.test.ts` a cancelled scan shared with
another read. **Gaps:** that test does not prove the scan stops early, and a
sheet whose file the workbook's relationships do not locate, with cells only
after row 1,000, still reads as empty in the grid.

**XLSX preview (2026-10-23):** project and granted external XLSX files use
`server/spreadsheet-preview.ts` through the existing generic-preview adapters;
`features/documents/ui/spreadsheet/document.tsx` displays visible worksheets,
formatted values and coordinates in the shared table, with explicit preview limits.
The source remains read-only and outside retrieval; agents read it only as
derived text. `spreadsheet-preview.test.ts` exercises source preservation, formatted values,
cached formulas, hidden/empty sheets, changed-source refresh, bounded dimensions,
invalid archives and cancellation. External-file route tests exercise the owning
window grant; renderer tests cover opening, sheet switching, virtual rows and safe text.
An isolated macOS Electron pass using the built renderer and bundled host opened
the XLSX fixture from Files, switched worksheets, and verified the empty-sheet
and damaged-workbook states. The original workbook remained byte-identical.
The built Spreadsheet Story was visually inspected in light theme. Host types,
focused host/protocol tests, documentation checks and Electron boundary/smoke
checks passed. All renderer gates passed across the validation run; coverage
was rerun with two workers after a Markdown shell test timed out, passing all
356 files and 1,794 tests without changing timeouts or coverage thresholds.
Packaged and Windows/Linux workbook previews remain unverified.

**External files (2026-10-23):** `features/documents/ui/workspace/drop-zone.tsx`
wraps the whole content row, document pane and chat alike, so a drop works with no
document open. It outlines the row while a desktop file is over it, lets preview
frames pass drag events through, takes the drop before an editor can, and leaves
drops on the message box (`data-file-drop="attach"`) to the composer, whose
editor no longer pastes a dropped file's text.
`app/composition/folder/use-external-files.ts` opens each file through the
`externalFiles` preload bridge, main's `electron/external-files/handler.ts`, and
the process-private grant in `server/external-files.ts`; reads go through
`server/routes/external-files.ts` by token only. The source is a
`SourceReference` whose folder is an `external:` marker (`shared/domain/external-source.ts`),
so like a cross-folder tab it stays out of the session and history; Markdown,
text, JSON and CSV save through the grant and the rest are read-only, and the Agent
binds it by absolute path (`features/agent/application/ask-about.ts`).
`server/routes/external-files.test.ts` covers the registration token, window
binding of reads and revocation, sibling bytes refused whatever the URL names, a
symlink swapped into the path, the project-copy/grant/refusal decision per format,
generic-text preview, reveal, revocation when the window leaves its project, and
saves that keep BOM, line endings, and permissions, refuse a stale version or
another window, and write a deleted file back only on an explicit overwrite.
Directory-alias regressions resolve both registered roots and dropped files to
real paths, keep the registry spelling, and select the deepest registered owner;
this includes Windows short-name temporary paths. A macOS-only server test covers
a project spelled through the `/System/Volumes/Data` firmlink, another refuses
StashBase's own data, and `use-external-files.test.tsx` covers another project's
file and a hidden one opening without binding to the chat. The native HTTP fixture also
checks canonical reveal paths instead of assuming the input spelling survives.
A built-host HTTP pass (2026-10-23) opened two projects, dropped a file through
a registered directory alias, and confirmed project ownership with unchanged
source bytes. All 905 host tests, host types, Electron tests and built Electron
smoke passed locally; Windows behavior is checked by the source CI matrix.
`electron/external-files/*.test.cjs` cover the preload sending only a path read
off a real file and sender authorization;
the built-renderer smoke confirms in real Electron that a `File` built in script
is refused before it reaches main.
Renderer tests cover grant-only adapter routes, read-only tabs left out of the
session and dropped from history on close, unresolved relative links, the veil and
capture of a drop, refusal wording, the drop card's attach and release,
external validation and prompt paths, and preparation status matched by folder.
An isolated built-renderer/source-host Electron pass dropped files with Chromium's
real drag pipeline (`Input.dispatchDragEvent` with file paths). Markdown, PDF, and
CSV opened as tabs, bound in the chat beside them as attached chips in the
frame the composer offers the document in front with, and typing in the
Markdown tab autosaved to the external file itself with nothing beside it; DOCX and a binary file were refused in one notice, and
nothing was copied or written beside the sources. The PDF rendered through
`/asset/__external/`. Closing the Markdown tab sent its revoke and removed its
card. The refusal's Copy into project and Open in default app actions were
later removed, so it now only names Files. A dropped project file opened as itself, and an image dropped
over an HTML preview after entering from the tab strip opened through the veil.
A drop on the chat with no document open opened the file, a drop on the
message box attached it without opening it or pasting its text, and a drop in
Chats mode opened the file and brought Documents back. A second pass reused a
separately started development server, as `pnpm dev` does: main's own token was
refused, it read the owner-only token file, and the drops opened.
The outline was inspected by eye in the light theme at a narrow pane width.
The refusal has since moved to the shared floating card below the panes'
header rows. A later driven pass of the built app dropped an outside DOCX
through `Input.dispatchDragEvent`: main answered copy-required, and the card
floated over the row with the sentence naming Files and Dismiss alone. These passes found and fixed a veil removed before React
received the drop, a notice covering the document, and the development server
refusing main's token. A banner marking external tabs was removed at the
reader's request: they read like any other tab.
**Gap:** a physical Finder drag, a drag that enters the window directly over a
preview frame, a live Agent turn reading an external path, and Windows/Linux
`getPathForFile` behavior are unproven.

**External document refresh (2026-10-21):**
`features/documents/hooks/use-document-refresh.ts` checks the active visible
document every two seconds and on activation, native window focus, and return
from hidden. Text, generic previews, and versioned assets use the same trigger;
the check does not depend on indexing or host tree revisions. Dirty or held edits
retain their draft and enter the existing versioned comparison on save.
`use-document-source.test.tsx` reproduces the missing refresh and covers focus,
inactive/hidden suspension, failure recovery, held edits, slow-read coalescing,
disposal, and an accepted save winning over an older in-flight read.
`document-viewers.test.tsx` checks generic text and an image's versioned URL.
`document-html.test.tsx` checks that unchanged and failed asset reads retain the
HTML frame, while a new source version replaces it with the same opaque sandbox.
An isolated built Electron fixture changed a same-length HTML file externally:
the preview requested its new versioned URL and executed its updated script.
`server/routes/html-refresh.test.ts` reproduces a data-script-only change leaving
the old HTML version unchanged. The host now includes directly declared local
scripts and stylesheets in that version and uses precise validators when serving
subresources. Route tests cover same-size writes with restored mtime, stylesheet
changes, dependency deletion/restoration, explicit project scope, base URLs,
entities, and refusal to follow outside-project symlinks. Dynamically loaded
resources and transitive CSS/JS dependencies are not tracked.
The built host also detected a data-only edit in an isolated copy of the reported
SEO dashboard and served the updated script without changing the
HTML bytes. The data-only update has not been visually confirmed in that built
window: native UI automation could not reliably control the isolated instance.
A separate release-preparation fixture changed only a same-size data script,
restored its mtime, and observed the updated script execute in the existing HTML
tab; its refreshed preview was inspected by eye.
`ui/workspace/refresh.test.tsx` checks that a workspace covered by Chat mode or
New tab retains its editor without polling and catches up when shown again;
`app/composition/layout/workspace-panes.tsx` supplies that visibility.
An isolated built-renderer/built-host Electron pass observed an external Markdown
edit in the same tab after 2.3 seconds, caught up after reactivation, refreshed a
generic source preview, and retained visible text across deletion and restoration.
A real editor input racing an external write opened comparison with both texts
intact; disk retained the external version until the explicit resolution.
The final-build pass repeated these flows with a kept tab and observed no source
reads during four-second stays in either Chat mode or New tab, followed by
immediate catch-up on return. All 12 `pnpm check:web` gates, host types,
documentation checks, Electron tests, and the built-output native smoke passed.
Release preparation repeated the complete source gate after integrating the
latest `main`, then reused its builds for the refresh and conflict flows above.
The refreshed view was inspected by eye. The existing conflict header crowds its
copy in a narrow Documents/Chat split; that separate layout gap remains.
This proves the source runtime, not installed-package delivery.

**Move by drag (2026-10-19):** `workspace/ui/file-tree-drop.ts` resolves where a
drag over the Files column lands, from one set of listeners on the sidebar frame:
a folder row, a file row's folder, or the root for the project's row and the rest
of the column. It moves a tree entry through `useFileOperations.moveEntry` and
`PATCH /api/files/*` or `/api/folders/*` with `{dir}`; the shared
`moveTargetAsync` in `server/rename-helpers.ts` refuses a missing destination and
a folder moving into itself. A file reuses `moveProjectFile` and a folder the
rename route's disk-first rollback, so both keep the rename link cascade, index
move and receipts. Desktop files go to `FileImport`'s `drop`, which uploads with
the `dir` field. `server/routes/file-mutations.test.ts` covers file and folder
moves into a folder and back, links into and out of the moved entry, a taken
name, a missing or non-folder destination, a folder into itself, and traversal;
the folder case stubs the index owner rather than binding a daemon. Existing
destination names and returned paths retain significant whitespace. `file-tree-drop.test.tsx` covers targets,
refusals, a folder's open branches after its move, rest-to-open, and focus. `use-file-operations.test.tsx` covers open-tab
coordination and the move refusal sentence. `file-import.test.tsx` covers a desktop
drop into a folder and a refused dropped folder. A built-app Electron pass drove
Chromium's real drag pipeline over CDP (`Input.setInterceptDrags`,
`Input.dispatchDragEvent`) in an isolated profile. It moved an open Markdown note into
a closed folder that opened after a rest, and a link to it in another note followed.
The tab rebound to the new path and the moved row took focus. A drop on the project
row moved the file back to the root, and a desktop file dropped on a folder was
imported there. A second pass dragged an open folder two levels deep: its own
descendant was no target, and a drop on a sibling folder moved it with its open
branches. Links into it and a link out of it were rewritten, and the open tab
followed. The drop region was reviewed by eye in the light theme. A drag that
first enters a row is answered at `dragenter`, which Chromium uses for that step.
Every row's context menu also offers the platform's reveal (`fileManagerLabel`,
`POST /api/reveal/*`) and copies its absolute or project-relative path
(`systemEntryPath`); `file-tree-menu.test.tsx` covers both on a file and a folder,
and `tree.test.ts` covers Windows separators.
An isolated built Electron pass used native input events on both copy menu items
and verified their values in the macOS clipboard; the menu was inspected by eye.
A second isolated pass on 2026-10-20 reused the final built renderer and host,
repeated file/folder-target and root moves plus OS-file payload import in the dark
theme, and inspected the drop highlight and resulting layout.
**Gap:** a physical Finder drag is unproven, and moving has no keyboard path.

**Local image preview (2026-10-12):** `electron/app-protocol.cjs` permits the
configured server's `/asset/` image route in production CSP. Previously a valid
PNG returned HTTP 200 and decoded as a blob, while the same URL failed as an
image with an `img-src` violation. `electron/renderer/document-image-smoke.cjs`
runs under the built renderer's real Electron policy and request authorization;
it checks direct PNG decoding from a folder-scoped URL with encoded filename
characters and confirms asset reads carry no window authority. The isolated
built `ImageDocument` was also driven with a controlled 640-by-360 PNG: preview,
Enlarge image, and Escape back to the preview worked and were reviewed by eye.
This verifies the source runtime with fixture bytes, not the reported user's
file, project navigation end to end, or packaged delivery.

**Chinese IME composition (2026-10-11):** `ui/markdown/outline-adapter.ts`
renders heading anchors through ProseMirror decorations and removes Milkdown's
competing heading-id synchronizer. Direct heading DOM writes previously made
the editor reparse nearby composing text and lose Chromium's IME replacement
range. A temporary Electron probe reproduced `c初始` after composing `初始` in
a paragraph between headings; disabling those writes removed the residue.
`document-input.test.tsx` checks unique outline-compatible Chinese anchors and
that rendering them publishes no document edit. The built Markdown surface was
driven in Electron with native Chromium composition updates from `c` through
`chu'shi`, followed by committing `初始`, in both a paragraph and a heading.
Rendered text and the live Markdown buffer contained only the committed word;
one Undo removed it, and updated heading anchors matched the outline's slugs.
The rendered surface was reviewed by eye. This isolated source-runtime probe
does not establish Sogou-specific candidate-window behavior, disk saves, or
packaged delivery.

**Currency and math (2026-10-08):** `ui/markdown/math.ts` replaces Crepe's
single-dollar math interpretation. `math.test.ts` runs the real Milkdown editor
and verifies price rendering/save preservation, inline double-dollar math, and
block/fence round trips. An isolated built macOS source app opened a fixture
with multiple dollar amounts, an inline formula, and a block formula. After a
normal text edit, the saved file retained every price and both double-dollar
forms; the rendered editor and formula preview were reviewed by eye. This is
source-runtime evidence, not packaged delivery.

**Intent:** [J03](../design-docs/journeys/README.md#j03-read-and-edit-source-documents).
The [Documents design](../design-docs/journeys/documents.md) owns navigation, continuity,
and recovery behavior; the evidence below establishes its exercised paths.

**Implementation:** Renderer: `renderer/src/features/documents/ui/source/registry.tsx`, `renderer/src/features/documents/application/document-runtime.ts`, `renderer/src/features/documents/ui/markdown/document.tsx`.
The Markdown reading bar composes the Settings-owned
`renderer/src/features/settings/ui/appearance/appearance-menu.tsx`, with font,
color and texture samples in the adjacent `appearance-samples.tsx`; durable
font, size, page colour and line presets cross `shared/protocols/http/appearance.ts` to
`server/app-config.ts` and are stamped on the document root by
`renderer/src/shared/runtime/appearance-surface.ts`.
Inline review: `renderer/src/features/documents/domain/revision.ts`,
`renderer/src/features/documents/ui/markdown/use-revision-review.tsx`,
`renderer/src/features/documents/ui/markdown/revision-adapter.ts` over a patched
`@milkdown/plugin-diff` (`patches/`).
Turn review: `renderer/src/features/documents/application/open-revision.ts`
(`openTurnChangeReview`), `infrastructure/turn-change-api.ts`, and the reversed
labels and colours in `ui/markdown/revision-adapter.ts`, `review-bar.tsx` and
`document.css`; host `server/turn-changes.ts` and `server/routes/turn-changes.ts`.
Ask agent on a selection: `renderer/src/features/documents/ui/markdown/selection-markdown.ts`
and `selection-toolbar.ts`, bound in `renderer/src/app/shell.tsx`, which saves the
documents, shows the chat pane, and hands the passage to the agent workspace.
The same `selection-toolbar.ts` owns the leading Text/Heading 1–3 block menu;
Milkdown's block command remains the document mutation owner.
A save refused against a version a deleted file no longer has, whose reload confirms
the source is gone, enters the document's `detached` state and stops autosave.
`application/draft-settlement.ts` turns a close or a release of such a tab into the
question rendered by `ui/workspace/discard-draft-dialog.tsx`, and `document-runtime.ts`
owns the explicit restore, which re-attempts the ordinary save before creating the file
so a source that came back is compared instead of overwritten.
Host/services: `server/file-save.ts`, `server/text-file-transaction.ts`,
`server/turn-changes.ts`, `server/routes/turn-changes.ts`.

**Status:** Release-dependent.

- **Contract Test:** `pnpm test:renderer`, `pnpm test:server`,
  `pnpm test:electron`, and `pnpm test:electron:smoke` cover format capabilities, source identity,
  hidden-file policy, tab/history behavior, save barriers, shared version
  authority, conflicts, and failure handling.
  `server/__tests__/file-listing.test.ts` exercises root and nested project
  configuration/skills with hidden-file visibility both off and on, sync/async
  listing parity, protected/derived exclusions, unchanged index eligibility, and
  that a listing never opens a source, so cloud-only files stay undownloaded.
  `server/routes/files.test.ts` verifies preference changes through folder-explicit
  workspace requests, including project isolation and refusal of unregistered roots.
  `pnpm test:server` covers strict durable preferences.
  `appearance-menu.test.tsx`, the Appearance domain/infrastructure/surface
  suites, `shared/protocols/http/appearance.test.ts`, and
  `server/routes/appearance.test.ts` cover the Appearance menu's font, size
  step and page-colour pair writes,
  immediate surface application, rollback, strict wire values, and preservation
  of unrelated preferences.
  Transaction/Python regressions cover concurrent saves, staging-time external
  edits, failed empty-source removal with same-content retry, and consecutive
  projection acceptance while a local embedder blocks. They do not establish
  provider completion or search latency during a pending revision.
  HTTP source-format contracts isolate index admission; they do not start or
  verify the Python daemon. Real daemon lifecycle belongs to Electron smoke
  and the built-service pass below.
  `revision-engine.test.ts` proves the inline review against the real Milkdown
  build with DOM clicks: what a proposal renders, which commands dirty the
  buffer, and that a per-change Reject resolves a deletion, including one of
  two adjacent deleted blocks while the other stays acceptable.
  It also proves the patched start keeps a document's trailing empty
  paragraph out of the diff.
  `selection-toolbar.test.ts` runs the Heading menu against a real Milkdown
  editor, covering toolbar order, the checked block kind, paragraph/heading
  conversion, menu dismissal, and Ask agent as the last item.
- **Project configuration visibility runtime pass (2026-09-30):** the built
  macOS source app used isolated configuration and a supplied folder-picker result.
  All five recognized configuration directories appeared with hidden files off.
  Toggling off → on → off showed and hid an unrecognized dot-directory, retained
  the configuration directories, kept caches unexpandable, and hid VCS/product state.
  Files opened a writing skill under the fixture's `.agents` directory; Quick Open
  found and opened a `.claude` skill. The expanded tree and document were reviewed by eye.
  A release-candidate rerun on 2026-10-04 after integrating current main confirmed
  all five default-visible directories and opened the `.agents` writing skill
  through the built desktop tree; its rendered document was reviewed by eye.
  Telemetry was unavailable in the isolated test configuration.
  These passes did not exercise a native picker or a packaged, signed application.
- **Reading typography runtime pass (2026-09-26):** the built macOS source app,
  with isolated configuration and telemetry disabled, opened this repository's
  README in Documents. The document reading menu changed Serif to Sans and the
  default size to Large without closing; the document root reported both new
  values, the computed prose face changed to Inter, and the isolated durable
  configuration retained `readingFont: sans` and `readingTextSize: large`.
  A full-window screenshot was reviewed by eye for the reading bar, open menu,
  selected presets, and enlarged document composition. This pass did not use a
  packaged, signed application or exercise a failed preference write. It
  predates the Appearance menu below.
- **Appearance menu runtime pass (2026-11-02):** an isolated macOS Electron
  source pass (renderer from the working tree through Vite) opened a Markdown
  note and its Appearance menu. Choosing Paper recoloured the whole window
  with brown ink; two slider steps set step 5 (`18px * 1.125` under Serif);
  Dark and Light under Paper and Green showed each pair's sides. Screenshots
  were reviewed by eye in each state. `shared/protocols/http/appearance.test.ts`
  holds every theme, Paper and Green included, to AA body and secondary
  contrast. A packaged application and a failed write from the menu were not
  exercised.
- **Heading menu runtime pass (2026-09-26):** the built macOS source app, with
  isolated configuration and telemetry disabled, opened a fixture Markdown file
  in the normal Documents and Chat split. Selecting its blocks and choosing
  Heading 2 converted them to H2, and reopening the menu marked Heading 2 as the
  current choice. A later pass the same day, after Humanize was removed,
  selected prose in the same split: the toolbar read Heading, the formatting
  marks, then Ask agent on one 401px line, and its open menu checked Text.
  With the document pane forced to 420, 360 and 320px, it stayed on one line
  at 420px and below that kept the formatting groups whole on the first row
  with Ask agent on a second, never clipped by the pane. Clipped screenshots in light and dark were reviewed
  by eye. These passes did not use a packaged, signed application or exercise
  undo and save-conflict recovery.
- **Driven Runtime Pass:** isolated built-app passes cover preview reuse/keep,
  history, draft creation/rename, and kept-only tab restoration. Earlier journal
  restoration passes apply to the removed snapshot feature, not current durability. A separate window-origin
  API pass proves one success/one conflict for same-version saves and missing
  asset refusal; it does not drive editor typing or conflict-dialog decisions.
  The 2026-09-15 v2.7.0 retry exercised the built service with a real Python/MFS
  daemon: consecutive versioned saves, stale-write rejection with source
  preservation, empty-source removal from keyword results, and rejection of
  blank agent identity and cross-project writes. No embedding key was configured;
  this pass does not establish real-provider latency or ranking quality.
- **Documents runtime pass (2026-09-15):** the built desktop app used an isolated
  real project to exercise hidden-tab autosave, undo after tab switching, external
  disk conflict, marker refusal and explicit merge completion, New tab close,
  rename rebinding, immediate Markdown publication, and undo after six other
  kept Markdown editors. No agent/provider fixture was needed. The source files
  and visible editor contents were checked; this was not a packaged release.
- **Turn-only review (2026-10-08):** the proposal tool, transient store,
  consumptive delivery routes/poll, and Accept/Reject chat controls are retired.
  The document retains the shared diff engine with fixed Undo/Keep controls,
  version/frontmatter refusal, and byte-preserving Keep. `open-revision.test.ts`,
  `document-revision.test.tsx`, and `use-turn-review.test.tsx` exercise the retained
  entry and failure paths. Earlier proposal-only runtime passes no longer
  establish the current entry. Current runtime evidence belongs with J07.
- **AI Eval:** not required.
- **Release Check:** representative complex PDF/DOCX/media in packaged viewers.
- **Gap:** packaged multi-format viewer behavior and large-project resource
  use remain unproven. The runtime pass above covers the changed text/Markdown
  flow, not every format or every interruption. See
  [conflict recovery](architecture.md#source-transactions).
- **Detached-draft runtime pass (2026-09-17):** the built renderer in Electron, with
  an isolated HOME, its own user-data directory and port, drove one real project: open
  a Markdown file, switch to Edit, type, autosave (41 bytes on disk), then delete it
  from outside the app and keep typing. The chip reported the draft as unsaved, Cmd+W
  asked "Close without saving?" naming the file instead of doing nothing, Cancel kept
  the tab and the draft, Restore file recreated the source with the draft in it, the
  next edit autosaved again, and a second Cmd+W closed the tab with no question.
  Not driven: the native window-close/quit barrier, because a renderer-side
  `window.close()` bypasses the main process's close event (proven with an
  always-refusing release handler), and CDP cannot deliver the native gesture. The
  only product caller of `window.close()` is the bug-report window, which holds no
  drafts.
- **Detached drafts:** `document-lifecycle.test.ts` covers the autosave stop, the
  close and release questions, the restore that creates the file, and the comparison
  that replaces it when the source came back. `work-preservation.test.tsx` covers the
  reader's path through the chip and the dialog. A transaction regression proves the
  host contract both depend on: a versioned save to a deleted source is refused, and
  only a write carrying no base version recreates it. The save barrier refuses a release
  while such a draft is open, so quitting needs the reader to restore or discard first
  and then repeat the quit; that refusal is proven at the renderer layer only, and no
  packaged build has been driven through this journey.
- **Focus-scoped current line (2026-10-01):** the code editor (plain text and JSON)
  and Markdown code blocks paint the current line only while their editor has
  focus, so a document the caret has left no longer shows a second marked line.
  A temporary harness in Electron's Chromium mounted both editors with the
  shipped theme and stylesheet and read the computed background: before the
  change it stayed painted after focus moved away; after it, focused lines keep
  the hover color and unfocused lines are transparent. happy-dom does not apply
  CodeMirror's focus class or theme, so no unit test owns this.
  A built-app Electron pass (2026-10-02) opened plain-text, JSON, and Markdown
  files in an isolated project/profile. Real mouse input focused and blurred
  the source editors via the file tree, then moved from a Markdown code block
  to prose and between two code blocks. Computed line and gutter backgrounds
  were the hover color only in the focused editor and transparent otherwise;
  refocusing restored the highlight. The light composition was inspected by eye.
- **JSON views and Find focus (2026-10-28):** JSON shows one view at a time, a
  read-only outline or the editable source, behind one Preview/Source control;
  both stay mounted. Find leaves focus in its field in either view: the code
  editor marks matches with its own decorations instead of focusing the match,
  and the outline selects a row without focusing it. `editor.test.ts` proves
  focus stays in a field while typing and stepping (it fails with the old
  `view.focus()`), `document-json.test.tsx` covers the switch and the retained
  editor, and `tree.test.tsx` the read-only outline. The New tab page isolates
  the document layer beneath it, so z-indexed table rows no longer draw through.
  A built-app Electron pass in an isolated profile typed into Find in both views,
  pressed Enter twice in Source with the document unchanged, found no add, delete,
  or inline editor in the outline, and hit-tested the New tab page at four points.
- **Known issues — source/viewers:** Markdown relative images lack folder-scoped resolution/upload/lightbox; heading
  ids are assigned by order without identity cross-check. PDF placeholder/observer
  counts are unbounded.
  Markdown retention remains a format-name exception outside the registry.
- **Known issues — work continuity:** sandboxed HTML owns its internal scroll
  position; host reading-position capture does not cross that boundary. Native
  close tracks document
  load rather than separate save-handler readiness, with failure/timeout keeping
  the window open. Recovery is a React remount, not a native reload protocol.
- **Keyboard sidebar resizing (2026-10-01):** the sidebar's edge rail is a
  focusable separator reporting its width and bounds; arrow keys step it 16 px,
  the same step as the agent pane seam, within 272–360 px, and never collapse it.
  The rail now renders inside the sidebar's landmark, measured at the same
  position in the sidebar, floating, and inset variants.
  `sidebar.test.tsx` covers the bounds, clamping, the reported width, the
  width-change callback, and shrinking from the provider's 288 px default.
  A harness in Electron's Chromium with the shipped stylesheet
  pressed real Tab and arrow keys: focus reached the rail, the panel and saved
  width moved 300 → 332 → 272, the edge hairline took the focus colour, and the
  rail's tooltip stood beside it and closed when focus left.
  A built-app Electron pass (2026-10-02) opened an empty project with an
  isolated profile, reached the rail with real Tab input, resized from 288 px
  with arrow keys, held both bounds without collapsing, and verified a 328 px
  rendered width, native session-file persistence, and restoration after reload.
- **Documents implementation (2026-09-15):** focused regressions cover explicit
  merge completion with no marker autosave, version-checked Keep-my-version,
  hidden-tab autosave, retained CodeMirror undo, New tab close routing, preview
  refresh preservation, and failed-open preservation of preview/history.
  `app/workflows/mutate-documents.test.ts` covers all-tabs retention on a later
  save refusal, confirmed rename identity/order, deletion, and scope retirement.
  `workspace/infrastructure/file-operation.test.ts` covers receipt-only retries;
  `server/routes/file-mutations.test.ts` drops a real rename response and checks
  its receipt and safe replay against a newly created file at the old path.
  These controlled tests do not establish packaged behavior or large-project
  resource usage. Activated Markdown editors now remain alive until their tabs
  close; memory use with many complex open documents needs measurement.
- **Durability limit:** the keychain-backed draft journal is removed by product
  decision. Automatic saves, versioned conflict handling, and native save barriers
  remain. Process crashes and shell remounts can lose text not yet saved to source.
  No existing keychain item or old snapshot is read, migrated, or deleted.
- **Known issues — trust:** executable source HTML and remote subresources remain
  weaker than intended isolation. The current opaque frame is not approval to
  expand script/network authority.

## J04: Preparation

**Replaced app working directory (2026-11-02):** 98 different PDFs on one macOS
2.18.3 installation failed before batch execution with `ENOENT`. The live host's
Resources cwd inode differs from the replacement bundle's directory. The installed
extractor converts an affected PDF from a valid cwd but reproduces the exact
failure from an unlinked cwd; a source traceback identifies multiprocessing's
`get_preparation_data` → `os.getcwd`. `extractor-process.ts` now starts PDF/OCR
in the OS temporary directory. Its real-child regression removes the host cwd
before launch and exercises both modes. Real installed-extractor and built-host
verification use private output directories and leave source bytes unchanged;
this does not update the user's running app or establish other platforms' native
PDF/OCR behavior.

**Extractor termination evidence (2026-10-27):** PDF/OCR errors now retain native
signals and structured stderr alongside exit codes. A real child-process fixture
distinguishes signal termination from caller cancellation. Retry and durable
failure policies are unchanged. This improves evidence for the reported OCR/PDF
failures; the original source files and the native crash cause remain unavailable.
macOS PDF batches now spawn fresh interpreters; PDF/OCR entry points and batch
workers enable native fault tracebacks. Source-mode tests convert a real two-page
PDF through spawned batches and preserve its bytes. A temporary PyInstaller build
of the actual combined entry verifies two spawned batches using controlled parser
fixtures; it does not prove packaged native PDF/OCR library behavior. Original
crash inputs and release-package verification remain gaps.

**MFS startup retirement (2026-10-25):** a real child/descendant fixture failed
because the readiness watchdog killed only its leader, leaving the helper
alive. `mfs-daemon.ts` now retains `MFS_START_TIMEOUT`, shares retirement across
startup waiters, and retires the whole tree before replacement. A separate
late-close fixture verifies that a close deadline rejects and fences respawn
until actual closure. Existing binding replay and explicit retirement checks
remain. These establish cleanup/recovery, not the original Windows device's
reason for taking more than ninety seconds to initialize.
An isolated built-host/built-renderer Electron pass opened a project, observed
the injected startup failure as HTTP 500, confirmed the helper was gone, then
received HTTP 200 from the real Python/MFS daemon on retry. The document remained
visible and its source bytes unchanged. The fixture used a shortened first
watchdog, a private profile, disabled telemetry and no external provider calls.

**Windows extractor launch recovery (2026-10-24):** the reported stack reaches
`runExtractor` before a child starts; historical logs contain no native Windows
error beyond `UNKNOWN`, so its original cause remains unproven. Controlled sync
and async launch-failure fixtures verify one cancellable Windows-only retry,
persistent error/cause retention and refusal to launch after cancellation.
A real child writes 2 MiB to stdout before exiting; the host drains it rather
than blocking on an unread pipe. This is recovery and diagnostic hardening,
not a reproduction of the unavailable Windows device or a fix for all OS launch
refusals. `error-diagnostics.test.ts` verifies errno/syscall/attempt preservation
without command arguments or environment capture.

**Daemon exit evidence (2026-10-16):** the host retains a bounded, credential-filtered
stderr tail and exit code/signal for unexpected MFS exits. A real child-process
fixture verifies startup failure evidence and a subsequent successful restart.
The fixture uses Node, not Python/MFS; the reported production code-1 failure's
traceback and root cause remain unknown.

**PDF raster allocation and disposal (2026-10-24):** `ui/pdf/page.tsx` caps
high-DPI raster dimensions while preserving CSS zoom and text coordinates, and
explicitly releases visible/scratch backing stores on scroll, close and render
settlement. Three `page.test.tsx` regressions failed on the baseline and pass
with the fix, including cancellation without stale pixels. The isolated Electron
`profile:pdf-memory` scenario ran twice before and after: one A4 page at 300% and
DPR 2 dropped from 69,797,376 to 16,768,800 backing bytes; its detached canvas
dropped from 69,797,376 to zero. CSS geometry remained 1836 × 2376 px. These are
canvas allocation measurements, not process RSS. The reported Windows renderer
OOM and adjacent GPU crash occurred on an approximately 4 GB machine that is
unavailable for reproduction; driver behavior and complex PDF decoding remain
unproven. See [the profiling scenario](../scripts/profiling/README.md#scenario-pdf-raster-memory).
The final built host/renderer repeated both runs with the same allocation and
release results; a captured Electron frame was visually checked at 300%. All
twelve renderer gates and the built Electron smoke passed.

**Markdown test setup (2026-10-24):** The Intel CI run exposed a cold Markdown
viewer import exceeding `tabs.test.tsx`'s five-second interaction wait. That
suite now loads the real
viewer in bounded setup before testing mode retention; a 5.5-second injected
module delay failed before and passed after this test-only change.

**PDF component probes and textless pages (2026-10-14):** `pdf-runtime.test.ts`
covers a packaged layout with no loose extractor scripts: unavailable probes
neither launch nor request a download, and installed probes/conversions select
the same component. `pdf_extract_test.py` covers missing native/scanned pages,
layout failure, empty completed OCR, source preservation, failed-OCR publication
refusal, and timeout refusal without an unbounded OCR restart. A real macOS
source-extractor pass reproduced the reported error with a one-page blank PDF;
after the fix that fixture completes with only a marker, while text and scanned
text PDFs remain readable. The reporter's PDF and Windows component execution
remain unverified; these logs alone do not establish whether its input was blank.
An isolated built-host HTTP pass with real Python/MFS also opened those three
PDFs, settled preparation without failures, retrieved only the two readable PDFs
by keyword with page locators, and verified unchanged source hashes. Validation:
744 host tests, 31 Python tests plus daemon smoke, 19 package-input tests, host
type checks, and documentation checks. No Windows package was built in this pass.

**Windows pipe encoding (2026-10-13):** the launcher and Python daemon explicitly
own UTF-8 stdin/stdout. A real subprocess regression starts with CP1252 encoding,
indexes emoji and multilingual text, retrieves it, and verifies UTF-8 output.
This exercises the encoding failure independently of the host OS; packaged
Windows execution remains a release verification requirement.


**Independent component reuse (2026-10-12):** the release pipeline selects a
component identity from its build inputs instead of the desktop version.
`scripts/packaging/extractor-release.test.mjs` covers input invalidation,
release completeness and component hash/target rejection; the component runtime
integration test opens a second offline owner against the same pinned installation.
Platform packaging still exercises real PDF/OCR and offline reuse. The new
independent prerelease publication and first cross-version hosted reuse are not
yet established by a live release.

**Intel compatibility (2026-09-17):** unsupported-system status bypasses download
and retry, while supported Intel component installation still verifies the
architecture-specific manifest and works offline. `extractor-runtime.test.ts`
owns those outcomes; `local-component-group.test.tsx` verifies the explanation
and absence of a misleading Retry action. Hosted Intel macOS 15 packaging passed
signed/notarized component execution, fixture PDF/OCR, and offline reuse.
Representative OCR quality and live release download remain release checks.
An isolated Electron render of the production recovery component and built
styles confirms readable wrapped copy and no Retry control for unsupported
systems. This checks the component composition, not a real Intel PDF journey.

**Status persistence (2026-09-16):** SQLite failures reject reads/writes rather
than reporting durable cancellation. Failed terminal writes remain pending in
process memory and are replayed after storage repair before discovery proceeds.
`conversion-status.test.ts` exercises corrupt storage, cancellation refusal,
repair without restart, persistence after reopen, and explicit reprocessing.
An unrepaired process crash cannot durably preserve a failed write.

**Contextual component recovery (2026-09-16):** `workspace-panes.tsx` composes
`local-component-recovery.tsx` beside a pending PDF, using the existing shared
installation port. Image previews no longer request the preparation slot
(2026-10-30); OCR still supplies search text, and failed component demand retains
its next-launch retry. Existing readiness/status-line tests retain PDF/DOCX behavior,
and document viewer tests retain versioned image loading. An isolated macOS
Electron source pass opened a PNG and visually confirmed the image without an
OCR status or recovery row. The installation owner and source cancellation are
unchanged; packaged verification is separate.

**Intent:** [J04](../design-docs/journeys/README.md#j04-prepare-a-hard-to-read-file).

**Implementation:** Renderer: `renderer/src/features/preparation/public.ts`.
Host/services: `server/conversion-dispatch.ts`, `server/conversion-scheduler.ts`, `server/extractor-runtime.ts`, `server/sync.ts`.

**Status:** Release-dependent.

- **Contract Test:** `pnpm test:server`,
  `pnpm test:python`, and `pnpm test:package-inputs` cover format completion,
  freshness, checkpoints, cancellation including descendants,
  native worker wiring, and bounded component install/retry/offline reuse.
- **Driven Runtime Pass (2026-10-13):** an isolated Node `MfsDaemon` launch
  inherited a simulated ANSI encoding, bound a disposable Gallery-named folder
  with emoji, indexed a Markdown filename with emoji and Chinese characters,
  then retrieved its Chinese content through the real Python/MFS RPC channel.
  This used source runtimes on macOS; the frozen Windows sidecar remains a
  release check.
- **Driven Runtime Pass:** PDF/OCR recovery (2026-09-15) covers
  failed first demand, no polling retries, one Settings retry, next-launch
  download/resume, and a later offline process with zero downloads. It uses a
  retained component build and controlled transport; picker/key storage are
  substitutes.
- **AI Eval:** no shared extraction-quality Eval claimed; correctness requires
  format-specific fixtures or datasets.
- **Release Check:** representative native PDF/OCR/DOCX, live component
  delivery/notarization, and no console/focus theft on Windows.
- **Background fixes (2026-09-16):** `server/background-recovery.test.ts`
  exercises production conversion/indexer wiring without waiting for semantic
  completion and verifies OCR cancellation waits for a stubborn real descendant.
  PDF and OCR share the same process-tree completion barrier. Component tests
  cover active/failed source cancellation, preserved peer demand, explicit
  component ownership, shutdown, and next-launch recovery. The affected backend
  suite passes 146 tests; retrieval passes 25 tests.
  A source-runtime pass with real Python/MFS and an isolated local embedding
  endpoint accepts two prepared files, frees each heavy lane, and returns both
  in keyword search while embedding remains blocked. Extracted text is a fixture;
  this does not establish OCR quality or packaged cross-platform behavior.

Media preparation is retired; see the [removal record](../docs/history/media-transcription-removal.md).
Direct media playback remains part of J03, without transcript or conversion.
An isolated macOS built Electron/server pass (2026-09-15) played a generated WAV,
showed the unavailable state for invalid MP4 bytes, and admitted only the Markdown
fixture to real MFS. This does not establish packaged codec coverage.

## J05: Search

**Search setup (2026-09-16):** unconfigured search exposes a direct Settings
Advanced entry. `project-search.test.tsx` checks that invoking setup preserves
the keyword query and does not submit semantic search.

**Intent:** [J05](../design-docs/journeys/README.md#j05-search-and-open-source-evidence).

**Implementation:** Renderer: `renderer/src/features/retrieval/ui/project-search.tsx`, `renderer/src/features/retrieval/ui/search/backends.ts`.
Host/services: `server/retrieval/index.ts`, `server/indexer.mfs.ts`, `python/stashbase_daemon.py`.

**Status:** Partial.

- **Cloud parent path fix (2026-10-14):** `MfsIndexer` now checks direct-text
  eligibility against the owning bound folder instead of the absolute source
  path. `semantic-index-inputs.test.ts` covers a project beneath Google Drive's
  `.shortcut-targets-by-id` pattern, project-internal hidden exclusions, and
  a separately bound nested project. An isolated real-daemon reconcile admitted
  the visible Markdown, reported an index total of one, and found its `ReplaySSM`
  keyword. An isolated built-service HTTP pass opened the project, synced it,
  reported a total of one, and returned one keyword match. The affected user's
  90-file project and packaged UI remain unverified.
- **Contract Test:** `pnpm test:server`, `pnpm test:python`, and the scoped
  project/config/renderer suites cover exact filtering, hybrid mechanics,
  current-source mapping, namespace isolation including nested projects,
  missing/blank/stale identity refusal, provider-independent keyword search,
  and current/failed/cancelled preparation. A real-daemon deletion-failure
  probe verifies cleared text cannot leak old evidence and identical save retries.
  A local blocked embedder exercises independent keyword/status responsiveness.
  Release-based setup was verified on 2026-09-15: MFS `v0.1.0` replaced the
  Git-sourced installation, matched its archive URL and package version, and
  remained installed on a second setup run without reinstallation.
- **Driven Runtime Pass:** no-key built-app passes prove keyword-only UI and
  Settings entry, exact retrieval over the then-bundled guide, separate project results, omitted
  scope refusal, nested namespace retirement/update, and deleted-source filtering.
  Nested ownership was repeated on 2026-09-14 against MFS `357fe252`, and setup
  provenance matched the pin after replacement and a no-op rerun. These use the
  development Python runtime, not packaged sidecars or real embedding providers.
- **AI Eval:** deferred (2026-10-23). The implementation from
  [PR #187](https://github.com/liliu-z/stashbase/pull/187) remains available as
  `pnpm eval:semantic-retrieval`, but its [dataset](../evals/semantic-retrieval/README.md),
  judgments, and thresholds have not been validated as a reliable measure of
  retrieval quality. There are no retained provider baselines.
  [Issue #176](https://github.com/liliu-z/stashbase/issues/176) is closed as not
  planned for now; future quality evaluation must reassess the approach before
  treating its results as evidence or a gate.
- **Release Check:** semantic-quality evaluation and baseline collection are
  deferred, with no required provider reports or quality threshold gate.
  Deterministic retrieval checks and packaged integration checks still apply.
- **Unreadable subdirectories (2026-10-30):** `conversion.ts` reports child
  `EACCES`/`EPERM` paths to `sync.ts`, which protects both indexed documents and
  derived preparation state while reconciling readable peers. Root denial and
  unexpected scan errors still abort before cleanup. `semantic-index-inputs.test.ts`
  covers retained nested rows, prepared artifacts and cancellation state,
  similarly named sibling cleanup, and recovery when access returns.
  `semantic-indexing-state.test.ts` covers folder-scoped warning persistence and
  clearing after success. `index-status.test.ts` verifies status polling retains
  failed/cancelled preparation through permission or I/O errors and clears only
  confirmed missing sources. Preparation and Search expose that warning, including
  its directory path, without requiring an embedding key; the renderer test
  retains usable keyword results and Retry/Dismiss. An isolated macOS source
  pass used real filesystem `EACCES` and Python/MFS: readable siblings updated,
  retained child rows and prepared state survived daemon restart, and restoring
  access allowed normal update/removal. Root denial preserved the index. This
  exercises the sync/MFS seam with synthetic prepared text, not extraction or
  the packaged application. An isolated Electron render of the production Search
  component at sidebar width visibly retained the wrapped directory warning,
  Retry/Dismiss controls and usable keyword result without a meaning-search key.
  The reporter's macOS
  permissions/ACL/TCC cause and packaged-device behavior remain unverified.
- **Background fixes (2026-09-16):** Real sync
  orchestration tests inject daemon retirement during upsert and deletion,
  verifying rebind, retry, and a successful result without false file failures.
  The redundant `folderReady` set is removed; successful daemon status establishes
  readiness directly. Runtime keyword availability during blocked embedding is
  covered by the J04 pass above.
- **Gap:** representative semantic retrieval quality remains unproven. Deferring
  evaluation does not establish ranking quality.

## J06: Agent

**First-send feedback (2026-11-11):** the session dispatcher publishes a pending
user-message snapshot before context resolution and cold-session startup. The
workspace no longer waits for native `ready` to show the reader's own message.
The existing composer/permission flow checks the bubble before readiness, no
early wire send, and one bubble/send after acceptance. Recovery checks cover
startup refusal, context preparation, cancellation and newer draft preservation.
`profile:first-send` measures the mounted workspace in isolated Electron with
controlled immediate and one-second startup ports; it does not measure live
provider startup, model response latency or packaged Windows performance.

**Missing-runtime history recovery (2026-11-03):** the renderer preserves
`412 AGENT_NOT_INSTALLED` as an installation prerequisite. Both the Chats sidebar
and history popover offer Agents settings and Check again, retain cached chats
and other agents' rows, and reserve Retry for ordinary failures. Closed popovers
do not start history reads. Adapter, sidebar, popover, hook consumers and scheduled
header regressions exercise this recovery and its settings composition. The
`HistoryNeedsInstallation` Story was inspected in Chrome, with cached Claude
history beside missing Codex and both recovery buttons visible. This does not
verify installing or signing into the real Codex provider. The fresh built
Electron app also opened the private empty project, received the real host's
missing-Codex history prerequisite, and navigated through its recovery button
to Agents settings with the Install control visible.

**Codex ownership and history recovery (2026-11-02):** a real child-process
fixture reproduces `already has an active writer` when a replacement resumes
before the disconnected process finishes retiring. `codex-session-runtime.ts`
now reserves native thread ids across windows and waits for the previous local
writer's verified closure. The fixture also refuses an active duplicate without
stealing its writer and permits an unrelated thread. A second real-process
fixture reproduces concurrent `thread/list` failures after one shared-reader
timeout; `codex-history.ts` coalesces these reads and awaits retirement before
one read-only retry. It covers both a healthy replacement and a second stall,
with no third attempt. Existing history scope/mutation and turn-timeout checks
remain. An isolated official Codex 0.166.0 binary reads an empty private project's
history through the production owner without login or model requests. These
checks establish local ownership/recovery defects, not the internal cause of the
historical native query stall, every upstream writer conflict, a completed live
provider reply or Windows-native process behavior.

**Structured tool failure categories (2026-11-02):** Codex MCP error objects
become JSON in the shared tool-result protocol. The previous prose-prefix-only
classifier lost explicit not-found/permission/timeout evidence. The telemetry
regression now traverses `toolResultFromItem` and verifies bounded inspection of
only error code/message fields; arbitrary content blocks and prose mentions stay
unknown, and tool output never enters the emitted diagnostic. Historical unknown
reports cannot recover their missing reasons, and this does not establish the
cause of shell failures or WebSocket 1006 closures.

**Math source copying (2026-11-02):**
`ui/transcript/markdown-copy.ts` retains Markdown source positions before KaTeX
replaces formula DOM. A selection inside formula glyphs copies the original
delimiters; selections crossing prose retain escaped prices, paragraphs, lists
and display formulas. Existing transcript/Markdown tests cover Copy response,
partial list and blockquote continuation selections. An
isolated macOS Electron source pass exercised real Chromium ranges for mixed
paragraph/list/matrix selections and selections inside inline/display glyphs.
External application paste behavior and real-provider continuation are not
established by these checks; see J01.
The actual Chat-to-Documents copy/paste composition is covered in
[J07](#j07-converge).

**Model and effort across projects (2026-10-29):** `server/routes/agent-preferences.ts`
atomically saves each agent's last explicit model and effort alongside the project
choice. `project-agents.ts` inherits these defaults only for missing project
choices, preserving explicit null resets and leaving personas project-scoped.
The existing model-preference scenario first reproduced Codex → Claude → new
project → Codex losing both choices. It now covers inheritance through the native
connection request, loaded defaults, project overrides, and explicit resets.
Host preference checks cover durable per-agent defaults, unrelated writes, and
project removal. J01's controlled full-window scenario also chooses a native model
and effort, uses another agent, reopens in a second project, switches back, and
sends a completed reply with the remembered choices. These fixtures do not prove
real-provider model availability or packaged behavior on the reporting installation.

**Codex approval duration and mode changes (2026-10-29):** `codex-approval.ts`
and `codex-session-runtime.ts` expose native session/persistent choices, return
MCP persistence in `_meta.persist`, and apply a changed reviewer on subsequent
turns without replacing the thread. The shared permission card carries the scope
through the session command and socket adapters. Controlled Codex RPC tests cover
session grants, offered/unavailable MCP durations, one-off approval, rejection,
and Auto/Ask/Plan/Edit transitions while preserving resolved workspace policy.
The existing workspace scenario exercises both duration buttons and the mode
switch; socket adapter and transcript checks cover presentation and transport.
An isolated Electron Story pass inspected normal and compact Computer Use cards,
verified four non-overlapping buttons, and resolved Always allow in both layouts.
These fixtures do not establish real Computer Use app-grant persistence or native
automatic-review behavior with a signed-in account.

**Agent choice across projects (2026-10-29):** `server/routes/agent-preferences.ts`
persists the last selected Agent with the project choice. The renderer's
`project-agents.ts` uses it only when the project has no choice; the workspace
hook reads on entry. Existing preference tests cover restart inheritance,
project overrides, explicit Default, write failure, and unrelated model/effort/persona
updates; the hook covers another window choosing while Welcome is open.
J01's controlled onboarding scenario also sends a completed first reply in a
second empty project with the inherited Agent, without repeating setup or login.
An isolated macOS Electron source pass selected Claude, inherited it in a second
empty project, then selected Codex and inherited that in a third. Returning to the
first project retained Claude; an explicit Default selection was inherited too.
This verifies selection and persistence, not real-provider subscription access;
packaged Windows/Linux behavior remains unverified.

**Codex model and effort continuity (2026-10-28):** cached picker catalogs no
longer clear saved selections. `codex-session-runtime.ts` honors explicit model
overrides on reconnect and preserves them when discovery omits a model or a turn
rejects it; rejection no longer retries on Default. Thread start/resume publishes
native reasoning effort through the typed models event, so history does not show
the catalog's Medium in place of native High. Composer effort resets and model
changes that reset effort reconnect with the intended value. Existing host tests
first reproduced catalog substitution, missing restored effort and automatic
retry; renderer preference/runtime/adapter tests cover cache omission, restored
effort, reconnect and explicit reset. Real-provider and packaged reproduction on
the reporting installation remain unverified; controlled tests do not establish
provider availability or native persistence across every installed CLI version.
Validation passed 72 host/protocol checks, 48 focused renderer checks, core tests,
host/renderer types, builds, Electron built-output smoke, and documentation checks.
The wider Agent run passed 502 tests and timed out on 15 UI cases during concurrent
validation; rerunning those suites with one worker passed all 29 UI tests. A live
Story browser pass selected another model and High. The first core command was
blocked by a concurrent Documents test's nullable-value type error; after that
file was corrected, renderer types and the core tests passed separately.

**Intentional window retirement (2026-10-27):** all four runtime disposals mark
intent before socket closure. Main retires the host window after successful saves
and before destroying its renderer; failed saves retain live sessions, and failed
host cleanup cannot pin a saved window. Telemetry regressions cover all four
adapters, explicit client close, unexpected 1001 closure and socket errors.
Lifecycle tests cover blocked saves, repeated closes and update approval; the
real Electron lifecycle fixture uses the actual renderer adapter to verify
host-socket retirement precedes window destruction without an error. A shared
clean-close reason distinguishes retirement from bare 1000 and unclean 1006;
existing terminal failure messages remain intact. These controlled checks do not replace a packaged/provider session
on the reporting installation.

**Composer action while running (2026-10-27):** `input-message-actions.tsx`
uses one action: Stop for an empty running draft, or Send now / Queue message
when the draft can be submitted. The extra secondary Stop duplicated the action
and rendered its inline square at zero size. `input-message.test.tsx` covers
empty-to-draft-to-empty transitions for steering and queued delivery, Stop and
submission callbacks. The built `Queued` Story reproduces the old gray circle;
browser review checks the surviving square's visible dimensions and action
switching. This is controlled renderer evidence, not a real-provider turn.

**Composer position after approvals (2026-10-27):** the transcript scroll area
in `ui/workspace.tsx` is also the containing block for its absolutely positioned
accessibility labels. Without it, those labels escape the transcript's clipping
and add scrollable overflow to the outer chat pane, which can move the composer
when the browser reveals a decision. `RepeatedApprovals` in `workspace.stories.tsx`
exercises five consecutive approvals with long edit previews in a short window.
A real-browser comparison failed on the old layout (468px scroll height in a
448px pane) and passed with the fix, preserving pane scroll offset and composer
position. The Story's geometry assertions need a real browser; the DOM test
runner alone does not establish layout correctness. Packaged reproduction on
the reporting installation remains unverified.

**Startup readiness in the composer (2026-10-26):**
`hooks/use-agent-catalog.ts` follows running preparation until the host reports
a settled state. `use-agent-catalog.test.tsx` covers settlement, failed-read
Retry and disposal; `workspace.catalog.test.tsx` reproduces the startup race
and checks restored model/thinking/permission controls, draft and explicit
choice retention, no automatic session or send, and a newer provider choice
surviving another runtime's completion. `StartupChecking` provides a delayed
catalog in the mounted workspace for visual review. A driven built-Storybook
pass observed only Provider before the three-second check settled, then the
permission and model/thinking controls appearing without an action. The draft,
file mentions and attachment remained; the restored panel changed High to
Medium and GPT-5.3 Codex to GPT-5.2 Codex successfully. Renderer coverage,
accessibility, types, both builds and structural gates passed; lint passed
after correcting a shadowed callback parameter. Host types and Electron
boundary tests passed. These controlled catalogs do not establish native
provider availability or packaged startup timing.

**Network-service 1006 evidence (2026-10-25):** an isolated real Electron pass
killed only Chromium's network service, causing three simultaneous 1006 closes
while the renderer and host survived. The production session runtime and
adapter resumed all three native session identities, preserved drafts and sent
only the three original prompts. Existing recovery needed no change. Main now
distinguishes network-service exits from generic Utility exits, retaining clean
exit observations as well as errors. The registered lifecycle smoke verifies
three real socket closures, the correlated native record and a new connection.
Unit checks preserve privacy for arbitrary utility names.

Additional production correlation established that the 2026-10-24 15:19 UTC
trio had no active turn; the last Claude turn completed at 15:10:42 UTC and
Codex had no pending RPCs. Codex retirement followed socket closure. No matching
native exit record identifies the original cause. Windows OpenCode's two failed
history starts emitted no stdout/stderr; later starts on the same installation
succeeded in 9.5 and 3.7 seconds. The existing bounded startup retry and cleanup
fixtures remain applicable; the unavailable device's initial stall is unproven,
so neither timeout budgets nor prompt replay policy changed.

**Allowance deadline and remaining telemetry (2026-10-25):** a real HTTP fixture
reproduced an allowance request staying pending indefinitely after response
headers because `server/hosted-account.ts` supplied no request deadline. A
single twenty-second signal now covers token waiting, headers/body and the
existing 401 refresh. Regression tests preserve credentials, stop a stalled body,
return before a shared refresh completes, and prevent a late second usage call.
An isolated actual Electron main/host plus built renderer reached Settings; an
injected stalled allowance returned 502, a subsequent healthy fixture returned
200, and the same saved session survived. This establishes bounded recovery,
not a repair of the production Windows connection timeouts or macOS network changes.
The J01 validation matrix covers this change too.

The latest 24-hour telemetry review also found three concurrent packaged macOS
2.17.0 WebSocket 1006 reports at 2026-10-24 15:19:35 UTC, with no matching native
exit record in the queried window. Three preceding shell-tool errors retain only
`tool_failure_kind=unknown`. Their original causes remain unproven; no automatic
prompt replay or speculative runtime change was added. Old-version updater
network failures cannot verify the later source timeout fix. No fresh backend
incident followed the model-stream deployment in the reviewed interval, apart
from its explicitly marked deployment probe; that short interval is not proof
that upstream model failures are eliminated.

**Idle 1006 investigation (2026-10-24):** two packaged macOS 2.17.0 connections
(Codex and Claude) closed with 1006 at 02:42 UTC after both preceding turns had
completed. Their shared window/host identity has no corresponding exit record;
Codex process retirement followed the socket close. Missing exit records do not
prove process health, and the affected device is unavailable. An isolated Electron
pass bundled the production session runtime and WebSocket adapter, completed one
controlled turn per agent, then abruptly terminated both real loopback sockets.
Both reported 1006 and automatically resumed their own native session; both drafts
survived and the server received exactly the two original prompts, with no replay.
This establishes controlled idle recovery, not the cause or recovery outcome of
the production incidents. Network, wake and proxy explanations remain unproven.

**1006 lifecycle correlation (2026-10-24):** host socket diagnostics now join
main-process window/renderer observations through window UUID and host instance
UUID. `lifecycle-diagnostics.test.cjs` exercises crash, destroyed-window closure
and clean shutdown; `native-diagnostics.test.ts` drives socket loss and native
spool delivery through the same collector, checks correlation, normal-event
severity and opt-out, and rejects renderer fabrication of lifecycle events.
Unexpected code-zero host exits are retained too. The built Electron boundary
smoke kills a real renderer with an open loopback WebSocket and checks the
spooled PID/window/host correlation after destruction. On macOS Chromium sent
1001 via its surviving network service, demonstrating why a socket code alone
cannot establish renderer health. These observations do not
establish the cause of historical 1006 events; missing records remain unknown.
Pre-commit verification passed 916 host tests, host/renderer type checks,
protocol/Electron checks, documentation/inventory checks, service builds and
built Electron smoke including this real process-exit scenario.

**Codex MCP project attribution (2026-10-22):** `server/agent-mcp.ts` now
allowlists the window and private session variable names in Codex's stdio
`env_vars`. Setting them on the parent app-server alone left the MCP child
unattributed: omitted-folder searches returned `FOLDER_REQUIRED`, and file
operations lost the Chat's project constraint. The generated configuration
stores no session values. `agent-runtime-recovery.test.ts` drives that config
through real stdio MCP and production HTTP/scope handling, with controlled
retrieval: two active Chats in one window search their own projects without a
folder argument; cross-project search/read and retired identities are refused.
The scope assertions compare normalized project paths on every OS. The delayed
pipe-closure fixture waits for a real child exit before testing the retirement
deadline; `extractor-process.test.ts` separately verifies real descendant-tree
cancellation, so Windows taskkill latency is not mistaken for a pipe-state failure.
The Electron smoke runner owns temporary profiles and removes them after the
child exits, with bounded filesystem retries. This avoids deleting Chromium
cache files while Windows still holds them open; the real Electron smoke passed
locally after moving cleanup to the parent.
An isolated Codex CLI 0.160.0 app-server pass through the built MCP launcher
reproduced the original 400 with both headers absent, then returned 200 for
each Chat after the fix, 403 for cross-project search/read, and 409 after
retirement. It used native `mcpServer/tool/call`, no model request, and controlled
retrieval; this does not establish packaged desktop behavior or retrieval quality.
A follow-up built-host pass mounted two real Codex sessions through the production
WebSocket endpoint, then used their identities with native tool-call clients and
the built MCP launcher against a real MFS index. Each omitted-folder search found
only its project's source; cross-project search/read and a closed session were
refused. Host/renderer types, 851 server tests, documentation checks, Electron
tests, and the built-output Electron smoke passed. No live model turn or packaged
desktop journey was exercised.

**Multimodal context admission and recovery (2026-10-21):** The adjacent
stashbase-api estimator separates UTF-8 text/context estimation from media's
financial fallback. Gateway regressions admit 23 small images across history and
a 23-page blank PDF, preserve forwarded bytes, and check content-free context
refusal diagnostics including configuration races. A 33 KB PDF whose compressed
object stream expands to 32 MiB verifies that estimation does not inflate it;
production admission no longer imports a PDF parser. Workerd tests exercise the
same media/text split. Financial media estimates remain approximate and can
under/overestimate costs; these tests do not establish provider token counts.
Gateway regressions now pass actual tokenizer output through the real
`fitAgentOutputBudget` function: one small image, 23 images across history, and a
23-page blank PDF fit low user balances while retaining the full provider input
reserve. Cases also cover output reduction, an affordable full reservation, zero
balance and a text floor exceeding balance. Refusal diagnostics retain the full
and user-funded media shares without content. This fixes the former fake ledger
coverage gap; it does not exercise PostgreSQL locking or live-provider billing.

`server/__tests__/opencode-native-smoke.test.ts` drives the pinned executable
through controlled HTTP 413 responses. For fresh images/PDFs first rejected before
being read, the broker ends the request without compaction or continuation, the
translator marks the turn failed, and an explicit same-session retry still sends
original media. A separate controlled wire-adapter/session-runtime pass verifies
that the failed turn pauses the queue and retains the next prompt without dispatch.
Separate text-only coverage
checks prior text reaching the summary, the current task reaching continuation,
unchanged model selection, successful settlement, and termination if the summary
also receives 413. Translator tests cover unfinished recovery and cancellation.
These are macOS native fixtures, not Momento's historical Windows trace or a
live-provider measurement. Summary fidelity is not established by the fixture.

Focused broker/translator/native tests passed (100), as did API unit/HTTP tests
(243), workerd tests (8), API and desktop host/Electron-boundary types, Node/Worker
builds and documentation checks. The full Agent suite passed 376/377 before the
additional upload-ceiling regression; its installer-capability assertion also
failed in the previous untouched-HEAD reproduction. The upload-ceiling test
verifies a visible terminal error instead of a socket close. No deployment,
packaged Windows pass or real-provider validation was performed.

**Cleanup timeout recovery (2026-10-20):** `agent-process.ts` owns one bounded
retirement attempt and a separate final-closure barrier. A deadline rejects its
original callers with `AGENT_PROCESS_CLOSE_TIMEOUT` while retaining the child;
late pipe/group closure releases that ownership. `opencode-runtime.ts` releases
closed runtime owners after that barrier and startup settlement, and shutdown
attempts every owner and the broker even if one fails. Session/window/project
and spare expiry/replacement/discard observe their detached promises, fixing the
unhandled-rejection paths also present in v2.16.11.

Each managed OpenCode, Codex and Antigravity termination attempt emits
`agent_runtime_stop_result` with purpose, initiating reason, a stop attempt ID,
original process-start ID, elapsed time, exit/pipe observations and termination
snapshot. A timeout and its later `closed_after_timeout` share that attempt;
the latter does not rewrite the failed operation. Windows snapshots retain
bounded filtered taskkill stderr, exit/spawn failure and fallback result;
process-tree presence is reported only where it is observable. The lifecycle
owner marks its reported Error so outer warning/error collectors do not count
it again. Unrelated errors still report normally.

`agent-runtime-recovery.test.ts` holds a real child's close notification past
the deadline and verifies one timeout, retained failure and eventual release.
The native OpenCode smoke repeats late closure through the actual runtime owner:
shutdown initially rejects, other owners still close, and shutdown after final
closure no longer retains the timed-out runtime. Windows command outcome tests
cover success, spawn/exit failure and one fallback with credential filtering;
telemetry tests cover typed delivery, deduplication and opt-out. The complete
local release gates passed after correcting a formatter issue and isolating the
file-mutation test's configuration. A strict-unhandled-rejection pass against the
built host delayed real child close notifications beyond the four-second deadline
at six detached cleanup entries. The host kept serving HTTP, emitted six paired
timeout/late-close records, released runtime ownership, and retired a new child
normally. These controlled failures do not establish why the reported Windows process exceeded its deadline;
the incident's original stack and a packaged Windows reproduction remain gaps.

**Background confirmation notifications (2026-10-17):** The agent attention
projection observes inactive sessions as well as the visible chat. Electron owns
background detection, coalescing, durable opt-out, and notification lifetime via
the product-independent notification center. The protocol/catalog register event
kinds; agent composition maps opaque IDs back to live pending targets. Click
navigation rechecks the pending request and focuses its decision card.
`electron/notifications/*.test.cjs` covers sender isolation, foreground suppression,
coalescing, stale clicks, cancellation, navigation/crash/close, opt-out and delivery
failure. Center tests exercise independent producers with overlapping IDs and
window-wide retirement. Native adapter contract tests exercise macOS, Windows and
Linux branches, Windows installed shortcut identity, and unavailable desktop
services; these mocks do not establish native behavior on those platforms.
Renderer attention tests cover inactive chats, subsequent requests,
historical requests and stopping; Settings tests cover opt-out, peer updates and
failed persistence. The transcript focus regression includes a pending card older
than its normal 200-block page. The full renderer gate passed architecture,
coverage, accessibility, size, duplication, lint, format, types and both builds;
the initial unused-export and rejection-comment failures were corrected, with
unused-code, conventions, format, lint and types rerun successfully. Host types,
Electron contracts, docs, inventory and the built Electron smoke passed.

An isolated macOS Electron pass used the production native adapter, notification
IPC/preload, attention composition, Settings group and transcript with controlled sessions. It
reported two native `show` events, verified foreground suppression, injected the
native click event to select an inactive chat and focus its approval, clicked Allow
through the rendered card, and verified cancellation and durable opt-out. The focused
card and Settings layout were inspected by eye. This establishes local integration,
not a real-provider turn or a physical notification-center click. OS notification
permission is not exposed reliably by Electron; support does not establish that
banners are permitted. Packaged notification presentation on macOS, Windows and
Linux remains unverified.

**Task outcome notifications and category controls (2026-10-17):** The same
notification center, renderer platform adapter and native driver now carry
`agent-completed` and `agent-failed` events. `outcome-notifications.test.ts`
exercises real session transitions for successful turns, failed turns, retries,
automatic queue continuation, unexpected exit, startup failure, startup stop and
stop timeout followed by a failure. History and repeated terminal signals do not
announce results. UI focus coverage includes a result before the ordinary
transcript page and keeps that page exposed after focus is consumed. IPC tests
exercise category isolation, durable preference fields, peer-window updates,
revocation and the absence of foreground/disabled outcome replay. Settings tests
exercise independent category controls, master opt-out and persistence failure.
These controlled tests do not establish provider or packaged OS behavior.
The renderer's full gate passed coverage, accessibility, architecture and both
builds; its size/lint failures were corrected by extracting transcript pagination
and removing unsafe test assertions. All ten affected gates then passed again.
Host types, Electron contracts, docs/inventory and the final built Electron smoke
also passed. A macOS Electron pass reused the production platform adapter,
notification center, outcome composition, Settings and transcript with controlled
session events. It observed three native `show` events; simulated native clicks
opened the correct completion/error blocks, whose layouts were inspected by eye.
It also exercised foreground suppression without later replay, active stop,
independent category controls, re-enable without replay and master opt-out through
the rendered controls. Physical notification-center clicks and packaged Windows,
Linux and macOS delivery remain release-checklist evidence gaps.

Notification settings reuse the shared Settings groups, rows, switches and quiet
retry messages; OS guidance sits below the list and disabled categories recede.
An isolated macOS Electron pass rendered the production General panel alongside
Software updates and inspected light, dark, disabled and persistence-failure
states. It exercised the real platform adapter and preference IPC, with a
controlled save failure. Native notification titles identify the event while the
body names the project and chat; OS chrome supplies the application identity.
The notification host tests and renderer gate cover this presentation change.

**Notification permission recovery (2026-10-17):** General settings now retains
platform-specific instructions and a system-settings action even when app
notifications are disabled. The existing platform adapter maps host-owned
macOS/Windows/GNOME/KDE destinations; unknown Linux desktops and missing launchers
fall back to manual steps. Host tests exercise fixed destinations, launch failure,
sender rejection and focus-driven availability refresh without notification
replay. Settings tests exercise launch retry, unchanged preferences and refreshed
manual guidance. The full renderer gate, 21 notification host tests, 96 protocol
tests, host boundary types and built Electron smoke passed. An isolated macOS
Electron pass used the production General panel, adapter, preload, IPC and native
settings launcher: clicking opened the OS Notifications page, verified through
its accessibility tree. Returning refreshed availability; controlled launch
failure and manual fallback were exercised, and light/dark layouts inspected.
System permission was not changed or inferred. Packaged Windows/Linux settings
navigation and denied-to-allowed recovery remain release-checklist checks.

**Message alignment (2026-10-17):** The notification focus wrapper in
`ui/transcript/transcript.tsx` now preserves the column flex layout required by
right-aligned user bubbles. An isolated Electron render of the production
transcript and built CSS reproduced a 268px right-edge gap at a 1000px window
(and 106px at 420px); changing only the wrapper layout removed the gap. Short
and wrapping prompts retain the 72% width cap without horizontal overflow.
This geometry check uses the actual browser layout; DOM-only transcript tests
do not establish visual alignment. The renderer gate passed its other 11 checks;
coverage initially hit widespread test and worker-start timeouts. Repeating only
coverage with two workers passed all 341 files and 1,695 tests without relaxing
assertions or timeout limits.

**Menu-bar icon weight (2026-10-18):** `scripts/icons/status.mjs` uses
tray-specific optical stroke weights for both standard and Retina assets,
slightly lighter than the padded small app icon. The transparent menu-bar mark
fills more of the native canvas, with a smaller separated
attention dot. Electron-rendered comparisons covered idle, working and attention
on light/dark surfaces, plus enlarged colored and template assets. A native
macOS Tray loaded all three template variants with 1x/2x representations; the
icon and documentation checks passed. This changes presentation only; native template tint and notification lifecycle are unchanged.

**Session menu and attention badges (2026-10-17):** `desktop-sessions.ts`
projects retained session selectors through the existing platform adapter into
the native menu-bar/tray. Running contains working, waiting and stopping sessions,
including work in inactive chats; completed, failed and stopped work is removed.
Notification switches do not affect this list. The native presenter accepts
ordered sections with stable row identities; Upcoming presentation is specified
but there is no scheduling owner or next-run data in the current application.
A controlled second section exercises section-scoped activation and removal;
it does not establish scheduled-task integration. The notification center separately
tracks background attention for Dock/taskbar marks. Renderer tests cover inactive
sessions, deduplicated updates, request focus and stale session retirement; host
tests cover multiple owners, notification opt-out, badge clearing, stale menu
callbacks and missing tray support on Linux. The 26 notification host tests,
protocol suite, host boundary types, icon/package-input checks and built Electron
smoke passed. The renderer gate passed after correcting the adapter placement
and rerunning lint plus coverage; one existing workspace test timed out on the
first coverage run and passed on retry. The later section-menu refinement passed
all 12 renderer gates without retries. An isolated macOS Electron pass used
the production session projection, platform adapter, preload, IPC, Tray and
badge driver. It observed a real Dock dot and waiting menu, invoked the native
menu callback, verified the owning chat and request-heading focus, and confirmed
Stop cleared the dot. A second isolated pass with the section-based menu verified
that a finished session leaves Running and the empty state appears; the existing
production adapter and native menu callback still focus the pending card.
Template and colored tray assets were inspected at normal and enlarged sizes;
colored attention uses the app's fixed badge-red with a transparent separation
around the dot, while macOS retains native template contrast. Physical menu clicks, packaged Windows overlays and Linux
tray/launcher availability remain explicit release checks.
**Native stream EOF and tool diagnostics (2026-10-24):** The OpenCode panel now
fails and retires an unexpectedly completed event stream instead of leaving a
turn running indefinitely. `opencode-agent.test.ts` reproduces the missing error
and socket closure on the baseline, checks one failure/exit without prompt
replay, and covers EOF racing native initialization. `server/telemetry.test.ts`
checks fixed tool failure kinds survive delivery while private tool input/output
never does; recovered tool failures still permit a successful turn. Historical
read-tool failures contain no error reason, so their cause remains unknown.
These checks do not identify the cause of the historical Windows WebSocket 1006.
A separate local runtime pass used the pinned SDK against a controlled HTTP SSE
server and a real WebSocket: EOF delivered one error and exit, closed the socket,
aborted the native session and retired its runtime once, with exactly one prompt.
The 908 host tests, three bundled OpenCode checks, host types and Electron
protocol/boundary/smoke checks passed; this does not exercise the affected device.

**Startup recovery and correlation (2026-10-18):** `opencode-startup.ts` removes
startup listeners and makes failure rejection wait for process retirement.
`opencode-runtime.ts` retains single-flight ownership through cleanup and fences
failed cleanup; only history listing requests one retry on timeout/early exit.
`opencode-agent.test.ts` covers split ready output, timeout evidence/listeners,
real child retirement before retry, bounded retry and cancellation/prerequisites.
The native smoke checks concurrent history readers share a startup and successful
chat/prewarm/history samples retain attempt IDs and timing. Codex transport/session
regressions correlate process exit and socket/client closure with connection ID,
process generation, pending RPC names and credential-filtered exit evidence,
without late skills errors. Telemetry tests preserve a search-tool failure followed
by a successful turn and delivery/opt-out of startup samples. These fixtures do
not reproduce the reported Windows cold-start failure or establish that a
WebSocket 1006 was caused by network loss.

Validation: agent tests (369), telemetry/native-diagnostic/error tests (43), native
OpenCode checks (3), Electron/protocol checks, host/renderer types, docs, service
and renderer builds, and the built Electron smoke passed. An isolated macOS
Electron run used the built host/renderer with controlled child failures: a silent
first child timed out at 15 seconds, closed, and was replaced 3 ms later; history
finished loading. Two controlled early exits exhausted the retry and kept
"Chats unavailable for Codex, Default" with Retry visible. Manual Retry launched
a third child, returned Default history HTTP 200 and removed Default's failure;
the unrelated Codex prerequisite failure remained. No chat was submitted.
`profile:default-session` (two runs per label) measured cold startup 1078–3629 ms
before and 1184–2125 ms after; next-chat startup was 17–28 ms before and 15–25 ms
after. This small local fixture comparison establishes no Windows performance
improvement; startup deadlines remain unchanged. Packaged Windows and production
telemetry delivery still need post-release evidence.

**Closed startup and duplicate diagnostics (2026-10-16):** Codex regressions close
the socket during model/skill discovery and verify no subsequent requests,
readiness or failure diagnostics. OpenCode's error/exit pair still reaches the UI
but reports one original failure. Real child-process fixtures cover startup
exit-code and signal diagnostics with credential-filtered stderr. These checks
establish local lifecycle/diagnostic behavior, not the cause of production
WebSocket 1006 disconnects or OpenCode startup termination.
`pnpm test:opencode:native` also passed its three checks using the actual bundled
runtime and a local fixture gateway, including SDK sessions and warm-runtime reuse;
this does not establish real-provider behavior.

**Auto review refunds (2026-10-15):** All ten affected production refunds aligned
with proxy HTTP 499 and local Bash permission starts by 5.118–5.163 seconds. The
published Auto review's five-second deadline aborted an already dispatched model
call; the old gateway misclassified this as a provider connection failure.
`hosted-agent-broker.test.ts` reproduced that disconnect over real local HTTP.
The broker now separates permission decision expiry from bounded response draining,
preserves the original accounting turn, and never lets a late ALLOW grant access.
Focused tests cover manual fallback, credential wait cancellation, and ordinary
turn cancellation. The bundled OpenCode smoke drives slow review, manual approval,
a subsequent turn, and late response completion without a disconnect. A separate
local broker/gateway/PostgreSQL pass confirms one exact settlement (363,000,000
picodollars), matching original turn/window totals, no hold, and no waiver after
the decision expires. Production Gemini and Haiku short-generation probes
completed; the actual synthetic Gemini permission review took 9.52 seconds,
exceeding the old cutoff. Three approved probes cost US$0.00071075 in total,
outside user allowance. A later 2.16.4 Haiku request recorded
`client_stream_interrupted` 5.353 seconds after its Bash tool part appeared;
subsequent requests settled without account lockout. These probes do not establish
arbitrary long-request reliability or a live packaged Auto-review billing journey.
The [2.16.5 source CI](https://github.com/liliu-z/stashbase/actions/runs/38748865835)
and [coordinated release](https://github.com/liliu-z/stashbase/actions/runs/38751098272)
passed on all four native targets. All 15 public app assets, three update metadata
files and sidecars, the separate eight-asset extractor set, and Homebrew were
verified. The downloaded arm64 DMG matched both update metadata and the cask;
strict/deep codesign, Gatekeeper, and stapler passed locally. On macOS 27.0.1,
the official 2.16.5 app launched with telemetry unavailable, displayed its version,
loaded General and Agent settings plus account/subscription state, and quit
cleanly. This manual pass made no model call; other-platform manual UI and real
N-to-N+1 update journeys remain unverified.

**Default stream interruption recovery (2026-10-14):** Local native logs showed
five `agent_provider_unavailable` stream errors after completed file reads.
The bundled runtime's retry parser labels unknown errors containing `unavailable`
as "Provider is overloaded"; this does not establish provider capacity as the
cause. The broker now bounds recovery before output to one additional call,
sharing the existing empty-response budget, and makes subsequent interruptions
terminal without replaying completed tools. After output, it preserves deltas
and emits a terminal interruption. Diagnostics retain the original gateway cause
even when the broker cancels the failed stream. The native pass also exposed
missing `message.part.delta` handling: the translator now delivers text and
reasoning before completion and deduplicates final cumulative snapshots.
Broker regressions cover fragmented UTF-8/SSE, combined output/error frames,
large output, mixed failures, retained tool context and accounting identities;
translator tests cover live deltas and late-turn isolation. The native fixture
exercises failure after a real file write and after visible partial output,
then continuation in the same session. Production SSH was unavailable, so the
original upstream error and real-provider recovery remain unverified.
Validation passed `pnpm test:agent` (334 tests), `pnpm test:opencode:native`
(3 tests), `pnpm typecheck:host`, `pnpm test:docs`, and `pnpm build:server`.
No packaged UI pass was performed for this host-only change.

**Accounting recovery refusal (2026-10-14):** A production Windows 2.16.3
diagnostic confirmed `agent_usage_recovery_limited` / HTTP 429 after native
retries. `agent-turn-failure.ts` now classifies its message as a rate limit,
preserving the service explanation instead of leaving the final error unclassified.
The `opencode-agent.test.ts` regression first reproduced the missing classification;
it covers network and accounting retry notices, the final classified error, and
failed native-idle settlement. This does not establish which accounting threshold
the account reached or restore its hosted admission.
Validation passed the 77 translator/classifier/broker tests, host types, and
documentation checks. No packaged or real-provider recovery pass was performed.

**Missing Codex history prerequisite (2026-10-14):** `codex-history.test.ts`
exercises list/read/rename/delete with no discoverable executable, no child
launch, and the shared HTTP envelope's `412 AGENT_NOT_INSTALLED`. Existing native
ownership checks remain covered. This does not establish real Windows CLI
discovery or authentication.
The same built-host pass returned that prerequisite for Codex while Claude's
history remained HTTP 200, using controlled absent-CLI discovery and isolated
empty native history.

**Turn diagnostics (2026-10-14):** `server/telemetry.ts`, `telemetry-state.ts`
and `telemetry-turns.ts` own durable pending turns, reserved terminal admission,
identity/version continuity, terminal deduplication and unknown-result recovery.
Actual runtime acceptance now establishes a missing turn independently of renderer
intake, marked with host origin/time. The shared adapter test covers all four runtime
identities, late renderer starts, host results and an intervening account switch;
recovery coverage also starts from host acceptance. Unknown results still cannot
manufacture starts, and telemetry failure never controls task execution.
Schema 8 terminal records include `tool_summary`: successful/failed observed
tool results by category, with persistent call-ID deduplication and a bounded
1,000-result limit. Host acceptance establishes a zero summary; missing summaries
in earlier or renderer-only observations are not zero work. Recovery retains the
same counts, and saturation marks them as a lower bound. Existing tool failures
still identify individual calls; successful calls add no separate queue events.
Focused telemetry scenarios cover duplicate results, a failed call followed by
a successful call, cancellation, bounded counts, restart recovery and refusal of
renderer-supplied summaries. These do not establish cross-turn task recovery.
`error-reporting.ts` observes native lifecycle facts; the hosted model diagnostic
owner emits request failures independently of native forwarding. Renderer context
reads carry explicit turn IDs and socket errors share connection IDs, including
later turns after a prior server error. Manual retries rejected by context
validation now settle as blocked. `server/telemetry.test.ts` exercises restart,
account change, offline saturation, opt-out, update shutdown, native process exit,
socket loss and tool recovery. Renderer regressions exercise rejected retry IDs
and second-turn disconnect correlation. Model-stream tests verify source reporting
and upstream request IDs without content. These controlled tests do not establish
Daniel's historical cause, production PostHog receipt, or saved alert configuration.

Validation passed `pnpm check:web` (all twelve gates), `pnpm test:agent`,
`pnpm typecheck:host`, `pnpm test:electron`, `pnpm test:electron:smoke:built`,
`pnpm test:opencode:native`, the focused telemetry/client-error/shutdown suites,
and `pnpm test:docs`. The built renderer's Interrupted Turn Story was inspected
by eye: partial output, unknown-outcome explanation and explicit reconnect action
remain visible. That static fixture does not prove reconnect execution. The native
OpenCode run uses a local fake model gateway; desktop smoke uses isolated fixtures
and disables collection. No test events were sent to production analytics.


**Default skill scope (2026-10-13):** `server/opencode-runtime.ts` disables native
external/upward config discovery and supplies project-relative skill paths plus
the project's instruction-file path. The pinned OpenCode smoke first reproduced
ancestor skill metadata entering a non-Git project's model request. It now uses
the production environment builder and proves that ancestor skills are absent,
all four project skill locations remain discoverable, project instructions reach
the model, and a native skill invocation loads its body only when called. This
controlled gateway test does not establish provider skill selection quality or a
packaged desktop run. Windows source CI exposed a native skill call waiting for
OpenCode's ripgrep lookup. The runtime now supplies the pinned Windows binary on
PATH, and packaging stages it as an explicit resource. The source fixture checks
native invocation; packaged smoke checks the binary and a fake-gateway turn.
Packaged skill invocation and real-provider skill selection remain unproven.

**Default short-term limit presentation (2026-10-13):** A local native log
recorded repeated identical short-term limit errors during one model call;
the retained assistant reply later completed. The OpenCode translator now shows
an identical retry reason once per turn while preserving native retries, and
the final refusal classifies as a rate limit. The hosted broker now forwards the
gateway's `Retry-After` header on 429/503; a broker test first reproduced its
loss. Targeted translator and classifier tests reproduce the original repetition
and missing classification. The live gateway status/code and an end-to-end
packaged retry were not captured.

**Model failure diagnostics (2026-10-13):** `hosted-agent-diagnostics.ts`
observes bounded SSE metadata and original stream failures; the OpenCode
translator joins gateway request identity, native message ID, finish reason and
token counts to the turn's error diagnostic. Broker and panel tests cover unknown
completion, malformed/error frames, broken streams and turn isolation without
capturing prompt or generated text. These controlled streams do not establish a
live provider's error shape or packaged delivery.

- **Default Crew (2026-10-13):** The main model comes from `/v1/agent/models`;
  selected members come from `/v2/agent/tools`. `agent-tool-catalog.ts` owns the
  account-scoped ETag cache; `default-agent-tools.ts` owns chat choices, new-chat
  defaults, briefing, and catalog/turn snapshots. `/api/agent-tools` requires a
  chat identity. `opencode-runtime.ts` registers selected members through MCP,
  disables native sub-agents, and permits text-only Crew work in Plan. Published
  descriptions define responsibilities; common prompt rules honor the current
  request and avoid unsolicited rewrite cycles. `agent-crew-history.ts` persists
  call attribution, carried by socket/history protocols to `role-call.tsx`.
  `use-agent-tools.ts` owns optimistic per-chat choices, serialized saves,
  rollback and visible errors; saving blocks Send.

  Catalog/MCP tests cover availability, model selection, chat isolation, defaults,
  removed members, ETag/account isolation and immutable turn snapshots. Broker
  tests cover v2 selection headers, root budgets, sign-in retry, refusal codes,
  and rejecting length-limited or incomplete SSE output. Panel tests cover
  selected MCP registration, Plan, active-turn ownership and persisted attribution.
  The reproduced Stop/version-refresh race is fixed by capturing cancellation and
  turn identity before preparation; a regression proves no old-call retry after
  Stop. Renderer hook tests cover failed-save rollback, retry, overlap prevention,
  and late responses after changing chats. Transcript tests/Stories cover running,
  successful and failed Crew cards with complete results and fixed model labels.
  A built macOS desktop with an isolated empty project and the live deployed
  gateway was driven through discussion (no member call), one Writer draft
  (Opus: 563 input/757 output tokens), and Plan review of that unsaved draft
  (one Reviewer call, GPT-6.1 Sol: 443 input/460 output tokens; no rewrite).
  Writer and Reviewer cards and complete results were inspected by eye.
  A subsequent live Writer call was stopped: the card showed Stopped, history
  reopening retained its model/status, and the next turn replied successfully.
  Changing a new chat to Reviewer alone left the old chat's Writer/Reviewer
  choice intact. Native abort events now settle as cancellation after the abort
  acknowledgement, with a focused regression for the error/idle ordering.
  This pass also exposed and fixed the MCP launcher's lost custom host port;
  the live round trip succeeded on port 8196 after the fix. The live gateway
  still served catalog 1; service migration 23 for responsibility-only member
  descriptions is committed separately but deployment remains unverified.
  These examples establish the exercised routing and handoff, not general
  writing quality, pricing, or provider cache efficiency.
  A root snapshot lives only for its turn; process restart does not resume a turn.

- **Low-credit calls (2026-10-11):** the hosted API's account-locked reservation
  reduces output to fit account/monthly and turn capacity while retaining input
  cost. API ledger tests cover positive remaining balance, concurrent last-credit
  reservations, release, and turn limits; gateway tests verify the provider gets
  the approved ceiling. `server/__tests__/hosted-agent-broker.test.ts` covers
  accurate insufficient-credit/turn wording through the OpenCode translator and
  retained recovery kinds. These fixtures do not establish real-provider response
  quality or complete agent tasks with very small output budgets.

**Default empty completion (2026-10-11):** the reported local transcript records
successful reads followed by an assistant message with zero output tokens,
no text/tools, and `finish: unknown`; the adapter previously reported success.
A sanitized panel replay failed before the fix. `hosted-agent-broker.ts` now
retries only an empty model call once, preserving tool results and turn identity;
it never replays output or executed tools. `opencode-agent.ts` fails unknown
completion and retains error/turn attribution through native cleanup. The pinned
OpenCode smoke drives a real MCP write, an empty continuation, and successful
recovery with exactly one write; two empty attempts produce a visible failure,
and the same session accepts another turn. Broker tests cover fragmented SSE,
streaming output, bounded buffering, cancellation, and accounting identity.
The built desktop renderer and host were driven in Electron with an isolated
project/account fixture and controlled model transport: one real MCP write,
empty continuation, recovered reply, and changed-file card; a subsequent pair
of empty responses showed the incomplete-turn explanation and retained the file.
Both settled surfaces were reviewed by eye with telemetry unavailable.
This establishes local recovery and native protocol behavior. The original raw
upstream response was not retained, so the provider-side cause of the empty
generation remains unproven; no live-provider or packaged desktop pass is claimed.

**First-send setup diagnostics (2026-10-09):** the access prompt previously
replaced a known bootstrap failure with a generic connection sentence.
`infrastructure/catalog-api.ts` now retains its stage and explanation;
`application/connect-agent.ts` carries them in `AgentSetupRefused`, and
`application/failure-messages.ts` presents the failed step and diagnostic in
`ui/access-dialog.tsx`. Transport causes and unexpected Error messages likewise
remain visible as plain text. The dialog wraps details, expands for failure,
and bounds its height without truncating the message. A mounted regression
first failed on the generic sentence, then passed with the download reason,
retained draft, and successful retry; the wire adapter covers MCP details and
the `SetupFailure` Story covers multiline composition/accessibility. A built
macOS Electron pass used an isolated home, empty project, and controlled Codex
executable: its login failure displayed the step, auth host, and ECONNREFUSED
in the same prompt; Not now preserved the draft. This proves error propagation
and UI recovery, not the original reporter's underlying Codex failure.

**Native connect progress and sign-in recovery (2026-10-23):** reports from
2026-10-16 to 10-22 showed a first-send prompt that said only Connecting for
minutes, Windows Codex npm shims under a profile path with a space failing
their sign-in check, Claude sign-ins waiting out ten minutes on Windows, and
runtimes that read ready only after restart. `server/agent-cli-launch.ts` now
starts the agent CLIs (Antigravity's sign-in aside); `agent-cli.test.ts` pins the cmd.exe command line for a
spaced `codex.cmd` path and double-escaped metacharacters. `loginToAgent`
skips the browser for a signed-in runtime, polls status beside the login and
retires a login that keeps waiting, captures the printed sign-in page, and
keeps query-stripped output on timeout; a refusal from a running conversation
makes the next sign-in wait for the login itself. A failed first install
reuses an executable that passes `--version`. Installer tests drive POSIX fake
CLIs through each login path and the coordinator through refusal and retry.
The renderer maps the running phase to `Agent.preparation`; `connectAgent`
reports each polled step, and `access-dialog.test.tsx` mounts the workspace
through a sign-in step to the resumed send. Settings rows offer the same page.
The `SetupProgress` Story covers composition. A built macOS Electron pass with
an isolated home and a fake `codex` whose login signs in after eight seconds
and never exits showed Checking, then the sign-in step with elapsed time and
the page link within one second, closed at nine seconds with Codex ready, retired
the login process, and continued the retained send. Not proven: the escaping on
a real Windows cmd.exe, real Codex/Claude login output and callbacks, and a
packaged pass.
Sign-in reports `authenticating` only for the browser step; StashBase's own
checks before it are `configuring`, so Stop is offered only while the reader
is waited on, and a stop that lands in a check reads as stopped. A send while a
sign-in already runs follows it (`connectAgent`) instead of being refused, and
Stop waiting keeps the answer busy until the service has retired the login
(`connect-agent.test.ts`, `access-dialog.test.tsx`, installer tests). A
followed sign-in that ends without signing in is reported, not restarted, and a
stop that finds an update or background connection leaves it alone.
**Gap:** signing in again after a refused credential disables status polling
and the after-exit check, so a CLI that keeps waiting after a successful
browser sign-in still waits out the 10-minute limit. Antigravity's sign-in
launch does not yet go through `agent-cli-launch.ts`. Stop carries no attempt
id, so a late stop can still end a newer sign-in started in another window.
Chat first-send now follows Antigravity's sign-in retry (2026-10-26); the
adapter and built-app evidence are recorded in J01.

**Real CLI connect pass (2026-10-23):** a source host with an isolated home and
real CLIs, its browser launch intercepted, exercised the new-user path over
HTTP. Signed-out `claude auth status` (2.1.280) and `codex login status`
(0.160.0) exit 1 with the output `agentIsAuthenticated` expects; startup read
both as installed and signed out. Real `claude auth login` opens a loopback
callback page but prints its provider-redirect page, which ends by asking for a
pasted code that the stdin-less login can never receive. The prompt had offered
that page as its sign-in link. `agentSignInUrl` now offers only a complete
printed page whose `redirect_uri` is loopback or absent. Codex's printed page
redirects to `localhost:1455`; this is established from the binary's
strings, not from a login run. The corrected host showed Claude's browser step
without a link, opened the loopback page, and Stop retired the login. In a
fresh home, the bootstrap route ran the official Claude installer (2.1.309,
27 s) to `authentication-required`. On this Mac, a Homebrew npm Codex without
its platform binary is discovered first. Its sign-in check fails, and Retry
had repeated that check. Connect now verifies such a copy and installed native
Codex 0.164.0 (16 s); Settings offers Retry instead of a failing Sign in
(installer and `agent-runtime-status` tests). No browser sign-in was completed,
no session was started, and Windows/Linux were not exercised.
**Gap:** a Claude browser that does not open has no in-app way on; relaying
Claude's pasted code to its login would provide one. The Claude installer's
PATH advice line can briefly show as the install step, and a runtime-level
model read refused by a broken copy is not repeated for five minutes after
native installation.

**Default Auto and connection latency (2026-10-13):** Default now exposes all
four access modes. `default-agent-permissions.ts` owns the bounded hosted review
for Auto; `opencode-agent.test.ts` covers exact-action grants, manual fallback
for uncertain/failed answers, frozen in-turn options, and Stop rejecting a late
answer across turns. `default-agent-permissions.test.ts` covers the deadline
while credentials remain pending and actions that must still ask. Broker tests
prove cancellation prevents forwarding after a pending token arrives. The
driven pinned-native smoke executes a reviewed `pwd` through the real panel,
broker, and OpenCode process without a permission card, using a controlled
gateway. A separate live-default-model check allowed a synthetic `pwd` request
in 2,513 ms; a synthetic destructive shell command returned to manual approval
at the five-second deadline. Neither check executed a destructive action. These
limited cases do not establish general model risk judgment.

`opencode-runtime.ts` now prepares one unused process and MCP connection after
each turn, with exclusive claim, fresh model/tool comparison, a two-minute
expiry, and window/project/shutdown cleanup. `opencode-warm-slot.test.ts` covers
claim, replacement, refreshed idle expiry, and awaited cleanup. The native smoke proves unique
MCP identities, independent chat disposal, changed model/tool configuration,
and project binding. The repeatable `profile:default-session` scenario measured
three runs per label with the real runtime and local catalog fixtures: baseline
`73aaa4c1` cold 1,160–1,406 ms / next chat 1,115–2,792 ms; current code cold
1,123–1,508 ms / next chat 14–16 ms after a fixed five-second idle interval. These exclude real catalog
network and model latency; the first chat and an expired/mismatched spare still
start cold. Per-call diagnostic tests distinguish headers, first byte, first
visible text, and cached token counts without retaining conversation content.
The native smoke also confirms the production `New Chat` title causes no extra
title model call. Built desktop composition and limited live-provider cases are
recorded above; representative network latency, cache reuse, and hosted Auto
reviewer quality remain unproven for this change.

**Default permissions and desktop commands (2026-10-08):** Default then declared
Ask/Edit/Plan and maps each turn to an OpenCode profile. Edit uses the shared
realpath-aware project-write predicate; commands, deletion, and broader access
still need approval. Plan denies mutating and delegated tools. Auto was
unavailable until the host-owned reviewer above. MCP approvals wait
for the same call's running arguments, which the real runtime can emit after
its permission request. Grants apply once to a pending id; Stop rejects late
grants. A reproduced duplicate idle event could finish the next optimistic
turn before native work began; the translator now requires native busy before
ordinary completion, while acknowledged interruption settles a pre-busy turn.
The bundled runtime restores common CLI directories through `agentCliPath`
without inheriting credentials or injection flags. The desktop-PATH regression
failed with `zsh:1: command not found: node`, then passed with the fix.
`opencode-agent.test.ts` covers mode changes, scoped/symlink writes, delayed
arguments, duplicate approvals/idle, and interruption. The driven native smoke
uses the pinned executable, a fake model gateway, and an isolated MCP writer:
approved Node exits zero under a desktop PATH; Edit writes automatically, Plan
rejects MCP and shell writes, and Ask confirms writes after switching back.
Its fixture shares one native-realpath temporary directory between the SDK and
Chat binding, asserts the SDK's returned scope, and uses file URLs for generated
ESM imports on Windows.
This establishes adapter/native protocol behavior, not live-model judgment,
the owner's X script, or a released desktop build.

**Requested external writes (2026-10-22):** `agent-runtime-instructions.ts` routes
requested external output through native tools without changing the chat's
project. Claude keeps native write tools for external targets and denies
in-project targets through a PreToolUse hook; Default asks instead of denying
native edit/write/patch, and Plan still denies changes. For Default, adapter
tests and the pinned smoke cover approval in every mode. For Claude,
`agent.test.ts` covers only StashBase's `canUseTool` callback, not Claude's own
Edit, Auto, or Plan decisions; `agent-native-write-guard.test.ts` covers the
hook decision (inside, outside, relative, new files, links, aliases, case) and
its installation on Claude sessions. Hook precedence over permission modes
rests on the SDK contract, not a live CLI run. The pinned OpenCode smoke exercises real
external file creation, editing, rejected overwrite, and Plan refusal with a
controlled gateway. A driven source desktop pass (2026-10-23), using the built
renderer/server, real bundled runtime, and a controlled model gateway, displayed
the external-file approvals, created the file after Allow, and preserved its
content after Reject on a subsequent overwrite. The empty project stayed empty.
Live-provider routing and packaged desktop behavior remain unproven. External
changes are outside project turn review.

**Explicit external reads (2026-10-07):** `agent-runtime-instructions.ts` now
makes the bound project the default read/search scope and routes explicitly
requested external paths through native tools under runtime permissions.
`opencode-runtime.ts` asks for external-directory access; `agent.ts` no longer
redirects an external prepared PDF/DOCX to project-scoped MCP. The Claude adapter
regression failed with the previous policy and external-PDF redirect, then passed
with the fix. A driven bundled OpenCode read exposed an ignored
`permission.asked` event; the adapter now translates it into the shared approval
flow. The native smoke reads an external fixture through the real runtime,
receives the translated approval, grants it once, and verifies the file content
reaches the fake model gateway. Host/renderer types, agent and installed native
protocol tests, service/renderer builds, Electron tests and built desktop smoke
passed. These checks do not establish
live-provider compliance with the prompt or a packaged desktop approval flow.

**Valid-stream interruption (2026-10-06):** a live desktop WebSocket capture
recorded the renderer sending `close` immediately after an ordinary text delta
at 00:41:40 local time, while the host subsequently delivered the remaining
text and a successful `turn-end`. Every received frame passed the shared schema.
`infrastructure/session-api.ts` had included event consumers in its invalid-frame
catch, relabeling their exceptions and closing the native session. It now delivers
validated events outside that catch. The adapter regression verifies that a
consumer exception preserves its original error, does not enter invalid-response
recovery, and does not prevent the next terminal event from being delivered.
The exposed consumer exception was React's maximum update-depth guard during
text delivery. An isolated browser App reproduced it when the captured turns
arrived over a real WebSocket; timer-based delivery did not. React instrumentation
located the pending updates in `ChatHistoryPopover`: `useConversationHistory`
flattened the unstable `useQueries` result array on every render, repeatedly
resetting the list cursor during streaming. Query-level combination now preserves
unchanged history data. The keyboard regression fails before this change because
ArrowDown selects the first chat again, and passes afterward. Both captured turns
then completed over the same real WebSocket without a consumer exception. This
fixture uses local captured messages and fake non-agent ports; packaged behavior
and unrelated network interruptions remain unverified.
All renderer checks passed across the gate and reruns, including 1,638 tests
with coverage and 146 Story accessibility cases, plus documentation and built
Electron smoke. The isolated worktree needed an explicit allowlist for linked
dependencies; two test workers resolved three timeout-only failures. The fix was
then copied unchanged into the primary checkout, where both new regression
suites also passed.

**Interrupted-turn cause (2026-10-05):** `ui/work-status.tsx` now exposes the
closed/failed connection's reported cause beside Outcome unknown; the separate
connection notice had been suppressed in this state, hiding useful runtime
errors. The mounted workspace regression covers a native exit during a turn,
retained partial output and draft, one reconnect action, continued uncertainty
after reconnection, and no automatic prompt replay. `InterruptedTurn` provides
the composition fixture. The reported live chat preserved its complete reply in
Claude history while the renderer stopped displaying it partway through; the
host stayed up across that interruption. Neither the hotel network nor a specific
native/transport failure has been established as the cause of that incident.
Validation passed all 12 renderer gates, documentation checks, and the built
Electron smoke. The built Storybook fixture was inspected in Chrome with its
specific cause and single recovery action visible. This verifies presentation
with controlled events, not the cause or repair of the reported interruption.

**Claude background completion (2026-10-05):** `server/agent.ts` requests native
session-state events and waits for `idle` before publishing `turn-end`, retaining
the latest result for the outcome. A live Claude 2.1.280 SDK probe reproduced a
successful waiting reply before a background agent finished, followed by another
result after its continuation. With state events enabled, `idle` followed that
continuation; interrupting during the wait stopped the child and emitted `idle`
without another result. Adapter regressions cover the waiting interval, child
completion before the parent reply, queue admission, duplicate idle, a failed
continuation, and cancellation racing acknowledgement. Result-only native CLIs
retain their existing terminal behavior. Validation passed 226 agent tests,
host types, Electron boundary tests and built smoke, and documentation checks.
The live probe exercised the SDK protocol, not the application UI; the changed
journey through the built desktop and packaged behavior remain unverified.

**Credit freshness and reservations (2026-10-15):** the account menu refetches on
opening and window focus; its shared query polls every thirty seconds. App
composition invalidates credits after every Default turn outcome, including
failure, independently of telemetry delivery. Settings and the menu show reserved
capacity separately, and failed refreshes do not leave a stale numeric balance
presented as current. A renderer regression reproduces 78% becoming 15% on menu
open and a failed refresh becoming Unavailable; a composition test covers a
failed Default turn. API contract coverage preserves legacy payloads and exposes
reservation percentages only to opted-in clients. Database recovery tests cover
refusals with outstanding holds and the five-minute, exactly-once waiver from
first uncertainty, including absent provider generation IDs. Real-provider
unknown-cost recovery still depends on provider evidence or that deadline. The built
ReservedCredits Story was inspected at the 28rem Settings width, showing 15%
available and 25% reserved without clipping; this fixture is not a production
settlement or packaged-release pass. A built Electron pass against the deployed
API on 2026-10-15 opened the current account menu and Settings -> Agents: both
showed 40% available after automatic recovery, matching the production ledger
(39.680695% available, no held user credits). Telemetry reported unavailable.
Renderer gates, host types, 323 agent tests, 22 hosted-account tests, Electron
boundary tests and the real Electron smoke passed on the current main baseline.
A fresh packaged pass remains part of the release verification.

**Monthly billing policy (2026-10-19):** Free is $1/month; Plus is $5/month
with $5 in credits; Pro is $20/month with $20 in credits. A first-ever Plus
subscription receives a native Stripe trial with full $5 credits, card collection
and automatic renewal. The API owns eligibility and preserves it across Checkout
recovery. Desktop and website display monthly terms and catalog credit amounts.
API ledger tests cover month-end clamping, no seven-day refill, shared usage,
non-stacking paid ceilings, and late settlement; billing tests cover returning
subscribers and idempotent offer recovery. Renderer gates passed after updating the monthly text assertions (1,695 tests),
along with host types and documentation checks. The local website pricing page
was visually inspected with a controlled monthly catalog; the built desktop
Story could not be inspected through the available preview tool. Live card
collection, first charge after trial, and deployed price/reminder configuration
still require Stripe validation. Native-trial tests cover confirmed access,
non-stacking credits, cancellation, expiry, failed first collection, paid renewal,
and ineligible returning subscribers. Desktop and website confirmation accept
`trialing` access and retain Portal cancellation. The HTTP compatibility field
keeps released clients' Checkout confirmation working; adapter tests retain
trial wording in updated clients and support older API responses. The operator configures the
seven-day reminder and `https://stashbase.ai/pricing/` cancellation link manually;
this change does not establish live email delivery. After the native-trial change,
all 12 renderer gates, API typecheck/build and 341 API tests passed (one skipped),
as did 20 website account tests and documentation validation.
The subsequent repair pass passed 345 API tests (one skipped), all 12 renderer
gates, host types and the complete website build. Real Stripe test-clock checks
verified trial grants, the first $5 payment, cancellation, declined first
collection returning to $1 Free, and the old $10 Plus price migrating and renewing
at $5 without an immediate invoice or billing-date reset. The built Ready and
RenewalCanceled Stories were visually checked, closing the earlier preview gap
for those states. Live card collection, public webhook delivery, production
migration and actual reminder delivery remain deployment checks.

**Subscription changes (2026-10-19):** Paid upgrades add credits corresponding to
settled supplemental payment and retain current-period consumption. Pro-to-Plus
changes use a Stripe schedule at renewal without current-period credits/refunds.
Settings and the website provide confirmation, scheduled target/date, withdrawal,
cancellation, resumption, and pending-recovery states. Host tests cover the
signed-in change request; panel tests exercise confirmation and all renewal
actions. API adapter/ledger tests cover idempotent funding reconstruction,
zero-payment upgrade invoices, preserved usage, and durable intent recovery.
Stripe test-clock verification covers unchanged current invoices/balances,
next-period Plus collection, and trial conversion to a paid full Pro month.
Validation passed: all 12 renderer gates, host types, host billing tests,
protocol/Electron boundary tests, the native Electron smoke, and documentation
checks. The built scheduled-downgrade Story and website controls were inspected.
API verification passed 364 tests plus 7 Worker tests; the website passed 27
account/billing tests and its 98-page build. Stripe test-clock checks additionally
verified a funded mid-period upgrade, automatic release of the completed schedule,
Pro-scoped coupon handling on downgrade, and an immediately ended trial with a
declined upgrade payment returning to Free. Production deployment and actual
reminder delivery remain separate evidence.

The 2026-10-19 launch subsidy changes the configured cost allowances to Plus $5
and Pro $50 while retaining the $5/$20 monthly selling prices. Production catalog
and existing Pro balance checks confirmed the increase without changing usage,
reservations, or period boundaries. The pending plan-change implementation scales
upgrade credits by allowance difference over price difference, including a legacy
base invoice after a no-invoice price migration. PostgreSQL tests cover partial,
zero, and capped supplemental grants, duplicate reconciliation, and next-period
Plus allowance. The API suite passed 367 tests (one skipped); renderer gates passed
after correcting the policy-copy formatting, and the website's 98-page build
passed. Final release preparation on the updated main branch passed all 12 renderer
gates, host types, account contracts, documentation checks, Electron boundary
tests and the built native smoke. The built scheduled-downgrade Story was
inspected and its confirmation/back flow driven; no live payment was initiated.

**Default Agent billing:** Settings -> Agents shows the subscription, reached also
from the sidebar account menu, through
`settings/hooks/use-billing.ts` and `settings/ui/agents/subscription-rows.tsx`.
`server/hosted-account.ts` calls the hosted billing plans, status, Checkout, and
Portal and subscription-change endpoints with the desktop session and admits only Stripe-hosted pages;
`server/routes/account.ts` exposes them to the renderer. The hosted API owns
Checkout, subscription state, and paid allowance ceilings; the website remains a
separate purchase path. A host test covers the bearer token, one refresh after
401, and refusal of a non-Stripe or non-HTTPS page. Panel tests cover Checkout
for a chosen plan, waiting until the status read confirms paid rights, the
following allowance refresh, Portal for a subscriber, and a refused Checkout that
keeps the plans and reads rights again. Hook regressions cover returning after a
long Checkout and a refused browser launch; panel coverage keeps management
reachable during confirmation and retries a failed handoff. Host tests cover a
stalled billing request and recovery; native tests cover browser launch timeout
and strict billing-return classification. A driven built Storybook pass on
2026-10-11 checked the canceled-renewal label and management feedback at the
28rem settings width. The built pricing return was checked without a browser
session or billing API, retaining the app-return link. The website return button needs no
browser login. Live discounted Checkout and cancellation with the patched desktop
and deployed services remain unverified. A macOS v2.15.7 release-package pass on
2026-10-11 opened Plans and billing, launched live Checkout, and returned the
management button from its opening state to a usable retry state. The free
account's live Portal rendered after a browser reload; first-load reliability
was not established. Automated custom-scheme navigation was blocked by the
browser tool; the user subsequently clicked Return to StashBase and confirmed
that the desktop opened. Inspection found the release package's Settings usable,
and Dismiss restored the Free subscription and purchase controls after an unpaid
live Checkout. This proves manual app opening and waiting-state recovery, not
paid-state refresh in the packaged app.
A sidebar test opens it from the account
menu's Plans and billing. The one-time sign-in banner is
`settings/hooks/use-account-offers.ts`, appended to the notice strip by
`app/composition/layout/workspace-notice-strip.tsx`; the host stores answered
offers in `server/app-config.ts`. A host test covers sign-in answering it,
sign-out keeping it answered, and the Developer tools reset; an App test covers
Not now. A macOS source-runtime pass on 2026-10-05 used the built renderer and
an isolated empty configuration: the banner appeared without a project, Not now
removed it, and it stayed dismissed after a clean quit and relaunch. The signed-out
Agents panel remained usable. The built subscription and turn-change Stories were
also visually inspected. The subscription fixture entered its slow-confirmation
state after the two-minute wait, kept Subscribe hidden, resumed waiting with
Refresh, and restored the plans with Stop waiting. A website test covers the
app-return hint without a browser session. Real Checkout from the packaged app
and promotion entry at Checkout from that path remain unverified. Hosted API integration tests cover
account isolation, idempotent Checkout recovery, paid-through expiry, tier changes
without usage resets, and settlement after cancellation. The built Settings Story
was visually inspected with a signed-in fixture; built website browser checks
covered sign-in return, Checkout/Portal navigation, and mobile layout with mocked
auth and API responses. Real Stripe test-mode validation covered the half-price
first invoice, full allowance, upgrade/downgrade, configured-only Portal offers,
minimum-expiry rejection recovery, and cancellation. Regression checks cover
invoice pagination, customer reconciliation locks/backoff, independent Stripe
maintenance/deletion jobs, audited catalog changes, and pricing-page restoration
after cached browser navigation, re-authentication after payment, token refresh
while opening Checkout, and disabled purchase during unavailable status. Checkout
switching retires the previous payable session before opening another; regressions
cover ambiguous creation, expiration failure, and early expiration. The allowance
hook refreshes on desktop window focus and removes its listener on unmount.
The hosted API repository's `dev:billing` command starts a test-only local stack;
the website repository's Astro billing integration reuses the production
handlers with a loopback transport. Local runtime checks covered the actual pricing page,
Stripe CLI webhook forwarding, scheduler processing of a paid half-price test
invoice, full fixture allowance, and child-process shutdown. These checks used
an SDK-created test subscription. A subsequent user-driven local sign-in and
Checkout completed a $5 half-price Plus test purchase; provider and local records
agreed on the active subscription and paid-through date, with all three payment
events processed and the full fixture allowance available. This establishes the
local initial-purchase flow, not live collection or packaged desktop handoff.
A repeat browser-driven sandbox pass on 2026-10-11 used the current signed-in
account, `STASHBASE50`, and Stripe's test Visa. Checkout charged a $5 test invoice
after a $5 discount and automatically returned to the local pricing page showing
Plus through 2026-11-11. Stripe and the local projection agreed; all three payment
events were processed within two seconds of receipt, with none pending, and the
full $1 fixture allowance was retained. The subsequent Portal pass opened without
a reload, completed period-end cancellation, and returned to pricing showing
`Plus · Ends 2026/11/11`. The cancellation webhook was processed, the local
projection matched Stripe's scheduled cancellation timestamp, and paid rights
and the fixture allowance remained available through the paid period. This local
stack does not change the account's production subscription or establish the
packaged desktop's paid-state refresh.
The API's repeatable `billing:verify` command passed real Stripe test-clock
renewal, failed collection, payment recovery after store restart, cancellation at
period end, and paid prorated tier changes against an isolated PostgreSQL ledger.
Allowance expiry uses the simulated timestamp explicitly. Read-only readiness
checks and protected billing queue/failure/staleness metrics support release
operations. A PostgreSQL regression covers queued and late webhook acknowledgement
when account deletion retires the billing identity.
An isolated real Stripe Portal browser pass completed Plus -> Pro -> Plus with
prorated invoices and period-end cancellation. The payment-method page did not
render a card form in the automated browser after retries, so card replacement
remains unverified; SDK payment recovery does not establish that browser action.
That Portal pass exposed timestamp-based cancellation missing from the local
indicator; the provider now handles an explicit cancellation at the current
period end, with regression and real-provider projection checks.
The 2026-09-28 merge onto current main passed the complete renderer gate
(the architecture check was rerun after repairing the isolated Electron install),
host types, 61 configuration/account tests, Electron tests and built-output smoke,
and documentation validation. A browser pass through the merged built Settings
Story confirmed the signed-in subscription entry, credit balance, and existing
agent controls. This uses controlled account ports, not live desktop login.
Real live-mode payment,
production renewal collection, browser card replacement, and packaged cross-browser account handoff remain release
checks; local and Stripe test-mode checks do not establish those behaviors.


**Agent switching and model memory (2026-10-22):** `application/project-agents.ts`
remembers explicit models and effort per project and agent through the Node-owned
preferences route. Switching an unsent draft and creating a new chat seed the model
before checking effort; clearing runtime-specific session state still removes skills
without adding a notice. `model-preferences.test.ts` first reproduced the lost model
and resulting effort reset, then covered switching, new-chat connection parameters,
restart loading, project isolation, persona/draft retention, ordered saves, explicit
clearing, refused changes and save failure. History restore clears the new-chat
model before reconnecting; catalog fallback never overwrites preferences.
`server/routes/agent-preferences.test.ts` covers disk persistence for all native
agents, independent model/effort/persona updates, invalid inputs, project removal
and corrupt-config preservation. A driven built-Storybook pass selected GPT-5.2
Codex and High, switched to Claude and back, and confirmed both choices and the
draft remained. The Story catalog now supplies its Codex models after switching.
These controlled tests and browser pass do not establish native provider model
availability or packaged behavior.
Validation passed host types, 14 configuration/preference tests, Electron tests
and built-output smoke, and documentation checks. `pnpm check:web` passed its
other eleven gates; the full coverage run hit five-second UI test timeouts at
default concurrency. Repeating all 351 suites with `--maxWorkers=2` passed all
1,751 tests and coverage thresholds without changing timeouts.

**New-chat thinking effort (2026-09-16):** project preferences persist explicit
effort separately for each agent. Workspace/session tests reproduce High reverting
to Medium, verify the next Codex connection receives High, preserve project/runtime
isolation and restart choices, and keep history/catalog defaults from changing the
preference. Host-route tests exercise persistence, invalid input, explicit Default,
and effort updates without switching the project's preferred agent.
An isolated built-main/host/renderer pass selected Codex High through the composer,
verified the real preferences route persisted it, created a new chat and inspected
its `effort=high` socket request, then reloaded the renderer and created another
chat with High retained. The catalog/socket were controlled; this is not a live
Codex provider run. Validation: all 12 renderer gates, 57 configuration tests,
96 protocol tests, host types, service builds, and documentation checks passed.

**Claude model choice (2026-09-18):** `server/agent.ts` applies a model only when
one was chosen; with nothing chosen the runtime keeps the model the user's Claude
settings name. Reproduced against Claude CLI 2.1.220 with its user settings naming
Fable 5.1: a bare session ran Fable, the SDK's `setModel(undefined)` switched the
session to Opus 5 with 1M context, and an explicit Fable id ran Fable. A pick made
while the runtime is still starting is held for catalog discovery instead of being
refused, and the init event's release name (`claude-fable-5-1`) maps onto the
catalog's context variant so the composer keeps its label. Host tests cover the
untouched runtime, the held pick, and the name mapping; the renderer transport
re-sends a model picked while the socket was still opening. The reproduction was
a scratch SDK script against the live CLI, not the packaged application.

**Runtime update (2026-10-09):** `server/agent-turn-failure.ts` classifies a
runtime too old for its model as `runtime-outdated` (observed live: Claude
2.1.220 refusing Fable 5.1 with a 400 naming 2.1.251 as required).
`server/agent-runtime-installer.ts` runs the provider's official native installer
for both installation and Update through one cancellable bootstrap coordinator,
then verifies the native launcher, confirms discovery selects it, and reconnects
MCP. An npm installation switches to native without an extra choice or removing
the old npm copy. `server/agent-cli.ts` prioritizes native launchers over npm
copies, rejects npm shims as native installation output, and preserves explicit
executable overrides. Overrides outside the native layout disable in-app updates.
The listing carries the installed version and whether an in-app update exists. The failed turn offers
Update Claude through `hooks/use-agent-runtime-update.ts`, which waits for the
runtime to be ready, reconnects the conversation so the service spawns the
updated executable, and resends the refused request; Settings → Agents shows
the version and the same Update. Focused tests cover native selection, npm-copy
preservation, installation/update verification, failure retry (including partial
first installs), the classifier, the version cache,
descriptor and schema fields, the hook's reconnect-and-resend and refused-update
paths, the transcript's action swap, and the Settings action. Failed updates carry
`retryAction: update` through the wire adapter to the mounted Settings panel;
Retry runs the installer again rather than reconnecting the old executable.
Codex uses the same installer-based update; its catalog comes from the installed
app-server. An old catalog can hide newer models, but the native
configuration can still name one and fail at inference (see the Codex recovery
entry below). A Codex model
chosen while its catalog is still being read is now held for that read instead
of being refused as unavailable.

A macOS arm64 Electron pass used the built renderer, preload, and server with an
isolated home and controlled installer scripts served for the official URLs.
Settings → Agents updated an existing npm Claude fixture; an injected download
failure showed Retry, which downloaded again and selected the native fixture.
Codex Update likewise selected its native fixture. Both rows refreshed their
versions and readiness, with no migration choice. Command logs showed native
verification/authentication, no npm updater call, and unchanged npm executables.

This proves the application flow with controlled downloads, not provider
distribution behavior. Not proven: a real update through the packaged app, or
the native update journey on Windows and Linux.

**Onboarding recovery (2026-10-09):** Both native providers now gate readiness on
their asynchronous status commands and expose provider browser login. A turn's
authentication refusal restores the sign-in action without clearing credentials.
The setup coordinator rejects conflicting explicit operations with HTTP 409;
identical operations share progress. Installation/download deadlines retire the
owned process tree before Retry can start another attempt. Version discovery and
post-install verification no longer block the shared server. MCP configuration
uses the provider's effective custom home through `server/agent-config-paths.ts`.
Bounded setup diagnostics retain installer stdout/stderr and nested fetch causes;
Settings and chat Update preserve HTTP errors. Every chat update entry respects
the runtime's update capability, including failed turns and proactive offers.

Focused host regressions exercise fresh Claude sign-in with a CLI fixture,
conflicting login/Update, actual installer timeout and process retirement before
retry, concurrent asynchronous version reads, custom-home config preservation,
and stdout/network diagnostic propagation. Renderer regressions exercise Claude
bootstrap-to-login, HTTP diagnostics through the real adapters/presenters, and
unsupported update offers in a mounted workspace. These fixtures establish
StashBase's decisions and recovery, not real-provider browser authentication or
Windows package-manager migration and executable-lock behavior.

A driven built-Electron pass used an isolated home, custom provider config
directories, and controlled CLI/official-URL installer fixtures. First-send
Claude sign-in failure displayed its ECONNREFUSED cause in the access prompt;
Not now preserved the draft. Settings sign-in retry reached Ready. A Claude
Update script failed with stdout-only EACCES and exit 13; both were visible on
the row, and Retry selected native 2.1.300 from npm 2.1.81. Codex Update selected
native 0.162.0 from npm 0.153.4. Both final versions and Ready states were seen
in Settings. Fixture logs confirmed native verification/authentication, intact
npm copies, no updater subcommands, and MCP writes only in the custom provider
config files. No real provider credentials or browser authorization were used.

**Codex model compatibility recovery (2026-10-04):** an older runtime using
`gpt-6.1-sol` from native configuration reported missing model metadata and then
a ChatGPT model rejection. The prior classifier emitted a plain turn error, so
the chat offered only Retry. `server/codex-session-runtime.ts` now associates
those two native messages by model within the app-server generation and sends
the existing `runtime-outdated` recovery kind. This exposes Update Codex through
the existing updater/reconnect/resend flow without rewriting the user's model.
Adapter regressions replay the reported warning and JSON error through terminal
notifications, failed completion, and RPC rejection; warnings alone, another
model's warning, service-tier warnings, and unrelated errors do not trigger it.
The native error is retained, warnings remain advisory, and a failed turn settles
once. The signal offers an update attempt, not a claimed minimum version or
guaranteed account access. Not proven: a real Codex update and successful provider
turn through the packaged application for this failure.

**Model-picker update entry (2026-10-04):** `ui/composer/thinking-models.tsx`
also offers the native updater in the model list before a turn fails, using the
host's `updatable` capability and `use-agent-runtime-update.ts`. The mounted
workspace regression starts with only an older model, invokes Update Codex,
then verifies reconnection publishes the replacement catalog and keeps the
unsent draft without sending a prompt. A refused update preserves the draft
and connection and reports its failure in the picker. The `ModelPicker` Story
covers the entry's composition and accessibility. These use controlled ports;
they do not establish which models a real updated Codex account can access.
The built Storybook model picker was inspected in Chrome: the update action
appears below the model choices. This is a
source UI check with controlled ports, not an installed Codex update.
Since 2026-10-18 the entry appears only with a known newer release: the
workspace regression asserts no Update Codex row without `availableVersion`.
On 2026-10-24 a dev build showed Claude 2.1.309 available in Settings while
the model menu offered nothing: the chat had read the catalog only before the
first release reading landed. Opening the model control now reads it again,
and a workspace regression covers a release that appears after every earlier
read. The entry is now a pinned `DropdownContent` footer: only the model list
scrolls when the popup runs out of room. The `ModelPicker` Story was driven in
Electron's Chromium with the popup capped at 150px: the list scrolled under a
hairline while Update Codex stayed in view, and hovering it drew the highlight
on that row. An update started from the chat once showed only "Updating
Claude…" while Settings streamed the installer's lines; `updateAgent` now
passes each preparation step to `use-agent-runtime-update.ts`, whose
`progress` the menu, the offer card and the failed turn show. A workspace
regression finds the installer line under the menu's update; in the Story
the menu read "Updating Codex…" then "Starting the updated Codex…". A real
installer's lines in the chat surfaces are unproven.
`server/__tests__/agent-runtime-releases.test.ts` covers version ordering,
feed parsing, background refresh, retry after failure, and the automatic-check
choice with a fake feed. A one-off read of the three live feeds returned
Claude 2.1.302, Codex 0.163.0, and Antigravity 1.4.0, matching the installed
Antigravity 1.4.0 that previously still showed Update. A packaged pass that
watches the entry appear after a real release is unproven.

**Newer-model offer (2026-09-23):** Claude learns from its server which models
an account may use, including ones the installed build is too old to run, and
caches that answer in `~/.claude.json` as `additionalModelOptionsCache`.
Observed on 2.1.276 with Opus 5.5 released: the cache holds
`{value: "cc-update-required-1", label: "Opus 5.5 (disabled)", description:
"Update to 2.1.280+ to use Opus 5.5", disabled: true}`, while the SDK
`initialize` handshake omits disabled entries (five entries, none disabled) and
a live turn on `--model opus` reported `canonicalModel: claude-opus-5`. So the
fact is local but not in the catalog: `server/claude-model-catalog.ts` reads it
from the file beside the user settings it already reads, cached by mtime,
and passes the runtime's own model name and sentence through unchanged.
StashBase compares no versions of its own, so it can never claim a requirement
the runtime did not state. Every unreadable shape is silence. The offer reaches
Settings → Agents as the row's leading sentence beside the Update it already
carried, and the chat as `ui/upgrade-offer.tsx` above the composer, which runs
the same in-place update through `use-agent-runtime-update.ts` with no refused
request to resend and is dismissed for the window. Tests cover the disabled
filter, the label's parenthetical, every malformed shape, a missing and an
unparseable file, the mtime re-read that withdraws the offer after an update,
the row's copy, and the card's update call, dismissal, completion, and failure.
Codex reports no equivalent, so it is never offered one. Driven through
`/api/terminal/clis`: a fixture `CLAUDE_CONFIG_DIR` naming the disabled entry
produced the offer on the Claude row and on no other, and the live withdrawal
was observed when the CLI auto-updated to 2.1.280 mid-session, after which the
cache dropped the entry, the listing dropped the offer, and the catalog began
resolving `opus[1m]` to `claude-opus-5-5[1m]`. Not proven: the offer rendered
in the running application, and the cache's freshness for a reader who has
never run a Claude turn from StashBase.

**Tool-attempt presentation (2026-09-16):** `ui/transcript/activity.tsx` omits failed
tools from chat, including summaries and expanded details. Activity tests cover
a subsequent running, successful, or failed call, empty-group suppression,
and changed-file results only after success. Transcript tests keep a
terminal turn failure and its retry action visible, and retain progress after a
running tool fails. No retry identity is inferred
from a shared file path; the native runtime still owns execution and retries.
The `FailedAttemptThenSuccess` Story covers the reported failed-edit/success layout.
An isolated built-main/host/renderer pass with controlled agent socket events
verified failed-only activity disappears, the successful file result and final
reply remain visible, expanded activity excludes the failure, and a subsequent
network turn failure retains its retry action. Both collapsed and expanded
layouts were inspected. This proves presentation, not real-provider retry behavior.
Validation: 35 focused tests passed; the subsequent combined validation passed
all 12 renderer gates, including coverage.

**Shell and subagent writes (2026-09-21):** a Claude Writer subagent created
a draft through a Bash heredoc, so no tool named the file: the turn
showed no file result, nothing reported the write, and the daemon's tree
revision never moved, so Files kept the stale listing. `domain/file-change.ts`
now asks, when a turn settles, whether it ran a call that could have written
unseen (a command, a subagent, or any tool it does not parse; reads, listings,
searches, and questions are excluded), and `application/session/events.ts`
reports the folder as possibly changed. `use-folder-refresh.ts` takes that
report down the existing agent-write path: re-read the listing, reconcile the
folder, re-read listing and status. A file result and its Open still require a
named write; a shell-written file has none by design and appears in Files
instead. Tests cover the classification, the settled-turn report against a
read-and-reported-write turn, and the hook's reconcile with no named source.
Validation: the complete `pnpm check` matrix passed in one run, including all
12 renderer gates with coverage, `pnpm test:electron`, host types, and the built
Electron smoke. An isolated built-app pass on macOS then wrote a Markdown file
into an open project from outside any file tool and posted the window-origin
`/api/sync` this report triggers: the reconcile added exactly that file, the
tree revision moved, and `/api/files` listed it. Not proven: a live runtime
turn through the built desktop, because no runtime signs in under an isolated
home; the renderer's report itself rests on the tests above.

**Work in progress presentation (2026-09-16):** a running turn is narrated by the
activity group that closes the transcript: `ui/transcript/tool-presentation.ts`
names the step in hand while the group is live and returns to the aggregate
summary once the turn settles, and `ui/transcript/transcript.tsx` marks that
group live from the turn rather than from any single call's status, so the
header keeps moving between two calls. The standing thinking indicator now
stands in only when no live group or decision card closes the transcript.
Transcript tests cover the reported still frame between calls, the settled
header, and a pending decision; presentation tests cover the running step,
parallel calls, refused calls, and one-ellipsis clipping of a long command.
The `StillWorking` Story shows the live and settled headers together.
A built-Storybook pass inside Electron's Chromium confirmed the live header
reads the step just taken while the settled group beside it keeps its summary.
That pass renders the group alone; a streaming turn against a real provider,
where the header advances call by call, remains unverified.
Validation: all 12 renderer gates passed, including coverage and Story
accessibility, and documentation checks passed.

**Expired attachment previews (2026-10-23):** history restoration checks that a
transient image still resolves safely before offering its preview URL; missing
bytes retain a named card. `ui/composer/context-tiles.tsx` handles subsequent
load/decode failure by showing the filename and “Preview unavailable”, retaining
the reference and retrying only when the preview URL changes. Route/history tests
exercise deletion and shared Codex/Claude replay; renderer tests cover load failure,
rerenders and a replacement URL. Historical PostHog IMG events do not distinguish
missing bytes from decoding/access failure, so this is a reproduced failure path,
not proof that every historical report has the same cause.
Validation: all twelve renderer gates passed (the final four were retried after
package manager cache permission failures), host types and docs passed, and attachment/history
host tests passed 22 cases. Electron suites and built smoke passed, including
production-CSP attachment decoding. The built `UnavailableHistoryPreviews` Story
was driven in Electron: actual image decode failure removed the broken image,
kept both named cards, and displayed the fallback without overflow. This fixture
does not establish recovery of old attachment bytes or Windows/Linux packaged
behavior. A pre-existing workspace hook-return-type convention failure was
replaced with the panel's explicit catalog shape while completing the gate.

**Request and attachment lifetime (2026-09-16):** the hosted broker binds
requests to the active turn's cancellation signal before reading the body.
Retirement closes local requests and aborts upstream work; token acquisition and
refresh recheck that signal before forwarding. Broker tests cover cancellation
during token acquisition, refresh, and an upstream request. Active-process
attachment batches survive age cleanup; old batches from previous processes
remain temporary. The attachment route test ages a live upload and verifies its
bytes survive while an abandoned batch is removed. OS/external deletion is not
prevented, and historical metadata does not restore attachment bytes.

**Default local attachments (2026-10-12):** the composer sends explicit attachment
references on first send, queue advancement, and Retry. Uploads are bound to the
registered project and checked against their original digest before model use.
`server/agent-attachments.ts` prepares bounded UTF-8 text, native images/PDFs, and
DOCX extracted text; `server/opencode-agent.ts` submits native file parts and
omits synthetic extraction text from history replay. The local broker adapts
inline PDF parts to Gemini's compatible input format. No R2 or billing changes.
Focused tests cover scope refusal, changed/missing files, size/format rejection,
DOCX extraction, cancelled preparation, and queue/retry snapshots. The pinned
native-runtime fixture checks actual outgoing media bytes, follow-up retention,
and history cards. Live hosted probes through the local broker verified text
markers, PNG/GIF image recognition, and a PDF's title, marker, and rectangle
color; this is not a general document-quality evaluation. Agent, conversion,
native-runtime, host type, and Electron tests passed. All renderer gates passed
(the coverage gate passed on retry after an unrelated application test timeout).
A built Workspace Story driven in Electron verified Default selection, pasted
image/text cards, image preview, and removal. Built application Electron smoke
verified attachment-preview image decoding under the production CSP and request
authorization; the Story pass uses fixture services, not a full live-model UI
journey. Existing gateway
reservation estimates remain unchanged and can reject larger media requests
before the provider; billing/multimodal estimation is explicitly deferred.
Temporary original files still are not durable historical attachments.

**General file attachments (2026-09-23):** attachment-capable runtimes accept
ordinary local files from the picker, drop, and clipboard instead of limiting the
composer to images and PDFs. Focused renderer tests cover an arbitrary MIME type,
an image preview, and a text-file card; history tests keep unknown-extension files
as name-only cards while leaving arbitrary image paths without a preview grant
in the transcript. Runtime interpretation of binary formats remains
provider-dependent and is not established by local upload acceptance.
Validation: `pnpm check:web` passed all 12 renderer gates; the agent server
tests (now in `pnpm test:server`) passed 204 tests; the attachment route test, host typecheck, and documentation
checks passed.

**Explicit project code context (2026-11-02):** `file-tree-rows.tsx` gives every
ordinary file a source drag identity, independently of indexing eligibility.
`context-composer.tsx` binds generic formats as file cards without changing prose;
`agentContextFile` resolves their exact source path without opening bytes.
`agent-history-attachments.ts` restores absolute generic paths as name-only cards
and preserves filename parentheses when removing prepared-document hints.
The file-tree/drop and workspace-context suites plus `project-file-reader.test.ts`
and `codex-history.test.ts` passed 55 focused checks. `pnpm check`, renderer
formatting/lint, and documentation checks passed. `BoundContext` includes the
code-file card; visual inspection, packaged pointer dragging and a real-provider
read of the dropped code file remain unproven in this run.

**Intent:** [J06](../design-docs/journeys/README.md#j06-start-and-continue-an-agent-chat).

**Implementation:** Renderer: `renderer/src/features/agent/application/workspace-runtime.ts`, `renderer/src/features/agent/application/session-runtime.ts`.
Host/services: `server/agent-contract.ts`, `server/agent-adapters.ts`, `server/agent-runtime-installer.ts`.
Project choice and first Send: `renderer/src/features/agent/application/project-agents.ts`,
`renderer/src/features/agent/hooks/use-agent-access.ts`,
`renderer/src/features/settings/hooks/use-account.ts`, `server/routes/agent-preferences.ts`.

**Status:** Release-dependent.

- **Contract Test:** `pnpm test:server`, renderer, project-operation, MCP, and
  config suites cover setup/consent, authentication, scope, permissions,
  queue/turn/history ownership, stop/retirement, failure classification,
  persona, and transcript/layout state. Automatic grep/hybrid selection
  follows current key configuration; explicit/provider failures do not silently
  change strategy. Choosing a persona resumes that Chat's own conversation so
  it applies from the next turn, and a new Chat starts with the project's last
  choice (`session-runtime.test.ts`, `project-agents.test.ts`,
  `use-agent-persona.test.ts`); the library, seeding, per-session record, and
  socket seam are `server/agent-persona.test.ts`; replay joins the record
  (`agent-history-routes.test.ts`); Claude and Codex compose the Chat's
  persona before the routing policy.
  An isolated built-app pass (2026-10-08, scratch HOME, no runtime signed in)
  chose and switched personas in the composer, wrote a new one (it runs at
  once), opened Browse personas…, read a Markdown sample, added
  Essayist (the page then reads Added and the picker lists it), and deleted the
  running persona (the Chat falls back to None and the project's choice to
  null); the library held the four seeded files plus the added copy. No live
  turn ran, so the socket seam and replay restore are test evidence only, and
  two concurrently started Chats keeping separate personas is
  `project-agents.test.ts` only.
  `pnpm test:opencode:native` completes a turn with the bundled executable and a
  local fake gateway; broker suites cover token/turn isolation, retry, and credits.
  Focused first-send tests cover project-default selection, durable explicit
  choices, preference failures, retained drafts, one continuation after access,
  cancellation on edits/navigation, and waiting for native setup readiness.
  Account waiters share one browser flow and cancel independently; route tests
  exercise registered-project validation and preserve corrupt configuration.
- **Driven Runtime Pass:** isolated built-app seeded-Claude-history passes
  exercise restore, copy/edit actions, timestamps, and Chat-pane controls without
  a live signed-in runtime. A window-authorized read pass (2026-09-14) proves
  source/prepared-path parity and stale/deleted-source refusal with seeded PDF
  output, not a native preparation or model turn.
  A built-app pass (2026-09-15) with an isolated project and controlled agent
  HTTP/socket events verifies draft reachability, mode switches, paused queues
  after Stop/failure/connection loss, same-session reconnect without resend,
  history restore, title search, folded activity, math, and return to latest.
  It uses production main/renderer code, not a live provider or signed package.
  A project-first pass (2026-09-16) through the built main, renderer, and host
  verifies Welcome without a composer, native-picker entry (with a controlled
  picker result), draft retention across Documents/Chats, Default first-send
  sign-in prompting, and cancellation without losing the draft. Built HTTP/WS
  checks reject missing, retired, aggregate, and unregistered session scopes;
  registered-project history still loads. Isolated credentials leave installed
  Codex history unavailable; this pass does not establish authenticated native
  history or a real-provider turn.
  A built Storybook pass in Electron (2026-09-17) checks the neutral permission
  card in light and dark themes. Allow and Reject remove the decision controls,
  show Running and Denied respectively, and return focus to the heading. This
  verifies the rendered card and its controlled reply callback, not native
  agent execution.
  Approval scroll regression (2026-10-17): an isolated Electron renderer
  harness with the real transcript and bottom-follow hook reproduced Allow
  jumping from scrollTop 1773 to 0 when the decided tool joined an activity
  group above an intervening long reply. Focus transfer now prevents scrolling;
  the same pass remains at the new bottom (1682) after the card folds.
  Allow and Reject both keep bottom-follow, and preserve the visible paragraph
  when the reader has scrolled up (including anchoring across the denied row).
  `transcript.test.tsx` covers Allow and Reject retaining summary focus without
  requesting browser scrolling. This is controlled renderer evidence, not a
  live-provider or packaged-app pass.
  Completed-turn folding (2026-11-02): `transcript-folding.test.tsx` covers the greater-than-eight
  visible-message threshold, complete expansion across the 200-block page boundary,
  and one earlier-messages click revealing the preceding turn after a turn longer
  than two pages. It also covers chat-scoped manual expansion, retained follow-ups
  and file results, focus and reading-position preservation, and running, failed,
  stopped, or unclassified turns remaining open. `transcript.stories.tsx` supplies
  completed, running, and compact views.
  A driven Storybook browser pass verified the counted row, full process
  expansion and re-collapse, retained final reply and changed-file card, running
  work remaining open, and the compact view in dark mode. The three new stories
  pass focused structural accessibility checks.
  Review caught and corrected repeated no-op earlier-message clicks after a
  long turn, and an outer clipping animation that cut off message controls.
  Native history without an explicit outcome remains expanded; this renderer
  behavior does not establish provider completion or historical outcome recovery.
  Clarifying questions (2026-09-18): focused renderer tests cover the question
  card's answers keyed by question text, multi-select and typed answers joined
  as the runtime reads them, Answer held until every question has one, Skip
  denying, and answers kept on the settled call; the Claude adapter test proves
  answers reach only the question tool's updated input, and the socket schema
  accepts them. A built Storybook pass in Electron drives the card in light and
  dark: single and multi-select choices, the Other line, Answer replacing the
  controls with Running, and the settled row opening to the questions and
  answers. This is the rendered card and its reply callback, not a live
  Claude turn.
- **AI Eval:** mechanics do not establish prompt adherence or writing quality;
  see J10 and J12.
- **Release Check:** signed bundled OpenCode executability plus a fake-gateway
  turn, a real hosted OpenQuill turn/credit response, external CLI installation
  and browser authentication, and runtime-supported clipboard image attachment.
  This is attachment support, not the removed clipboard screenshot capture.
- **Interaction contract:** session-owned queues advance after success and a
  confirmed Stop, and hold on failure/connection loss until a later turn
  completes or an unknown outcome is reviewed. Claude and Codex take follow-ups
  into the running turn; runtime tests cover placement where the runtime reads
  one, return to the queue when a turn ends or refuses it, and Alt+Enter
  queueing. Server tests cover Claude's lifecycle confirmation, the Stop
  re-interrupt, and replay of follow-ups read mid-turn. A live Haiku probe
  (2026-10-23) confirmed mid-turn absorption at a tool boundary, a follow-on
  turn inside one idle when no tool remains, and that a Stop leaves a queued
  follow-up to run unless interrupted again. A live Codex 0.160 app-server
  probe (2026-10-24) confirmed `turn/steer` returns before the input is read,
  records it under the sent client id after the running tool or reply, and
  drops it on interrupt without carrying it into the next turn; server tests
  cover confirmation on that record, confirmation on acceptance for an
  app-server that drops client ids, a timed-out steer left to the turn, return
  at turn end, and holding one sent before the turn has its id; no live probe
  covers the echo of the turn's own `clientUserMessageId`, though the 0.160
  schema accepts it on `turn/start`. Runtime and Claude server tests cover
  holding a follow-up sent while the first prompt connects and never pushing
  one into a CLI without `command_lifecycle`.
  `FollowUpWaiting` is the composition fixture. Focused runtime tests
  cover refusal, retained drafts and context, unknown outcomes, restored
  identity, and protected titles. Sidebar title search includes drafts; arrows follow
  project visits. Thinking/routine tools fold per turn, with approvals, failures,
  and file results visible. Markdown supports double-dollar and LaTeX bracket
  math and scoped file navigation.
- **Limits:** historical attachment metadata cannot recover upload bytes; reuse
  shows unavailable items and requires replacement or explicit removal. Direct
  Retry requires the exact retained request; restored-only requests use Reuse. Unknown
  outcomes require reconnect/review and deliberate continuation. Local transport
  acceptance is not proof that native work finished. Real-provider cancellation,
  reconnect timing, writing quality, and packaged behavior need the checks above.


- **Installation/runtime fixes (2026-09-16):** focused regressions in
  `server/__tests__/agent-runtime-recovery.test.ts` cover unrelated commented and
  quoted TOML tables, multiline strings, idempotence, refusal without writes,
  retained login-shell discovery after elapsed time, and real POSIX descendant
  termination after its leader exits. Codex session tests verify that a process
  crash does not disable subsequent runtime access. Installer tests retain
  cancellation, authentication, output verification, and temporary-file cleanup.
  Validation: 195 agent tests, 145 Settings tests, 97 protocol tests, host types,
  service build, and documentation checks pass. The full renderer gate is not
  green: first-send conventions and unused exports remain; seven failures in
  four chat/document test files all pass when rerun together (22 tests).
  A built-app pass with an isolated home and controlled HTTP responses verifies
  provider-owned rows, failed installation followed by explicit retry, and the
  remaining failure controls. It does not execute an official installer.
  Private-runtime discovery/manifests/uninstall and development source overrides
  are removed; official installations remain provider-owned. Real provider login,
  official installer downloads, and packaged cross-platform shutdown remain
  release checks, not established by these local fixtures.

**Antigravity runtime (2026-10-17):** `server/native-agents.ts` declares
Antigravity (`agy`) beside Claude and Codex. `server/antigravity-setup.ts` owns its
readiness check and terminal-hosted sign-in, `server/agent-runtime-installer.ts`
its official installer, and `server/agent-mcp.ts` its MCP entry and `PreToolUse`
hook launcher. `server/antigravity-session-runtime.ts` runs a chat's `agy`
stream-json process, `server/antigravity-protocol.ts` parses its events and
owns the approval policy, `server/routes/antigravity-hook.ts` answers the hook,
and `server/antigravity-history.ts` records the conversations StashBase chats
start. `antigravity-agent.test.ts` covers launch flags and instructions,
streamed text and tool rows, the history record and its project scope, process
reuse and restart on a model change, read/write/command decisions per mode,
always-answers, withdrawn and post-Stop approvals, Stop and resume, empty
`SUCCESS`, a crash with `AGY_ERROR`, and the hook route's refusal of unknown
sessions. `antigravity-setup.test.ts` covers sign-in classification, reuse of an
existing sign-in without launching an interactive login, initial check failures
and cancellation without launching login, the sign-in loop's retirement,
cancellation and early exit, model-variant grouping, nested
and flat event forms, setup that keeps the reader's own MCP servers and hooks,
and the generated POSIX hook launcher against a real local server.
On macOS (2026-10-23), the sign-in entry checked the locally installed `agy`
with its real `/usage` probe and reused the existing account without invoking
the interactive-login launcher. An isolated macOS Electron pass through the
built renderer and server used a fake `agy` that initially reported signed out,
then reported signed in after an external marker changed. Clicking Sign in in
Settings → Agents reached Ready without invoking the interactive CLI; the row
was inspected by eye. These checks do not establish a packaged pass or a fresh
OAuth exchange. Manual-code OAuth remains blocked in StashBase on POSIX: the
login terminal is hidden and no UI forwards the code to its input.
A driven pass through the built app (2026-10-17, macOS, scratch HOME, port 8097)
used a fake `agy` in `~/.local/bin` that answers `--version`, `/usage` and
`models`, speaks stream-json, and runs the real configured `PreToolUse` hooks
before its tools. Startup readiness reached Ready · 1.4.0 and wrote the
`stashbase` entries to Antigravity's MCP and hook configuration; the
picker grouped the low/high variants into one model. The composer offered
Antigravity, settled the chat on Edit, and showed no attachment control. The
generated hook launcher reached the host with the chat's session id: the write
inside the project passed in Edit, the command raised the approval card, Allow
ran it, and Reject in a later turn denied it. Changed in this turn listed the
written note. After relaunch the chat list restored the conversation from the
StashBase record, and a follow-up resumed it with `--conversation` and fresh
instructions. That pass found tool rows of a resumed turn attaching to an earlier
turn's rows, since step numbers restart per process; tool ids now carry the
turn (`antigravity-agent.test.ts`).
A signed-in `agy` 1.4.0 on macOS (2026-10-17) confirmed the `models` envelope
the catalog reads. Outside the available regions, `-p /usage` and a headless
turn both returned Google's 403 eligibility refusal with an `AGY_ERROR` line;
setup had reported it as a failed sign-in check, and now reports Account not
accepted with that sentence (`antigravity-setup.test.ts`,
`failure-messages.test.ts`, `agent-runtime-status.test.ts`). Later the same
account passed `/usage` and answered a headless turn.
A Windows user (2026-11-10) whose `~/.gemini/antigravity-cli/settings.json` set
`"modelProvider": "gemini"` without `GEMINI_API_KEY` saw Connect fail as
"closed before sign-in finished": `agy` exits before any sign-in, so the
console window StashBase opened closed at once. `agy` 1.5.1 on macOS reproduced
the exit and its sentence through `--settings`, and confirmed that file
location with a scratch HOME; with any key present, `/usage` returned
`SUCCESS`. Setup now asks the reader to remove `modelProvider` from that file
and rechecks on Retry, without opening a sign-in (`antigravity-setup.test.ts`,
with a fake `agy` through the real probe). The Windows dialog was not rerun.
The same week a Windows user's Connect dialog stayed on "Connecting
Antigravity…" for over four minutes, while Antigravity was signed in after a
StashBase restart. The dialog showed no host step, so its follow-up listings
were not answering. Each listing completed the model catalog of any installed
runtime, and a signed-out `agy -p /model` (1.5.1, macOS) waits about a minute
on its own sign-in. A scratch-HOME server with a fake signed-out `agy` held the
first listing 15.8 s (the fake's wait); listings now prime only ready runtimes
and answered in 0.1 s (`agent-contract.test.ts`). Print-mode `agy` also starts
StashBase's MCP server as a child. Why the Windows listing waited past one
probe timeout is unproven: the server log is replaced at launch, and the
user's `agy` logs were not collected.
Headless stream-json runs on that `agy` confirmed the `init`, `step_update`
(text deltas) and `result` shapes. They also showed that `init` names no model,
so the catalog reads the current one from `-p /model`, and that a failed tool
ends in `ERROR` rather than `DONE`. MCP calls arrive as `call_mcp_tool` with
`ServerName`/`ToolName`/`Arguments`, and the tool names now come from its tool
list. With the StashBase hook installed, a terminal run outside StashBase kept
`agy`'s own refusal of an unapproved MCP call, as the hook's `allow` intends.
A real `agy --mode auto` run refused a StashBase MCP call outright, so Auto is
StashBase's own rule set in the hook, and new Antigravity chats now start there
instead of Edit; `antigravity-agent.test.ts` and `antigravity-setup.test.ts` cover
its decisions and `isReadOnlyCommand`, but no driven pass has run it.
Attachments now reach Antigravity as the prompt's `Attached files:` paths, as for
Claude and Codex: given an image path, a real headless `agy` read and described
the image itself, and replay restores the cards (`antigravity-agent.test.ts`).
Not proven: no StashBase chat has run on a real `agy`, so the hook's payload and
its running in a StashBase-launched stream-json process, stdio MCP startup there,
and pseudo-terminal sign-in remain unexercised. Windows sign-in, the Windows
hook launcher, and a signed-in provider turn remain release checks.

**Document context (2026-09-25):** a passage is a context kind in
`renderer/src/features/agent/domain/context.ts`, rendered into the prompt as a
`Selected passages:` block by `domain/prompt-context.ts` and validated only
against scope, listing, and its 6,000-character limit. `application/ask-about.ts`
binds it to the chat in the passage's folder and leaves a composer focus request that survives the pane
mounting. `server/agent-history-attachments.ts` lifts the block back out of
Claude, Codex, and Default (OpenCode) history, and `infrastructure/session-api.ts` turns a replayed
quote under the chat's folder into the same passage chip. The composer's
current document comes from `activeSource`, which
`use-agent-environment.ts` publishes only in Documents with New tab closed;
`domain/draft-context.ts`
decides what is included and `use-current-source.ts` holds the dismissal and
captures the source before sending, access setup, a new queue entry, or steering.
Until that action it is derived context, so opening a document keeps empty chats
blank. The same context tiles show it before and after submission; a later
document switch does not change a queued request or retry.
`context.test.ts`, `session-runtime.context.test.ts`, `ask-about.test.ts`,
`session-api.test.ts`, `codex-history.test.ts`, `context-composer.test.tsx`,
`selection-markdown.test.ts`, and `use-agent-environment.test.tsx` own these rules.
The current-document change (2026-11-02) passed 54 focused tests, including
composer-to-wire inclusion, removal, setup handoff, frozen queue context, steering,
and keeping Stop available with an empty draft. The shell regression in
`app.test.tsx` (2026-11-03) proved that New tab excludes a retained background
document from the outbound prompt and that selecting the document restores its
context; all seven app tests passed. Types, core host checks, onboarding
composition, controlled bundled runtime, formatting, lint, and docs checks passed;
the localhost hook check needed a rerun outside the sandbox. The
`CurrentDocument` workspace Story provides the changed composition. Its visual
review was blocked by unavailable browser access and native screen capture errors;
a real-provider turn receiving the automatically included document remains unproven.
A prior driven built-app pass (2026-09-25, Linux, isolated home, folder dialog stubbed
in the main process) opened a Markdown file beside the agent pane: the pane
offered it as a dashed suggestion; a selection showed Ask agent on the
toolbar; Ask agent bound "tide rises twice" as a passage chip and moved the
caret into the composer; clicking the suggestion turned it into an inline
mention and removed it. The original pass left the formatting toolbar drawn after Ask agent moved
focus; the passage-navigation change below now collapses that selection. Not proven at runtime: a real
turn receiving the passage, and a reloaded chat restoring its chip.
A real Default turn (2026-09-25) received the passage and replied with a
`#:~:text=` citation, but showed the reader's own prompt, context block
included, again as agent text: OpenCode streams the prompt's text part like a
reply's, and `OpenCodeEventTranslator` forwarded every text part. It now drops
parts of messages OpenCode announced as the user's; `opencode-agent.test.ts`
owns that rule and the history restore.
A table selection (2026-10-23) is the same passage kind: Documents builds its
text (`domain/table.ts`) and binds it through the same `askAbout` path, so
validation, prompt rendering and history replay are unchanged; replay now
recognizes CSV, TSV and XLSX paths.

**Passage navigation and reference marks (2026-10-23):**
`use-referenced-passages.ts` derives current-chat references from draft, queue,
unread follow-ups, and sent context. App composition passes their source/Markdown identity into
Documents; `passage-chip.tsx` routes both draft and sent clicks through document
navigation. `use-markdown-highlights.ts` binds Find and passage navigation to the
active viewer; `passage-highlights.ts` owns ProseMirror decorations and exact
live-selection anchors. Ask agent collapses the selection before moving focus,
which hides Crepe's toolbar. Edits before a passage map its position; edits to
its text invalidate it without relocating to a duplicate. Reopened quotes are
parsed with the editor's schema and require one exact match. A reload from disk
(Milkdown `replaceAll`) maps anchors by the changed span; inside it only a
passage that was and remains the file's one copy is followed. Table passage
chips open their file. `passage-highlights.test.ts` covers reloads with
duplicates, changed words, and a unique passage between two changes;
`use-referenced-passages.test.tsx` shows streamed deltas do not re-render the
hook's host. References do not modify the source or native selection.
Focused tests cover live duplicate occurrences, source preservation, changed
text, formatted/multi-block quotes, ambiguous recovery, active-chat switching,
queue/follow-up/history membership, sent and unread message navigation,
independent remove and locate actions, and navigation
failure notices. A local Electron pass over a production-built harness with
the real Markdown editor, session
runtime, and composer selected a passage, clicked Ask agent, confirmed toolbar
closure and composer focus, scrolled away, located the passage from its chip,
cleared the stronger highlight while retaining the reference mark, and removed
the reference. Provider execution and packaged delivery are not established
by this UI pass.
Integration with the 2026-10-23 remote changes retains references while Claude
follow-ups wait to be read, and routes both sent and unread message chips through
the extracted `user-message.tsx`. Five focused renderer files passed 43 tests;
all renderer gate checks passed after removing a duplicate catalog type to meet
the file-size limit. Host types, documentation checks, Electron tests and the
built-output Electron smoke passed, as did 98 broker/translator tests and three
native OpenCode tests against controlled gateways. The integration pass did not
repeat the passage-specific visual harness or exercise a live model provider.

**Composer context shrink (2026-10-23):** the preview and queue regions now
measure their inner content with `useMeasuredSize`; the animated parent's
`scrollHeight` was floored by its previous height and left a blank row after
removing a wrapped source suggestion. Both regions keep spacing inside the
measured content as padding. `input-message.test.tsx` reproduces that browser
measurement floor and verifies the preview shrinks while retaining the passage.
A local Electron composer harness using the real session runtime and UI added
an Ask agent passage, then dismissed the original file suggestion: the gap
between the remaining chip and editor fell from 44px to 8px. This verifies the
composer layout, not a packaged application or a provider turn.

Additional hosted accounting evidence (API repository):
*agent-credit-admission.test.ts* reproduces the long-context/remaining-credit
refusal and verifies concurrent admission with separate user/provider ceilings,
refund and late-result races, and request-to-window/turn/minute/provider totals.
*agent-usage-waiver.test.ts* covers paid-month and reset isolation. The five-minute
refund begins at first uncertainty; this evidence does not prove live-provider
pricing or a newly packaged desktop journey.

## J07: Converge

**Write failure evidence (2026-11-04):** `write-diagnostic-context.ts` records
actual checks in path, scope, edit, transaction and atomic publication owners;
`write-diagnostics.ts` retains restricted attachments and temporary target timelines.
`project-path-diagnostics.test.ts` and `write-diagnostic-evidence.test.ts` cover
Windows lexical drive/case/separator/Unicode decisions, project/session rejection,
realpath/symlink failure, absent source, permission/publish failure, edit matching
and both version checks without including text. `scripts/write-diagnostic-replay.ts`
reads only received evidence and generates temporary branch regressions. The
store/replay tests cover limits, opt-out, failures, target changes and distinct
operation IDs for repeated external writes; changed caller sources keep separate
samples. Windows fixtures compare native-equivalent paths and do not treat POSIX
mode bits as Windows ACL evidence. These are
controlled reproductions, not native Windows/provider or production upload proof.
An independent assessor given only numbered packets identified all 13 failure
branches and executed their generated regressions; two additional successful
path-semantics cases also ran (15/15). Evidence establishes policy branches and
observed system-call failures, not the original OS permission configuration.
Two further blind timelines reproduced same-target success and changed-target
success (4/4 generated cases). The sequence regression also checks unchanged
success and a symlink alias resolving to the same physical target after an early
edit refusal.
Settings' full-path disclosure was visually inspected through native Chrome in
its isolated Story. The core gate, focused file/diagnostic and four-runtime checks,
renderer Settings tests, formatting/lint, docs and service/MCP builds passed.
The private upload service is absent: production delivery stays `unavailable`.
See [write diagnostics](../docs/usage-statistics.md#write-failure-diagnostics) for
coverage gaps and the evidence-only reproduction command.

**Shared math workflow (2026-11-02):**
`renderer/src/test/fixtures/math.ts` supplies one Markdown sample to the
`app/composition/layout/math-workflow.test.tsx` regression and
**Compositions / Math workflow / Chat To Document** Story. It contains inline
math, fractions, an integral, a matrix, a fenced sum and a long formula alongside
escaped prices, a formatted list and literal code. The composition drives the
real App through streamed Chat output, opening a controlled Agent-written file,
unescaped prices that stay text in both surfaces, a formula source edit, Copy response,
and copying a selection inside matrix glyphs. Real document paste, autosave and
close/reopen preserve TeX, matrix rows and surrounding Markdown. Controlled
session and versioned storage ports do not establish provider behavior or disk
writes. The interactive Story composes the public Chat and Documents workspaces
side by side and provides an empty paste target, save/reopen and saved source.
It uses the production renderers with in-memory files, without adding a second
formula implementation.

An isolated macOS Electron pass used the real system clipboard for the whole
reply, a selection inside a formula glyph, and mixed prose/display-formula
selections. Native paste into Documents followed by save/reopen preserved the
formulas and surrounding content; ordinary list-marker normalization remained
valid Markdown. The two rendered surfaces were visually inspected together.
The same sample also passed real MCP HTTP `write_file`/`read_file` with an exact
disk-byte comparison, then opened in the source application. These checks used
controlled Agent output, not a live provider or packaged distribution.

**Interactive notes (2026-10-28):** `create_interactive_note` shares the blank
starter with New tab, returning a new directory, HTML entry, and JSON data paths.
Shared runtime instructions explain when to choose text or interactive notes and
how to keep resources under the note's own `assets/`. Ordinary edit permissions
apply; file changes remain directly saved. Controlled MCP creation and project-scope
refusal are exercised in `server/interactive-note.test.ts`. Real-provider selection
and customization quality remain unverified.

**Shared Agent instructions (2026-10-27):**
`server/agent-runtime-instructions.ts` supplies Default, Claude, Codex, and
Antigravity with one role and the default to answer in Chat. File output
requires a user request or an applicable loaded project workflow for the
current task; opening or attaching a source and granting write permissions
do not provide edit intent. Known paths need no discovery preflight; gaps in
tool coverage or prepared text permit native reading within runtime permissions.
Project text writes still require MCP. Provider adapter tests cover instruction
delivery, not model compliance. Real-provider behavior with discussion,
draft-only requests, explicit file-output workflows, and original-source
fallback remains unverified; this policy adds no enforced write gate.

**Agent code and configuration (2026-10-20):** Project text reads/writes no
longer depend on the Documents format whitelist. `project-file-mutations.ts`
uses `file-save.ts`'s `saveTextFileContent`; `project-file-reader.ts` reads other
UTF-8 sources by exact path. Strict bounded snapshots remain owned by
`text-file-transaction.ts`, and atomic replacement retains existing permissions.
`project-text-files.test.ts` drives real MCP write/read/edit calls for dotfiles,
code, configuration, unknown extensions and extensionless names; it covers
BOM/CRLF and version preservation, concurrent edits, restrictive/executable
permissions, rejected binary/invalid/oversized/special sources, protected paths,
project scope and symlink escape. Generic text calls no index operation, and
the Documents save gate still refuses it. Runtime instructions and MCP tool
descriptions explicitly allow requested programming and preserve filenames.
Directory discovery, generic move, automatic context and search
eligibility retain their separate capabilities. These tests do not establish
live-provider tool selection or packaged behavior.

**Generic file deletion (2026-11-02):** `deleteProjectFile` now shares one
format-independent deletion path between Workbench and Agent/MCP. It validates
project scope, writable paths, realpath containment, and regular-file identity
before cancelling source work or changing files. `project-file-mutations.test.ts`
exercises real MCP deletion of .mjs files, dotfiles, extensionless names and binary
files, repeat deletion, untouched neighboring files, and protected-path
(including directory aliases), cross-project, directory and symlink-escape
refusal. `active-file-operations.test.ts`
checks that invalid paths and containment failures are errors rather than
reported as already gone. Shared runtime instructions prefer `delete_file` but
allow native deletion of the same authorized path when the tool is unavailable
or explicitly lacks file-type support. Permission/protected-path/scope refusals
and source conflicts cannot be bypassed; uncertain outcomes require a fresh
existence check. Adapter tests establish delivery and existing permission
configuration, not provider compliance. Live-provider fallback and packaged
deletion remain unverified.

A controlled Electron pass using the built server and renderer in an isolated
profile created, read and edited `.env` and a Python source through MCP. The
Files tree kept both exact names and each opened with the edited text in its
read-only preview. A stale version and binary overwrite were refused with disk
content preserved. This exercises production file services and presentation;
no live model turn or packaged application was used.

**Intent:** [J07](../design-docs/journeys/README.md#j07-converge-chat-into-a-document).

**Implementation:** Renderer: `renderer/src/features/agent/application/session-runtime.ts`, `renderer/src/features/documents/application/document-runtime.ts`, `renderer/src/app/composition/layout/workspace-panes.tsx`.
Host/services: `server/project-file-mutations.ts`, `server/text-file-transaction.ts`,
`server/project-operations/index.ts`,
`server/turn-changes.ts` (turn baselines at the `attachAgentRuntime` seam), and
`renderer/src/features/agent/ui/transcript/turn-changes-card.tsx`.

**Status:** Release-dependent.

- **Contract Test:** `pnpm test:server` and `pnpm test:renderer` establish permission, version, and write boundaries, including literal
  dollar-sequence replacement.
- **Composition Test:** `agent-convergence.test.tsx` exercises both a Chat file
  result's Open action and a reply's local file link: each selects Documents,
  shows the file, and retains the same conversation and unfinished follow-up.
  Its context port resolves the visible document before the Agent connects;
  preparation status remains pending so writes must still reach the tree
  independently of indexing.
- **Driven Runtime Pass:** isolated built-app window-authorized write/edit
  (2026-09-14) persists literal replacements with version checks. It proves the
  file boundary, not a real conversation producing a requested draft/revision.
  A controlled built desktop pass (2026-09-16), with a fixture agent transport
  and real document services, clicks both Open and a local Markdown link from
  Chats. Both select Documents and display the file while retaining the same
  agent session and unfinished follow-up.
- **File tool routing (2026-10-22):** shared runtime instructions require
  `edit_file` for existing documents and `write_file` for new ones; `suggest_edits`
  and its approval exceptions are removed from HTTP/MCP and all built-in runtimes.
  Claude retains `alwaysLoad` for StashBase MCP. Native write tools remain
  available for requested external output under runtime permissions. Claude's
  in-project native writes are denied by a PreToolUse hook; for other runtimes
  and shell commands, project routing is an instruction, not a native-tool gate. Shell/subagent writes
  remain detectable by the common turn scan. `project-file-mutations.test.ts` covers edits of empty
  files, nonempty-match rejection and stale versions through real MCP.
- **Driven runtime pass (2026-10-08):** the production renderer in a source
  Electron launch, with a disposable project and a project-local MCP port
  override, completed a real Claude turn through two `edit_file` calls. The
  Chat's Changed in this turn card opened two inline Undo/Keep changes. Undoing
  one and keeping the other saved the expected mixed result; reviewing the
  same turn again refused the now-stale source. This establishes the removed
  proposal path is unnecessary for the Claude flow. It does not establish
  packaged or other-runtime behavior.
- **Compact turn results (2026-10-17):** `turn-changes-card.tsx` owns the
  three-file preview, total file/line summary, and Show N more files / Collapse
  files control. Its component test exercises expansion, collapse, and Review
  on a previously hidden file; the ManyFiles Story supplies the long-path case.
  A built Storybook pass in Electron verified 3 → 9 → 3 files, both themes,
  and a 311px-wide card without horizontal overflow. This exercises the real
  card with controlled turn data, not a live provider or packaged application.
- **Turn review (2026-10-04):** every turn on a folder-bound agent socket is
  bracketed by a Markdown baseline taken before the prompt reaches the runtime
  and a rescan at `turn-end`; the Chat card offers Review per edited file, which
  opens a reversed inline review (Undo/Keep). The runtime policy has agents
  write directly through the StashBase file tools.
  `server/turn-changes.test.ts` covers created/edited/deleted detection for
  untooled writes, hidden-note and size exclusion, retention, prompt hold and
  ordering, capture failure, and a refused prompt's baseline;
  `server/routes/turn-changes.test.ts` covers scope, expiry and repeatable reads;
  `open-revision.test.ts`, `turn-change-api.test.ts`, `document-revision.test.tsx`,
  `turn-changes-card.test.tsx`, `session.test.ts` and `events.test.ts` cover the
  renderer path. A driven dev-build pass with a real Claude turn showed the card,
  the reversed review with Undo/Keep labels and swapped colours, a per-change
  Undo saving, Keep all, a stale refusal on a second Review, and Keep all. Not proven: Codex and the
  Default runtime driven at runtime (they share the socket seam but were not
  run), a packaged build, and large-vault scan cost per prompt.
- **Citations (2026-09-25):** `renderer/src/features/agent/domain/citation.ts`
  reads a `#:~:text=` phrase from a reply's local link; the transcript hands it
  to `locatePassage` in `use-document-sources.ts`, which opens the file with a
  passage-purpose Find target whose notices `navigation-runtime.ts` words for a
  passage. `server/agent-runtime-instructions.ts` asks every runtime to cite
  that way. `citation.test.ts`, `markdown.test.tsx`, `navigation-runtime.test.ts`,
  and `agent-convergence.test.tsx` (a cited link selects Documents and Find lands
  on the phrase) cover it. Not proven: that a real runtime cites as instructed,
  and a phrase spanning a line break in the rendered text is not found.
- **Block copy (2026-10-30):** `renderer/src/features/agent/ui/transcript/markdown.tsx`
  gives each fenced block in a reply its own Copy, revealed on hover or focus,
  which copies the block's text without the fence's closing line break. Blocks
  wrap, and the Copy floats beside the first line so text never runs under it.
  `markdown.test.tsx` covers the copied text. A Storybook pass in Electron's
  Chromium showed a wrapped drafted post in both themes, unchanged in layout
  between idle and hover. `server/agent-runtime-instructions.ts` asks every
  runtime to put paste-ready text, such as a post or email, in such a block
  (2026-11-11). Not proven: a packaged build, and that each real runtime
  follows that instruction. A Claude session before it quoted a drafted post
  with `> ` instead, and fenced it only once the user asked.
- **AI Eval:** requested writing quality belongs to J10. Existing deterministic
  orchestration evidence is not document-specific diff evidence.
- **Release Check:** real-runtime requested draft/revision followed by editor save.
- **Validation:** the pre-commit coverage run passes all four Canvas cases and
  all 1,456 renderer tests. The initial full-suite run exceeded the default test
  timeout while the isolated case passed; the composition cases now allow time
  for workspace startup and their bounded surface waits under coverage load.
  The remaining renderer gates, host/service tests, types, service builds, and
  built Electron smoke checks passed.

## J08: External MCP

**File-operation measurement:** `project-operations/index.ts` records one
`project_file_operation` per public read/write/edit, retaining initiating identity
and supplied request/turn correlation. The transaction's `changed` result
distinguishes changed and unchanged writes; an edit's internal read/write does
not double count. Validated live sessions supply Agent/runtime attribution;
external MCP and ordinary HTTP have separate origins. The mutation integration
suite exercises actual MCP and HTTP read/write/edit/conflict/no-change outcomes;
the Project Operations suite covers delayed results through an account switch
and opt-out. Native CLI/shell filesystem access outside this owner, move/delete,
and interactive-note creation are outside this event's coverage. MCP requests
without a reliable live-session or supplied turn ID remain uncorrelated rather than guessed.

**Interactive notes (2026-10-28):** The shared MCP tool factory and stdio HTTP
adapter expose `create_interactive_note` through Project Operations. The host test
calls the actual HTTP MCP tool, checks its generated starter against manual
creation, and verifies that an attributed session cannot create in another project.

**Intent:** [J08](../design-docs/journeys/README.md#j08-connect-an-external-agent-through-mcp).

**Implementation:** Renderer: `renderer/src/features/settings/ui/mcp/mcp-access-panel.tsx`.
Host/services: `server/project-operations/index.ts`, `mcp/server.ts`, `server/routes/mcp-http.ts`, `server/mcp-http-service.ts`.

**Retired interface (2026-10-08):** `suggest_edits` and its HTTP delivery routes
are removed. External clients use the existing write/edit tools; unsupported old
calls fail without writing. Post-write Chat review requires a StashBase-owned
agent turn and is not promised for standalone external MCP clients.

**Status:** Partial and release-dependent.

- **Contract Test:** `pnpm test:server` covers transport/operation parity, authorization, scoped
  direct/prepared reads, bounded windows, format/encoding restrictions, mutations,
  and reconcile. Current/stale/cancelled/orphaned prepared evidence is covered.
  The J07 Agent text-file regression also exercises the external MCP transport;
  explicit UTF-8 code/configuration access does not grant search eligibility.
- **Driven Runtime Pass:** a 2026-09-16 isolated source HTTP client initializes
  MCP, lists tools, reads a registered Markdown file through production Project
  Operations, rejects an outside-project read, and verifies token rotation.
  This is a controlled protocol client, not a third-party agent or packaged launcher.
  On 2026-10-23, `scripts/smoke-packaged-server.mjs` used the Settings-generated
  stdio launcher/configuration in an isolated macOS arm64 2.16.17 app copy with
  the new fuses, initialized MCP, and listed the host's registered project.
  The app copy was ad-hoc signed; this is protocol/launcher evidence rather than
  final signed distribution or representative third-party-client evidence.
- **AI Eval:** retrieval quality is J05; client generation is outside app ownership.
- **Release Check:** packaged launcher, copied configuration, URL access, and a
  representative external client.
- **Gap:** deterministic boundaries and the macOS arm64 stdio launcher have
  focused evidence; representative third-party connection and changed-fuse
  launchers on the other release platforms remain unproven.
- **Listener retirement (2026-09-16):** disabling Docker access closes active
  connections as well as the listener. A real incomplete HTTP request in the
  MCP suite verifies disable and subsequent enable; the removed audio-search
  assertion has been updated to current format support.

## J09: Bug report

**Report entry (2026-09-16):** native Help owns report initiation. The Settings
shortcut and unused workspace-renderer bridge consumer were removed; the native
Help entry and separate report-review window remain.

**Intent:** [J09](../design-docs/journeys/README.md#j09-prepare-and-hand-off-a-bug-report).

**Implementation:** Renderer: `renderer/src/features/bug-report/application/review-runtime.ts`.
Host/services: `electron/bug-report-service.cjs`, `electron/bug-report-handoff.cjs`, `electron/bug-report/review-ipc.ts`.

**Status:** Partial and release-dependent.

- **Contract Test:** [collection](../electron/bug-report-collection.test.cjs),
  [review authority](../electron/bug-report-review.test.cjs),
  [redaction](../electron/bug-report-redaction.test.cjs), and
  [handoff](../electron/bug-report-handoff.test.cjs) establish privacy,
  snapshot approval, and artifact ownership, including spaced-path redaction.
- **Driven Runtime Pass:** built review opened from Settings, prepare/back/cancel;
  isolated Electron smoke covers privacy refusal/correction, sanitized log preview,
  Downloads copying, delayed-save edits, and approval locking using synthetic
  logs, a fixture capture window, and temporary Downloads. Export repair is
  focused filesystem evidence, not a packaged external handoff.
- **AI Eval:** not required.
- **Release Check:** packaged native capture, review, Downloads copy, browser handoff.

## J10: Core loop

**Release source pass (2026-10-16):** The merged 2.16.6 candidate passed the
complete `pnpm check`, including all twelve renderer gates, 773 host tests,
three bundled OpenCode checks, host types, service builds and Electron smoke.
A separate native window loaded those built renderer/services with isolated
configuration and collection disabled (`available: false`). The driven pass
cancelled the native folder picker, opened a disposable project, inspected
General/Agents/Advanced settings and Gallery covers, retained an unsent chat
while opening a document, attached the document as context, saved an edit,
and found that durable text through keyword search. The window quit cleanly.
This source harness does not establish signed-package delivery, real-provider
model quality, or N-to-N+1 updates. Native Codex discovery reported a missing
local executable behind its npm launcher; no installation or login was attempted.

**Intent:** [J10](../design-docs/journeys/README.md#j10-turn-a-local-project-into-durable-agent-assisted-work).

**Implementation:** Renderer: `renderer/src/app/composition/folder/use-agent-environment.ts`, `renderer/src/app/composition/folder/refresh-folder.ts`.
Host/services: follow J02/J03/J05/J06/J07 owners for the exercised path. StashBase ships no workflow prompt; the user's `AGENTS.md` / `CLAUDE.md` owns it.

**Status:** Partial and release-dependent evidence for implemented writing.

- **Contract Test:** J02/J06 establish entry and agent ownership, J03/J07 writing,
  and J04/J05/J08 supporting references/client paths. These do not prove usefulness.
- **Driven Runtime Pass:** no complete enter project → brainstorm → requested
  writing → return pass, especially from an empty project without a wiki/index.
- **AI Eval:** Gap. No representative useful-idea-development and requested-writing
  Eval over empty and reference-filled projects. Grounding is required when
  sources are used, not a prerequisite for every brainstorm. J05 is narrower.
- **Release Check:** packaged empty-project discussion, requested draft,
  inspection/edit/save, and return; also a reference-assisted native-runtime task.
  These verify writing and revision, including saved changes reviewed inline.

## J11: Conversation to project

**Intent:** [J11](../design-docs/journeys/README.md#j11-turn-a-conversation-into-a-project).

**Status:** Retired. No unbound conversation entry, Instructions scope, native
migration, or history override remains. The stable ID records removal, not a gap
or future commitment. Explicit MCP directory creation remains under J08.

**Implementation:** `server/agent-contract.ts`, `server/routes/agent-sessions.ts`,
`renderer/src/features/agent/application/workspace-runtime.ts` enforce project-first
sessions. Native history is in `server/claude-history.ts`, `server/codex-history.ts`,
and `server/opencode-agent.ts`.

**Evidence:** Agent contract tests reject absent/aggregate/unbound scope; workspace
runtime tests cover Welcome without a session and entry into the first project.
Provider quality and packaged behavior remain separate J06 evidence requirements.

## J12: Build Wiki Pages

**Intent:** [J12](../design-docs/journeys/README.md#j12-build-wiki-pages-from-a-local-folder).

**Implementation:** Renderer: `renderer/src/features/agent/ui/workspace.tsx`, `renderer/src/features/agent/application/session-runtime.ts`.
Host/services: `server/project-file-mutations.ts`, `server/sync.ts`. No packaged
prompt states wiki conventions (a `wiki/` folder, following an existing wiki's
structure); they come from the request or the user's
`AGENTS.md` / `CLAUDE.md`.

**Status:** Partial and release-dependent.

- **Contract Test:** renderer suites cover runtime gates, explicit typed wiki
  requests, retained requests during setup, blank-chat runtime
  adoption, and sending without waiting for folder preparation. Agent, file, and
  data validation covers approvals, confinement, reconciliation, and admission.
- **Driven Runtime Pass:** real-app gated composer retains a typed Build Wiki
  request through runtime setup and restores Send without sending automatically.
  No real agent page-generation turn is part of this pass.
- **AI Eval:** Gap. No representative mixed-format Eval of completeness, source
  links, useful pages, requested scope, and preservation of existing wiki content.
- **Release Check:** real packaged OpenQuill setup and generated-page review;
  optional BYOK indexing and an external agent are separate secondary checks.
- **Gap:** model quality remains unproven; persistent ready/stale wiki state,
  scheduled rewriting, and an Update Wiki Pages mode are not product promises.

## J13: Gallery download

Gallery catalog synchronization (2026-11-06): the published catalog and desktop/
website bundled metadata now retain the same seven template IDs and target
`stashbase-org/template-*` repositories. Removed X Content Starter and POC Deck
Builder entries no longer appear in the new snapshots; the website redirects
their former detail routes to Gallery. Using the unchanged v2.18.10 snapshot
downloader, all seven original personal-account URLs followed GitHub's two-hop
redirects to the renamed repositories and downloaded/extracted successfully in
temporary directories. This verifies archive acquisition, not seven full GUI
project-entry flows. The Gallery publication and CDN match the new metadata.

Download-count implementation (2026-11-06): stable template IDs reach the shared
import operation; `server/routes/project.ts` records only committed acquisitions.
`server/telemetry.ts` reuses durable privacy-aware delivery, with a restricted
native relay in `electron/account/auth-network.ts`. The separate hosted API
repository owns the PostgreSQL operation ledger and public aggregate endpoint.
Focused import tests exercise receipt replay, conflicts, cancellation and ordinary
imports; telemetry tests exercise retry/restart, payload minimization, independent
destination recovery and opt-out. Validation: `pnpm check`, focused import,
telemetry and native-relay suites, the 17 affected renderer checks, documentation
validation, and fresh-build Electron smoke passed. The hosted repository's
HTTP/catalog tests, PostgreSQL concurrent replay/rate-limit integration, typecheck
and generated OpenAPI checks passed. Hosted deployment and live end-to-end counting
remain unverified until the API migration and service are deployed. Card display
is not part of this implementation.

The withdrawn-template regression covers a per-template 503 followed by a
current template and ordinary analytics, repeated drains with a new completed
copy, and eventual catalog propagation using the original operation ID. A
separate outage check verifies that generic service failures defer the whole
destination rather than probing every queued download.

**Intent:** [J13](../design-docs/journeys/README.md#j13-download-a-ready-made-wiki-from-the-gallery).

**Implementation:** Renderer: `renderer/src/app/composition/gallery/use-gallery-shop.tsx`, `renderer/src/features/workspace/hooks/use-project-entry.ts`, `renderer/src/features/workspace/ui/import-github-dialog.tsx` (the Make a copy confirmation).
Personas: `renderer/src/features/gallery/ui/persona-page.tsx`, `renderer/src/features/gallery/domain/persona-snapshot.ts`, `renderer/src/app/shell.tsx` (add through `useAgentPersonaLibrary`).
Host/services: `server/routes/gallery.ts`, `server/github-import.ts`, `server/github-snapshot.ts`, `electron/multi-window.cjs`, `server/agent-persona.ts`.

**Status:** Partial.

- **Contract Test:** `pnpm test:protocols`, `pnpm test:renderer`, and
  `pnpm test:server` cover bounded whole-index
  parsing/fallback, image-host and redirect restrictions, cached browsing, copy
  serialization, and shared GitHub acquisition/publication rollback.
  `github-snapshot.test.ts` covers anonymous default-branch archive redirects,
  bounded streaming/extraction, path and symlink confinement, malformed archives,
  cancellation and idle timeout. `__tests__/github-import.test.ts` exercises real
  archive extraction with controlled HTTP bytes, Git unavailable, and publication,
  registration and shutdown recovery. The Electron
  smoke also loads the built Gallery UI through `app://renderer`, decodes cover,
  and detail cover images using controlled
  proxy bytes with production CSP and native request authorization. See
  [Gallery boundary](architecture.md#gallery). Persona parsing (optional array,
  refused ids, unknown icons) is `gallery.test.ts`; the bundled persona
  fallback is `use-gallery.test.tsx`; a Gallery add landing in the picker's
  cache is `use-agent-persona.test.ts`; the two entrances never showing each
  other's shelf is `gallery-refresh.test.tsx`.
- **Confirmed copy and location (2026-11-05):** Make a copy opens a
  confirmation with the folder name and location and no repository URL;
  nothing downloads until it is confirmed. `gallery-shop.test.tsx` covers the
  confirmation through the shell, `use-project-entry.test.ts` the picker-chosen
  location reaching the import, and `__tests__/github-import.test.ts` the copy
  and its staging landing in the chosen location, plus refusal of a missing,
  relative or non-directory location before download. `routes/project.test.ts`
  covers the remembered location and its folder-home fallback. The dialog was
  reviewed in its Story (light and dark); no built-app pass drove the native
  picker or a real copy into a non-default location.
- **Acquisition diagnostics (2026-11-10):** `__tests__/github-import.test.ts`
  exercises network refusal, GitHub HTTP 429, invalid gzip and registration
  failure through real HTTP import/receipt handlers, the production log reporter
  and archive extraction. Cancellation/shutdown retains its download stage.
  Each attempt keeps one stage/cause diagnostic across repeated POST and GET
  receipt recovery, while responses contain no internal diagnostic or upstream
  response body. `github-snapshot.test.ts` retains the original idle-timeout
  reason. This repairs missing evidence, not the historical Windows download
  failure; its original cause and Windows runtime reproduction remain unknown.
- **Snapshot runtime pass (2026-10-09):** an isolated macOS Electron app with
  the built renderer, native boundary and built Node service imported real
  `octocat/Hello-World` through GitHub Import and Gallery Copy with no executables
  on the service's PATH. GitHub Import reused Welcome; Gallery opened a second
  project window while the source kept its project. Both copies contained the
  same README and no `.git`; the copied README opened with its real content.
  Repeating Gallery Copy showed the destination conflict without changing files.
  Gallery index metadata was controlled; archive downloads used real GitHub.
  Telemetry was unavailable in the isolated profile. This is source-runtime
  evidence, not a packaged Windows/Linux or update-path result.
- **Driven Runtime Pass:** clean-profile bundled browsing and detail
  inspection without account/runtime. A separate isolated built-app pass
  (2026-09-14) copies real `octocat/Hello-World` via a controlled Gallery index,
  registers it, opens a second bound window, and preserves the shop's null binding.
  An isolated built-app pass on 2026-10-08 opened Browse personas from the
  composer, read Essayist's sample and prompt, added its library copy, and
  returned to the unchanged Builder selection. The sidebar Gallery showed
  projects only; X Content Starter's detail showed one cover and its About
  introduction with no prompt or thumbnail strip. Both surfaces were inspected
  through the native UI, and project-detail composition was reviewed by eye.
  Injected window-open failure preserves the copy/registration. OS key/URL setup
  is substituted; packaged delivery is not exercised. An isolated macOS source
  Electron pass (2026-09-15) loads the built UI through the production app
  protocol, browses the live published index, and visually verifies the ECCV
  2026 Orals hero and all three thumbnails. The original failure was relative
  image URLs resolving to bundled files, followed by CSP blocking the daemon
  image URL. Both are covered by the built-renderer smoke above. A further
  isolated pass (2026-09-15) hovered a shelf card carrying a long description
  and measured two rendered lines; restoring the `block` class beside the clamp
  in the same window returned four, which is what the shelf showed before.
- **AI Eval:** not required; acquisition does not generate content.
- **Release Check:** published index, CDN screenshots, real copy, and new window
  in one packaged pass.
- **Gap:** published delivery still needs verification in a signed installer. Wire fields
  `learnMore`, `starterPrompts`, `contents`, and `files` have no app surface.
  The shared flow now owns Gallery acquisition, conflict recovery, and window
  entry. The older separate-window runtime pass above predates this policy;
  the new J02 built-app pass verifies Welcome reuse, explicit conflict recovery,
  and retry without reacquisition. Packaged validation remains a release check.
- **Gallery review (2026-09-15):** reviewed the working tree at `ab8d4c9b`
  through catalog loading, details, clipboard, and shared project acquisition.
  Focused renderer and host/protocol suites passed 29 tests. Two temporary
  controlled probes reproduced the cache and selected-entry issues below;
  they were removed after review. This pass did not repeat live CDN or packaged
  verification.
- **Gallery recovery implementation (2026-09-15):** `use-gallery.test.tsx` covers
  reconnect after a failed catalog load. `gallery-refresh.test.tsx` covers
  reopening recovery, updated detail/copy identity, and withdrawal of a selected
  entry. `gallery/ui/recovery.test.tsx` covers clipboard refusal/retry, retired
  prompt feedback, and screenshot retry through the original proxy. The detail
  now labels the generating request **Prompt**, and missing metadata refers to
  a project. The unused copy-error prop chain and obsolete separate-window
  comments were removed; acquisition failures remain in the shared entry dialog.
- **Gallery recovery runtime pass (2026-09-15):** a native window loaded the
  built renderer through `app://renderer` and recovered a failed catalog and
  failed screenshot through the authorized local proxy. A controlled clipboard
  refusal kept the prompt readable, and retry displayed confirmation for the
  correct text. Service/clipboard failures were fixtures, not live CDN or OS
  permission failures. The standard Electron smoke also passed cover, hero,
  thumbnail decoding and selection with production CSP. Installed delivery
  remains a release check.
- **Gallery cover frame runtime pass (2026-10-15):** covers are drawn at 16:9
  without the project's name, and the shelf card prints the name in a band
  below the picture instead of over it. A native window of the built renderer
  loaded an unpublished local index of redrawn covers through
  `STASHBASE_GALLERY_INDEX_URL`, with relative screenshot paths served from
  `app://renderer`. It showed the full cover in every Welcome card, the hover
  description rising over the picture without changing card height, and the
  full cover on the entry page. The proxied CDN path was not exercised before
  publication.

## J14: Scheduled tasks

**Project-list isolation and diagnosis (2026-11-03):** a held unrelated directory
stat reproduced a healthy registered-project lookup waiting on all projects.
Exact membership now checks the selected root's availability; schedule scans
read projects independently with a two-second wait and a problem entry for slow
storage. Concurrent scans share pending reads until actual I/O settles, without
changing definitions, switches, history or occurrence claims. Path comparison
fast paths also prevent unrelated synchronous volume probes during state reads.
Focused project/path/schedule regressions cover scope, malformed membership,
slow-project isolation, current enabled state and recovery. The isolated
`project-availability` profile measures the previous list at 12,047–12,306 ms
and the isolated list at 2,001–2,002 ms with injected three-second stats; see the
[scenario](../scripts/profiling/README.md#scenario-project-availability).
Renderer and scheduler clients now retain a pre-dispatch request UUID through
transport and body timeouts. Host lifecycle observations distinguish pending,
finished and closed requests under bounded, consent-aware telemetry; they do
not equate closure with failure. These changes fix demonstrated coupling and
missing evidence, not the still-unproven cause of users' Windows timeouts or
WebSocket 1006 closures. Actual device service/process evidence remains needed.
The final slow-storage regressions hold both root stat and task-file open,
retain enabled switches, and verify missing storage stays quiet. Seven built
Electron scheduler checks pass, including request IDs across transport/body
timeouts with no request replay. Built smoke also passes controlled renderer
and network-process closure correlation and reconnection; injected process
termination does not establish the cause of users' historical disconnects.

**Intent:** [J14](../design-docs/journeys/README.md#j14-run-a-scheduled-task-in-a-project).

**Implementation:** Renderer: `renderer/src/features/agent/application/scheduled-run.ts`,
`renderer/src/features/agent/ui/scheduled/scheduled-tasks-view.tsx`,
`renderer/src/features/agent/hooks/use-scheduled-run-receiver.ts`. Main:
`electron/scheduled-tasks/scheduler.ts`, `electron/scheduled-tasks/ipc.ts`,
`electron/multi-window.cjs`. Host: `server/scheduled-tasks.ts`,
`server/routes/scheduled-tasks.ts`.

**Status:** Partial.

- **Contract Test:** `server/scheduled-tasks.test.ts` covers lenient parsing,
  single-task edits that keep unknown fields, version conflicts, unreadable files left
  untouched, at-most-once claims, enabled-time cutoff, bounded run history, forward-only
  run reports with their bounded reply excerpt, missed days recorded as one entry in
  its place in time (including across a clock change and below a later Run now), the
  five-minute on-time window with no late runs, stale running runs, and removal.
  Electron suites cover the due rule with its on-time window, one run per day, Run now, the run
  coordinator's late-subscriber pull and deadlines, preload de-duplication, and the
  no-focus window rule. Renderer suites drive a run through the real session runtime
  over a fake port (sent in the background with its title and file, its first-turn
  outcome and reply excerpt reported, refused for a missing file or an unready agent),
  the surface that stands in the chat's place, and the list page: next run, latest-run
  states including a held chat's live approval wait and missed days, today's run
  listed as missed once its window passed, the run history with reply excerpts, the
  empty list, the in-page form with its agent
  choices, and the clock on run chats in the chat list.
- **Driven Runtime Pass:** 2026-10-16, built app under an isolated HOME and port: a
  due task was claimed about 20 seconds after launch, its project window opened hidden
  and unfocused, the run failed with the agent-readiness reason (no agent set up in
  that HOME), and the run was recorded with its occurrence and the task file
  untouched; focusing the other window revealed it without taking focus. The chat
  pane's header beside Documents showed the list page in the chat's place and toggled
  back; the Chats sidebar row showed the same page with each task's next run, its
  latest run and the run history. The page followed an external file edit within one
  refresh, recorded Run now in the history, and edited a task in the page with its
  named file as a chip. No live agent turn was driven.
- **Driven Runtime Pass (Windows):** 2026-10-16, source build with a signed-in
  Default Agent: a task due at 17:47 was claimed at 17:47:44, sent its chat without
  taking the visible chat, and settled as finished with its title. With the task's
  record set to a last run on Oct 13, launching at 20:19 recorded "Missed 2 runs"
  (Oct 14 – Oct 15) when that day's run was claimed, which wrote its brief file and
  showed "Finished" with the reply excerpt. That build still started a run due
  earlier the same day; the current rule lists it as missed instead. A Claude task with no
  sign-in failed as "Did not run" with the sign-in reason. The Chats list marked both
  run chats with the clock and not the reader's own chat. A Codex task ran on time
  and settled with its excerpt. With only Welcome open and Notepad focused, a due
  task opened its project in a hidden window, kept Notepad focused, and finished;
  focusing StashBase revealed it behind the focused window. A run whose app was
  quit mid-turn read as "Started" after relaunch, and its Open chat restored the
  partial chat. A copied project listed every task off with no history. An approval
  wait could not be produced: in Ask mode the runtimes reported their write tool and
  shell as unavailable, and the runs finished with that reply as their excerpt.
- **Driven Runtime Pass (no late runs):** 2026-10-19, built app on macOS under an
  isolated HOME and port. A task due two minutes before launch, last run three days
  earlier, was claimed 23 seconds after launch in a hidden project window, failed with
  the readiness reason (no agent set up in that HOME), and recorded "Missed 2 runs"
  (Oct 17 – Oct 18) below it. A task due 30 minutes before launch was never claimed
  within 95 seconds; the list showed it as missed that day, with the closed-or-asleep
  note and its next run tomorrow, and the run history listed all three newest first.
  Repeated on 2026-10-20 on main after the merge, with the same results.
- **AI Eval:** Not applicable; a run's quality is the workflow's and the agent's.
- **Release Check:** packaged macOS, Windows, and Linux runs with a signed-in agent,
  including a run slept through listed as missed, and the hidden-window reveal on
  each platform.
- **Gap:** a run's later approval wait, the persisted title on each runtime, a
  signed-in Claude run, live runs on macOS and Linux, and packaged builds are
  unproven in the app. Waking
  from sleep inside the on-time window is covered by tests only. The reply excerpt
  shows what a finished turn said, not whether its work succeeded.

## Maintenance Rule

Update this map when ownership, evidence, status, or a residual check changes.
Keep stable Jxx anchors; record decisive behavior and substitutions, not copied
assertions/counts or execution diaries. Detailed new runs belong to the owning
change record. [UI Release Sanity](../release-checklists/ui-sanity.md) owns the
packaged checklist. Documentation validation checks links and reciprocal routes,
not the truth of a test's claims or intent metadata.

## Cross-cutting Gaps

- **Interface consistency pass (2026-10-23):** the
  [Visual Style](../design-docs/visual-style.md) rules for cards, buttons,
  working buttons, menus, drop targets and dots, and the
  [Glossary](../design-docs/glossary.md) terms for chat, approval and the
  Default Agent, were applied across the renderer and host copy. Owners:
  `lib/local/drop-target.ts` (the one drop highlight), `components/ui/menu-item.tsx`
  (`destructive`), `features/workspace/ui/file-tree-menu.tsx` (the tree menu on
  the shared kit, opened by right click or a row's "…"), and
  `server/agent-runtime-installer.ts` with `POST /api/terminal/clis/:id/stop`
  (a stoppable runtime sign-in that asks for the browser only once one opens).
  Unit evidence: `access-dialog.test.tsx` (hand-off to the account dialog,
  failures kept, Stop waiting), `use-account.test.ts`,
  `account-access-dialog.test.tsx`, `runtime-row.test.tsx`, the installer
  tests, `menu-item.test.tsx`, `file-tree-menu.test.tsx`,
  `conversation-tree.test.tsx`, `context-tiles.test.tsx` (one chip or tile
  predicate before and after sending) and `use-external-files.test.tsx` (a
  failed open reported once). A built-app pass showed the tree's "…" and its
  shared menu with Delete last in the error colour; Storybook showed the paper
  turn-changes, approval and upgrade cards, the Agents panel and the account
  dialog. Real CLI and browser sign-in, the stop route against a live login,
  and dark-theme composition of the paper cards are unproven.
- **Notice placement (2026-10-23):** the
  [Visual Style](../design-docs/visual-style.md) places a notice inline, in
  the strip, floating, or in the sidebar's corner. `shared/ui/notice.tsx`
  owns the strip and the floating and corner cards; the window strip and every
  document strip draw through `NoticeStrip`, and only the sign-in offer and its
  wait keep their own centred banner. `app/composition/folder/use-workspace-notices.ts`
  sorts the shell's own notices: preparation the shell ran reports from the
  corner, a reprocess the reader asked for and turn reviews that did not open
  float, and a host folder disagreement holds the strip beside the sign-in
  banner. The file-tree menu, opened without a trigger, is named through
  `DropdownContent`'s `aria-label`. Document open and link failures float in
  `documents/ui/workspace/workspace.tsx` and the HTML, DOCX and Markdown viewers;
  `features/updates/ui/update-notice.tsx` is a corner card, and
  `app/composition/layout/workspace-titlebar.tsx` marks the collapsed sidebar's
  control while the corner holds a notice. `use-workspace-notices.test.ts`
  covers the sorting and `workspace-titlebar.test.tsx` the collapsed mark.
  A driven pass of the built app refused a Markdown link with the external
  open stubbed to fail. The card floated on one line below the pane's reading
  bar, left its controls uncovered, and Dismiss cleared it, in light and dark.
  The corner card, the strips, and the long-sentence wrap were reviewed in
  Storybook only.
  The external-file drop refusal floats from `drop-zone.tsx`.
- **Native crash recovery (2026-09-16):** confirmed renderer termination
  releases its save barrier; a live renderer timeout still blocks close.
  Lifecycle tests cover reload and refusal, and an isolated real Electron
  `forcefullyCrashRenderer` pass confirms Close destroys the crashed window.
  Text that had not reached its source file remains unrecoverable.
- **Remaining-area follow-up (2026-09-16):** Agent preferences and embedder
  route tests now run under `test:server`; obsolete manual file-order storage,
  synchronous upload naming, and unwired legacy smoke scripts were removed.
  Node owns atomic MCP launcher generation at startup and readiness/Settings.
  The root linter remains required by architecture fixtures and current lint
  resolution; removing it activates a different tool version. Real providers, signed releases, and cross-platform
  update installation remain separate evidence requirements.

- No measured startup, interaction, long-task, disposal-memory, or bundle-size
  budgets. Token/source gates do not measure runtime performance.
- HTTP has no bounded reconnect ladder; recovery is polling or explicit retry.
  Settings lacks a local render boundary, so a render failure remounts the shell.
- No automated painted contrast, overlay stacking, or composed density/icon/fill
  consistency gate. The separate `pnpm test:renderer:a11y` sweep runs Story
  interactions and structural axe checks once in default/light appearance;
  it is part of `check:web`, not the focused renderer suite. Neither it nor
  token checks establishes painted behavior.
- Full journey automation and pixel baselines are absent. Electron smoke
  exercises launch/preload and selected boundaries. A future journey harness must
  use current preload/registry contracts and state its Jxx intent. J10/J08/J12
  still require the flow/client/quality evidence described above.

These are engineering or evidence limitations, not additional product features.
