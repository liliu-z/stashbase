# Renderer Styling

Implementation contract for how the renderer is styled. Design intent
(voice, color language, density) lives in `design-docs/visual-style.md`;
this file records the mechanics a change must respect.

## Layer model

1. **Semantic theme variables** (`web-src/src/styles/globals.css` `:root`
   blocks) — the only place literal colors, radii, and motion values are
   defined, once per theme. `data-theme` on `<html>` switches themes;
   'system'/absent follows the OS preference.
2. **Tailwind theme mapping** (`web-src/src/styles.css` `@theme inline`) —
   exposes those roles as utilities. Chrome type scale `text-2xs..4xl`
   (10..30px, every step multiplied by `--ui-scale`), corner scale
   `rounded-xs/sm/md/lg/xl` forwarding the globals roles
   `--radius-xs/-control/-ui/-container` = 4/6/10/20px, assigned by role
   rather than size — each step is a `var()` and never a literal, so
   `styles/*.css` reaches the same roles; `rounded-lg`, `rounded-xl` and
   `rounded-2xl` all collapse onto `-container` on purpose, so a component
   reaching for any of the three lands on the one box corner —
   `shadow-low`/`shadow-elevation`,
   `duration-fast`/`duration-standard` (via the `--transition-duration-*`
   namespace — the bare `--duration-*` namespace generates nothing),
   `ease-ui`, and the semantic colors. `muted` is the subtle SURFACE role;
   `muted-foreground` is subdued text. The `dark:` variant is redefined to
   follow `data-theme`; never rely on the raw media query.
3. **Primitives** (`web-src/src/components/ui/`) — shadcn-generated Base UI
   adapters (button, input, select, segmented-control, dialog, alert-dialog,
   menu, toast, tooltip, status). Feature code must not recreate
   their focus, Escape, outside-press, collision, timer, or announcement
   behavior, and new buttons/inputs/selectable groups use these instead of
   bespoke classes.
4. **Utility classes in JSX** — everything surface-specific. Tailwind is
   utility-only (no preflight): UA margins on `<p>`/`<h*>` are not reset, so
   migrated markup zeroes them explicitly where it matters.

## Corner shape

Corners have two independent halves, and a change that moves one without
the other flattens the shape language:

- **How much** a corner turns — the role scale above.
- **How** it turns — `corner-shape: squircle`, applied app-wide from a
  universal selector in globals.css (the property does not inherit, so it
  cannot live on `:root`). Chromium 139+ implements it; the renderer is on
  142 via Electron 39, and non-supporting engines drop the declaration and
  fall back to circular corners, so it needs no guard.

Capsules and circles opt back out with `corner-shape: round` — at a radius
of 50% or more a squircle is a bulged superellipse, not the capsule the
affordance is drawing. The opt-out list (`.rounded-full`, the transcript
progress capsule) lives beside the universal rule; extend it there rather
than locally.

## Assigning a corner

The question is never "how big is this element" but "what kind of thing is
it":

- **A box** — has its own border or fill and holds content: `-container`.
  Composer, transcript cards, code blocks (chrome and content alike), text
  fields, cards, panels, menus, popovers, dialogs, framed images. Size does
  not enter into it; short boxes clamp to capsule ends and that is correct.
- **An item inside a box** — takes a hover or selected background: `-ui`.
  Tree rows, menu items, mention rows, buttons, the segmented control.
  Buttons are the trap here: at `-container` a 32px button becomes a
  capsule, so `ui/button.tsx` must never reach for `rounded-lg` or wider
  (the foundation test asserts this).
- **A sub-24px icon button**: `-control`.
- **An inline run of text**: `-xs`. Code spans, mentions, search marks, the
  PDF hit overlay.

Nested boxes derive their inner corner rather than picking one — an inner
surface inside a padding-inset parent sits exactly that padding tighter
(`calc(var(--radius-md) - 1px)` in the segmented control), so the two curves
stay concentric when the scale moves.

## Icons

`web-src/src/icons.tsx` is generated — run `node scripts/gen-icons.mjs` and
edit the map in that script, never the paths in the output. Icons are
inlined from the `@phosphor-icons/core` devDependency rather than imported
from `@phosphor-icons/react`, which ships six weights per icon and would not
fit the entry-chunk budget. Phosphor assets are 256-viewBox filled paths, so
there is no stroke width to keep consistent and no `fill-current` trick for a
solid state — a filled variant is a different asset (`StarIcon` /
`StarFilledIcon`). Size comes from the parent's CSS in every case.

Adding icons is not free: the budget below has little headroom, and each
Phosphor path is bulkier than the hand-drawn strokes it replaced. Prefer
reusing an existing export over adding a near-duplicate.

## Enforcement

`web-src/src/__tests__/renderer-foundation.test.ts` locks the mapping, the
type and corner scales, the squircle rule, and bans `text-[calc(` and
`bg-[var(--hover)]` in components. It also asserts that `styles/*.css`
carries no literal `border-radius: <n>px` other than the one sanctioned
999px capsule — a literal radius is the same violation as a literal colour.
Extend it when the contract grows; never weaken it to land a change.

## CSS exemptions — the only rules allowed to stay in styles/*.css

- **Electron chrome** (globals.css): `.app` grid and splitters, the macOS
  drag regions (the `.sidebar-drag-zone` traffic-light clearance band and
  the `.tab-strip` empty-background drag with its `no-drag` opt-outs —
  there is no titlebar strip), `body.is-electron` variants,
  reduced-motion policy block.
- **Tab strip** (mainpane.css): `electron/tab-strip-layout-smoke.cjs` reads
  this file raw and asserts layout from it — migrate the test before
  migrating the CSS.
- **Rendered-content typography**: Crepe
  variable bridge (`.crepe-shell`), `.agent-prose` and agent thinking/diff
  blocks, One-Dark syntax palette, and CodeMirror-generated JSON token classes.
  JSON token classes consume the light/dark `--syntax-json-*` roles from the
  global token layer; they never embed a fixed palette in the component.
  Content follows `--reading-font-size`, not the chrome scale, and may use its
  own serif/mono voices.
- **State-machine and imperative-DOM hooks**: tree drag/drop, Agent turns,
  CodeMirror-created DOM, focus flashes, preview highlights, and keyframes that
  cannot be expressed at the JSX call site.
- **Style-free marker classes** kept as querySelector/behavior hooks only
  (e.g. `.agent-view`, `quick-open-veil`) — do not re-grow
  styling onto them.

Unlisted feature rules are migration debt, not a new exemption. Move them to
the owning JSX surface when touched and delete the old rule in the same change.

## Implementation Map

| Role | Stable entry points |
|---|---|
| Token Interface | `web-src/src/styles/globals.css` |
| Utility Adapter | Tailwind mapping in `web-src/src/styles.css` |
| Primitive Interface | `web-src/src/components/ui/` |
| Feature styling | JSX utility classes plus the documented exemptions under `web-src/src/styles/` |
| Generated icon Adapter | source map in `scripts/gen-icons.mjs` → `web-src/src/icons.tsx` |
| Focused evidence | `web-src/src/__tests__/renderer-foundation.test.ts`, `electron/tab-strip-layout-smoke.cjs`, and `e2e/visual/` |

## Review checklist for styling changes

- No new hex/rgb literals, radii, font sizes, or durations outside the token
  layer; no `text-[calc(...)]`; surface tints use the accent/status ramps.
- Works in light, dark, and system themes (tokens flip — verify no raw
  `dark:` media assumptions) and at all `--ui-scale` steps.
- Focus ring visible and non-layout-shifting; reduced-motion policy holds
  (no transform/layout animation under it).
- Deleting a component deletes its styles; anything left behind in
  styles/*.css needs an exemption category above, or it is a defect.

## Visual regression validation

When a styling change affects the workspace shell, Markdown/JSON document
surfaces, Appearance Settings, Quick Open, or Command Palette, run the
representative visual spec and review whether its Linux baseline should
change. The authoritative environment is Ubuntu 24.04 under Xvfb; do not
approve a macOS or Windows screenshot as a replacement golden. Generate
intentional updates through the manual **Generate visual baselines** workflow,
review every expected/actual/diff image and the binary patch, then include only
the approved PNG changes with the styling change.

Run `pnpm typecheck`, `pnpm test:renderer`, and `pnpm build:web` for styling
changes. Run `pnpm test:e2e:visual` to compare existing baselines and
`pnpm test:e2e:visual:update` only in the Linux-authoritative environment.
Visual tests use explicit viewport/theme/content and reduced motion; do not
silence a regression with broad masks, fixed sleeps, or a global pixel
tolerance. The complete workflow and current gallery are defined in
[UI Regression Testing](ui-regression-testing.md).
