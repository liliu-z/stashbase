# Journey Coverage

This is the canonical traceability and evidence map for StashBase's stable
product journeys. A journey defines the observable product promise; this file
records which engineering contracts protect it and what evidence currently
supports or contradicts it. Tests and Evals own exact fixtures, inputs, and
assertions.

This is not a source-file inventory. For reverse review, trace changed code to
its nearest owning contract, then use this map to find affected journeys.
Cross-cutting infrastructure may stop at a contract when it has no direct user
outcome, but user-visible behavior without a journey is a traceability gap.

## Evidence Model

- **Contract Test** proves a deterministic Interface, invariant, failure mode,
  or recovery rule at the lowest useful layer.
- **Journey E2E** proves that the decisive observable flow crosses its real
  product Seams. A Journey ID in a test name or tag identifies intent; it does
  not imply every Required Observable Result is covered.
- **AI Eval** measures probabilistic quality such as semantic relevance,
  source grounding, context use, or task completion on representative inputs.
- **Release Check** covers behavior that requires a packaged application,
  native dependency, real provider, credential, operating-system integration,
  or third-party client.

Coverage status is independent of evidence type:

- **Covered** — decisive evidence exists for every Required Observable Result
  at the appropriate layer.
- **Partial** — important lower-level evidence exists, but at least one
  Required Observable Result lacks decisive evidence.
- **Release-dependent** — automation is complete as far as the repository can
  prove, but a named packaged or external check remains.
- **Gap** — a Required result is contradicted by Shipping behavior or lacks
  meaningful evidence.

Broad commands are validation entry points, not proof by themselves. A passing
suite supports only the named behavior its tests exercise.

When a Journey crosses format capability, evidence is selected by behavior
class rather than by extension count: editable prose, editable structured
text, direct preview-only text, binary preview with prepared text, OCR image,
and transcript media. The
[Documents matrix](../design-docs/design/documents.md#format-capability-matrix)
owns the Shipping capability claim; shared format-detection tests own extension
aliases, and Journey E2E owns representative composition.

## Traceability Map

| Journey | Product areas | Primary review contracts |
|---|---|---|
| [J01 Onboarding](../design-docs/user-journeys.md#j01-complete-onboarding-and-reach-first-value) | [Workspace](../design-docs/design/workspace.md), [Search](../design-docs/design/search.md), [Agent Panel](../design-docs/design/agent-panel.md) | [Renderer Workspace](renderer-workspace.md), [Settings and Config](settings-config.md), [Agent Panel](agent-panel.md), [Window Lifecycle](window-lifecycle.md) |
| [J02 Folder](../design-docs/user-journeys.md#j02-add-and-open-a-folder) | [Workspace](../design-docs/design/workspace.md) | [Renderer Workspace](renderer-workspace.md), [File Transactions](file-transactions.md), [Data Lifecycle](data-lifecycle.md), [Window Lifecycle](window-lifecycle.md) |
| [J03 Documents](../design-docs/user-journeys.md#j03-read-and-edit-source-documents) | [Documents](../design-docs/design/documents.md), [Workspace](../design-docs/design/workspace.md) | [Markdown Rendering](markdown-rendering.md), [Document Viewers](document-viewers.md), [File Transactions](file-transactions.md), [Renderer Workspace](renderer-workspace.md), [Window Lifecycle](window-lifecycle.md) |
| [J04 Preparation](../design-docs/user-journeys.md#j04-prepare-a-hard-to-read-file) | [Preparation](../design-docs/design/preparation.md) | [Data Lifecycle](data-lifecycle.md), [Document Viewers](document-viewers.md), [File Transactions](file-transactions.md), [Settings and Config](settings-config.md) |
| [J05 Search](../design-docs/user-journeys.md#j05-search-and-open-source-evidence) | [Search](../design-docs/design/search.md), [Workspace](../design-docs/design/workspace.md) | [Data Lifecycle](data-lifecycle.md), [Renderer Workspace](renderer-workspace.md), [Settings and Config](settings-config.md), [MCP Access](mcp-access.md) |
| [J06 Agent](../design-docs/user-journeys.md#j06-start-and-continue-an-agent-chat) | [Agent Panel](../design-docs/design/agent-panel.md) | [Agent Panel](agent-panel.md), [Agent Runtime](agent-runtime.md), [MCP Access](mcp-access.md), [Settings and Config](settings-config.md) |
| [J07 Converge](../design-docs/user-journeys.md#j07-converge-chat-into-a-document) | [Agent Panel](../design-docs/design/agent-panel.md), [Documents](../design-docs/design/documents.md) | [Agent Panel](agent-panel.md), [MCP Access](mcp-access.md), [File Transactions](file-transactions.md), [Markdown Rendering](markdown-rendering.md) |
| [J08 External MCP](../design-docs/user-journeys.md#j08-connect-an-external-agent-through-mcp) | [Search](../design-docs/design/search.md), [Workspace](../design-docs/design/workspace.md) | [MCP Access](mcp-access.md), [File Transactions](file-transactions.md), [Data Lifecycle](data-lifecycle.md), [Settings and Config](settings-config.md) |
| [J09 Bug report](../design-docs/user-journeys.md#j09-prepare-and-hand-off-a-bug-report) | [Bug Reporting](../design-docs/design/bug-reporting.md) | [Bug Reporting](bug-reporting.md), [Window Lifecycle](window-lifecycle.md), [Architecture](architecture.md) |
| [J10 Core loop](../design-docs/user-journeys.md#j10-turn-a-local-project-into-durable-agent-assisted-work) | [Workspace](../design-docs/design/workspace.md), [Documents](../design-docs/design/documents.md), [Preparation](../design-docs/design/preparation.md), [Search](../design-docs/design/search.md), [Agent Panel](../design-docs/design/agent-panel.md) | [Renderer Workspace](renderer-workspace.md), [Data Lifecycle](data-lifecycle.md), [Agent Runtime](agent-runtime.md), [Agent Panel](agent-panel.md), [MCP Access](mcp-access.md), [File Transactions](file-transactions.md), [Markdown Rendering](markdown-rendering.md) |
| [J11 Conversation to project](../design-docs/user-journeys.md#j11-turn-a-conversation-into-a-project) | [Workspace](../design-docs/design/workspace.md), [Agent Panel](../design-docs/design/agent-panel.md) | [Renderer Workspace](renderer-workspace.md), [Settings and Config](settings-config.md), [MCP Access](mcp-access.md), [Agent Runtime](agent-runtime.md), [Agent Panel](agent-panel.md), [File Transactions](file-transactions.md), [Data Lifecycle](data-lifecycle.md) |
| [J12 Build Wiki Pages](../design-docs/user-journeys.md#j12-build-wiki-pages-from-a-local-folder) | [Agent Panel](../design-docs/design/agent-panel.md), [Search](../design-docs/design/search.md), [Workspace](../design-docs/design/workspace.md) | [Agent Panel](agent-panel.md), [Settings and Config](settings-config.md), [Renderer Workspace](renderer-workspace.md), [File Transactions](file-transactions.md), [Data Lifecycle](data-lifecycle.md) |

## J01: Onboarding

**Status:** Release-dependent.

- **Contract Test:** renderer initialization, Settings state, workspace
  navigation, and Electron lifecycle are exercised by `pnpm test:renderer`,
  `pnpm test:config`, `pnpm test:updates`, and `pnpm test:electron:smoke`.
  The Settings and config suites cover hosted and BYOK choices for search by
  meaning, rejection of new local selection, deterministic retirement of
  persisted local selection before daemon startup, and transactional source
  activation that keeps the prior source selected when runtime reset or
  binding fails.
  Account identity fixtures cover profile normalization, migration, privacy,
  and UI fallbacks.
  Renderer state evidence keeps bootstrap settlement distinct from confirmed
  library membership, so a failed or pending membership load cannot claim the
  library is empty.
  The Settings smoke drives the development-only update simulator through the
  production update-state bridge to verify available and ready update-banner
  behavior without claiming a packaged installation; the Linux workspace
  visual suite owns the floating banner's composition above persistent account
  utilities.
- **Journey E2E:** [launch smoke](../e2e/smoke/launch.spec.ts) and
  [library navigation](../e2e/journeys/library-navigation.spec.ts) exercise
  blank-workspace entry, the quiet state of search by meaning, explicit
  setup/skip behavior, folder selection, and local availability.
  [Navigation layout](../e2e/journeys/navigation-layout.spec.ts)
  verifies that Appearance Settings remains usable with the operating system's
  reduced-motion preference while transform movement is removed and quiet
  state feedback remains, and that a folder name too long for a narrowed
  sidebar truncates inside the column instead of crossing onto the tab strip.
  These checks do not yet prove the full orientation,
  first-value, and return sequence as one onboarding outcome.
- **AI Eval:** onboarding mechanics are deterministic. If first value uses
  semantic retrieval or a real Agent, its quality evidence comes from J05 or
  J10 rather than being duplicated here.
- **Release Check:** Gatekeeper acceptance of the Developer ID-signed and
  notarized macOS artifact, packaged first launch, native folder selection,
  offline startup, one first-session-to-returning-session pass, and real
  N→N+1 desktop updates on supported platforms remain release evidence.
- **Gap:** no single Journey E2E currently proves that a first-time user sees
  the source/derived/hosted distinction, authorizes useful content, reaches a
  concrete first result, and returns without unnecessary onboarding replay.
  The first local-model download and selection path is also lower-layer and
  packaged-release evidence rather than a complete Journey E2E.

## J02: Folder

**Status:** Partial and release-dependent.

- **Contract Test:** workspace transitions, library mutation, cleanup, GitHub
  repository import (`server/__tests__/github-import.test.ts`,
  `web-src/src/features/workspace/__tests__/import-github-modal.test.ts`), and
  window retirement run through `pnpm test:renderer`,
  `pnpm test:library-files`, and `pnpm test:electron`.
- **Journey E2E:** [library navigation](../e2e/journeys/library-navigation.spec.ts)
  and [library mutations](../e2e/journeys/library-mutations.spec.ts) exercise
  entry, switching, and removal without source deletion; navigation also proves
  folder entry creates no `AGENTS.md` or `CLAUDE.md`.
- **AI Eval:** not required.
- **Release Check:** real operating-system folder picking, Git cloning of public
  repositories, and file drop remain release evidence.
- **Gap:** repository publication reserves the final directory without
  clobbering concurrent user state, but Node lacks a cross-platform atomic
  no-replace directory rename; see the File Transactions Known Gap.

## J03: Documents

**Status:** Release-dependent.

- **Contract Test:** renderer, viewer, Markdown, JSON, TXT, file transaction, and
  Electron lifecycle suites cover source identity, parsing, mode changes,
  ordinary saves, navigation, removal of native reload bypasses, save-gated
  recovery reload, shared renderer/Agent/MCP version authority, conflict
  decisions, format detection, content-write boundaries, and their
  failure/confirmation paths. `server/__tests__/file-listing.test.ts` locks
  default and show-hidden listings, protected VCS/derived paths, bounded
  hidden excluded rows, sync/async parity, and large-scan yielding;
  `pnpm test:config` locks default-off recovery, strict failure, and durable
  hidden-files persistence; renderer `hidden-entries.test.ts`,
  `hidden-files-menu.test.ts`, `hidden-visibility-actions.test.ts`, and
  `file-listing-generation.test.ts` lock row marking, checked semantics,
  rapid/failing writes, and stale continuation ownership.
- **Journey E2E:** [document editing smoke](../e2e/smoke/document-editing.spec.ts),
  [workspace navigation depth](../e2e/journeys/navigation-depth.spec.ts),
  [Markdown, JSON, and TXT](../e2e/journeys/markdown-json.spec.ts), focused
  `plain-text-document.test.ts`,
  [outline and Find](../e2e/journeys/markdown-outline-find.spec.ts),
  [library mutations](../e2e/journeys/library-mutations.spec.ts), and
  [format and media](../e2e/journeys/formats-media.spec.ts) cover representative
  format classes and document work, including preview-only affordances,
  truthful generic-file and excluded-folder visibility, Quick Open parity,
  the Show Hidden Files menu flow and cross-window convergence, protected
  `.stashbase*` state, retained hidden document tabs, and Agent-safe explicit listings,
  strict read-only text versus binary fallback, `.txt` authoring capability,
  explicit PDF/DOCX preview-failure identity, external-write conflict recovery,
  and a live edit flushed through recovery reload.
- **AI Eval:** not required.
- **Release Check:** complex packaged PDF, DOCX, and media behavior remains
  release evidence.
- **Gap:** none in the deterministic save/conflict path. The Journey E2E proves
  external-write recovery; separate save and mutation tests prove that renderer,
  Agent, and MCP writes share the same version authority. See
  [File Transactions](file-transactions.md#renderer-conflict-recovery).
  The Show Hidden Files toggle is covered by the server and renderer contract
  tests above plus the J03 navigation-depth Journey.

## J04: Preparation

**Status:** Release-dependent.

- **Contract Test:** `pnpm test:config`, `pnpm test:conversion-scheduler`, and
  `pnpm test:python` cover the default-off capture preference, scheduling,
  format completion, cancellation, PDF/OCR spawn configuration, freshness,
  checkpoints, and recovery. `pnpm test:package-inputs` locks the static
  Windows extractor bootloader argument wiring without discarding stderr.
  `pnpm test:electron` locks the focused-window and unclaimed-composer offer
  policy.
- **Journey E2E:** [preparation capture](../e2e/journeys/preparation-capture.spec.ts)
  proves default-off opt-in, explicit screenshot acceptance, opt-out stopping
  later offers, visible source publication, deterministic OCR through the real
  preparation path, keyword search, and navigation back to the image source.
  Viewer journeys separately cover source continuity and failure identity.
- **AI Eval:** extraction correctness is format-specific deterministic or
  dataset evidence; no shared product-level quality Eval is currently claimed.
- **Release Check:** operating-system screenshot capture and representative
  PDF/OCR/DOCX/media preparation with packaged native helpers, including no
  visible console or focus theft on Windows, remain release evidence.
- **Gap:** none in the deterministic screenshot-to-current-evidence path.

## J05: Search

**Status:** Partial.

- **Contract Test:** `pnpm test:retrieval` and the data, scope, credential,
  and renderer suites cover exact filtering (including encoding-safe TXT), semantic mechanics, source
  remapping, access boundaries, account identity, and failure presentation.
  Python daemon tests additionally lock the fixed ONNX model identity,
  provider/dimension collection separation, and cross-collection cleanup for
  renamed or deleted sources; keyword search remains provider-independent.
- **Journey E2E:** [semantic search UI](../e2e/journeys/semantic-search-ui.spec.ts)
  covers mode, scope, readiness, result presentation, and source navigation.
- **AI Eval:** `pnpm eval:semantic-retrieval` runs the versioned, synthetic
  [semantic retrieval dataset](../evals/semantic-retrieval/README.md) through
  the production index and Retrieval interfaces. It reports provider, model,
  dataset version, Recall@3, MRR, missed evidence, unexpected top results, and
  selected keyword-search comparisons against predeclared thresholds. It remains
  calibration evidence until three retained runs exist for both supported BYOK
  providers; the runner makes that gate state explicit. Ranking is scored over
  distinct sources, not chunks, and the corpus includes multi-chunk sources so
  chunking changes are actually observable.
- **Release Check:** the semantic AI Eval is credentialed BYOK release evidence,
  not required or scheduled CI, because it makes paid provider requests and
  allows bounded ranking variability. Hosted account behavior remains
  lower-layer or release evidence.
- **Gap:** library-wide readiness is not yet Shipping. The semantic Eval is
  present but still in calibration: no baseline run is retained, so no
  semantic-quality gate is active yet. Completing the baselines and activating
  the thresholds is tracked in
  [GitHub issue #176](https://github.com/liliu-z/stashbase/issues/176).

## J06: Agent

**Status:** Release-dependent.

- **Contract Test:** `pnpm test:agent`, `pnpm test:e2e:agent-protocol`, and
  renderer tests cover consent, normalized protocol, scope, lifecycle,
  permissions, failed-install external recheck without another download,
  managed Codex PowerShell path ownership and missing-output diagnostics,
  installed-but-signed-out Codex detection, same-executable browser login,
  recovery, transcript, individually deletable waiting follow-ups, layout state,
  and structured folder-scope retirement
  for blank, draft-only, queued, and active-tool Chats. Workspace reset tests
  pin Chat preservation through both direct folder loss and 412 recovery.
  Library-operation, route, keyword-search, and renderer composition tests pin
  the per-session policy for search by meaning, library-wide text fallback, and
  prepared-PDF source remapping while the switch is Off. Agent Instructions
  config tests pin bounded folder isolation, strict persistence, and membership
  cleanup plus default restoration; Adapter tests pin verbatim runtime
  injection; a renderer composition
  test pins that a save remounts the sessions on that exact scope and leaves
  every other scope's session alone.
  `pnpm test:opencode:native` starts the
  exact bundled OpenCode binary and completes an SDK session against a local
  fake OpenAI-compatible gateway; broker tests cover token isolation, streaming,
  refresh retry, per-session credentials, required UUID turn-header
  attribution across retries, stable model profile routing, and allowance
  classification. Config tests also prove that ambient credentials and process
  injection flags do not enter the bundled runtime.
- **Journey E2E:** [Agent Panel](../e2e/journeys/agent-panel.spec.ts) exercises
  the Wiki Agent account gate and bring-your-own choices, then
  exercises the built-in panel against the deterministic fake Codex runtime,
  including the session-scope **Search by meaning** switch before and after
  scope binding plus folder-scoped Agent Instructions persistence, no
  source-file creation, and exact native developer-instructions injection, and
  retaining a started cross-folder Chat through Library removal and opening a
  fresh explicitly Library-scoped Chat.
- **AI Eval:** not required for panel and runtime correctness; actual
  task-quality evidence belongs to the J10 core loop.
- **Release Check:** packaged OpenCode version/executability plus a fake-gateway
  model turn that proves the signed runtime stays alive, a real hosted Wiki Agent
  turn and allowance response, bring-your-own CLI/account setup,
  and bring-your-own clipboard image behavior remain release evidence.

## J07: Converge

**Status:** Release-dependent.

- **Contract Test:** Agent, MCP, file transaction, and Markdown suites prove
  the decisive Seams independently.
- **Journey E2E:** [Agent workflows](../e2e/journeys/agent-workflows.spec.ts)
  proves a deterministic Agent request through visible approval and the real
  MCP/file transaction boundary, workspace refresh without focus theft, user
  review/edit/save, close, and durable reopen.
- **AI Eval:** deterministic fake-Agent evidence can prove the write/review
  workflow; whether a real Agent selects and writes the requested accepted
  content belongs to J10 task-quality Eval.
- **Release Check:** one real-runtime Canvas write remains release evidence.

## J08: External MCP

**Status:** Partial and release-dependent.

- **Contract Test:** `pnpm test:mcp`, `pnpm test:library-files`, and
  `pnpm test:retrieval` cover operation parity, transport, authorization,
  path confinement, direct and prepared text reads, text-format mutation
  boundaries, and reconcile.
- **Journey E2E:** in-repository transport and operation tests cover the
  StashBase side; third-party client UI is intentionally outside product E2E.
- **AI Eval:** retrieval quality is shared with J05; client generation quality
  is outside StashBase ownership.
- **Release Check:** packaged launcher, copied configuration, URL access, and
  one representative external client remain release evidence.
- **Gap:** none in the deterministic transport, direct-text
  description/parity, or format-capability boundary; focused MCP mutations
  cover Markdown, JSON, and TXT plus invalid-encoding refusal and
  generic-file exclusion. Packaged launcher and third-party client behavior
  remain release evidence.

## J09: Bug report

**Status:** Partial and release-dependent.

- **Contract Test:** [collection](../electron/bug-report-collection.test.cjs),
  [review authority](../electron/bug-report-review.test.cjs),
  [redaction](../electron/bug-report-redaction.test.cjs), and
  [handoff](../electron/bug-report-handoff.test.cjs) prove the app-owned draft,
  privacy, approval, and artifact boundaries.
- **Journey E2E:** native-window integration is exercised below packaged UI,
  but no full packaged review-window flow is claimed.
- **AI Eval:** not required.
- **Release Check:** packaged capture, review, Downloads copy, and browser
  handoff remain release evidence.

## J10: Core loop

**Status:** Partial and release-dependent.

- **Contract Test:** J02 and J04–J07 prove their owner Interfaces and recovery
  rules independently.
- **Journey E2E:** [Agent workflows](../e2e/journeys/agent-workflows.spec.ts)
  proves one Golden Path from a visible image through deterministic OCR,
  derived-text UI retrieval, scoped Agent retrieval, approved real MCP
  writeback, user review/save, Chat close, and later keyword search. Native
  extractor packaging and hosted providers remain release or focused evidence.
- **AI Eval:** Gap. No first-class representative dataset currently measures
  whether an Agent receives the relevant project evidence and produces a
  source-grounded result suitable for explicit writeback.
- **Release Check:** one packaged built-in or external Agent loop should remain
  a release check even after deterministic E2E and task-quality Eval exist.

## J11: Conversation to project

**Status:** Partial and release-dependent.

- **Contract Test:**
  [project creation tests](../server/__tests__/agent-projects.test.ts) prove
  name and location validation, owned-root and symlink confinement,
  an empty project with no seeded instruction files, membership failure cleanup, live Library-session
  attribution, history override ordering, and rebind-race rollback.
  [MCP transport tests](../server/__tests__/mcp-http-transport.test.ts) prove
  attributed built-in calls and unattributed external calls remain distinct.
  [renderer scope tests](../web-src/src/features/agent-panel/__tests__/agent-folder-pill.test.ts)
  prove the Library-to-folder scope presentation.
- **Journey E2E:** [Agent workflows](../e2e/journeys/agent-workflows.spec.ts)
  rejects one visible `create_project` approval and proves no directory or
  membership appears, then approves the same real MCP action and proves folder
  creation without `AGENTS.md`, registration, same-Chat rebind, originating-window
  entry, transcript continuity, and a post-rebind real MCP write inside the
  new project. Adapter contract tests additionally prove Codex keeps its thread
  and Claude keeps its native session id while subsequent execution moves to
  the project cwd.
- **AI Eval:** Gap. No representative real-Agent Eval proves that the Agent
  chooses `create_project` after an explicit project decision, avoids bare
  filesystem creation, and does not create a project merely because exploratory
  conversation sounds project-like.
- **Release Check:** one packaged real-runtime conversation-to-project flow on
  each supported path family remains release evidence after deterministic E2E
  exists.
- **Gap:** real-Agent intent/tool choice still needs an Eval. Codex
  configuration leaves `create_project` on the default prompt path, but no
  focused test locks that tool allowlist; Claude requires equivalent focused
  or release evidence. Wiki Agent can rebind the live panel and attributed
  MCP path, but OpenCode cannot yet migrate its native history/cwd; its restored
  row remains under Library and this path needs separate evidence after that
  native limitation is resolved.

## J12: Build Wiki Pages

**Status:** Partial and release-dependent.

- **Contract Test:** renderer tests cover the Templates handoff, the concise
  editable draft with no automatic wire send, the one-time first-folder setup
  offer and durable **Not now**, manual setup reopening, and the preset's
  independence from embedding authorization. Agent, file-transaction, and
  data-lifecycle suites cover approval, source confinement, write
  reconciliation, and index admission.
- **Journey E2E:** [Agent workflows](../e2e/journeys/agent-workflows.spec.ts)
  handles the first-folder setup offer for search by meaning, uses the
  Knowledge Base Template independently through the deterministic fake Codex runtime,
  reviews and sends its draft, approves a real MCP **wiki/index.md** write,
  observes the directory in the tree, and
  proves an original source stayed byte-identical. [Library navigation](../e2e/journeys/library-navigation.spec.ts)
  separately proves the bare Library remains quiet, the first active folder
  offers setup, later folder switches stay quiet after **Not now**, and the
  persistent **Set up** route can reopen setup.
- **AI Eval:** Gap. The deterministic Agent proves orchestration and safety,
  not whether a real model produces useful, complete, well-linked Wiki Pages
  over representative mixed-format folders.
- **Release Check:** one packaged Wiki Agent flow should cover independent
  account-required Agent setup, hosted activation/backfill for search by
  meaning, and review of real generated Wiki Pages. Bring-your-own-key plus a
  real external Agent is representative secondary evidence.
- **Gap:** no real-Agent quality Eval yet covers folder-map completeness,
  source-link correctness, or preservation under ambiguous existing Wiki
  content. The first release intentionally claims no persistent ready/stale
  state, Update Wiki Pages label, or scheduled regeneration.

## Maintenance Rule

Update a journey when its observable flow or Required Observable Results
change. Update this file when Area or Contract ownership, evidence type,
coverage status, or a residual check changes. A Journey E2E should carry its
`Jxx` intent in a stable test name or tag; lower-level tests normally map to
their owning contract instead.

Do not add per-assertion rows, copied test counts, or broad commands as proof.
The test suite owns exact setup and assertions, while
`pnpm test:e2e:functional --list` remains the functional inventory. E2E
fixture isolation, selectors, readiness, visual baselines, and flake policy
live in [UI Regression Testing](ui-regression-testing.md). Packaged checks live
in [UI Release Sanity](../release-checklists/ui-sanity.md).

### Known traceability gap

Most existing Journey E2E titles predate the stable `Jxx` convention. The file
links above are therefore the current traceability authority, and documentation
validation checks that the files and reciprocal routes exist but cannot yet
verify intent from test metadata. Add a stable Journey tag when an affected E2E
is next changed; do not rename unrelated tests solely for documentation churn.
