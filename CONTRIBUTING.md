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

During implementation, run the smallest suite that exercises the changed behavior:

```bash
# Renderer feature or one file (paths are relative to renderer/)
pnpm test:renderer src/features/documents
pnpm test:renderer src/features/settings/domain/appearance.test.ts

# One host regression; broader boundary suites are in the journey map
node --import tsx --import ./server/__tests__/isolated-home.ts --test server/text-file-transaction.test.ts

# Story interactions and structural accessibility
pnpm test:renderer:a11y
```

`test:renderer` excludes the catalog accessibility sweep and does not build,
check architecture, or collect coverage. `pnpm check:web` is the complete
renderer gate, including coverage, accessibility, static checks, and both builds.
Build and lint commands do only their named work.

Host test workers automatically suppress production telemetry, including when
`STASHBASE_PACKAGED=1` is inherited. The shared isolated fixture also suppresses
child processes. Automated Electron and packaged-server smoke launches disable it too.
Manual packaged checks must set `STASHBASE_TELEMETRY_DISABLED=1` before launching;
see [testing packaged builds](docs/usage-statistics.md#testing-packaged-builds).

`test:server`, `test:agent` and `test:mcp` preload `server/__tests__/isolated-home.ts`,
which points the home directory, app data and Agent settings at a temporary
folder, so host tests never change your own `~/.stashbase` config or projects.
Keep that `--import` when running host test files directly, as above.

Before opening a PR, run `pnpm check` for the complete local source gate.
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

## Profiling

To measure a performance change, run a profiling scenario before and after it
and compare the results. The harness launches an isolated development app and
drives it over the DevTools Protocol; see
[scripts/profiling/README.md](scripts/profiling/README.md) for the workflow,
the scenarios, and how to add one.

## Debugging

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

In development builds, Cmd/Ctrl+Alt+Shift+D opens Developer tools for Agent setup
and turn simulations and sidebar update previews. These controls are separate
from Settings; the production application does not offer the shortcut.
