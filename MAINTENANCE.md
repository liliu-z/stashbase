# Project Maintenance Model

Keep product intent, engineering ownership, implementation, and evidence
connected. Code is the current implementation truth; tests prove only what
they exercise. Documentation states intent and requirements without claiming
unimplemented behavior is Shipping.

## Documentation Ownership

| Record | Owns | Update when |
|---|---|---|
| [Overview](design-docs/overview.md) | Product identity, uses, principles | A product decision changes |
| [Vertical designs](design-docs/journeys/README.md) | User flows, choices, results, recovery | A user flow changes |
| [Horizontal designs](design-docs/README.md#horizontal-designs-capabilities) | Shared capability rules and intentional entry differences | A shared rule changes |
| [Glossary](design-docs/glossary.md) | Shared terminology | A term or relationship is settled |
| [Engineering Boundaries](code-review/architecture.md) | Cross-module ownership, invariants, validation | A boundary, risk, or guarantee changes |
| [Journey Coverage](code-review/journey-coverage.md) | Journey-to-code routes and evidence limits | Ownership, evidence, or gaps change |

Keep committed docs English-only. Give every rule one primary home and link to
it elsewhere. Product docs contain no source inventories. Tests own fixtures
and exact assertions. Code maps are temporary navigation snapshots, not proof
of necessity or review coverage. Research is temporary: move durable decisions
and unresolved risks into the owning document, then delete completed reports.
Use issues and PRs for chronology, scheduling, and task ownership.

Design docs describe outcomes, capability boundaries, and consequential user
choices. Keep planned behavior and open product decisions in the owning design,
clearly distinguished from current behavior. Do not maintain a separate product
direction document. Do not freeze current button positions, pane arrangements, gesture
lists, animation choreography, or component implementation as product intent.
Record current renderer mechanics only where engineering review needs them;
a layout change that preserves the behavioral contract need not preserve an
old presentation. Unconfirmed external-product analogies are not specifications.

## Status Labels

- **Current / Shipping:** implemented behavior, with its observed limits.
- **Experience Contract / Required:** behavior to preserve. Unlabelled
  engineering invariant bullets have this meaning.
- **Known Gap:** Required behavior is contradicted or unproven; name the
  limitation and evidence needed, rather than relabelling intent as Shipping.
- **Direction:** agreed product work not yet complete. Defects and evidence gaps
  are not a feature roadmap.
- **Next:** maintenance within an existing capability.
- **Coordinate First / Not Planned:** a decision is required, or work is outside
  scope. These are not automatically implementation tasks.

Evidence coverage labels belong to Journey Coverage and do not measure feature
completion. Updating prose does not change UI copy, packaged assets,
permissions, or data formats; record material mismatches until code changes.

## Previous-version Data Policy

At this stage, previous-version application data is not a compatibility
requirement. Remove code whose sole purpose is to recognize, migrate, merge,
repair, or preserve retired configuration fields, database schemas, storage
paths, or cached/derived formats. Do not add replacement migration machinery
or retain such branches for hypothetical existing users. Older contract text
requiring historical-data compatibility does not override this policy.

Keep current-format validation and initialization, ordinary persistence across
restarts, crash recovery, failed-operation rollback, cancellation, and retry.
Those protect current work and are not historical-data compatibility. Removing
migration code does not authorize deleting user-authored project files. Current
external-client and provider protocol requirements must be assessed separately;
an old name alone does not make an active interface obsolete.

Remaining migration behavior may be documented as current implementation until
removed, but it is a cleanup target rather than a required guarantee. Update
its tests and affected boundaries together with the removal.

## The Maintenance Loop

1. **Design:** locate the vertical journey and horizontal capabilities. Keep
   entry-specific choices in the journey and shared rules in the capability.
   Record only consequential decisions; a new helper or screen needs no new doc.
2. **Implement:** read those designs and engineering boundaries, keep policy
   with its owner, and keep adapters narrow. Revisit unexpected boundary changes
   before widening scope. Run focused validation and update affected docs in the
   same change as code.
3. **Review:** follow the [review guide](code-review/README.md), preferably in a
   fresh context. Pin a diff or audit snapshot; assess necessity, simplicity,
   and correctness using the vertical and horizontal routes as applicable.
   Trace code back to intent and each Required journey result
   forward to evidence. Infrastructure may have a cross-cutting contract without
   a user journey; user-visible behavior without one is a traceability gap.
4. **Close:** preserve stable Jxx IDs, reconcile affected boundaries and coverage,
   record unresolved gaps, and apply the [execution gates](AGENTS.md).

When behavior varies by format, client, or representation, keep one qualified
capability matrix in the owning capability. Compare that matrix with
implementation dispatch, UI affordances, public tools, and representative tests.
A capability proven on one surface does not establish it on another.

## Review Documentation Shape

Keep `code-review/` to four documents: the review guide, Engineering Boundaries,
Journey Coverage, and the Release Runbook. A module, feature, or helper does not
need its own review document.

Engineering Boundaries records cross-module authority, ordering, security,
durability, cancellation, and recovery requirements. Journey Coverage maps Jxx
outcomes directly to a few primary code entry points and records unresolved
implementation/evidence gaps. Release operations stay in the runbook.

Do not preserve implementation essays in another documentation folder. Local
rationale belongs beside its code, exact rules/limits in executable configuration,
and fixtures/assertions in tests. Add to an existing section only when the rule
is hard to recover from those owners. Update changed boundaries and journeys in
the same change as code; never turn cleanup into a second specification layer.

## Human and AI Responsibilities

The maintainer decides product direction and non-goals, new ownership and
external interfaces, permissions/privacy/data-ownership changes, and acceptance
of Known Gaps, visual results, release risks, and releases. AI inspects,
compares, implements within the approved scope, updates documents, and verifies
evidence. A new trust or product decision must be surfaced rather than silently
assumed. Ordinary work within an already approved scope proceeds under
[AGENTS.md](AGENTS.md).
