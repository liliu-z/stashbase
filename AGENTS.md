# Agent maintenance contract for this repo

The human/AI operating model is [`MAINTENANCE.md`](MAINTENANCE.md). Follow it
for design, implementation, review, and evidence ownership.

Before writing code, consult the affected product area in `design-docs/` and
the owning engineering contract in `code-review/`. For code review, pin the
diff and follow the diff-first route in `code-review/README.md`, then use
`code-review/journey-coverage.md` to recover product intent and evidence.
Product docs define intent and observable behavior; review contracts define
risky Interfaces, invariants, implementation entry points, and validation.
Code remains the source of truth for the current implementation.

Keep the affected docs current in the same change as code. This is not a later
documentation pass. All committed docs are English-only.

## GitHub access for this repository

For GitHub write operations on `liliu-z/stashbase` (including PR/issue
comments, reviews, merges, and workflow dispatches), use the locally
authenticated `gh` CLI directly. The GitHub Connector is authenticated as a
different account and does not have write access to this repository, so do not
probe a Connector write first. Connector reads remain available when useful.

## Temporary worktrees

Secondary Git worktrees do not inherit ignored local dependencies. Before
running Electron E2E journeys that exercise indexing or sync, make sure the
worktree has `python/.venv.nosync`: reuse a working primary checkout's venv via
an explicit symlink when appropriate, or run `pnpm setup:python`. Without it,
`/api/index-status` and `/api/sync` return misleading 500 responses with
`ModuleNotFoundError: No module named 'mfs'`; treat that as worktree setup, not
as a product regression. Never commit the venv or its symlink.

## Electron launch environment

The agent host may inherit `ELECTRON_RUN_AS_NODE=1`. Remove it from the child
environment before any command that must launch Electron as a desktop runtime,
including Electron smoke tests, Electron E2E, and temporary visual harnesses.
On POSIX, run commands as
`env -u ELECTRON_RUN_AS_NODE pnpm test:electron:smoke` (and apply the same
prefix to the other Electron launch command). If `require('electron').app` is
undefined or a smoke fails at `app.setPath`, treat the inherited variable as
environment setup, not a product regression. Do not remove the variable from
flows that intentionally run Electron's embedded Node runtime.

You are responsible for keeping the relevant docs under `design-docs/` and
`code-review/` up to date. Update them as a side effect of relevant code
changes — never as a standalone "documentation pass". If a change touches the
surface area one of these docs covers, edit that doc in the same change.

## Documentation route

Start with [`design-docs/README.md`](design-docs/README.md).

- `overview.md` and `principles.md` — product identity and durable rules.
- `product-direction.md` — intended direction, not a promise list.
- `product-scenarios.md` — high-level reasons people use StashBase.
- `user-journeys.md` — observable Shipping flows with stable `Jxx` IDs.
- `glossary.md` — shared product language.
- `architecture.md` — product-level ownership, flows, and trust boundaries.
- `design/*.md` — Workspace, Documents, Preparation, Search and Retrieval,
  Agent Panel, and Bug Reporting outcomes, current experience, contracts, and
  contribution areas.

Start engineering review with
[`code-review/README.md`](code-review/README.md). It routes a change to:

- `architecture.md` — cross-process ownership and system flow;
- `window-lifecycle.md` — native windows, save barriers, retirement, shutdown;
- `bug-reporting.md` — local report collection, review authorization, approval,
  artifact handoff, and privacy;
- `renderer-workspace.md` — folder/tab/search transitions and renderer liveness;
- `data-lifecycle.md` — preparation, indexing, reconcile, queues, cleanup;
- `file-transactions.md` — paths, import, save, conflicts, mutations;
- `document-viewers.md` and `markdown-rendering.md` — preview behavior and trust;
- `settings-config.md` — durable preferences, credentials, reconfiguration;
- `mcp-access.md` — MCP transports, credentials, and authorized scope;
- `agent-runtime.md` and `agent-panel.md` — native Agent and renderer behavior;
- `renderer-styling.md` — styling mechanics;
- `journey-coverage.md` — product journey to automated/release evidence;
- `ui-regression-testing.md` — E2E mechanics, fixtures, and visual baselines;
- `release-pipeline.md` — source CI, tag gating, packaging, and release runbook.

`README.md` is the short external entry. `docs/` contains user/operator guides;
`release-checklists/` contains residual packaged checks. Do not duplicate one
topic across these layers.

## Documentation rules

- **Truth:** code > docs. Tests prove only what they exercise.
- **Status:** Current means observed Shipping behavior; Required contracts may
  be stricter. If they differ, record a Known Gap instead of rewriting intent
  as implementation truth. Durable capability direction lives in
  `product-direction.md`; area-specific direction stays under Next/Coordinate
  First.
- **Concision:** every paragraph should pay rent. Cross-reference the one
  owning document.
- **Boundary:** product docs contain no source-tree inventories. Review
  contracts name only stable Interfaces, primary owner Modules, Adapters, and
  validation entry points. Tests own exact fixtures and assertions.
- **Maintenance:** update an area/journey when Shipping behavior changes and a
  review contract when its Interface, invariant, risk, or validation changes.
  Use issues and PRs for chronology, scheduling, and ownership.

## Development loop

When the user reports a bug or asks for a feature, run the full loop:

1. Locate and diagnose after reading the relevant design and review contracts.
2. Implement while preserving these cross-cutting constraints: sync and
   conversion are folder-explicit; hidden derived notes never surface; one
   daemon owns the local index; credentials live only in Settings, never env.
3. During implementation, run the smallest focused tests that exercise the
   changed behavior. Do not run the full validation matrix after every edit;
   reserve broad contract, E2E, and build verification for the pre-commit gate
   unless a broader command is needed to diagnose the change.
4. Update affected docs in the same change. Run `pnpm test:docs` for changes to
   the documentation structure, links, contracts, or journey mapping as part
   of the pre-commit gate.
5. Leave work uncommitted until the user asks to commit.

## Pre-commit verification

Before creating commits, run the complete validation matrix for the pending
change:

- `pnpm typecheck` always;
- `pnpm build:web` for renderer changes;
- focused commands from every crossed review contract;
- `pnpm test:docs` for documentation structure, links, contracts, or journey
  mapping changes;
- `pnpm test:e2e:check-focus` for E2E changes;
- `pnpm test:e2e:smoke` for release-blocking renderer/cross-process paths;
- `pnpm test:e2e:functional` for affected broader journeys;
- `pnpm test:e2e:visual` on Linux for covered composition changes. Generate
  intentional Linux baselines through **Generate visual baselines**; never
  approve local macOS/Windows goldens.

## Commit protocol

When the user asks to commit, group the dirty tree into focused commits by
theme—feature, fix, refactor, docs—without unrelated work. Match existing
subjects: `fix(scope): …`, `feat(scope): …`, `refactor(scope): …`,
`docs(scope): …`, `chore: …`. Split mixed-file hunks when needed so each
commit stands on its own. Do not push unless the user says push or asks for a
release.

## Release trigger

When the user asks to release or package a build, read and follow
[`code-review/release-pipeline.md`](code-review/release-pipeline.md) in full.
The only question is the patch/minor/major version choice; everything after it
runs unattended. Tidy and push focused commits first, gate the tag on source CI
for the exact version-bump commit, then hand off GitHub Release publication and
verify all platform assets plus residual packaged UI sanity.

Packaging is release-only. `pnpm dist:brew` is a local macOS fallback, not the
default. Never commit packaged artifacts; outputs belong in `release.nosync/`.
