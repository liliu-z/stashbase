# Design Docs
This directory is the committed source of truth for StashBase product intent:
why the product exists, what users can observe, and which experience rules a
change must preserve. Code remains the source of truth for the current
implementation; tests are evidence only for the behavior they exercise.
The repository-wide human/AI workflow lives in
[`MAINTENANCE.md`](../MAINTENANCE.md); this directory owns its product layer.

The documentation is deliberately organized for bounded review context. Start
coarse, descend only through the affected product area and engineering Seam,
and stop when the current question is answered. A reader should not need to
load every document or inspect the whole source tree before making a focused
change.

## Coarse-to-fine Model

| Level            | Question                                                     | Read                                                   |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| Product identity | What is StashBase, and which durable rules constrain it?     | Overview, Principles, Product Direction                |
| User outcome     | Why does this work matter, and what does the user observe?   | One scenario and journey, then the owning area design  |
| Engineering Seam | Which Interface owns the behavior and what must remain true? | One or more focused `code-review/` contracts           |
| Implementation   | Where does the behavior live?                                | The contract's Interface, owner Modules, and Adapters  |
| Evidence         | What proves the behavior without reading unrelated code?     | Focused validation and Journey Coverage                |

Each level has one job. Do not copy an implementation rule upward as product
direction or copy exact test assertions into a contract. Move downward only as
needed and sideways only when a named cross-area Seam requires another
contract.

To review current product capability, read two complementary views: User
Journeys are the vertical end-to-end outcomes, while the Area designs below
are the horizontal Shipping feature surfaces and experience contracts. Use
Product Direction for intended direction, not as a current feature inventory;
use Journey Coverage only after the behavior is understood, to inspect its
evidence and gaps.

## Reading Paths

For product orientation:

1. [Overview](overview.md) — what StashBase is and who it serves.
2. [Principles](principles.md) — durable decision rules.
3. [Product Direction](product-direction.md) — intended shape and investment
   themes.
4. [Product Scenarios](product-scenarios.md) — high-level reasons people use
   the product.

For understanding or extending a product area:

1. Identify the motivating [Product Scenario](product-scenarios.md) and the
   affected [User Journey](user-journeys.md). A new user-visible capability
   must change an existing journey or define a distinct end-to-end outcome.
2. Find the narrowest owning [product area](#product-areas). For a focused
   change to established behavior, starting from the area is acceptable, but
   still resolve the affected journey before implementation.
3. Read [Architecture](architecture.md) when the change crosses ownership,
   lifecycle, or trust boundaries.
4. Read the matching maintainer contract in
   [`code-review/`](../code-review/README.md) before changing code.
5. Follow that contract's Implementation Map and focused validation instead of
   inventorying the repository.

For reviewing an implementation or diff, start with the
[`code-review/` diff-first route](../code-review/README.md#diff-first-review).
It leads back to the same area and journey before descending into changed
code. The canonical Journey → Area → Contract → Evidence relationships live in
[Journey Coverage](../code-review/journey-coverage.md).

User Journeys are the product-behavior backbone, not a feature inventory. Each
journey defines an observable outcome, required results, and meaningful
recovery. Area designs and system contracts protect rules shared by several
journeys; they should not be duplicated into every flow.

[J01 Onboarding](user-journeys.md#j01-complete-onboarding-and-reach-first-value)
and the [J10 Core Loop](user-journeys.md#j10-turn-a-local-project-into-durable-agent-assisted-work)
are the critical product-level journeys. J01 owns understanding, minimum setup,
first value, and clean return; J10 owns durable repeated value after onboarding.
[J11 Conversation to Project](user-journeys.md#j11-turn-a-conversation-into-a-project)
is the Chat-first activation route between them. Capability journeys define the
focused behavior and recovery they compose.

For terminology and UI work, use [Glossary](glossary.md) and
[Visual Style](visual-style.md).

## Document Types

| Type            | Purpose                                              | Changes when                                           |
| --------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| Intent          | Overview, principles, and product direction          | Positioning, scope, or a durable decision rule changes |
| Scenario        | High-level user motivation and desired outcome       | The product begins or stops supporting a class of work |
| Journey         | Stable, observable shipping workflow with a `Jxx` ID | A user-visible step, outcome, or recovery path changes |
| Area design     | Current experience and contribution direction        | Shipping behavior or area guidance changes             |
| System contract | Cross-cutting ownership and trust boundaries         | A major runtime or data-flow contract changes          |

Journeys are not test cases. They give automated and manual checks a stable
product vocabulary; the test suite owns exact setup and assertions.

## Capabilities and Product Areas

StashBase is a **Wiki** for local files, delivered through three product
capabilities. The **Document Workbench** spans the Workspace and Documents
areas; the Wiki's **local RAG layer** spans Preparation and Search and
Retrieval; visible **Wiki Pages** are built through the **Agent Panel**, which
is also a product area. Product capabilities describe what StashBase is.
Product areas divide design and contribution ownership.

## Product Areas

| Area                 | User outcome                                                   | Design document                          |
| -------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| Workspace            | Work directly in ordinary local folders                        | [Workspace](design/workspace.md)         |
| Documents            | Read, edit, and navigate supported source files                | [Documents](design/documents.md)         |
| Preparation          | Make difficult formats searchable without replacing the source | [Preparation](design/preparation.md)     |
| Search and Retrieval | Find source evidence for people and Agents                     | [Search and Retrieval](design/search.md) |
| Agent Panel          | Collaborate with Built-in or bring-your-own Agents in scope    | [Agent Panel](design/agent-panel.md)     |
| Bug Reporting        | Prepare a local, user-reviewed report without telemetry        | [Bug Reporting](design/bug-reporting.md) |

Each area document uses the same shape: user outcome, scope and non-goals,
current experience, experience contract, cross-area seams, contribution
direction, and related journeys/contracts.

## Extending the Model

Extend the narrowest existing owner first:

- Add behavior to an existing area when it serves the same user outcome and
  preserves that area's scope.
- Add a journey when users gain a distinct end-to-end outcome or recovery path,
  not for a UI variant or test case. Assign the next stable `Jxx` ID and add its
  Area, Contract, and Evidence route to Journey Coverage.
- Add a product area only when one outcome needs independent scope, non-goals,
  and contribution direction. A screen or navigation entry is not an area by
  itself.
- Add a review contract only for a review-significant Seam with independent
  invariants and focused evidence. Files, helper Modules, or one-off Adapters do
  not each earn a contract.
- Change Overview, Principles, or Product Direction only when product identity
  or a durable decision changes.

Prefer deepening an existing Module and its Interface over layering another
document or pass-through Seam. If a change cannot be routed without reading
unrelated areas or contracts, repair the ownership or traceability as part of
that change.

## Status Labels

* **Current** — observed shipping experience.

* **Experience contract** — required product behavior. If current code violates
  it, add a plainly named Known Gap and link to the owning review contract.

* **Next** — useful contribution direction, not a release promise.

* **Coordinate first** — valuable cross-cutting work that needs alignment.

* **Not planned** — intentionally outside the current product shape.

Never combine Current, Required, and Direction in one claim. Product Direction
contains durable choices, not Shipping UI state. A reader must be able to tell
what the product does now without reconstructing code history.

## Maintenance Rules

* Keep these documents concise and in English.

* Give each rule one primary home and cross-reference it elsewhere. Repetition
  may summarize intent but must not duplicate state-machine or recovery detail.

* Update affected journeys and area design in the same change as shipping
  behavior. Update intent documents only when the underlying intent changes.

* Keep implementation inventories, state-machine detail, and validation
  matrices in `code-review/`; keep exact assertions in tests.

* Keep a cross-journey product capability matrix in the narrowest owning area
  when behavior varies by source type, client, or representation. Journeys
  reference its stable capability classes and observable results rather than
  duplicating the inventory. Exact fixtures and assertions remain in tests.

* Keep coverage ownership in
  [`code-review/journey-coverage.md`](../code-review/journey-coverage.md); a
  journey ID alone does not claim that the flow is automated. Keep its Area and
  Contract routes current as the canonical traceability map.

* Use issues and pull requests for schedules, owners, and implementation
  chronology. These documents are not ticket trackers or changelogs.
