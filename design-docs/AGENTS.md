# Agent Instructions

Start with `README.md` and descend through only the affected product area,
journey, and engineering contract.

- Keep committed documentation English-only.
- Keep product identity, Shipping behavior, Required contracts, Direction, and
  evidence distinct.
- Put user outcomes and observable behavior in `design-docs/`; put Interfaces,
  invariants, implementation entry points, and validation in `code-review/`.
- Give each rule one primary home. Cross-reference it instead of copying
  state-machine, recovery, or test detail across layers.
- For implementation review, use the diff-first route in
  `../code-review/README.md` and the canonical traceability map in
  `../code-review/journey-coverage.md`.
- Update affected documentation with the behavior or Interface it describes.
  Run `pnpm test:docs` when routes, contracts, journeys, links, or structure
  change.
