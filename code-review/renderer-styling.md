# Renderer Styling

Implementation contract for how the renderer is styled. Design intent
(voice, color language, density) lives in `design-docs/visual-style.md`;
this file records the mechanics a change must respect.

## Layer model

1. **Semantic theme variables** (`web-src/src/styles/globals.css` `:root`
   blocks) — the only place literal colors, radii, motion values, and
   stacking values are defined, once per theme. `data-theme` on `<html>`
   switches themes; 'system'/absent follows the OS preference. This file
   also carries the universal reset (box-sizing, squircle corners,
   focus-visible, the reduced-motion policy) — the pieces every surface
   depends on, not any one feature's.

   Five ramps live here alongside the colors, and each exists because the
   app had already proved it could not hold the line without one:

   - **Corners** — `--radius-xs/-control/-ui/-container` = 4/6/10/16,
     assigned by role (see "Assigning a corner").
   - **Motion** — `--motion-instant/-fast/-standard/-slow` = 100/120/180/240ms
     and three curves: `--motion-ease-out` for anything entering or exiting,
     `--motion-ease-in-out` for something moving or morphing on screen, and
     `--motion-ease-hover` for tint-only change. `--motion-ease` aliases the
     entering curve.
   - **Layers** — `--layer-raised/-sticky/-chrome/-banner/-veil/-picker/`
     `-backdrop/-modal/-menu/-menu-backdrop/-menu-modal/-tooltip/-toast`,
     spaced by 100. The ORDER is the contract: a tooltip can be raised from
     a menu item and a toast can report a modal's own failure, so both
     pairs have to stay the right way round. Before this ramp the app
     carried seventeen unrelated z-indexes and tooltips genuinely rendered
     behind menus.

     `menu-backdrop`/`menu-modal` (310/320) are the ramp's one nesting
     exception, and they exist because BOTH directions are real while a
     linear ramp can only serve one. A menu opened from inside a modal —
     the library search's scope pill — needs `menu` above `modal`. A
     confirmation opened from inside a menu or popover — the session-history
     row's "Delete chat?" — needs the reverse, and on the ordinary pair it
     rendered behind the popover that raised it while its backdrop dimmed
     everything except the surface it had to block. Flipping the ramp would
     only move the break to the other case, so the nested dialog gets its
     own pair above `menu` instead. That is what the 100-spacing is for.

     A dialog reaches it through `<DialogContent layer="menu">` /
     `<AlertDialogContent layer="menu">`, never by adding a `z-` class at
     the call site. The prop exists because the primitive already spells
     one layer class and two custom `z-` utilities are not a conflict pair
     tailwind-merge resolves — both would survive and stylesheet order,
     not the call site, would pick the winner. Choosing inside the
     primitive means exactly one is ever emitted, which
     `shared-overlays.test.ts` asserts along with the pairing itself.
   - **Overlay geometry** — `--overlay-w-xs/-sm/-md/-lg/-xl/-2xl` =
     320/360/420/480/640/760, each already clamped by the one
     `--overlay-fit` = `calc(100vw - 32px)`; `--overlay-h-xs/-sm/-md/-lg` =
     180/360/440/560 each clamped at `70vh`, plus `--overlay-h-window` and
     `--overlay-h-stage`/`--overlay-w-stage` for the two surfaces that take
     the window instead of a step. Thirty-one hand-typed literals preceded
     it, carrying nine widths, five spellings of "and never outgrow the
     window" (90vw, 92vw, 94vw, 100%, `calc(100vw - 16|24|32px)`), and a
     `min()` whose arguments flipped order between neighbouring call sites.

     The clamp is a role too, which is the half easiest to miss: banning
     `w-[min(` and `max-h-[min(` left `max-w-[calc(100vw-24px)]` legal, and
     three popups walked through that gap on a sixth rounding of the one
     rule. The foundation test now rejects a bare `[calc(100vw-` /
     `[calc(100vh-` as well, so a surface names `max-w-overlay-fit`, the
     lightbox's `-stage` pair, or `max-h-overlay-window`.
   - **Measure** — `--measure-xs/-sm/-md/-lg` = 180/440/640/760, clamped to
     `100%`. A separate scale from overlay width on purpose; see "Assigning
     a width" below.
   - **Pane chrome offsets** — `--chrome-top` and `--chrome-top-banner`, the
     two places the main pane's absolutely-positioned chrome (Markdown edit
     toggle, PDF control slot, find bar) may start: below the tab strip, or
     below the tab strip plus the out-of-folder identity banner. The second
     is derived from the first plus `--chrome-banner-h`, never typed. Both
     scale with `--ui-scale` because the strip and the banner do; the three
     px literals they replace (`top-11`, `top-[76px]`, `top-[78px]`) did
     not, so at the Large interface size the stack reached 82.8px and both
     literals sat under the chrome they were meant to clear.

   Shadows are two steps and one exception. `--shadow-low` and
   `--shadow-elevation` are the chrome scale (`--shadow-raised` is the hero
   composer's one sanctioned standing shadow); `--shadow-stage` is the image
   lightbox's, off the scale because it lifts a photograph off a dark room
   rather than a panel off the app. It is theme-static for the same reason
   `--scrim` is, which is why it spells its own rgb instead of reaching for
   `--shadow-color` — that one flips with the theme and the stage never
   does. All three live in the base `:root` only.
   The chrome type scale lives here too — `--text-2xs` … `--text-4xl`,
   10/11/12/13/14/16/20/24/30px, every step multiplied by `--ui-scale`.
   It sits in globals' plain `:root` rather than in the `@theme inline`
   block that spends it, and that placement is load-bearing: `inline`
   means Tailwind pastes a step's value into the utilities it generates
   and never emits the variable, so while the numbers lived in
   `styles.css` a hand-written `var(--text-sm)` resolved to nothing —
   the declaration was dropped and the surface silently inherited its
   parent's size. Every colocated `*.css` file therefore restated
   `calc(12px * var(--ui-scale))` by hand, and "one type scale" held
   only for `*.tsx`. `styles.css` now forwards each step
   (`--text-sm: var(--text-sm)`), the same pattern `--radius-*`,
   `--shadow-*` and `--font-*` already use, so the `text-*` utilities,
   colocated CSS, and `electron/tab-strip-layout-smoke.cjs` — which
   concatenates globals.css with workspace.css and nothing else — all
   read one definition. `--ui-font-size` is `var(--text-base)` rather
   than a fourth spelling of 13.

   `--spacing` is NOT reachable this way and deliberately stays where it
   is: it is Tailwind's own base and nothing outside a utility should be
   deriving px from it (`--chrome-top` restates `4px * var(--ui-scale)`
   for exactly that reason). Hand-written CSS spends the ramp as plain
   px, which the spacing guard below checks.
2. **Tailwind theme mapping** (`web-src/src/styles.css` `@theme inline`) —
   exposes those roles as utilities. Chrome type scale `text-2xs..4xl`
   (forwarding the globals steps above), corner scale
   `rounded-xs/sm/md/lg/xl` forwarding the globals roles
   `--radius-xs/-control/-ui/-container` = 4/6/10/16px, assigned by role
   rather than size — each step is a `var()` and never a literal, so every
   colocated exemption file (below) reaches the same roles; `rounded-lg`,
   `rounded-xl` and `rounded-2xl` all collapse onto `-container` on purpose,
   so a component reaching for any of the three lands on the one box corner —
   `shadow-low`/`shadow-elevation`,
   `duration-fast`/`duration-standard` (via the `--transition-duration-*`
   namespace — the bare `--duration-*` namespace generates nothing),
   `ease-ui`, and the semantic colors.

   `--spacing` is `calc(4px * var(--ui-scale))`, so every `p-`/`m-`/`gap-`/
   `size-` utility is a multiple of the same base AND follows the
   interface-size preference the way the type ramp does — chrome text used
   to grow with that preference while padding stayed put, which tightened
   every dense row exactly as its text got bigger. The legal ramp is
   half-steps to 4 and whole numbers above it; quarter-steps and half-steps
   past 4 (`px-2.25`, `py-1.75`, `mt-5.5`, `size-9.5`) are eyeballed values
   wearing scale notation and the foundation test rejects them.

   The overlay and measure steps ride Tailwind's `--container-*` namespace
   (`--container-overlay-md`, `--container-measure-md`), which is the one
   that generates width utilities — so a single entry lands `w-overlay-md`
   AND `max-w-overlay-md`. Both halves are used: a dialog sets the width
   alone (the primitives ship no cap of their own — see "Assigning a
   width"), a tooltip sets the max alone, and a picker sets both.

   Five `@utility` families sit beside the `@theme` block because Tailwind
   has no namespace that would generate them:

   - `z-raised` … `z-toast` — one per layer role, so a component names the
     role it occupies and never a number.
   - `max-h-overlay-xs` … `max-h-overlay-stage` — one per overlay height
     role. Tailwind's `max-h-*` reads the spacing ramp, so without these a
     scrolling surface has to re-decide, in an arbitrary value, both how
     tall it wants to be and how much of a short window it may eat.
   - `transition-control` / `transition-tint` / `transition-surface` — a
     transition is three decisions (which properties, how long, what curve)
     and spelling all three at each call site is how the app ended up with
     `transition-all`, eleven bare `transition-colors` silently falling
     back to Tailwind's 150ms, and four nearly-identical property lists.
     Naming the role collapses it to one decision: what kind of feedback is
     this? Property lists stay explicit inside the utility, so nothing here
     animates a layout property.

     The two roles that move something name `transform, translate, scale,
     rotate` together, not `transform` alone. Tailwind v4 emits `scale-96`
     and `-translate-y-1` as the standalone `scale` and `translate`
     properties rather than as `transform` functions, so a list naming only
     `transform` transitions nothing those utilities write: the Button's
     `active:scale-97` and every popup's 96% entrance were snapping, in
     silence, everywhere. Tailwind's own `transition-transform` names all
     four for this reason and these roles have to match it. All four remain
     compositor properties, so the layout path is still untouched.
   - `origin-anchor` — `transform-origin: var(--transform-origin)`, the
     corner Base UI resolved a popup to after collision handling.

   `muted` is the subtle SURFACE role;
   `muted-foreground` is subdued text. The `dark:` variant is redefined to
   follow `data-theme`; never rely on the raw media query. `styles.css` is
   also the one place Tailwind's `@theme inline` token bridge may live —
   it does not move to a feature file.

   `muted-foreground` clears AA against the resting surfaces it was
   calibrated for, NOT against the selected-row fill (`--active`), where it
   lands under the floor. Any surface that dims a row and can also select
   it therefore restores full ink on selection — selection already carries
   its own emphasis, so the dim only has to hold in the resting list. Check
   a subdued role against the surface it actually paints on before reusing
   it; a colour verified against the base white can still fail on a sunken
   pane or a selected row.

   A `@theme` entry is a NAMESPACE, not an alias. `--color-secondary`
   generates `bg-secondary` and declares `--color-secondary`; it never
   declares a bare `--secondary`. A hand-written `color-mix()` or `calc()`
   in a component must therefore name the globals role it wants, not the
   utility's short name — the Button's `secondary` variant mixed
   `var(--secondary)` with `var(--foreground)`, neither of which exists, so
   the declaration was dropped and the hover background vanished with no
   error anywhere. That is the failure mode the var-resolution guard below
   exists to catch.
3. **App shell composition** (`web-src/src/app/app-shell.css`, imported from
   `app/App.tsx`) — the `.app` grid (sidebar | main | splitter | chat) and
   every state it responds to, the titlebar control band, the macOS drag
   regions, and the two panel splitters. This is genuinely cross-feature: it
   expresses how the workspace's tab strip and the agent panel's chat-tab-row
   relate to one top-level layout, so it stays with the shell that owns that
   composition rather than either feature.

   The band's two stacked surfaces now name the ramp instead of the raw
   `7`-over-`6` they carried: `.sidebar-drag-zone` takes `--layer-chrome`
   (globals spells that role "floating pane chrome, drag zones", which is
   these two exactly) and `.titlebar-controls` takes
   `calc(var(--layer-chrome) + 1)`. Neither element sits inside a nearer
   stacking context — `.app` and `.sidebar` are both `position: relative`
   with `z-index: auto` — so the pair genuinely compares against the rest
   of the app's chrome, which the old numbers ordered against nothing.
   The `+ 1` is a backstop, not the guarantee: the controls render before
   the sidebar in `App.tsx`, so at an equal z-index the drag zone would
   paint over them and the whole control band would go dead on macOS.
   What actually keeps the band clickable is geometry — the drag zone's
   width is `var(--titlebar-controls-left)`, so it stops where the
   controls begin and the two rects never overlap. That is the fix that
   replaced the `-webkit-app-region` carve-outs, which proved
   intermittently stale on windowed macOS and killed clicks across the
   whole band; do not reintroduce carving, and do not let the two rects
   start overlapping on the assumption that the ordinal will save it.

   Geometry owns the band's right edge the same way. `.titlebar-controls`
   caps itself at the sidebar column, so the cluster's box never reaches
   the tab strip beside it — but a cap only contains the cluster if one
   child can absorb the squeeze. The sidebar toggle, the search button and
   the hairline are fixed by design, which leaves the folder switcher as
   the single elastic item; it carries `min-w-0 shrink` against the button
   recipe's default `shrink-0`, and its label truncates to an ellipsis.
   Drop that override and the trigger overflows its capped parent at its
   full intrinsic width, painting the folder name across the document tab
   strip (or, with Chat as the workspace, the chat tab row). The narrow
   window this leaves is real: at the 200px minimum sidebar width the
   macOS traffic-light inset spends most of the budget, so the label keeps
   only a small truncated fragment. The cap ends exactly at the sidebar
   edge; widening it further means reserving the cluster's overhang in the
   neighbouring row, not relaxing the cap in isolation.
4. **Colocated feature CSS** — exemption rules (below) that a component needs
   but Tailwind utilities can't express, living in a CSS file next to the
   feature it styles and imported directly from the component(s) that render
   those classes (e.g. `features/agent-panel/agent-panel.css` imported from
   `ChatPane.tsx`; `common/styles/tree.css` — the one primitive genuinely
   shared across features — imported from every tree renderer: `FileTree.tsx`,
   `Sidebar.tsx`, `DocumentOutline.tsx`, `JsonTreeView.tsx`). Vite inlines
   every import into one stylesheet at build time regardless of which
   component pulled it in, so this costs nothing at runtime; it exists so a
   change to one feature's CSS never means opening a shared file. Deleting a
   component's file deletes its CSS import at the same time — there is no
   separate "did we leave rules behind" step.

   **The bar is "no utility can own this", and each surviving block says
   which of five reasons it is.** `agent-panel.css` is the worked example:
   467 lines down to 320 (164 of them declarations, the rest the reasons),
   because most of it was never an exemption — it was the panel's ordinary
   box, type and spacing written in CSS because that is where the file
   already was. What a rule has to be to stay: geometry no utility spells
   (the transcript's `max()` reading column; the bubble's
   `min(85%, 620px)`, since `max-w-[min(` is the exact spelling the
   overlay guard bans; the mention popup's coupled 220/180 caps); a
   selector Tailwind has no variant for (`.agent-turn + .agent-turn`, and
   the `:has(.agent-turn-edit)` rule the foundation test pins by name);
   content typography, which styles DOM a renderer emitted and so has no
   call site (`.agent-prose`); a content palette that is deliberately not
   a theme role (the One-Dark diff tints, which keep `.agent-diff-row` /
   `.agent-diff-gutter` as their hooks while the diff's frame and mono
   type moved to the call site); or imperative DOM (`.agent-input` and the
   mention widgets `MentionComposer` builds in a `WidgetType.toDOM`).
   Everything else moved: a box two components share is a class string
   beside them (`turnHeadClass` in `agent-panel/lib/panelStyles.ts`), and
   a hover-reveal is `group/turn` rather than a descendant rule.

   Two ramps reach these files by NAME now rather than by hand. `--text-*`
   is declared in `globals.css` `:root` precisely so a colocated
   stylesheet can spend it — see the type-scale note there — and the two
   guards below ("spacing in colocated CSS", "font size in colocated CSS")
   hold both.
   `--spacing` is NOT the spelling for a colocated file: Tailwind emits it
   to `:root` only when some candidate happens to spend it in an arbitrary
   value, so a stylesheet leaning on it would resolve or not depending on
   markup somewhere else. Colocated CSS writes the ramp step as a px
   literal, which is what the spacing guard reads.
5. **Primitives** (`web-src/src/common/components/ui/`) — shadcn adapters
   over Base UI: button, input, textarea, select, checkbox, collapsible,
   (a standalone `switch` was retired when its last caller moved into a menu;
   the track-and-thumb look now lives as `menu-radio`'s switch indicator, so
   restore the primitive only for a real form-row switch, not for a menu row)
   segmented-control, tabs, field, label, progress, dialog, alert-dialog,
   menu (+ `menu-radio`), popover, toast, tooltip, status, plus the
   non-Base-UI recipes badge, card, section, empty-state, pill, and
   menu-option. `collapsible` earns its place on the WIRING, not the
   toggle: its trigger carries `aria-controls` for the panel it reveals,
   where a `<button aria-expanded>` beside a conditionally rendered `div`
   announces that something expanded without saying what. Its trigger is a
   bare part — pass `Button` through `render` — so a disclosure header
   stays a control the size of its own label rather than a full-bleed row
   that lights up under a pointer nowhere near it; the rule that spans the
   column belongs to the header's wrapper, not to the control. Part names follow the
   shadcn registry (`TabsList`/`TabsTrigger`/`TabsContent`,
   `FieldSet`/`FieldLegend`/`Field`/`FieldLabel`, `Progress`/`ProgressTrack`/
   `ProgressIndicator`) with this repo's tokens substituted for the
   registry's generic ones — the registry ships `z-50`, `shadow-md`,
   `transition-all`, `rounded-4xl` and `ring-[3px]`, none of which exist
   here. Every primitive has a caller: one with no caller is a guess about
   the next feature, not a design system.

   `select` is the one that takes DATA rather than parts, and the one that
   no longer wraps a native element. The native `<select>` was a deliberate
   choice once — the OS popup brings collision handling, typeahead and
   accessibility for free — and the cost was that a native popup paints in
   the OS palette, so the app's six selects were the only surfaces that did
   not follow `data-theme`: a light popup dropping out of a dark app. They
   could not take the corner, the focus halo, the entrance motion, or the
   layer ramp either, and the caret had to be faked with an
   `appearance-none` box under an absolutely-positioned chevron, which is
   the tell that the element was being fought rather than used. Base UI
   supplies what the native control was being kept for.

   It takes `items` instead of Trigger/Content/Item parts because every
   select here is a flat list of value/label pairs, and because Base UI
   resolves the CLOSED trigger's label from `items` — the popup is
   unmounted, so its rows cannot answer. A parts version would therefore
   have to pass the same array twice, once for the label and once for the
   rows, and those two can drift. One prop cannot. Export the parts when a
   grouped or decorated select actually lands, not before.

   `pill` and `menu-option` are one idiom in two halves — a quiet
   "pick a value" trigger and the choice rows it opens onto — and they
   arrived by absorbing a shared module of twelve exported class strings
   that the composer's settings/mode pills and the search popup's scope
   pill both had to spell in the same order. A recipe that has to be spelled is
   a recipe that can be spelled half: `Pill` carries `min-w-0` AND the
   label's `truncate` because the two are one decision (a flex item's
   default `min-width: auto` refuses to shrink below its content, so a long
   model name pushed the send button off the composer row; `min-w-0` alone
   would overflow instead, and `truncate` alone would have nothing to
   shorten). `MenuOption` carries the same pairing on the active row —
   a neutral selected surface plus a trailing accent check, two signals and
   deliberately no third, because accent must never become a row-width
   wash. `MenuOptionContent` is the row body alone, for the menus whose
   container is `MenuRadioItem` and which therefore already own their check.
   `Pill` reaches its menu through Base UI's `render` prop, so the trigger
   stays the primitive's element while the menu behind it stays the
   caller's business. `MenuSectionLabel` joined `menu-radio` rather than
   `menu`, by that file's own rule — it is a grouping part and both callers
   sit behind an interaction boundary, so it costs the initial chunk
   nothing; `menu-submenu` holds the nested-menu parts under the same rule. It is a muted grouping line rather than a `MenuSeparator`,
   because a hairline directly under the default row cuts a menu in half
   and reads as two.

   **`MenuGroupLabel` must render INSIDE its group.** It is the group's
   accessible name, not a heading that happens to sit above one: it
   registers its id through the group's context and Base UI THROWS when
   that context is missing, so a heading placed as the group's sibling
   turns opening the menu into a thrown render. In the composer that
   reached the user as the chat pane's error boundary — the whole session
   replaced by "Could not open chat session." the moment a pill was
   clicked. Either put the label inside the `MenuRadioGroup`/`MenuGroup`,
   or use `MenuSectionLabel`, which needs no group. Guarded by
   `agent-composer-pills.test.ts`, which opens each pill's lists and reads
   the group names back.

   The agent panel's `AttachmentChip` is the same absorption one layer out,
   and it deliberately stayed a feature component rather than moving here:
   it knows what an attachment is, which is a fact about the panel and not
   about the design system. It took nine class strings with it, and the
   `onRemove` prop is what retired the last two — the composer used to pass
   its own remove button in, which is how two different close-control
   recipes came to sit a few lines apart with nothing to check either
   against.

   **This is the only place `@base-ui/react` may be imported.** A feature
   reaching past the wrapper layer re-decides focus, motion, and tokens per
   surface, which is the drift the layer exists to stop; the foundation test
   enforces it, and also bans a second component library outright. The agent
   panel ran on `react-aria-components` until this contract was written, and
   that seam is where most of the hand-rolled row/button recipes grew — two
   libraries meant two focus models, two overlay stacks, and two answers to
   "what is a button".

   That last clause is a test, not an aspiration: the foundation suite
   rejects a raw `<button>`, `<input>`, `<select>` or `<textarea>` anywhere
   under `web-src/src` outside this directory. Its allowlist is the set
   below, and it pins the NUMBER of raw controls each exempt file holds
   rather than the file — an exemption covers the elements it was reasoned
   about, so an exempt file cannot grow a second unreasoned control, and an
   entry whose call site has since been converted fails as stale. See
   "Enforcement".

   `label.tsx` is the one primitive with no caller outside this directory,
   and that is correct rather than dead: `Label` is the label PART of
   `Field`, so `Field` is its caller and its only one. Everything else here
   is rendered by a feature.

   `menu-radio.tsx` is split from `menu.tsx` for bundle reasons only:
   `menu.tsx` is reachable from the eager sidebar, while the grouping and
   single-choice parts are used only behind an interaction boundary. Treat
   them as one primitive. Feature code must not recreate their focus,
   Escape, outside-press, collision, timer, roving-focus, or announcement
   behavior, and new buttons/inputs/selectable groups use these instead of
   bespoke classes.

   The palette query fields (Quick Open, library search, the link-file
   picker) are the one standing exemption from that last clause, and they
   are a raw `<input>` on purpose. `Input` is the BOX role — its own fill,
   border, container corner, and h-9 step — while a palette field is a seam
   across the top of a panel that is itself the box and the focus
   affordance; the panel's `overflow-hidden` corners clip a ring into a
   stray bar, so the field must also suppress the global focus outline from
   an unlayered rule in `globals.css`. Adopting the primitive there would
   mean neutralising six of its decisions to arrive back at the same markup.
   Each call site carries the reason inline, and the suppression rule names
   all three veils — `.link-file-picker-veil` was missing from it, so the
   picker's field wore a ring its own panel then clipped into a stray bar.

   Three buttons are exempt from `Button` for reasons that hold, and each
   says so where it lives. `ErrorBoundary`'s pair is the recovery path and
   must not depend on the primitive stack that may have just crashed. The
   other two are structural parts of a recipe that already owns them: the
   outline row's chevron and label sit inside the unlayered `.tree-row`
   family, which wins over every utility the recipe would bring, and the
   sidebar's section-header toggle is the full width of its own tinted
   strip, where the `ghost` variant's `aria-expanded:bg-muted` would paint
   a permanent second background on exactly the state that drives it. The
   test is the same one the palette fields pass: if adopting the primitive
   starts by cancelling half its decisions to arrive back at the same
   markup, the element is not a button in its own right. Everything else
   is — including a control with a palette of its own, which passes that
   palette as a className (the lightbox's white-on-dark stage controls) and
   still gets the press, the ring, and the transition from the recipe.

   The Similarity Search setup cards (`EmbeddingAuthChoice`) are the second standing
   exemption, and the reason is worth stating because the surface looks
   like two things it is not. They are not a radio group: each card fires
   on click, there is no pending selection and no submit, and the screen is
   built specifically so nothing reads as already chosen. They are also not
   `Button`s: that primitive is a centred, single-line, `-ui`-cornered ITEM,
   while these are two-line, left-aligned `-container`-cornered BOXES whose
   disabled state deliberately keeps full opacity. Adopting it would mean
   overriding display, height, alignment, wrapping, corner, and the
   disabled treatment. What the primitive does own — `active:scale-97` —
   is duplicated at the call site, the same deliberate copy `ErrorBoundary`
   and the lightbox toolbar make.

   A text button that sits INSIDE a sentence (`Back`, `Not now`, the
   preparation callouts) is `variant="link"` with the size taken
   for its type step alone and the height and padding removed — one shared
   shape, not a per-site recipe. That shape is for ACTIONS in prose; an
   in-sentence navigation to an external page (Settings → MCP's `See setup
   examples`) is a real `<a href>` whose click is intercepted to route
   through `openExternalUrl`, because a control that goes somewhere must
   announce as a link and the renderer must never navigate itself.

   **Known Gap: there is no `radio` primitive.** Base UI ships `radio` and
   `radio-group`, but nothing wraps them, so the transcription model list is
   still native `input[type=radio]` wearing the UA appearance — the one
   remaining control that does not look like the rest of the app. Its
   semantics are sound (a `FieldSet` with a `FieldLegend`, each input
   wrapped by its own `label`), so this is a styling gap, not an
   accessibility one; closing it means adding a `radio` primitive beside
   the others, since a feature may not reach for `@base-ui/react` itself.

   `tabs` and `field` are the two that carry real accessibility weight.
   Base UI's Tabs owns roving focus, arrow-key movement, and the
   `aria-controls`/`aria-labelledby` pairing; the app has three
   independently hand-rolled `role="tablist"` blocks, and two of them — the
   Settings sections and the chat session strip — could not be driven from
   the keyboard at all. Both are on the primitive now. The chat strip shows
   the shape: a tab chip holds its own close button, so its trigger renders
   as a `div` (Base UI's `nativeButton={false}`) rather than nest a button
   in a button, and the panels are `keepMounted` so every session keeps its
   state and its scroll position. Both set `activateOnFocus` explicitly —
   Base UI defaults it off, and without it arrow keys move focus without
   selecting.

   **A `keepMounted` panel that overrides `display` must state its own
   `aria-hidden`.** Base UI hides a kept-mounted panel with the `hidden`
   ATTRIBUTE, whose entire effect is the UA's `display: none` — so a panel
   class that sets `flex` to preserve layout and scroll position also
   cancels the hiding, and every inactive pane stays in the accessibility
   tree answering as though it were on screen. The chat pane hides the
   inactive panes with `invisible pointer-events-none` and says
   `aria-hidden` explicitly for exactly this reason.

   **The document `TabStrip` is the third, and it stays hand-rolled — the
   `menu-radio` exception again, for bundle reasons only.** The two
   consumers above load behind an interaction boundary, so Tabs costs them
   nothing; the document strip mounts with the window, and putting it on
   the primitive pulled Base UI's composite/roving-focus machinery — the
   `Tabs*` and `Composite*` modules plus the `react-dom` and
   `useOpenChangeComplete` chunks they drag behind them — into the initial
   graph, measured at ~22.7 KB, about 5% of the whole eager budget in
   `scripts/check-renderer-chunks.mjs`. It bought nothing: unlike the other
   two, this strip already implemented arrow/Home/End/Enter/Space, roving
   tabindex, and select-on-move. So it keeps that keyboard contract locally
   and spells selection `data-active`, the way `ui/tabs.tsx` does, so the
   stylesheet reads one signal on every tab set. `accessibility-semantics.
   test.ts` mounts it against a real DOM and is what holds the two in step —
   change selection behavior in one and check the other. The strip also
   keeps two departures the primitive has no opinion on either way: its
   panel is rendered by `MainPane` outside the strip, so each tab names that
   ONE panel through an explicit `id`/`aria-controls`; and its look stays in
   `workspace.css`, because the Electron tab-strip layout smoke reads that
   stylesheet raw. Its close and New-tab controls are still `Button`, which
   is free — `Button` is already eager chrome.

   The tree's inline rename and new-folder fields are a second standing
   raw-input exemption alongside the palette queries, for the same reason:
   `Input` is a box, and these are row-height runs of text inside someone
   else's stroke — the rename field shares its border with the extension
   suffix beside it. Each carries the reason inline.
   Field generates the id and wires `label[for]`
   and `aria-describedby` — which is what an `aria-label` cannot do, since
   it names a control for assistive tech while leaving the visible text
   inert, so clicking it does not focus the field.

   `section` (`Section` / `SectionHeading` / `SectionDescription`) exists
   because a heading built out of `<div className="text-base font-semibold">`
   announces nothing: the renderer had one `<h1>` and five `<h2>`s across
   119 components, so a screen reader got a wall of text with no outline to
   skim. `SectionHeading` takes a `level` and renders a real heading.

   `empty-state` (`EmptyState`) is the muted "nothing here" body — a
   loading fallback, a no-matches notice, an empty list. Four recipes said
   it once each, at three type sizes and four paddings, so the same
   sentence changed size and alignment depending on which surface you
   reached it from.

   **An empty state is `text-sm`, one step below body text, and that is a
   decision rather than a default.** `text-base` is 13px — the ambient
   `--ui-font-size` — so it is what any block gets for saying nothing about
   its type at all, which is exactly how the viewer fallbacks arrived at
   it. A placeholder reports that content is MISSING, so it sits a step
   below the body text it stands in for instead of at parity with the
   document it replaces.

   The two layouts are the real split, not a padding preference. `row` is
   one line inside someone else's list — a picker's results, a menu, the
   file tree — so it takes the list's horizontal padding and claims no
   height. `fill` takes the whole host cell and centres on both axes: the
   lazy viewer fallbacks, where there is no list to sit in, only an empty
   pane, and a message pinned to that pane's top-left corner reads as
   content that failed to lay out rather than as a placeholder. A caller
   that needs the class rather than the element — `LazyLoadBoundary` takes
   a className, not a child — uses the exported variant function, the same
   way `PopupLoadingStatus` reaches for `statusVariants`.
6. **Utility classes in JSX** — everything surface-specific. Tailwind is
   utility-only (no preflight): UA margins on `<p>`/`<h*>` are not reset, so
   migrated markup zeroes them explicitly where it matters.

## Composing class names

`cn()` — clsx over tailwind-merge, in the shared renderer utils module — is
the only way class names are combined. Three idioms coexisted before this
rule, and two of them defeat the merge:

| Idiom | What ships | Who decides |
|---|---|---|
| `cn('px-2', on && 'px-4')` | `px-4` | the call site |
| `'px-2 ' + (on ? 'px-4' : '')` | both | stylesheet order |
| `` `${BASE} px-4` `` | both | stylesheet order |

Concatenation and interpolation emit BOTH sides of a conflicting pair, so
which one paints is settled by the order Tailwind happened to generate the
two utilities in — never by the caller that asked for the override. This is
the failure the dialog-width note under "Assigning a width" describes from
the other direction, and it is invisible in review: the markup reads as
though the later class won.

Converting a site therefore CHANGES BEHAVIOUR wherever a conflicting pair
was previously settled by source order, which is the point of the rule and
the reason a conversion is not mechanical. Look for a conflicting pair
before making one. One flipped in the pass that established this rule: the
audio preview's fallback hint asked for `text-destructive` on top of a
shared hint recipe carrying `text-muted-foreground`, and the generated
sheet puts the muted rule last — so the warning had been rendering in the
same grey as the two hints beside it. It is red now.

The rule is about composition, not about backticks. A template literal
INSIDE `cn()` builds ONE dynamic class name and still goes through the
merge — the JSON tree view's per-type token class is the shape — so the
guard exempts an expression that is itself a `cn(...)` call rather than
banning the character. Nothing needed an exemption beyond that.

### A shared class string, or a component?

A class string is the right answer when what repeats is a set of
utilities handed to something that already owns the element: a `className`
on a primitive (the find bar's latch buttons, the search-mode segments),
a `className` on a boundary that takes no child (`LazyLoadBoundary`), or a
recipe two branches of one file must not let drift apart. It is the wrong
answer when what repeats is MARKUP — an element with its own ARIA, its own
handlers, and children in a fixed arrangement — because a class string can
carry the padding and none of the rest.

Two families failed that test and are components now, both file-private or
near it:

- The picker result row. Quick Open (files and commands), Link to file,
  and Editor History each hand-spelled the same `<li>` around three shared
  class strings, and the markup is the part that has to agree:
  `role="option"` with `aria-selected`, an `id` the listbox points
  `aria-activedescendant` at, hover-to-activate, and a mousedown that must
  `preventDefault()` so the query field never loses focus to the row being
  picked. `PickerRow` / `PickerEmptyRow` own all of it; what stays in the
  picker chrome module are the LAYERS around it — veil, panel, group
  label, scroller — each handed to a differently shaped element per picker.
- The agent runtime gate's card. Four gates (pre-discovery, preparing,
  failed, not installed) are the same card with different copy and a
  different action row, described by five `runtimeCard*` strings that
  shared nothing but a prefix and five places to edit.

The composer's send button and the lightbox's stage controls went the same
way for a smaller reason: each had a shape stated once and its skins stated
apart from it, and the stage controls also repeated `variant`/`size` at
every call site — three decisions a class string can only carry one of.

What is left is 24 class constants, down from 65. Every one carries a
comment saying why a component would be the wrong shape for it; a constant
that cannot say so is a component waiting to be written.

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
  not enter into it.

  The step is 16, not 20, and the four points matter. At 20 a 36px-tall box
  — every `Input`, every short card — clamps to half its height and comes
  out a capsule, which contradicts the rule in `visual-style.md` that
  capsules are RESERVED for semantics that need them (identity, status, a
  terminal action). Every short box was quietly spending the one shape the
  language had set aside. At 16 it keeps its corner and stays a box, so the
  capsule means something again wherever it does appear.
  **Build Wiki** is one such terminal capability action: its `rounded-full`
  capsule marks the fixed folder activation path, directly below the empty
  composer, rather than styling an ordinary button as a pill. The capsule is
  all it adds — it is otherwise the default solid-accent `Button`, the same
  primary the zero-folder sidebar and the empty main pane put under their own
  invitations, because a hero's one action should not be a second dialect of
  primary. A tinted outline is not that dialect: a pale fill under a pale
  stroke under pale text is three washes of one hue, and it reads as a status
  badge rather than as the thing to press. The cancellable waiting state
  retains the capsule's identity, and its progress arc sits on the caption
  below rather than inside the fill the accent arc would vanish against.
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

## Assigning a width

Same shape of question again: not "how many pixels" but "what kind of
surface is this, and what is it bounded BY".

- **A floating surface** — bounded by the window: `w-overlay-*` /
  `max-w-overlay-*`, six steps that are three purposes in two weights each.
  An **anchored strip** is `-xs` (a tooltip, which wraps one sentence) or
  `-sm` (a toast, which holds title + body + action, so it is deliberately
  the wider of the pair). A **dialog column** is `-md` (default, and the
  menu and narrow picker that sit at the same measure) or `-lg` (wide). A
  **document-width panel** is `-xl` (wide picker, crash report) or `-2xl`
  (Settings).

  Every step already carries `--overlay-fit` = `calc(100vw - 32px)`, so a
  call site never spells the clamp and cannot spell a different one. That
  is the whole of the rule a floating surface owes the window: 16px of
  margin a side. The 90vw/92vw/94vw it replaces were the same intent
  rounded three ways.

  A dialog sets `w-` only. `DialogContent` and `AlertDialogContent` no
  longer ship a width or a gap of their own: the shadcn recipes' responsive
  384px cap was wrong for every caller in this app, and because
  tailwind-merge cannot resolve a bare class against a responsive one, each
  caller had to beat it with an important-flagged `max-w`. A primitive
  default would fail the same way in reverse — `max-w-overlay-*` is a custom
  container step tailwind-merge does not recognise, so a default and an
  override would both survive and stylesheet order would pick the winner.
  The primitive keeps only `max-w-overlay-fit`, the shared viewport clamp.

  A dialog that names no width shrink-wraps its content; that is the signal
  it forgot to choose. Removing the cap also let `SessionHistoryMenu`'s
  confirm dialog finally render at the 420 its class had always asked for.
- **A content column inside a pane** — bounded by its PARENT: `w-measure-*`,
  four steps clamped to `100%`. The agent transcript and its composer share
  `-md`; a notice card is `-sm`; a media stage is `-lg`; `-xs` is an inline
  control such as the audio scrubber. This is a separate scale because it
  answers a different question — a column narrows when the agent panel is
  dragged narrow, not when the window is, and folding it into the overlay
  ramp would tie the transcript's measure to the Settings dialog's width.
- **A surface that scrolls** — `max-h-overlay-*`. The px step is what the
  surface wants (`-xs` a status block nested inside a modal, `-sm` a short
  menu or log excerpt, `-md` a full menu or a picker's result list, `-lg` a
  long list); `70vh` is the one answer to "and never more than this much of
  a short window", replacing 32/48/55/60/70vh and two `calc()` spellings
  doing that job at slightly different strengths. `-window` and `-stage`
  are the two surfaces that take the window rather than a step — the crash
  panel keeps the width scale's 16px-a-side margin, and the lightbox stage
  additionally reserves the band its floating zoom toolbar sits in.

Arguments inside these `min()`s stay in px-then-viewport order at every
step. Half the call sites they replace wrote the pair the other way round,
which is the clearest single piece of evidence that each was typed fresh
rather than chosen off a scale.

## Semantic markup

Utilities decide how a surface looks; the element decides what it IS, and
the second question is the one a screen reader, a keyboard, and the browser's
own behaviour all answer from. The renderer had drifted a long way from it —
one `<h1>` and five `<h2>`s across 119 components, 100 `aria-label`s against
14 real `<label>`s — so these are rules, not preferences.

Where that has reached: 32 real headings (31 `SectionHeading` call sites plus
the crash screen's own `<h1>`), 13 `htmlFor`/`id` pairs, 99 `aria-label`s, and
four `<form>`s where there had been none. The `aria-label` figure is the one
worth reading carefully, because it did not fall and was never going to: the
overwhelming majority name icon-only controls, landmark regions, and
`Progress` roots, which is exactly what the attribute is for. What changed is
the small remainder that named something already carrying visible text —
those are labels, legends, and `aria-labelledby` now — plus three key fields
that carried no accessible name at all and gained one.

- **A heading is a heading.** `SectionHeading` with an explicit `level`, never
  a `<div>` wearing `font-semibold`. Levels nest: a panel's own title outranks
  the groups inside it. `level` runs the full 1–6 because the depth is real
  rather than hypothetical — Base UI's dialog title is an `h2`, so a Settings
  panel is 3, a block inside it 4, and that block's own sub-heading 5, which
  MCP access → Server connection → Advanced reaches exactly. A union that
  stopped at 4 would not have made the tree shallower, only made its last two
  steps lie about their depth.

  A heading LABELS a section; bold text does not become one by being bold.
  Text emphasised mid-sentence stays a `<span>`, a card's numeric read-out
  stays a value, and a title that sits inside a `<button>` or a `role="menu"`
  popup stays what it is — neither element may contain a heading, so the
  scope menu's title is named through `aria-labelledby` and the Similarity Search
  setup cards keep theirs as card text. The sidebar's Document Outline strip
  is the opposite case: it always WAS a disclosure heading, so the heading
  element now wraps its toggle, carrying the level and none of the look.
- **A repeated row is a list item.** Runtimes, transcription models,
  transcript segments, and outline entries are `<ul>`/`<li>`, so they announce
  a count and item boundaries instead of one undifferentiated run of text.
  So are the agent transcript's own three: the steps inside an expanded tool
  activity group, the artifact cards a group leaves behind, and the chat
  session rows in the history popover. The notices that share the popover's
  scroller — loading, no matches, partial runtime failure — stay OUTSIDE the
  list, so its count is the number of sessions rather than the number of
  things drawn.
  An ARIA pattern that supersedes the list (`role="tree"`, `role="listbox"`)
  is the exception, not a licence for anonymous `<div>`s. Library search is
  that exception end to end: its rows are `role="option"` under one listbox,
  so the folder bands grouping them stay plain `<div>`s — a heading inside a
  listbox is not a valid child of one.
- **A single-choice group is a `fieldset` with a `legend`.** The legend is the
  visible label AND the accessible name, which is why the control inside it
  does not repeat the string as an `aria-label` — one label doing both jobs
  cannot drift out of step with the text beside it.
- **A labelled control is a `Field`.** `aria-label` names a control for
  assistive tech and leaves the visible text inert, so clicking it does not
  focus the field. Use it only where there is no visible label at all.
  A `<label>` WRAPPING its control does associate — the browser binds the
  first labelable descendant at any depth — but it binds silently and
  invisibly, so the settings panels' wrapping labels now pass an explicit
  `htmlFor`/`id` pair instead. The two spellings differ the moment the
  control moves, gains a sibling control, or is swapped for a component
  that renders no labelable element at all. The JSON tree's search field and
  its key/value editor were the last three, and they take generated ids
  rather than literals: every open JSON tab keeps its tree mounted, so a
  literal id would repeat across tabs and each `htmlFor` would bind to
  whichever copy the document reached first.

  A label and an `aria-label` on the same control is not belt-and-braces, it
  is two names of which only the invisible one is exposed — and the invisible
  one is then free to drift away from the words printed beside it. The
  foundation suite fails that pairing outright. The General panel's two
  capture checkboxes are why the rule is worth stating: their label wrapped
  BOTH the title line and the explanatory sentence, so the control announced
  a paragraph. Split, the label names it and the description reaches it
  through `aria-describedby`.

- **A text field with a confirm action beside it belongs in a `form`.** Enter
  then submits through the browser's own implicit-submission rule instead of
  through a hand-rolled keydown branch that has to re-decide `preventDefault`
  and IME composition per call site — the API-key dialogs each carried their
  own copy, and one of the two also carried the composition guard the other
  had forgotten. Two conversions require care and both are spelled out where
  they live. A raw `<button>` inside a form defaults to `type="submit"`, so
  every raw button in the renderer now states its type and a test holds that;
  and Base UI's `useButton` writes `type="button"` onto every `Button`, so a
  confirm action inside a form must say `type="submit"` explicitly or the
  form has no submit control at all.
- **`aria-label` needs a role to land on.** On a bare `<div>` or `<span>` it is
  not exposed at all. Give the element the role its content actually has —
  the message-action row is a named `role="group"`. The scan behind this rule
  reads JSX, so it cannot see a node built imperatively: the composer's
  @-mention chip is a `<span>` assembled in a CodeMirror widget's `toDOM`,
  and it carried a label nothing announced. It says its path in the text
  layer now, the same way the transcript's copy of that chip does.

  An icon cannot take one either, and this one is silent in both directions.
  Every glyph in the icon module accepts `className` and nothing else, and
  stamps `aria-hidden="true"` itself — so an `aria-label` passed to one is
  dropped, and TypeScript does not object, because it skips excess-property
  checks on any JSX attribute name that is not a valid identifier. Hyphenated
  ARIA attributes are all of them. The sidebar's favourite star had announced
  nothing on that basis; the label lives on a `role="img"` wrapper now, which
  is the shape the menu's needs-attention dot already used.
- **A visible title is the accessible name.** Where a surface already shows
  its own name, it points at that text with `aria-labelledby` instead of
  repeating the string as an `aria-label`: the Editor History picker and the
  JSON tree's edit panel each had two copies of one name, free to drift
  apart. This is the `fieldset`/`legend` rule one level up.
- **A container role owns only its own children.** `role="tablist"` holds
  tabs; the New-tab control sits outside it (which also stopped it scrolling
  away with the tab list, since it had been a child of the scroller).
- **State that is conveyed visually is conveyed programmatically.** The
  download bar reports a number through `Progress`, rather than being a
  coloured rectangle only sighted users can read. The two hosted-allowance
  bars — Settings → Similarity Search and the sidebar account menu — were the same
  shape of silence (a nested `div` with an inline `width`, no role and no
  value) sitting beside the finished primitive, and now run on it too. A
  bar that needs the full width of its container overrides the track's
  inline step rather than growing a second recipe.

## Assigning motion

Same question as the corner: not "how long should this take" but "what kind
of feedback is this".

- **A control answering a pointer** — `transition-control`. Tint, stroke,
  and the press scale together, at `--motion-fast` on the entering curve.
  This is the Button primitive's own recipe.
- **Colour alone** — `transition-tint`. Hover, selection, focus ring.
  Nothing travels, so the symmetric hover curve is right and a dramatic one
  reads as lag on a control the pointer is already resting on.
- **A transient surface arriving or leaving** — `transition-surface`, plus
  `origin-anchor` when the surface is anchored to a trigger. Menus,
  tooltips, and popovers grow out of the control that opened them; a modal
  deliberately does not, because it is anchored to nothing and belongs in
  the middle of the viewport.

  **One entrance, everywhere: fade in from 96%.** Menu, popover, tooltip
  and toast all enter that way, and the modals' `zoom-in-95` is the same
  gesture under the shadcn recipe's own spelling. The origin is the only
  variable — the anchor for a surface with a trigger, the centre for one
  without. A tooltip adds a 4px nudge from the side it landed on and keeps
  it: it is the only anchored surface with no visual attachment to its
  trigger (8px away, no arrow, any of four sides), so the direction it
  travels is the one cue naming the control it belongs to. A menu or
  popover sits 6px off its control with an edge aligned to it, and its
  anchored scale already says where it came from.

  **The exit is one role step quicker than the entrance.** Menu, popover
  and tooltip enter at `--motion-fast` and leave at `--motion-instant`;
  the toast enters at `--motion-standard` and leaves at `--motion-fast`.
  An arrival is information and may take the time to be read; a dismissal
  is an instruction the user has already given, and a surface that takes
  as long to go as it took to come reads as arguing with them. Spell the
  asymmetry as a `data-[ending-style]:duration-*` role token on the
  surface, never as a second literal duration.
- **Something already on screen moving** — name the property and reach for
  `ease-in-out`. The app-shell grid's column transition is the one case.

Three rules hold across all of them:

- **Nothing enters from `scale(0)`.** Popups start at 96%. Nothing in the
  world appears from nothing, and an element that does reads as a glitch
  rather than as an arrival.
- **`ease-in` is never correct here.** It starts slow, delaying exactly the
  first frame the user is watching, so it reads as lag at any duration.
  `ease-in-out` is a different curve and stays legal for on-screen movement.
- **Every pressable surface answers the press.** `active:scale-97` lives in
  the Button recipe, and `ErrorBoundary` is the one surface that duplicates
  it rather than importing it — its recovery path must not depend on the
  primitive stack that may have just crashed. The lightbox toolbar used to
  be the second; it is now the primitive under a theme-static palette
  passed as a className, which is the pattern for any surface whose colours
  must not follow the theme: override the palette at the call site, never
  grow a variant for it.

Durations stay under 300ms app-wide. This is a workbench: a surface someone
opens fifty times a day must never feel like it is catching up with them.

## Icons

`web-src/src/common/components/icons.tsx` is generated — run `node scripts/gen-icons.mjs` and
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

### Assigning an icon size

Same shape of question as the corner and the motion role: not "how big
should this glyph be" but "what is it sitting in". **Three steps —
12 / 14 / 16 (`size-3` / `size-3.5` / `size-4`)** — and hierarchy comes
from colour, weight and text, never from glyph size. Anything between them
is a value nobody could have chosen off a scale — roughly seventy glyphs
sat on the three steps with no rule written down, and the one that sat
between them (`size-[15px]`) was the only one wrong on its face.

The mapping lives in `ui/button.tsx` and nowhere else, because a button is
where a glyph most often sits. The base recipe sets
`[&_svg:not([class*='size-'])]:size-4` and two size variants step down from
it: `xs` and `icon-xs` (the 24px control) to `size-3`, and `sm` (the 28px
TEXT button, whose glyph rides its `text-sm` step) to `size-3.5`. The
`:not([class*='size-'])` guard is the important half — it means a call site
that genuinely needs a different step just says so, and the recipe stands
aside instead of fighting it.

- **A glyph that IS the content of a 28px-or-larger box** — 16. Icon-only
  buttons from `icon-sm` up, a menu item's leading icon slot and its check,
  a file-type tile, the lightbox's 40px stage controls. `icon-sm` keeps 16
  where the `sm` text button takes 14 for exactly this reason: one is a
  glyph with room around it, the other is a glyph next to a line of text.
- **A disclosure chevron** — 12, wherever it sits. It is a direction, not
  an object, and at 14 it competes with the label it points at.
- **A control deliberately held under 24px** — 12, or smaller when the box
  is (the composer's 16px chip × is 10). Below the button ramp the box is
  the constraint and the step comes off it.
- **Everything else** — 14. This is the standing chrome glyph: sidebar
  rows, the titlebar controls, the find bar, the tab strip, agent-panel
  rows. It is also the one deliberate departure from the primitive's
  `icon-xs` default, taken at eight call sites so that every glyph in that
  chrome reads at one size regardless of which control holds it. **Known
  Gap:** the primitive says 12 for `icon-xs` and practice says 14; the
  eight overrides are the honest record of that, not drift, but the
  divergence should be closed in the recipe rather than repeated a ninth
  time.

A call site sets an icon size only to depart from the recipe, and says why
inline. Setting the size the recipe would already have given is noise that
reads as a decision.

## Enforcement

`web-src/src/common/__tests__/renderer-foundation.test.ts` locks the mapping, the
type and corner scales, and the squircle rule; bans `text-[calc(` and
`bg-[var(--hover)]` in components; and scans every colocated CSS file
under `web-src/src` (a directory walk, not a hardcoded file list, so it
survives a file moving to a new feature folder) for a literal
`border-radius: <n>px` other than the one sanctioned 999px capsule — a
literal radius is the same violation as a literal colour.

Every path these walks produce is repo-relative and POSIX-separated on
every platform, and every path constant in that file is spelled the same
way. The exemption tables below are keyed by path, and a key is written
the way the repo spells it; joining with `path.join` instead made a
Windows runner miss every lookup, reporting one file both as carrying an
unexempted value and as a stale exemption in the same run while the rule
it was meant to enforce went unchecked. A guard that only holds on the
maintainer's platform is not a guard.

Three more tests cover the ramps added since, and they exist because all
three share a failure mode: each is cheap to bypass one component at a time
(`z-[10001]`, `transition: .12s`, `px-2.25`), every bypass looks locally
reasonable, and the damage is only visible in aggregate.

- *the layer ramp is the only source of stacking order* — every role is
  defined, the values are strictly increasing in the documented order, each
  has its `@utility`, no component writes `z-[…]`, and a bare `z-<n>` may not
  exceed 3. Ordinals 1–3 stay legal: ordering two or three children inside
  one component's own stacking context is local bookkeeping, not app-wide
  layering. The scan walks `*.ts` as well as `*.tsx`, for the reason the
  spacing scan does: shared class recipes live in plain modules, and a
  components-only walk let `z-1200` sit in the picker veil recipe and ship —
  putting every picker above the modal, tooltip, and toast roles at once.
- *motion comes off the role scale, never a literal* — the four durations
  and three curves exist, `--ease-out`/`--ease-in-out` still override
  Tailwind's built-ins (losing those two lines silently returns the whole
  app to the stock curves, which is invisible in review and obvious in
  use), the three `transition-*` roles exist, no CSS hardcodes a transition
  duration, and no component uses `transition-all`, bare `ease-in`, or a
  `transition-*` with neither a role nor a token duration.
- *spacing stays on the derived ramp* — `--spacing` still follows
  `--ui-scale`, and no component carries a quarter-step or a half-step above 4,
  or an arbitrary `size-[Npx]`. The bracketed spelling is the same violation
  and it also steps off the icon ramp: the lightbox's stage glyphs were
  `size-[15px]` beside a `size-4` sibling inside the same 40px control.
- *overlay geometry comes off the two size scales* — every width, measure,
  and height step is defined, each scale is strictly increasing, every width
  and measure step has its `--container-*` bridge and every height step its
  `@utility`, and no component writes `w-[min(` (which catches
  `max-w-[min(` and `min-w-[min(` too) or `max-h-[min(`. This scan walks
  `*.ts` as well as `*.tsx` for the reason the layer and spacing scans do:
  `common/lib/pickerChrome.ts` alone carried four of these literals, and one
  shared class recipe reaches more surfaces than any single component.

  Two spellings still slip past it, and both were still in the tree: a bare
  `max-h-<n>` off the spacing ramp (`PICKER_RESULTS_CLASS`'s `max-h-95`) and
  a hand-written `max-w-[calc(100vw-Npx)]` that is simply a different margin
  from `--overlay-fit`'s 16px (`ScopeMenu`'s `w-85` under its own
  `calc(100vw-24px)`). Both are roles now. A scrolling surface names a
  `max-h-overlay-*` step, and a scroller nested inside a capped panel takes
  the step BELOW its panel's — at the same step its last rows fall under the
  panel's `overflow-hidden` edge, where nothing can scroll them back.

Two more cover the same two ramps in the OTHER half of the renderer. Every
scan above reads `*.tsx`/`*.ts` — Tailwind class strings — and the
colocated `*.css` files had never been scanned for either ramp, which is
where the app writes its longest-lived surfaces: the tree row, the tab
strip, the shell band, the transcript.

- *spacing in colocated CSS stays on the derived ramp* — no `*.css` file
  under `web-src/src` may carry a px length off the ramp (1px hairlines,
  2px half-steps to 16, whole 4px steps above it). Declarations whose px
  is not a spacing decision are out of scope by property name: anything
  `shadow`, where an offset and a blur are optical values calibrated
  against each other rather than steps of air, and the type scale
  (`--text-*`, `--ui-font-size`, `--reading-font-size`, `font-size`,
  `font`), which is deliberately not 4px-derived. The allowlist is a
  table in the test with the same shape and bar as the raw-control one,
  except that it pins the VALUES rather than a count: an exempt
  stylesheet cannot grow a second unreasoned literal, a value that moved
  fails as a mismatch, and an entry with no argument written out fails on
  its own length. One entry: the sidebar splitter's `margin-left: -3px`,
  which is `-width/2` — the offset that straddles its 6px grab area
  evenly across the boundary `left` puts it on, not an amount of air.
  Snapping is a judgement per surface, not a substitution: 9 is neither 8
  nor 10, and nothing we run would catch a bad mass rewrite.
- *font size in colocated CSS comes off the type scale, never a literal* —
  no `font-size` or `font` shorthand in any `*.css` under `web-src/src` may
  carry a px literal, in the `calc(Npx * var(--ui-scale))` spelling or
  bare. Both are the scale copied by hand rather than a shortcut around
  it, which is why nothing could rename a step or add one; the bare form
  additionally ignores the interface-size preference. `em`, `%`,
  `inherit` and `var(--reading-font-size)` stay legal — content
  typography is a separate scale, and prose headings sized in `em` are
  relative to whichever role their container took.

Both report every offending file in one run rather than throwing at the
alphabetically first, because a ban that names one file at a time turns
one cleanup into one run per stylesheet. Neither scans
`electron/bug-report-review.css`: the review window is a main-process
surface that never loads the renderer token layer.

Two guards hold the primitive layer, one from each side, and they exist
because the layer is only worth its cost while both halves are true.

- *no feature hand-rolls a form control the primitive layer owns* — no raw
  `<button>`, `<input>`, `<select>` or `<textarea>` under `web-src/src`
  outside `common/components/ui/`. The allowlist is a table in the test,
  and it pins a COUNT and a REASON per file rather than a path: an
  exemption covers the elements it was reasoned about, so an exempt file
  cannot grow a second unreasoned control, an entry whose call site has
  since been converted fails as stale, and an entry with no argument
  written out fails on its own length. The eleven entries are the
  ErrorBoundary pair plus its lazy-boundary sibling, the three palette
  query fields, the two tree-row inline editors, the composer's hidden
  file picker, the two Similarity Search setup cards, the transcription radios, the
  two outline row controls, and the sidebar section-header toggle — every
  one of them reasoned above and repeated inline where it lives.
- *`cn()` is the only way class names are composed* — no `className={…}`
  under `web-src/src` may concatenate with `+` or interpolate a template
  literal, unless the whole expression is itself a `cn(...)` call. It reads
  the balanced `{…}` after each `className=`, which a regex cannot: these
  expressions nest braces and run across lines, and four of the sites this
  rule retired were multi-line and invisible to the greps that found the
  rest. There is no allowlist, because nothing needed one.
- *every primitive has a caller* — every `*.tsx` in `common/components/ui/`
  is imported from at least one file outside that directory. A primitive
  nobody renders is invisible to every other guard here: nothing asserts
  its tokens, nothing catches it drifting, and it costs entry-chunk bytes
  regardless. `label.tsx` is the one exception and it ratchets both ways —
  it must have a caller INSIDE the layer (`Field`) and none outside, so the
  moment a feature imports `Label` directly the exception has to go.

A fifth guard covers the same silence from the other side: *every
`var(--token)` a component names actually resolves* collects every custom
property declared by a stylesheet under `web-src/src` or set from the
component layer itself (a style-object key, `setProperty`, a
`[--x:<value>]` utility — locally scoped properties such as
`--composer-min-h` and the dragged `--sidebar-width` are declarations too),
and asserts every `var()` in a `*.tsx` or `*.ts` file lands on one. An
unresolved `var()` drops its declaration rather than failing, so nothing
else would have reported it; see the `@theme` namespace trap above.

Two more arrived with the forms, and both read JSX open tags with the brace
and quote depth in hand rather than with `[^>]*` — attribute text is full of
arrow functions and comparisons, so the first `>` is almost never the end of
the tag.

- *a raw button spells the type it wants* — every `<button>` outside
  `common/components/ui/` carries an explicit `type`. A missing one means
  submit, which was inert while the renderer had no `<form>` and stopped
  being inert the moment it had four: a stray untyped button inside one now
  submits it, and the symptom is "the dialog closed by itself". The
  primitive layer is exempt because it does not have the bug to have — Base
  UI writes `type="button"` for every `Button` that does not ask otherwise,
  which is the same fact that forces a confirm action inside a form to spell
  `type="submit"`.
- *a control with a visible label does not also carry an `aria-label`* —
  no element named by a `FieldLabel htmlFor` in the same file may also carry
  one, because `aria-label` replaces the accessible name rather than adding
  to it and the visible words then go inert. It is deliberately scoped to
  that pairing rather than to "has visible text and an `aria-label`": the
  broader shape has legitimate members — the outline row prefixes its
  heading level, the update banner names the version — and a guard that
  fires on those would teach people to delete real information.

Extend them when the contract grows; never weaken one to land a change.

The external ShadScan audit is a complementary regression signal for the
shadcn/Base UI layer, not a substitute for these repository-owned invariants or
browser evidence. CI pins the Action revision and CLI `0.17.0`, uploads the
machine-readable report, and enforces the reviewed `45` floor. The baseline is
intentionally not treated as a product-quality percentage: Electron/Vite
implementations such as theme management, the Error Boundary, Toasts, and the
command surface are observable in renderer and Playwright evidence even when
that static ruleset does not recognize their custom wiring. Raise the floor
only after reviewing a complete report; never add product behavior solely to
silence an inapplicable rule.

## CSS exemptions — rules Tailwind utilities can't own

These categories are still exempt from the utility-only rule; what changed
is where the exemption lives. Each one is colocated with the component(s)
that render its classes and imported directly from there — see "Colocated
feature CSS" above — rather than bundled into a shared `styles/*.css` file.
Two categories are still centralized because they are genuinely
cross-feature, not because migrating them was skipped:

- **App shell composition** (`app/app-shell.css`, imported from `app/App.tsx`):
  `.app` grid and splitters, the macOS drag regions (the `.sidebar-drag-zone`
  traffic-light clearance band and the `.tab-strip` empty-background drag
  with its `no-drag` opt-outs — there is no titlebar strip), `body.is-electron`
  variants. Cross-feature because it expresses how the workspace tab strip
  and the agent panel's chat-tab-row relate to one top-level layout.
- **Universal reset** (`styles/globals.css`, imported centrally from
  `styles.css`): box-sizing, squircle corners, focus-visible, and the
  reduced-motion policy block — every surface depends on these, not any one
  feature.
- **Tab strip** (`features/workspace/workspace.css`):
  `electron/tab-strip-layout-smoke.cjs` reads this file raw (by path, bypassing
  Vite) and asserts layout from it — update that script's file list before
  moving this CSS again.
- **Rendered-content typography**: Crepe variable bridge (`.crepe-shell`,
  `features/documents/documents.css`), `.agent-prose`
  (`features/agent-panel/agent-panel.css`), and the JSON value/type classes
  that carry the `--syntax-*` roles
  (`features/documents/components/json/json-tree.css`). Those roles come from
  the global token layer in both themes; they never embed a fixed palette in
  the component. One syntax palette serves every code surface — JSON source,
  JSON tree, and the code viewer — with roles named for what a token means
  rather than for a language, so the same kind of token is the same colour
  wherever it appears. Each role clears AA against the surface code actually
  paints on (`--pane`), which is stricter than measuring against the base
  white; the json-document test asserts that floor for all roles in both
  themes. Content follows `--reading-font-size` or the reading step of
  the ramp, not whatever the chrome around it is wearing. It does not get its
  own text face: chrome and content share the system UI sans, while code/data
  surfaces switch to bundled Geist Mono through `--font-mono`.

  Colour is the one place content does diverge: long-form reading text takes
  `--text-reading`, not the chrome's `--fg`. The two are the same value in
  light and diverge in dark, where primary on the canvas is over 15:1 and
  halates at paragraph length. A surface that renders a paragraph someone
  settles in to read takes the reading role; a label, a row, a button keeps
  primary. The agent panel's thinking block is NOT in this category
  any more — it is a meta disclosure row and a quote-barred body, both plain
  utilities at the call site.
- **State-machine and imperative-DOM hooks**: the `.tree-row` family with
  drag-drop and `format-*` signature colors (`common/styles/tree.css` — the
  one primitive genuinely shared across features, imported from every tree
  renderer: `FileTree.tsx`, `Sidebar.tsx`, `DocumentOutline.tsx`,
  `JsonTreeView.tsx`), the two `.agent-turn*` rules a utility cannot spell
  (the bubble's measure and its `:has(.agent-turn-edit)` expansion,
  `agent-panel.css` — the bubble's own box is `turnHeadClass` in
  `agent-panel/lib/panelStyles.ts`, and the below-bubble action row is
  `group/turn`), CodeMirror-created DOM (`.agent-input`, the mention popup
  surface, `agent-panel.css`), `input.flash-focus`,
  `.pdf-page-highlight` + keyframes (`documents.css`), spinner keyframes
  referenced by the reduced-motion block.
- **Style-free marker classes** kept as querySelector/behavior hooks only
  (e.g. `.agent-view`, `quick-open-veil`) — do not re-grow
  styling onto them.

Small single-component exemptions (`.drop-veil` in
`common/components/drop-veil.css` and the workspace-only preparation-status
icons in `workspace.css`) each live beside their one component now — no
separate "pending migration" list. A component that renders nothing this
file's classes touch should not import any of these; deleting a component
deletes its CSS import in the same change.

## Implementation Map

| Role | Stable entry points |
|---|---|
| Token + reset Interface | `web-src/src/styles/globals.css` |
| Utility Adapter | Tailwind mapping in `web-src/src/styles.css` |
| App shell composition | `web-src/src/app/app-shell.css` (imported from `app/App.tsx`) |
| Shared tree primitive | `web-src/src/common/styles/tree.css` (imported from every tree renderer) |
| Colocated feature CSS | `features/*/[feature].css` and `common/components/*.css`, each imported from its owning component(s) |
| Primitive Interface | `web-src/src/common/components/ui/` |
| Class-name composition | `cn()` in `web-src/src/common/lib/utils.ts` |
| Shared picker row | `web-src/src/common/components/PickerRow.tsx` (with the layer classes in `web-src/src/common/lib/pickerChrome.ts`) |
| Layer + motion ramps | `--layer-*` / `--motion-*` in `globals.css`; `@utility z-*`, `transition-*`, `origin-anchor` in `styles.css` |
| Overlay + measure geometry | `--overlay-w-*` / `--overlay-h-*` / `--measure-*` in `globals.css`; `--container-overlay-*` / `--container-measure-*` and `@utility max-h-overlay-*` / `max-w-overlay-fit` in `styles.css` |
| Pane chrome offsets | `--chrome-top` / `--chrome-banner-h` / `--chrome-top-banner` in `globals.css`; `@utility top-chrome` / `top-chrome-banner` in `styles.css` |
| Generated icon Adapter | source map in `scripts/gen-icons.mjs` → `web-src/src/common/components/icons.tsx` |
| Focused evidence | `web-src/src/common/__tests__/renderer-foundation.test.ts`, `scripts/renderer-quality-gates.test.mjs`, `electron/tab-strip-layout-smoke.cjs`, and `e2e/visual/` |

## Review checklist for styling changes

- No new hex/rgb literals, radii, font sizes, or durations outside the token
  layer; no `text-[calc(...)]`; surface tints use the accent/status ramps.
- Stacking names a layer role (`z-menu`, `z-toast`), never a number; spacing
  lands on the ramp; a transition names one of the three motion roles or
  carries a token duration.
- An overlay names a width and, when it scrolls, a height role
  (`w-overlay-md`, `max-h-overlay-md`); a content column inside a pane names
  a `w-measure-*` step; neither hand-writes its own viewport clamp.
- A floating surface is `bg-popover`. `bg-background`, `bg-card` and
  `bg-pane` under a `shadow-elevation` are defects — they agree in light mode
  and split apart in dark. This catches a Button variant as readily as a
  panel: the toast's Clear-all control is the `outline` recipe (which is
  `bg-background`, correctly, for the fifty-odd buttons that sit ON a
  surface) floating above the app, so it overrides the fill at the call
  site in both themes rather than moving the shared recipe. The lightbox
  stage is the one standing exception and says so in place.
- Floating pane chrome names `top-chrome` or `top-chrome-banner`, never a px
  offset: a literal cannot follow the tab strip and banner as they scale.
- A new button, field, or selectable group is a `common/components/ui/`
  primitive, not markup. A raw control needs an allowlist entry saying which
  of the primitive's decisions adopting it would start by cancelling; a new
  primitive needs a caller in the same change.
- An icon takes 12, 14, or 16 off the step its control sits on, and the
  call site sets a size only to depart from the recipe — with the reason
  inline.
- A "nothing here" body is `EmptyState` — `row` inside a list, `fill` for
  an empty pane — at the primitive's `text-sm`, not a fresh muted `<div>`
  that lands on the ambient size by saying nothing.
- Class names are composed with `cn()` and nothing else. A conversion away
  from `+` or a template literal is a behaviour change wherever the base
  and the addition conflict — check the pair, and say which one now wins.
- A repeated set of utilities is a class string only while the ELEMENT and
  its ARIA are not what repeats; once they are, it is a component. A new
  class constant says in a comment why it is not one.
- No important-flagged utility. If one seems necessary, the primitive's
  default is wrong for its callers — fix the default instead.
- Anything pressable answers the press; anything entering uses `ease-out`;
  anything anchored to a trigger carries `origin-anchor`.
- A heading is a heading (`SectionHeading`), and a labelled control is a
  `Field` rather than a bare `aria-label`.
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
