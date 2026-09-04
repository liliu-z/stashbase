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
- **Typography:** three voices, split by what the surface is for. The
  system UI sans (SF Pro on macOS, with explicit CJK fallbacks — PingFang
  SC first) carries chrome — dense lists, tabs, menus are what system
  faces are optically tuned for, and it is what the reference class does.
  Bundled Geist (the marketing site's face, latin subset with the same
  CJK fallbacks) carries reading surfaces: the Markdown view, the editor,
  and chat replies. Bundled Geist Mono carries paths, code, and
  structured data on every platform. Documents may carry their own
  typography (a styled HTML file keeps its fonts).
- **Icons:** one coherent Lucide family — rounded caps and joins — for
  product controls, with separate marks only for brands and the file-format
  glyphs, which keep their own sets.

Repeated elements must not multiply accent, brand color, or visual noise. File
type is carried primarily by shape and label rather than a rainbow of colors.

## Surfaces and Hierarchy

- Light mode is deliberately FLAT: sidebar, document, and chat share one
  near-white paper (the marketing site's ground), and pane separation is
  carried by hairline strokes alone. Dark mode keeps the sunken / base /
  raised depth model, where surface shifts do the separating.
- Documents read as the primary content surface. Chat uses a consistent
  workbench canvas whether expanded or docked; layout changes do not recolor
  its identity.
- Shadows are reserved for transient overlays and the rare standing surface
  that needs a clear anchor. Permanent hierarchy should not depend on heavy
  elevation.
- Anything that floats sits on the same raised surface, one step above paper.
  Dialogs, menus, popovers, tooltips, toasts, pickers, the find bar and the
  floating viewer chrome had drifted across three roles while all claiming the
  same elevation shadow. In light mode that drift is invisible — base and
  raised are both white — so it was written without anyone seeing it, and only
  dark mode showed dialogs floating a full surface step lower than the menus
  above them. One floating role removes the whole class of error.
- The image lightbox is the one exception, and it is an exception on purpose:
  it is a dark room in both themes, so its stage, toolbar, and drop shadow are
  theme-static and belong to the stage rather than to app chrome.
- Section hierarchy comes from spacing, alignment, and type weight rather than
  decorative header bands.

## Shape and Density

- Boxes share one continuous container shape; controls and rows use the
  smaller interaction shape appropriate to their role. Size alone does not
  create a new corner language.
- Circles and capsules are reserved for semantics that need them, such as
  identity, status, or a terminal action. A box never becomes a capsule by
  being short — if the shape appears, it was chosen.
- A person avatar keeps one stable circular footprint while remote content
  loads or fails. Its fallback order is provider image, display-name initials,
  email initials, then the generic person icon; decorative avatar content does
  not repeat adjacent identity text to assistive technology.
- List hover and selection are quiet inset surfaces. Accent feedback is
  reserved for states that must be unmistakable, such as an active drop target.
- Sibling controls align to shared grid lines. Empty states use one deliberate
  anchor instead of distributing unrelated decoration through unused space.

## Reading and Interaction

- Reading content follows a comfortable measure and reading-size preference;
  workbench chrome remains compact. The interface-size preference moves text
  and the space around it together, so a larger setting stays legible instead
  of crowding denser.
- Focus is visible without shifting layout. Hover and selection do not move
  surrounding content.
- Every control that can be pressed visibly accepts the press. A surface that
  takes a click and shows nothing leaves the user waiting on the result with
  no sign the app heard them.
- A panel that belongs to a control appears from that control. Menus,
  popovers, and tooltips grow out of what opened them; a dialog, which
  belongs to no single control, arrives in the middle.
- Motion is brief feedback, never spectacle, and reduced-motion preferences are
  respected. It is graded by what it is doing — arriving, moving, or merely
  tinting — rather than by which surface it happens on, and nothing arrives
  from nothing.
- Light, dark, and system themes are equal product states. A visual change is
  incomplete if hierarchy or legibility works in only one.

## Contribution Contract

A visual contribution should:

- strengthen the content-first workbench identity;
- reuse semantic roles and managed primitives instead of inventing one-off
  literals or behaviors;
- remain clear at supported UI and reading sizes, compact layouts, and reduced
  motion, and stay operable from the keyboard alone;
- change this document only when the visual language itself changes, and change
  the Renderer Styling contract when implementation mechanics or validation
  change.

Exact tokens, corner assignments, primitive ownership, exemptions, and Linux
baseline workflow belong only in
[Renderer Styling](../code-review/renderer-styling.md) and
[UI Regression Testing](../code-review/ui-regression-testing.md).
