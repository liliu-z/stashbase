# Contributing

Thanks for helping improve StashBase. Small focused PRs are easiest to review. For larger changes, please open or comment on an issue first so the scope and design direction can be discussed.

Start with the [design guide](design-docs/README.md) for product intent and
[review guide](code-review/README.md) for scoped code review. The
[journey map](code-review/journey-coverage.md) leads directly to implementation
owners and evidence.

## Local Development

Install Node.js 24.11.0+, pnpm, and Python 3.13 with venv support.
On Ubuntu / Debian, also install the native build tools:

```bash
sudo apt install build-essential binutils cmake curl git nasm pkg-config xz-utils
```

```bash
git clone https://github.com/liliu-z/stashbase
cd stashbase
pnpm install
pnpm setup:python

# Build the renderer and run Electron
pnpm build:web
env -u ELECTRON_RUN_AS_NODE pnpm electron

# Development mode
env -u ELECTRON_RUN_AS_NODE pnpm dev
```

The launch commands use POSIX shell syntax to clear an inherited
`ELECTRON_RUN_AS_NODE`. On Windows, clear that variable in your shell before
running `pnpm electron` or `pnpm dev`.

`pnpm dev` rebuilds Electron's main/preload boundary before launching the desktop
and waits for both development servers. Restart it after changing Electron or
shared boundary code so the desktop uses the updated modules.

Source runs share usage statistics under the same Settings privacy switch as
packaged builds, with `app_distribution=source`. To exclude your own development
session, launch with `env -u ELECTRON_RUN_AS_NODE STASHBASE_TELEMETRY_DISABLED=1 pnpm dev`.
This process-only override leaves the saved preference unchanged.

For local PDF and image OCR extraction from this checkout, run
`pnpm setup:python-extract`. To build the independent PDF/OCR component payload,
run `pnpm build:python-extract-sidecar`.

`pnpm count:lines` reports hand-written source lines per area, splitting the
renderer from the host processes and keeping tests and Stories out of the
production totals. It reads the working tree, so the numbers include
uncommitted work. It needs `cloc` (`brew install cloc`) and fails if a
production file falls outside every bucket, so a new top-level source
directory has to be added to the script.

## Testing

The default acceptance is J01: open an empty folder, prepare/sign in to the
chosen Agent, receive a completed reply, update when needed, and return without
another login. Exercise Default, Claude, Codex, and Antigravity.

Run `pnpm check` at the end of a change. It checks types and `pnpm test:core`:
full-window onboarding scenarios, host setup and file-preservation rules, and
the bundled OpenCode runtime against a controlled gateway. The window scenarios
use controlled ports; they do not prove real OAuth, installer delivery, or
provider availability. Other features use focused checks when affected. Prefer
extending an existing core scenario over adding a regression file for each bug.

During implementation, run the smallest suite that exercises the changed behavior:

```bash
# Renderer feature or one file (paths are relative to renderer/)
pnpm test:renderer src/features/documents
pnpm test:renderer src/features/settings/domain/appearance.test.ts

# One host regression; broader boundary suites are in the journey map
node --import tsx --import ./server/__tests__/isolated-home.ts --test server/text-file-transaction.test.ts

# Chat formulas, Agent-written Markdown and copy/paste into Documents
pnpm test:renderer src/app/composition/layout/math-workflow.test.tsx

# Story interactions and structural accessibility
pnpm test:renderer:a11y
```

`test:renderer` excludes the catalog accessibility sweep and does not build,
check architecture, or collect coverage. `pnpm check:web` is the complete
renderer audit for CI and architecture/toolchain changes, including coverage,
accessibility, static checks, and both builds. Ordinary local UI work uses the
core gate, formatting/lint, and affected tests.
Build and lint commands do only their named work.
Use `test:renderer:a11y` for Story accessibility: its dedicated Vite configuration
loads real styles for computed visibility checks.

For interactive math checks, run `pnpm storybook` and open
**Compositions / Math workflow / Chat To Document**. Chat and Documents share
`renderer/src/test/fixtures/math.ts`: compare rendering, switch Math, edit a
formula, or copy a reply/selection into **Paste target**, then **Save and reopen**.
**Saved Markdown** exposes the saved source. This Story uses a controlled Agent
and in-memory files; provider output and disk writes require separate checks.

Host test workers automatically suppress production telemetry, including when
`STASHBASE_PACKAGED=1` is inherited. The shared isolated fixture also suppresses
child processes. Automated Electron and packaged-server smoke launches disable it too.
Manual source and packaged checks must set `STASHBASE_TELEMETRY_DISABLED=1` before launching;
see [testing and development](docs/usage-statistics.md#testing-and-development).

`test:server`, `test:agent` and `test:mcp` preload `server/__tests__/isolated-home.ts`,
which points the home directory, app data and agent settings at a temporary
folder, so host tests never change your own `~/.stashbase` config or projects.
They also exclude host PATH/global/login-shell CLI discovery and clear inherited
provider executable overrides. Tests may install fixtures in their private home
or inject explicit executables. Profiling uses the same isolation.
Keep that `--import` when running host test files directly, as above.

For a complete source audit, run `pnpm check:all`.
It includes `check:web`, documentation validation, host suites, type checks,
builds, and Electron smoke; do not repeat its constituent commands afterward.
For a scoped change, follow [AGENTS.md](AGENTS.md) and the affected
[journey](code-review/journey-coverage.md).

The source gate builds each target once. `pnpm test:electron:smoke` builds its
own prerequisites when run alone; `pnpm test:electron:smoke:built` is for a
pipeline that already built the renderer and Electron boundary from the same
checkout. Never use it against stale outputs as evidence for a change.
Headless Linux needs Xvfb; CI supplies it and uses `--no-sandbox` for the isolated
source smoke. Packaged apps and macOS/Windows retain their normal sandbox.

Real-provider evaluations and packaged verification stay in the
[release workflow](code-review/release-pipeline.md); a passing source gate does
not establish model quality or a complete user journey.

### Real Agent Onboarding

Run `pnpm verify:onboarding --agent codex` (or `stashbase`, `claude`,
`antigravity`) for explicit interactive verification. It builds the app and
opens a persistent private profile under `profiling.nosync/onboarding/`.
It excludes the developer's discovered CLIs and home-based credential files. Install
and sign in through the app's controls; rerunning the same command preserves
that profile's sign-in and projects. `--fresh` archives the previous profile in
a dated directory and starts a new one; omit it on the next run to reuse login.
`--built` reuses outputs only when they were built
from the same unchanged checkout in this validation run.

Open the printed empty folder, choose the named Agent, connect/sign in, and
send an idea. Require a visible reply and a completed turn, not merely Ready.
If an update is needed, update and verify another completed reply. Close and
reopen to check login reuse. Check each provider separately; Default signs in
through StashBase and ships its runtime with the app. This explicit pass may
open the provider's browser; ordinary tests must not start real login.
Record provider/runtime version, observed steps, substitutions and uncompleted
steps in [J01](code-review/journey-coverage.md#j01-onboarding). An interrupted
or unavailable login remains unverified, never passed.

Prioritize first installation and connection over already-signed-in reuse.
Use this small environment matrix; do not expand every variable into a full
cross-product or create a regression suite for each machine:

| Starting condition | Required result |
|---|---|
| No CLI and no provider sign-in | Install through the app, complete real authorization, and receive a completed first reply. |
| Working CLI, signed out | Reuse the installation, sign in, and continue the held message once. |
| Broken npm/Homebrew/native launcher | The first explicit Connect checks executability and repairs through the official installer; preserve unrelated installations/configuration. |
| Existing account and current CLI | Connect without another browser login or download, including after reopening. |
| Old runtime | Update when required, reconnect, and complete the refused request once. |
| Failed download, unavailable browser, or cancelled login | Show the failed step and a usable recovery; retain the draft and never report Ready without verification. |

Run the clean-install path on each supported OS for release acceptance. Check
affected environment differences where they actually matter: a spaced/non-ASCII
home path, stale GUI PATH, installer permissions, proxy/network, or provider
account eligibility. Controlled fixtures establish local decisions only.
`--fresh` resets app/home state, not the OS keychain or browser account. A true
new-user pass requires a separate OS user or clean VM with no provider sign-in;
record reused credentials instead of calling that pass fresh onboarding.

## Profiling

To measure a performance change, run a profiling scenario before and after it
and compare the results. The harness launches an isolated development app and
drives it over the DevTools Protocol; see
[scripts/profiling/README.md](scripts/profiling/README.md) for the workflow,
the scenarios, and how to add one.

## Debugging

Startup checks `better-sqlite3` in the server's actual runtime, reads back a
temporary database in application data, and verifies the existing preparation
state. A failed check appears once in the desktop and in server logs; document
editing remains available. `/api/health` reports this startup snapshot under
`preparationStorage` separately from its server-identity `ok` flag.

After changing Node versions or packaging locally, a source checkout may contain
a native addon built for another runtime. Use the Node runtime that starts the
source server, run `pnpm rebuild better-sqlite3` in the checkout, then restart.
Packaged users should reinstall the matching StashBase installer; changing a
system Node installation cannot repair Electron's bundled runtime. For storage
failures, check application-data permissions and disk space. Preserve a damaged
state database for diagnosis instead of deleting it as an automatic repair.

- Renderer logs: **View -> Toggle Developer Tools**
- Packaged-app server logs: `~/Library/Logs/StashBase/`
- Useful env vars: `STASHBASE_LOG=debug`, `STASHBASE_PYTHON=/path/to/python`, `STASHBASE_BUILD_EXTRACT=1`

With `STASHBASE_LOG=debug`, Default Agent logs model-catalog and native connection
times, spare-runtime readiness, and each model request's headers, first bytes,
first visible text, and elapsed time. Requests include the profile and turn id;
input/output and cache token counts appear when the gateway supplies them.
These measurements contain no prompt or generated text. Gateway timing includes
network and upstream work; it does not isolate the provider's own latency.

API keys are configured in Settings, not environment variables.

## Release Notes for Maintainers

Follow the [Release Runbook](code-review/release-pipeline.md) for versioning,
source-CI gating, signing, packaging, publication, and residual checks.
Packaging is release-only; outputs stay in `release.nosync/` and are never committed.

## Development Controls

In development builds, Cmd/Ctrl+Alt+Shift+D opens Developer tools for agent setup
and turn simulations and sidebar update previews. These controls are separate
from Settings; the production application does not offer the shortcut.

For restricted write-failure diagnosis, use the evidence-only reader and temporary
regression generator in [Usage statistics](docs/usage-statistics.md#write-failure-diagnostics).
Received attachments contain full paths and must not be committed or pasted into
public issues. Run generated regressions with the isolated-home command shown there.
