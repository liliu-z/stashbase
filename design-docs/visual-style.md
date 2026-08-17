# Visual Style

StashBase is a quiet, professional workspace for sustained work with the
user's own files. It borrows the structure and density of a code workbench and
the reading comfort of a focused writing application. The interface frames the
work; it does not compete with it.

This document owns visual intent. Semantic tokens, primitives, CSS mechanics,
and visual validation live in
[Renderer Styling](../code-review/renderer-styling.md).

## Stance

- **Content first.** Documents, evidence, and Agent conversation carry the
  visual weight. Chrome stays restrained.
- **Calm over impressive.** Prefer clear hierarchy, neutral surfaces, and small
  transitions over decorative effects.
- **Durable over fashionable.** A change should still suit a daily workbench
  after visual trends move on.
- **Dense but readable.** Controls stay compact; reading surfaces keep enough
  space and line length for long-form work.

## Signature

StashBase has three stable visual voices:

- **Color:** cyan is the working accent; amber is a scarce brand counterpoint.
  Selection surfaces stay neutral, and status colors communicate state rather
  than decoration.
- **Typography:** system sans for chrome, serif for long-form reading, and
  monospace for paths, code, and structured data.
- **Icons:** one coherent Phosphor family for product controls, with separate
  marks only for brands that have no equivalent icon.

Repeated elements must not multiply accent, brand color, or visual noise. File
type is carried primarily by shape and label rather than a rainbow of colors.

## Surfaces and Hierarchy

- Sunken chrome, base content, and raised transient surfaces form the depth
  model. Separation comes from subtle strokes and surface shifts.
- Documents read as the primary content surface. Chat uses a consistent
  workbench canvas whether expanded or docked; layout changes do not recolor
  its identity.
- Shadows are reserved for transient overlays and the rare standing surface
  that needs a clear anchor. Permanent hierarchy should not depend on heavy
  elevation.
- Section hierarchy comes from spacing, alignment, and type weight rather than
  decorative header bands.

## Shape and Density

- Boxes share one continuous container shape; controls and rows use the
  smaller interaction shape appropriate to their role. Size alone does not
  create a new corner language.
- Circles and capsules are reserved for semantics that need them, such as
  identity, status, or a terminal action.
- List hover and selection are quiet inset surfaces. Accent feedback is
  reserved for states that must be unmistakable, such as an active drop target.
- Sibling controls align to shared grid lines. Empty states use one deliberate
  anchor instead of distributing unrelated decoration through unused space.

## Reading and Interaction

- Reading content follows a comfortable measure and reading-size preference;
  workbench chrome remains compact.
- Focus is visible without shifting layout. Hover and selection do not move
  surrounding content.
- Motion is brief feedback, never spectacle, and reduced-motion preferences are
  respected.
- Light, dark, and system themes are equal product states. A visual change is
  incomplete if hierarchy or legibility works in only one.

## Contribution Contract

A visual contribution should:

- strengthen the content-first workbench identity;
- reuse semantic roles and managed primitives instead of inventing one-off
  literals or behaviors;
- remain clear at supported UI and reading sizes, compact layouts, and reduced
  motion;
- change this document only when the visual language itself changes, and change
  the Renderer Styling contract when implementation mechanics or validation
  change.

Exact tokens, corner assignments, primitive ownership, exemptions, and Linux
baseline workflow belong only in
[Renderer Styling](../code-review/renderer-styling.md) and
[UI Regression Testing](../code-review/ui-regression-testing.md).
