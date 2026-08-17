# Project Maintenance Model

StashBase is maintained by keeping product intent, engineering ownership,
implementation, and evidence connected. AI may perform most reading, coding,
and checking; the maintainer keeps control of decisions and accepts the result.

## What Must Stay Under Control

| Control | Question | Primary record |
|---|---|---|
| Intent | Why should this exist, and what should users observe? | `design-docs/` |
| Ownership | Which Interface owns the behavior and its failure modes? | `code-review/` |
| Status | Is the claim Shipping, Required, Direction, or a Known Gap? | Area design and review contract |
| Evidence | What actually proves the behavior? | Focused tests and Journey Coverage |

Code is the current implementation truth. Tests prove only the paths they
exercise. Documentation defines intent and required behavior; it must not
pretend that an unimplemented requirement is Shipping.

## The Maintenance Loop

```text
Design and implementation:
intent → scenario → journey → area and engineering Seam → code → evidence

Product acceptance:
journey → required results → Journey Coverage → exact evidence → code or gap

Implementation review:
diff → engineering contract → journey or cross-cutting rationale → evidence
```

Design moves coarse-to-fine. Review starts from the changed code, recovers the
coarser intent and contracts, then returns to the implementation and evidence.
Both directions must reach the same ownership and requirements.

### 1. Understand and Design

For a new capability, start with the scenario and journey before selecting the
owning product area. For a change to established behavior, the area may be the
fastest entry, but the change must still resolve to an affected journey or a
cross-cutting product contract. Establish:

- the user outcome and non-goals;
- current Shipping behavior;
- the Required behavior or Direction being proposed;
- recovery behavior and Known Gaps;
- the engineering Seams the change is expected to cross.

User-visible work is accepted through a journey: the journey states the
observable outcome, required results, and meaningful recovery, while Journey
Coverage records the evidence. Cross-cutting ownership, trust, and lifecycle
rules constrain many journeys and remain in area or engineering contracts
rather than being copied into every flow.

When one user-visible capability varies by source type, client, or
representation, keep one canonical capability matrix in the narrowest owning
Area. Use qualified capability terms instead of generic claims such as
`supported`, `readable`, or `writable`. Journeys reference the stable classes
and require truthful affordances; contracts own the Interfaces and invariants;
code owns exact dispatch membership; tests own representative fixtures and
assertions.

Deepen an existing Area, Journey, or Contract when it still owns the outcome.
Create a new one only when the outcome or engineering Seam is independently
meaningful. The maintainer approves durable product direction, new ownership,
and changes to trust or access before implementation begins.

### 2. Implement

Read only the selected Area, Journey, and owning Contracts. Put behavior behind
the owner Module's Interface; keep Adapters narrow and avoid copying policy
across callers. If implementation needs an unexpected Seam, stop and revisit
the design instead of silently widening the change.

Run focused validation while implementing. Update affected design, contracts,
Known Gaps, and evidence in the same change as the code they describe.

### 3. Review

Review from a pinned diff, preferably in a fresh context that does not inherit
the implementation's assumptions. Use the
[diff-first route](code-review/README.md#diff-first-review) to identify the
smallest set of crossed Contracts, then review in both directions:

- **Journey to evidence:** for each affected journey, check every Required
  Observable Result and recovery path against Journey Coverage, then read the
  exact test, Eval, or release check that claims to prove it.
- **Code to intent:** for each changed behavior or stable Interface, recover its
  owning Contract and affected journeys. Code outside the target journey must
  either support another reviewed journey or have an explicit cross-cutting
  engineering purpose with focused evidence.
- **Capability to code:** when behavior varies by format, client, or
  representation, compare the owning Area's capability matrix with dispatch,
  UI affordances, public tool descriptions, and representative evidence. A
  capability proven on one surface must not be generalized to another.

Cross-Module review follows Seams, not file count. A finding names the code,
the violated requirement or invariant, the consequence, and the missing or
contradictory evidence. User-visible behavior without a journey is a design
gap; code without a journey, owning Contract, or necessary implementation
rationale is a scope finding rather than implicit future work.

### 4. Close the Loop

Before commit or release, reconcile the diff with documentation and Journey
Coverage. Record unresolved Required behavior as a Known Gap; never hide it
behind passing but incomplete tests. Run the validation required by every
crossed Contract, then apply the repository's commit or release gate.

## Human and AI Responsibilities

The maintainer decides:

- product outcomes, non-goals, and durable direction;
- new Areas, Journeys, external Interfaces, and review-significant Seams;
- permission, privacy, data ownership, destructive behavior, and other trust
  decisions;
- whether to accept a Known Gap, visual result, release risk, or release.

AI is expected to inspect the repository, expose inconsistencies, compare
alternatives, implement within the approved scope, maintain documentation, run
validation, and review evidence. It must surface a decision instead of assuming
permission when the work would change one of the maintainer-owned choices.

## Entry Points

- Product model and extension rules: [`design-docs/README.md`](design-docs/README.md)
- Engineering and diff-first review: [`code-review/README.md`](code-review/README.md)
- Journey, Area, Contract, and evidence traceability:
  [`code-review/journey-coverage.md`](code-review/journey-coverage.md)
- Repository execution and validation rules: [`AGENTS.md`](AGENTS.md)
- Release ownership and gates:
  [`code-review/release-pipeline.md`](code-review/release-pipeline.md)
