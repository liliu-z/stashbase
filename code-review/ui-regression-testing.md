# UI Regression Testing

> Engineering contract for Electron/Playwright harnesses, deterministic
> fixtures, selectors, visual baselines, cleanup, and flake policy. Product
> coverage ownership lives in [Journey Coverage](journey-coverage.md).

## Layer Ownership

- Renderer tests own state reducers, actions, accessibility semantics, and
  component behavior through narrow Interfaces.
- Electron tests own native-window, preload, process, and save-barrier
  contracts. A real-Electron smoke is appropriate when the runtime itself is
  the behavior under review.
- Playwright smoke owns short release-blocking paths. Functional journeys own
  broader user workflows. Visual tests own representative composition only.
- Packaged, credentialed, real-media, and native-dialog checks stay in release
  sanity unless a deterministic lower Adapter can prove the contract.

Add a regression at the lowest layer that proves the behavior. Promotion to a
broader layer must buy evidence that the lower Seam cannot provide.

## Harness and Isolation

- Each worker owns disposable folders, configuration, ports, server processes,
  Agent fixtures, and browser state. Tests never read personal credentials or
  documents.
- Readiness is explicit: wait for the server and required app state, not a
  fixed delay. Failures retain useful logs and process output without exposing
  secrets.
- Cleanup closes live windows, child processes, sockets, and temporary state.
  A failed assertion must not poison a later test or leave a local daemon
  running.
- Electron desktop runs must remove an inherited `ELECTRON_RUN_AS_NODE`; flows
  intentionally using Electron's embedded Node runtime retain it.
- A secondary worktree running indexing or sync journeys must provide
  `python/.venv.nosync`; a missing `mfs` module is worktree setup failure, not a
  product regression.

## Fixtures and Adapters

- Fixtures contain only deterministic, disposable data and declare the
  behavior they replace.
- Native dialogs, Agent protocols, network providers, clocks, and other
  unstable dependencies may use a narrow Adapter. The production Interface and
  authorization rules still apply.
- Fake Agents speak the production protocol and record only test-owned data.
  When a Journey claims a StashBase action, the fake may choose deterministic
  tool arguments but must request the real approval and call the real MCP
  operation with the live window/session attribution. It never writes source
  files directly and does not weaken the packaged real-runtime release check.
- A fake native extractor may make OCR text deterministic while the real
  scheduler, derived-state publication, source mapping, and retrieval path
  remain in use.
- Tests must not make unsupported product states convenient merely for setup.
  Add a fixture Interface when a real setup path would make the test slow or
  nondeterministic.

## Long Journey Strategy

A Journey E2E proves that decisive product Seams compose into one observable
outcome; it does not repeat every lower-layer invariant or make probabilistic
quality deterministic. For a long journey:

- choose one representative Golden Path with stable, disposable source data;
- cross the production Interfaces for scope, permission, MCP, file mutation,
  renderer refresh, and durability that the journey claims;
- keep provider ranking, model judgment, native extraction, and platform
  integration in focused Contract Tests, AI Evals, or Release Checks;
- assert named milestone transitions so one failure identifies the broken
  handoff instead of timing out at the end of an opaque script;
- add only a critical recovery branch that changes the product outcome, not
  every validation and failure variant already owned below the journey.

Real models do not belong in required deterministic Journey E2E. A fake Agent
may replace model choice while still speaking the production protocol,
requesting the real approval, and crossing the real StashBase operation
boundary. A direct fixture write cannot stand in for an Agent/MCP write when
permission, source version, workspace refresh, or session attribution is the
behavior under test.

### Deterministic Agent action fixture

`e2e/fixtures/fake-codex-app-server.mjs` owns deterministic model decisions and
Codex protocol events. For Journey actions it starts the repository's stdio MCP
server against the isolated app port, preserving the built-in session's trusted
attribution. J07 uses this for Canvas write and durable reopen, J10 composes real
prepared-text retrieval and writeback with later search after the Chat closes,
and J11 covers rejected and approved `create_project` plus a real post-rebind
MCP write inside the new project.

## Selectors and Readiness

- Prefer roles, accessible names, and durable product identifiers. CSS layout,
  implementation class names, and copied visible prose are last resorts.
- Assert the state transition that makes the next action legal. Do not use
  sleeps to hide missing readiness or liveness ownership.
- Pointer, keyboard, and focus assertions use the input mode relevant to the
  behavior. A programmatic click is not evidence for native pointer handling.
- Keep assertions at the product or Interface level. Exact fixture events and
  internal intermediate state belong in focused tests.

## Validation Commands

```bash
pnpm test:e2e:check-focus
pnpm test:e2e:harness
pnpm test:e2e:smoke
pnpm test:e2e:agent-protocol
pnpm test:e2e:functional
pnpm test:e2e:visual
pnpm typecheck
pnpm build:web
```

Use `pnpm test:e2e:debug` for an interactive local smoke run. On headless Linux,
prefix Playwright with `xvfb-run -a`. `pnpm test:e2e:visual:update` is
Linux-authoritative and must not approve macOS or Windows images.

The current Journey-to-suite map and all declared gaps are in
[Journey Coverage](journey-coverage.md). Use
`pnpm test:e2e:functional --list` for the authoritative functional inventory;
do not copy a test count or per-test catalog into this contract.

## Implementation Map

| Role | Stable entry points |
|---|---|
| Playwright configuration | `playwright.config.ts` |
| Application harness Interface | `e2e/support/app.ts`, `fixtures.ts`, `locators.ts` |
| Deterministic fixtures | `e2e/fixtures/journey-workspaces.ts`, `fake-extractor.mjs`, and the fake Codex app-server |
| Required suites | `e2e/smoke/`, `e2e/journeys/`, and `e2e/visual/` |
| Harness evidence | `e2e/harness/`, `e2e/support/fixtures.test.ts`, and CI summary reporter tests |
| CI Adapter | `.github/workflows/ci.yml` and `.github/workflows/visual-baselines.yml` |

## Visual Baseline Workflow

Ubuntu 24.04 under Xvfb owns authoritative PNG baselines. Fixtures set explicit
viewport, theme, content, Agent availability, and reduced motion. A missing
baseline is failure, not approval; masks are narrow, explained, and limited to
unavoidable dynamic values.

For an intentional visual change:

1. Dispatch **Generate visual baselines** for the exact branch or commit.
2. Confirm focus, build, inventory, update, and unchanged rerun checks passed.
3. Review every expected/actual/diff image and the generated binary patch.
4. Apply and commit only approved PNG changes from the workflow artifact.
5. Let normal CI verify the committed baselines without update mode.

The workflow never commits or pushes. Candidate artifacts are diagnostics and
do not constitute approval. Keep secrets and personal documents out of
fixtures, reports, screenshots, and logs.

## Focus and Flakes

Focused tests and raw `.skip`/`.fixme` calls are rejected. CI forbids focused
tests, uses one worker, retries once, and fails a test that passes only on
retry. There is no quarantine mechanism.

Fix or revert a flaky test. Do not hide it with sleeps, looser assertions,
global screenshot tolerance, or disabled coverage. Any future quarantine
mechanism requires an owner, tracking issue, expiry, and CI-visible report
before use.
