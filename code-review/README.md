# Code Review Contracts

These maintainer-facing contracts make a large codebase reviewable in bounded
context. They connect product intent to the Interface that owns a behavior, the
invariants at that Seam, stable implementation entry points, and focused
evidence. They are not a source-tree inventory or a substitute for reading the
diff.

The repository-wide human/AI workflow lives in
[`MAINTENANCE.md`](../MAINTENANCE.md); this directory owns its engineering
review layer.

The contract set is an index over deep Modules, not a compressed source-tree
inventory. Select the smallest set of Seams that owns the change; do not load
every contract or expand an Implementation Map unless the change crosses the
named Interface. This is the engineering half of the
[coarse-to-fine documentation model](../design-docs/README.md#coarse-to-fine-model).

## Intent-first Review

```text
product scenario → user journey → product area → review contract
→ Interface and owner modules → focused tests → changed code
```

1. Identify the motivating
   [Product Scenario](../design-docs/product-scenarios.md) and the observable
   outcome in [User Journeys](../design-docs/user-journeys.md).
2. Read the narrowest owning area in
   [`design-docs/design/`](../design-docs/README.md#product-areas). For a change
   to established behavior, starting from the area is acceptable, but resolve
   the affected journey before implementation.
3. Choose the focused contract below. Add Architecture only when ownership or
   a process boundary changes.
4. Use its Implementation Map to locate the Interface, primary owners,
   Adapters, and focused validation. Inspect neighboring code only when the
   changed Seam crosses into another contract.
5. Check [Journey Coverage](journey-coverage.md) for end-to-end evidence; do
   not infer coverage from a journey ID alone.

Use this route when the request starts with a user outcome, issue, or proposed
feature.

Journey Coverage is the product-level router and evidence ledger. It does not
replace focused contracts: journeys cut vertically across a user outcome,
while contracts cut horizontally across shared Interfaces, invariants, and
failure modes. Review the journey to establish what must be delivered and the
selected contracts to establish how the implementation remains safe.

## Journey-to-Evidence Review

Use this route to accept a journey, feature slice, or release claim:

1. Read the journey's Required Observable Results and meaningful recovery. Do
   not reduce the journey to its happy path or title.
2. Open [Journey Coverage](journey-coverage.md) and verify that its Area and
   Contract route matches the behavior being accepted.
3. For each Required result, identify the appropriate Contract Test, Journey
   E2E, AI Eval, or Release Check. One evidence type does not substitute for
   another.
4. Follow the owning contract's validation entry points and read the exact test
   setup and assertions. A suite command, passing count, or `Jxx` label is not
   proof by itself.
5. Compare the evidence with Shipping code and classify the journey as Covered,
   Partial, Release-dependent, or Gap. Record missing or contradictory evidence
   instead of inferring it from adjacent tests.

This route checks whether the product promise is implemented and proven. It
does not require one large E2E test when focused evidence at several Seams is
more decisive.

## Diff-first Review

Use this route when the input is a branch, commit, pull request, or working-tree
diff:

1. Pin the comparison point and list changed files and commits. Do not review a
   moving or ambiguous diff.
2. For each changed stable Interface or entry path, search the Implementation
   Maps in this directory. When a leaf file is not named, follow its import or
   caller to the nearest named owner Module; do not expand the contracts into a
   file inventory.
3. Use [Choose by Change Surface](#choose-by-change-surface) for unmatched or
   newly introduced behavior. A new review-significant external Interface or
   cross-process Adapter must acquire an owning contract in the same change.
4. Take the union of the owning contracts and their explicitly crossed Seams.
   Map them back to product areas and journeys through
   [Journey Coverage](journey-coverage.md).
5. Read the originating issue or specification when one exists. Compare the
   diff separately against product intent and engineering contracts.
6. Inspect focused tests before broad suites. A test proves only its exercised
   path; missing evidence is a review finding, not permission to infer safety.

Useful local searches:

```bash
rg -F "server/file-save.ts" code-review
rg -F "FilesystemPathModule" code-review
```

If `rg` is unavailable, use an equivalent fixed-string repository search.

## Reverse Traceability Review

Run this check over the diff after locating its owning contracts. Every changed
user-visible behavior, stable Interface, and review-significant branch must
have a reason to exist, but not every source line must map directly to a
journey:

- User-visible behavior maps to one or more documented journeys. If none owns
  it, report a product-design or traceability gap.
- Behavior outside the target journey may serve another journey. Add that
  journey and its evidence to the review rather than treating the change as
  local.
- Shared infrastructure, security, migration, lifecycle, and recovery code may
  be cross-cutting. It must still have an owning contract, a stated invariant
  or failure mode, and focused evidence.
- When behavior varies by format, client, or representation, trace it through
  the owning Area's capability matrix. Preview, Workbench editing, prepared
  text, Agent access, and file mutation are separate claims; evidence for one
  surface does not establish another.
- Code with no affected journey, owning contract, or necessary implementation
  rationale is a scope finding: it may be unrequested behavior, premature
  abstraction, or dead code.

The reverse route is therefore:

```text
changed behavior → owning contract → journey or cross-cutting rationale
→ exact evidence → product and engineering finding
```

Do not turn Journey Coverage into a source-file inventory to support this
check. Trace code to its nearest stable Interface and contract first, then use
the contract-to-journey map.

## Choose by Change Surface

| Change surface | Required contract |
|---|---|
| Runtime ownership or cross-process flow | [Architecture](architecture.md) |
| Native windows, save-on-close, app shutdown | [Window Lifecycle](window-lifecycle.md) |
| Bug-report collection, review, approval, handoff, privacy | [Bug Reporting](bug-reporting.md) |
| Renderer folder, tab, search, or overlay coordination | [Renderer Workspace](renderer-workspace.md) |
| Conversion, indexing, reconcile, cleanup | [Data Lifecycle](data-lifecycle.md) |
| Import, save, rename, move, delete, conflicts | [File Transactions](file-transactions.md) |
| PDF, DOCX, HTML, image, audio, or JSON viewers | [Document Viewers](document-viewers.md) |
| Markdown parsing, assets, navigation, trust | [Markdown Rendering](markdown-rendering.md) |
| App config, credentials, onboarding, appearance | [Settings and Config](settings-config.md) |
| MCP tools, transports, credentials, scope | [MCP Access](mcp-access.md) |
| CLI discovery, installation, native sessions, history | [Agent Runtime](agent-runtime.md) |
| Chat renderer, transcript, composer, permissions | [Agent Panel](agent-panel.md) |
| Theme tokens, primitives, CSS boundaries | [Renderer Styling](renderer-styling.md) |
| Journey-to-test ownership and remaining gaps | [Journey Coverage](journey-coverage.md) |
| Electron E2E mechanics, baselines, fixtures | [UI Regression Testing](ui-regression-testing.md) |
| Source CI, packaging, release gating | [Release Pipeline](release-pipeline.md) |

Some changes require more than one contract. An Agent file write, for example,
normally crosses Agent Runtime, MCP Access, File Transactions, and the affected
journey. Read the smallest set that owns the changed Seams.

## Trust Model

Contract language must distinguish these states:

- **Shipping** — evidence-backed current behavior. “Current Experience” in a
  design doc has this meaning.
- **Required** — an invariant new code and reviews must preserve. Unlabelled
  invariant bullets in a review contract have this meaning.
- **Known gap** — current code does not yet meet a Required invariant or a
  journey lacks decisive evidence. Name the implementation location and the
  missing validation; never rewrite the gap as Shipping.
- **Direction** — desired product work that is not committed behavior. Durable
  capability direction lives in Product Direction; area-specific work stays
  under Next or Coordinate First, never in a review contract.

When code, tests, and prose disagree, code is the implementation truth, tests
are evidence of exercised behavior, and the docs must be corrected in the same
change. A passing test never makes an uncovered claim true.

## Review Output Contract

Review both axes; passing one never hides failure in the other:

- **Product and Spec** — the diff delivers the requested outcome, preserves the
  related journey and experience contract, and introduces no unrequested
  behavior.
- **Engineering** — the diff crosses the correct Interface, preserves required
  invariants and recovery behavior, keeps adapters narrow, and supplies focused
  evidence at the lowest useful layer.

Every finding names the code location, the violated requirement or invariant,
the user or system consequence, and the missing or contradictory evidence.
Separate hard contract violations from maintainability judgments. Report no
finding for style already enforced mechanically unless the enforcement itself
is missing or bypassed.

## Contract Shape

A focused contract contains only information needed to review its Seam:

- scope, owners, invariants, state transitions, and recovery behavior;
- an **Implementation Map** naming the public Interface, three to eight primary
  owner modules, concrete Adapters, and focused tests or scripts;
- exact validation commands and links to related journeys/contracts;
- any Known gap where Shipping behavior violates the Required contract.

A Module hides related state and decisions. Its Interface includes ordering,
errors, configuration, performance bounds, and invariants—not just function
signatures. An Adapter translates HTTP, MCP, Electron, native-process, iframe,
or renderer events into that Interface. Keep internal Seams private unless an
independent caller or test genuinely needs them.

Do not add file-by-file inventories, test-case prose, exact line references, or
implementation chronology. A path belongs here only when it is a stable review
entry point. Exact fixtures and assertions belong in tests.

Deepen an existing contract when behavior remains behind the same external
Interface. Add a contract only when a distinct Seam has independent callers or
Adapters, invariants, failure modes, and focused evidence. A new file, helper,
route, or internal test Seam does not by itself justify another contract.

## Maintenance Rules

- Keep contracts concise, English-only, and current in the same change as the
  implementation they govern.
- One invariant has one primary home. Other contracts link to it.
- Journey Coverage is the canonical Area and Contract traceability map. Area
  documents summarize their local routes; this map resolves ambiguity.
- A journey ID describes product coverage; a test path and assertion describe
  implementation coverage. Do not substitute one for the other.
- Journey Coverage distinguishes Contract Tests, Journey E2E, AI Evals, and
  Release Checks. Do not describe deterministic mechanics as proof of
  probabilistic retrieval or Agent quality.
- Add a regression at the lowest useful layer, then promote only
  release-blocking cross-feature behavior into E2E smoke.
- Run `pnpm test:docs` when changing this documentation system.
