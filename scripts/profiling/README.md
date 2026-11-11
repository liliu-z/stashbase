# Profiling

These scripts measure isolated StashBase runtimes so you can compare two
versions of the code. Renderer scenarios drive a window through the Chrome
DevTools Protocol, either the development renderer or the production build
(`budgets`); host scenarios use the native runtime directly. Each scenario measures one user task. Run a scenario
before and after a change, then compare the two labels.

Results and CPU profiles go to `profiling.nosync/<scenario>/`, which Git ignores.

## First-send feedback

`pnpm profile:first-send --label before --runs 2` measures Send-to-own-message
paint in the mounted development Chat workspace. The isolated fixture uses a
ready catalog and controlled session ports with immediate and one-second startup;
it never starts a native Agent or calls a model. Each run records `ownMessageMs`
and `wireMs` under `cases.0` and `cases.1000`, verifies a single wire send, and
saves one screenshot of the delayed-startup case per label. The delayed case
should show a pending bubble before the wire send; actual provider startup,
production-build timings and first reply latency are outside this scenario.
Compare with `pnpm profile:compare first-send --labels before,after`.

## Workflow

1. Run the scenario on the current code:
   `pnpm profile:editing --label after`.
2. Get the baseline: `git stash`, run with `--label before`, then
   `git stash pop`. Check `git stash list` first, so you pop your own stash.
   Each run restarts the host, so server changes are included.
3. Compare: `pnpm profile:compare editing --labels before,after`.
4. To find where the time goes, add `--cpu-profile`. It prints the busiest
   functions and their heaviest caller chains, and saves a `.cpuprofile` file
   that opens in Chrome DevTools (Performance → Load profile). Summarize the file
   again with `node scripts/profiling/cpu-profile.mjs <file> --callers <function>`.
   CPU profiling slows the renderer, so compare profiled runs only with other
   profiled runs.

Run at least two runs per label (`--runs`, default 2) and report ranges. Most
scenarios use React's development build, so their absolute times are inflated:
compare ratios between labels. Only `budgets` measures the production build
against fixed limits.

To profile an older commit, use a worktree. It needs `node_modules`,
`renderer/node_modules` and `python/.venv.nosync`, so symlink them from the
main checkout. Copy `scripts/profiling/` in if it is missing at that commit.
pnpm rejects symlinked dependencies, so start Vite yourself with
`pnpm --config.verify-deps-before-run=false dev:web`. The harness reuses a Vite
that is already running on :5173. That also means a Vite left running from
another checkout serves the wrong renderer, so stop it first.

## What the harness guarantees

`harness.mjs` sets up the following:

- **Isolation.** The host and Electron get a private `HOME`, `XDG_DATA_HOME`,
  `XDG_CONFIG_HOME` and Electron user-data directory. The real project
  registry, settings, session and index are never touched. Telemetry is off.
- **Renderer.** `renderer: "dev"` (the default) serves the renderer from
  Vite. `renderer: "build"` loads the production bundle in `dist/renderer`
  over `app://renderer`, as a packaged app does; `buildRenderer()` builds it.
- **Host ownership.** By default the harness starts the host before Electron.
  `ownHost: true` lets Electron start it, as a normal launch does, so a
  measurement from launch includes host startup.
- **Ports.** The host runs on :8190 and DevTools on :9333, so a normal
  `pnpm dev` on :8090 can keep running. If either port is busy, the harness
  stops with an error. Vite on :5173 is shared.
- **Startup.**
  - The host runs with the same Node as the script, not a version-manager shim.
  - `ELECTRON_RUN_AS_NODE` is removed.
  - The Electron boundary is rebuilt before launch.
- **Focus.** The window keeps page focus through `Page.bringToFront` and focus
  emulation. Without it, a window on a hidden workspace receives no synthesized
  keystrokes.
- **Project open.** `openProject` opens the project through `/api/projects/open`
  and reloads the window. Without the reload, the window stays on Welcome.
- **Relaunch.** `fresh: false` keeps the profile from an earlier launch, so
  the window restores its last project. `rootPids` lists the app's process
  group leaders (never Vite) for process-tree memory.
- **Teardown.** Every child runs in its own process group and is stopped when
  the scenario ends, including when it fails. Logs stay in
  `profiling.nosync/<scenario>/logs/`.

Fixtures are generated fresh for every invocation (`fixtures.mjs`). They live
outside hidden directories and outside `/tmp`, because projects inside hidden
directories index no files and the Recent list hides `/tmp` projects.

## Scenario: budgets

`pnpm profile:budgets --label after --runs 3` measures the performance budgets
against the production renderer. Run it before and after any change aimed at
speed or memory. It builds `dist/renderer` first and prints each budget with
its range and whether the worst run is within the limit. `--skip-build` reuses
the current build and records the revision the runner last built it from, or
`unknown` for a bundle built another way. The limits are the `BUDGETS` table
at the top of `budgets.mjs`. They are informational: nothing gates on them
until the thresholds are agreed.

The runner supports Linux and macOS. Windows is unsupported: process-tree
memory reads `ps`, and child processes are stopped by process group.

**Setup**

- The project has 1,000 notes in 20 folders, `big.md` (124 KB, about 2,300
  editor paragraphs) and `small.md` (3 lines).
- A priming launch opens and indexes the project and saves that profile.
  Each run restores the documents and that profile, then launches Electron,
  which starts its own host and reopens the project with no documents open.
  Every fixture file keeps one fixed modification time, so the restored
  project matches the primed index and no resync overlaps the measurements.
- The host's `server.log` stays in the isolated profile, under
  `profile/data/stashbase/logs/`, as for every launch with
  `STASHBASE_LOCAL_DATA_ROOT` set. Each run restores the profile first, so
  only the last run's log is kept.

| Budget | Measured as |
|---|---|
| Cold start | Electron launch → the restored project's tree shows its files. Includes host startup. |
| Startup JS | Minified size of every script parsed at that moment. |
| Folder expand | Click on a collapsed folder → its first child row on screen, before any document opens. |
| Open small / 120 KB file | Tree click → the editor shows the file's marker sentence. |
| Switch tab | Tab click → the other kept document is visible again. |
| Idle long tasks | Long tasks during 10 s with `big.md` in front. |
| Idle memory | PSS summed over the whole process tree after the idle period (RSS outside Linux), grouped into Electron, host, Python and agents. |
| Typing p99 | 150 keys at 60 ms in `big.md` and then the chat box; `beforeinput` → next frame → next task. |

Timed actions report `visibleMs`, when the result is first on screen, and
`settledMs`, which also runs to the end of any long task starting within the
following 2 s. The budget uses `settledMs`, because a freeze right after the
first paint is part of the action.

**Limits of the measurement**

- The profile is signed out, so the Default agent never starts or pre-warms
  OpenCode, and agent memory is not counted. Agent process startup is covered
  by the Default session scenario.
- The host runs from source through `tsx`, so cold start includes TypeScript
  loading that a packaged app does not do.

**Reference ranges** (Linux x64, `ef80f7bd`, 2 runs)

| Budget | Limit | Measured |
|---|---|---|
| Open small file | 50 ms | 496–509 ms |
| Open 120 KB file | 200 ms | 2,485–2,705 ms |
| Switch to small / 120 KB tab | 50 ms | 510–526 / 545–551 ms |
| Folder expand | 16 ms | 74–91 ms |
| Idle long tasks, 10 s | 0 | 0–1 |
| Typing p99, editor / chat | 16 ms | 29–35 / 22–24 ms |
| Cold start | 1,000 ms | 2,477–2,585 ms |
| Idle memory (PSS) | 600 MB | 955–959 MB (Electron 489, host 293, Python 177) |
| Startup JS | 350 KB | 2,317 KB |

## Scenario: editing

`editing.mjs` measures typing in a long Markdown document. Use it for changes
to the Markdown editor, document runtime, saving, file tree, outline or
workspace session.

**Setup**

- The project has 300 short notes plus `big.md`, which is 124 KB and 2,305
  editor paragraphs of headings, prose with inline marks, and `-` lists.
- Before measuring, the scenario waits for the first keyword index of the
  project to finish.
- Each run restores `big.md`, reloads the window, opens the document from the
  tree, and puts the caret in the middle paragraph.
- It then types 61 characters at 80 ms intervals (about 12 per second) and
  waits 10 seconds for the held edit, autosave and refreshes.

| Metric | Meaning |
|---|---|
| `latencyMs.p50`, `p90`, `max` | `beforeinput` → next animation frame → next task: roughly when the frame showing the character is committed. |
| `longTasks.count`, `totalMs` | Main-thread tasks over 50 ms. `startAndDurationMs` places each one relative to the start of typing. |
| `treeReloads` | `GET /api/files` requests: full project-tree reloads. |
| `saves` | `PUT` or `POST` to `/api/files/*`. |
| `sessionFileEvents` | Filesystem events on `workspace-session.json` (several per write). |
| `savedFileChangedLines` | `git diff --numstat` of the saved file against the original. Typing changes one line; anything more means the save rewrote unedited Markdown. |
| `indexSettled` | Whether the first index finished. If false, saves were not followed by indexing as they are in normal use. |

**Reference ranges** (Linux, development build, 2 runs each)

| | Before PR #222 (`34a55dce`) | After (`1bb6b57f`) |
|---|---|---|
| Latency p50 | 194–274 ms | 22–24 ms |
| Latency p90 | 290–1,388 ms | 30–33 ms |
| Long tasks | 71–84 (19–46 s) | 4–5 (0.5–0.7 s) |
| Tree reloads | 3–6 | 0 |
| Saves | 6–15 | 1 |
| Saved-file diff | +2,882 −1,729 | +1 −1 |

## Scenario: Default session startup

`pnpm profile:default-session --label after --runs 3` measures the real pinned
OpenCode process, MCP readiness, and native chat creation. Use `--checkout
/path/to/baseline` to measure another checkout with its own runtime code and
available dependencies/build output. Compare with
`pnpm profile:compare default-session --labels before,after`.

The headless scenario isolates Settings and app data, supplies local catalog
fixtures, and makes no external model requests. Each pair starts cold, ends a
turn, waits five seconds to represent reading the answer, then starts another
chat. The idle interval is excluded from startup latency. Renderer development
build overhead does not apply to this scenario.

| Metric | Before (`73aaa4c1`) | After (2.16 Crew changes) |
|---|---|---|
| `coldMs` | 1,160–1,406 ms | 1,123–1,508 ms |
| `nextChatMs` | 1,115–2,792 ms | 14–16 ms |

Reference ranges are three runs per label on the same macOS arm64 machine.
The baseline worktree had unchanged source and untracked dependency/build
symlinks, hence its raw revision label includes `+dirty`. These measurements
exclude real catalog network latency, model generation, and UI rendering.
An expired or incompatible spare still requires cold startup.

## Scenario: PDF raster memory

`pnpm profile:pdf-memory --label after --runs 2` opens a generated twelve-page
vector PDF in isolated Electron, emulates DPR 2, zooms to 300%, then scrolls to
page ten. Use it for PDF raster allocation and disposal changes. The script
retains the first detached canvas long enough to measure explicit release
without depending on garbage collection. No user document is read.

Reference ranges on macOS arm64, two runs per label, baseline `24026773`:

| Metric | Before | After raster cap and disposal |
|---|---|---|
| First-page backing bytes | 69,797,376–69,797,376 | 16,768,800–16,768,800 |
| Detached first-page backing bytes | 69,797,376–69,797,376 | 0–0 |
| CSS page dimensions | 1836 × 2376 px | 1836 × 2376 px |

This measures canvas dimensions × four bytes, not total renderer/GPU RSS or PDF
image-decoder allocations. It does not reproduce the reported low-memory Windows
OOM/GPU crash, establish a driver fault, or measure arbitrary complex documents.

## Scenario: project availability

`pnpm profile:project-availability --label after --runs 2` measures
healthy registered-project lookup and scheduled-task enumeration while another
project's storage is slow. The headless scenario requires the isolated-home
preload, creates disposable project files, and makes no provider requests.

On macOS arm64 (2026-11-03), two baseline runs left the healthy lookup pending
through a 400 ms hold on the unrelated directory; after isolation it returned
in 0.3–6.7 ms while that hold remained. With a three-second delay injected into
each slow-directory stat, list latency fell from 12,047–12,306 ms to
2,001–2,002 ms. The healthy task returned alongside a problem for the slow
project. These are controlled coupling/deadline measurements, not real disk
benchmarks or proof of the reported Windows timeout's cause. The schedule
regressions separately cover stored switches and synchronous path comparisons.

## Adding a scenario

Write `<scenario>.mjs` beside `editing.mjs`:

1. Generate its fixture in `fixtures.mjs`.
2. Call `launchApp({ workDirectory: profilingDirectory("<scenario>") })`.
3. Drive the window through `app.window` (`evaluate`, `waitFor`, `type`,
   `reload`, `send` for raw CDP).
4. Append one JSON line per run to `results.jsonl`, with `scenario`, `label`,
   `run` and `revision`. `compare.mjs` shows any numeric field, including
   nested ones.
5. Stop the app in a `finally` block.

Then add a `profile:<scenario>` script to `package.json` and a section here
covering what the scenario measures, when to use it, and reference ranges.
Measurements of host or Python daemon work need tooling beyond renderer CDP,
such as `--cpu-prof` on the host, event-loop delay, and process memory. Add
those to the harness when the first scenario needs them.
