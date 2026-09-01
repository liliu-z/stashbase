/**
 * Design-token discipline for the renderer's foundation.
 *
 * WHY THIS FILE READS SOURCE TEXT, AND WHY THAT IS ONLY EVER STYLESHEETS
 * --------------------------------------------------------------------
 * A stylesheet has no rendered output to assert against. `--radius-lg:
 * var(--radius-container)` is not observable from any component: nothing
 * mounts it, jsdom/happy-dom resolve `var()` only for declarations they
 * were handed, and the rule these tests protect is about which ROLE a token
 * forwards, not about any pixel that lands on screen. The text of the
 * stylesheet is the artefact. Reading it is the assertion.
 *
 * A component is the opposite. `aria-label`, `role`, a class recipe, the
 * Base UI primitive a surface delegates to, whether a lazy container really
 * loads its managed body — every one of those is observable by mounting the
 * component, and every one of them is invisible to a regex the moment the
 * component moves file, gets split in two, or spells the same output a
 * different way. Component invariants therefore live in tests that RENDER:
 * see `shared-overlays.test.ts`,
 * `@/features/workspace/__tests__/accessibility-semantics.test.ts`,
 * `@/app/__tests__/app-shell-semantics.test.ts`, and the per-feature
 * `__tests__` folders. Do not move a component assertion back into this
 * file, and do not "clean up" the stylesheet reads that remain — they are
 * the only form those assertions can take.
 *
 * The two `walkCss` / `walkSources` scans below are the one deliberate
 * exception on the source-text side: they are repo-wide bans on specific
 * literals (a legacy accent blue, an arbitrary-value escape, a hand-stamped
 * platform class) that must hold in EVERY file, including inside injected
 * `<style>` strings that no render can reach. They walk the tree rather
 * than naming paths, so a file moving between feature folders neither
 * breaks them nor silently drops out of their coverage.
 *
 * `electron/preload.cjs` is read for the same reason as a stylesheet: it is
 * a main-process file with no renderer to mount.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../../../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('renderer foundation keeps Tailwind utility-only and maps semantic tokens', () => {
  const styles = read('web-src/src/styles.css');
  assert.match(styles, /tailwindcss\/theme\.css/);
  assert.match(styles, /tailwindcss\/utilities\.css/);
  assert.doesNotMatch(styles, /tailwindcss\/preflight\.css/);
  for (const token of [
    'background', 'foreground', 'pane', 'card', 'border', 'accent', 'focus', 'danger',
    'status-info', 'status-success', 'status-warning', 'status-danger',
    'scrim', 'veil', 'veil-quiet', 'stroke-strong',
  ]) {
    assert.match(styles, new RegExp(`--color-${token}:`));
  }
  assert.match(styles, /--spacing-density:/);
  assert.match(styles, /--radius-control:/);
});

test('theme maps shadcn surface/text semantics and the app dark variant', () => {
  const styles = read('web-src/src/styles.css');
  // `muted` is the subtle SURFACE role; `muted-foreground` the subdued text.
  assert.match(styles, /--color-muted: var\(--hover\);/);
  assert.match(styles, /--color-muted-foreground: var\(--muted\);/);
  assert.match(styles, /--color-input:/);
  // dark: must follow data-theme, not the raw media query.
  assert.match(styles, /@custom-variant dark/);
  assert.match(styles, /:root\[data-theme='dark'\] &/);
});

test('chrome type scale and radius scale are the only visual values', () => {
  const styles = read('web-src/src/styles.css');
  const globalTokens = read('web-src/src/styles/globals.css');
  // Every text-* utility scales with the interface-size preference — and
  // the step is REACHABLE by name, which is the half this assertion used
  // to miss. It only checked that styles.css spelled
  // `--text-sm: calc(12px * var(--ui-scale))` inside `@theme inline`, and
  // `inline` means Tailwind pastes that value into the utilities it
  // generates and never emits the variable. So `var(--text-sm)` resolved
  // to nothing in hand-written CSS, the declaration was dropped, and the
  // only way a colocated `.css` file could reach the scale was to restate
  // the literal — which is exactly what every one of them did. The scale
  // now lives in globals.css's plain `:root` and styles.css forwards it,
  // so BOTH halves are asserted: the numbers, and the bridge that carries
  // them into Tailwind's namespace. Losing either one silently returns the
  // renderer to two copies of nine numbers.
  for (const step of ['2xs', 'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl']) {
    assert.match(globalTokens, new RegExp(`--text-${step}: calc\\([0-9]+px \\* var\\(--ui-scale\\)\\);`),
      `globals.css is missing the --text-${step} step`);
    assert.match(styles, new RegExp(`--text-${step}: var\\(--text-${step}\\);`),
      `styles.css does not forward --text-${step} into the Tailwind namespace`);
  }
  // The ambient body size is the base step, not a fourth spelling of 13.
  assert.match(globalTokens, /--ui-font-size: var\(--text-base\);/);
  // Brand role: the amber counterpoint is a named token, so warmth-budget
  // surfaces never restate the literal.
  assert.match(styles, /--color-accent-amber: var\(--accent-amber\);/);
  // Every corner step forwards a globals.css role instead of restating a
  // literal — that is what lets styles/*.css reach the same roles through
  // var(--radius-container) and friends, and what keeps one edit re-shaping
  // the whole app. lg/xl/2xl collapsing onto ONE container role is the
  // contract, not an oversight: boxes are not graded by size here, so a
  // component reaching for any of the three must land on the same corner.
  for (const [name, role] of [
    ['xs', 'var(--radius-xs)'],
    ['sm', 'var(--radius-control)'],
    ['md', 'var(--radius-ui)'],
    ['lg', 'var(--radius-container)'],
    ['xl', 'var(--radius-container)'],
    ['2xl', 'var(--radius-container)'],
  ]) {
    assert.match(styles, new RegExp(`--radius-${name}: ${role.replace(/[()*]/g, (c) => '\\' + c)};`));
  }
  // Buttons are items, not boxes: the Button recipe must never reach for a
  // container step. That one is asserted against the class strings the
  // component actually emits — see `shared-overlays.test.ts`.

  // Legacy CSS stays on the shared scale: no half-pixel chrome sizes, no
  // off-palette accent blues, no odd font weights. Scans every colocated
  // .css file (not a hardcoded list) so this coverage survives a file
  // moving to a new feature folder without silently going stale.
  const walkCss = (dir: string): string[] =>
    fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walkCss(rel);
      return entry.name.endsWith('.css') ? [rel] : [];
    });
  const legacy = walkCss('web-src/src')
    .map((file) => read(file))
    .join('\n');
  const legacyBlue = /46, ?116, ?230|#4a8cff|#4f7cff|#1a73e8/;
  assert.doesNotMatch(legacy, /font-size: calc\((9|10|11|12|13)\.5px/);
  assert.doesNotMatch(legacy, /font-weight: *(650|800)\b/);
  assert.doesNotMatch(legacy, legacyBlue);
  // The ban covers TS/TSX too: the legacy blue once hid inside injected
  // <style> strings (previewChunkHighlight, findIframe) where a CSS-only
  // scan could not see it.
  const walkSources = (dir: string): string[] =>
    fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walkSources(rel);
      return /\.tsx?$/.test(entry.name) ? [rel] : [];
    });
  for (const file of walkSources('web-src/src')) {
    assert.doesNotMatch(read(file), legacyBlue, `${file} carries a legacy accent blue`);
    // Cursor-style chrome has no `is-electron` switch: platform classes are
    // stamped ONCE by `electron/preload.cjs` as `platform-${process.platform}`
    // (asserted below), and the app-shell CSS keys off those. A renderer
    // module stamping its own class would fork that contract, so the ban is
    // repo-wide rather than pinned to whichever file composes the shell.
    assert.doesNotMatch(read(file), /is-electron/, `${file} stamps its own Electron class`);
  }
  // Corners come off the scale too — with no exceptions left. The last
  // sanctioned literal was a 999px pill in the hand-rolled transcription
  // progress bar; that bar is the Progress primitive now, and every capsule
  // in the app reaches the shape through `rounded-full`, which is also the
  // single squircle opt-out. A literal radius here is a defect, not a
  // shape that needed one.
  assert.deepEqual(legacy.match(/border-radius: *\d+px/g) ?? [], []);
  // The squircle is what makes the corners read as continuous rather than
  // merely large; losing it silently would flatten the whole app.
  assert.match(legacy, /corner-shape: squircle;/);

  // Migrated components consume named tokens, not arbitrary-value escapes.
  // Reuses walkSources above (rather than a hardcoded directory list) so
  // this coverage survives feature-folder moves without silently going stale.
  for (const file of walkSources('web-src/src').filter((f) => f.endsWith('.tsx'))) {
    const source = read(file);
    assert.doesNotMatch(source, /text-\[calc\(/, `${file} uses an arbitrary scaled font size — use the text-* ramp`);
    assert.doesNotMatch(source, /bg-\[var\(--hover\)\]/, `${file} uses bg-[var(--hover)] — use bg-muted`);
    assert.doesNotMatch(source, /rounded-\[\d+(?:\.\d+)?px\]/, `${file} uses a literal radius — use the rounded-* role scale`);
    // Placeholders are one role, not a per-field opacity guess. Four
    // fields had drifted to three different values before this landed.
    assert.doesNotMatch(source, /placeholder:text-(?!placeholder\b)/, `${file} styles a placeholder off-role — use placeholder:text-placeholder`);
  }
});

test('explicit-dark and system-dark token blocks stay identical', () => {
  // globals.css maintains the dark palette twice: once for the explicit
  // data-theme='dark' choice and once for system-following mode. They are
  // hand-synced duplicates (see the comment above the blocks) — this guards
  // against a token landing in one and silently missing from the other.
  const globals = read('web-src/src/styles/globals.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const declarations = (block: RegExp): string[] => {
    const body = globals.match(block)?.[1];
    assert.ok(body, `dark theme block not found: ${block}`);
    return body.split(';').map((decl) => decl.trim()).filter(Boolean);
  };
  const explicitDark = declarations(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/);
  const systemDark = declarations(
    /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme\]\),\s*:root\[data-theme='system'\]\s*\{([^}]*)\}/,
  );
  assert.deepEqual(systemDark, explicitDark);
});

test('shadcn generation is configured for Base UI and renderer aliases', () => {
  const config = JSON.parse(read('components.json')) as Record<string, unknown>;
  assert.equal(config.style, 'base-nova');
  assert.equal(config.rsc, false);
  assert.equal((config.tailwind as { css?: string }).css, 'web-src/src/styles.css');
  assert.equal((config.aliases as { ui?: string }).ui, '@/common/components/ui');
});

test('motion is budgeted and reduced-motion is honoured at the stylesheet level', () => {
  // The per-component motion contracts (the drag veil's reduced-motion
  // config, the dialog's enter/exit) are asserted by rendering, in
  // `shared-overlays.test.ts`. What lives only in CSS is the global budget.
  const globals = read('web-src/src/styles/globals.css');
  assert.match(globals, /transition-property: opacity, color, background-color/);
  assert.match(globals, /animation-duration: 0\.01ms !important/);
});

test('the Electron chrome contract is stamped once, by preload', () => {
  // A main-process file: no renderer, nothing to mount, so its text is the
  // artefact — the same reason the stylesheet reads above stay.
  const preload = read('electron/preload.cjs');
  assert.match(preload, /platform-\$\{process\.platform\}/);
});

test('shell geometry and reading-surface fixes stay pinned', () => {
  const appShell = read('web-src/src/app/app-shell.css');
  // Cursor-style chrome: no titlebar strip — the traffic lights float
  // over the sidebar's top drag zone and the tab strip's empty
  // background doubles as the other macOS drag surface. This composition
  // lives in the app shell, not any one feature's CSS. (The sidebar's
  // matching drag-zone ELEMENT is asserted by rendering the sidebar — see
  // `@/app/__tests__/app-shell-semantics.test.ts`.)
  assert.doesNotMatch(appShell, /app-chrome/);
  assert.match(appShell, /platform-darwin \.sidebar-drag-zone/);
  assert.match(appShell, /platform-darwin \.tab-strip/);
  // Drag surfaces never overlap controls: the sidebar drag zone stops at
  // the titlebar controls (per-element no-drag carve-outs proved
  // intermittently stale on windowed macOS — geometry, not carving).
  assert.match(appShell, /\.sidebar-drag-zone \{[^}]*width: var\(--titlebar-controls-left\)/s);
  // The left cluster ellipsizes at the sidebar column edge instead of
  // bleeding onto the tab strip…
  assert.match(appShell, /\.titlebar-controls \{[^}]*max-width: calc\(var\(--sidebar-width\) - var\(--titlebar-controls-left\)\)/s);
  // …and the collapsed-sidebar budget is ONE token shared by the cluster
  // cap and both tab-row reserves, so the floating controls never overlap
  // a tab.
  assert.match(appShell, /--titlebar-controls-collapsed-width:/);
  assert.match(appShell, /\.app\.sidebar-collapsed \.tab-strip \{[^}]*var\(--titlebar-controls-collapsed-width\)/s);
  assert.match(appShell, /\.app\.sidebar-collapsed \.titlebar-controls \{[^}]*max-width: var\(--titlebar-controls-collapsed-width\)/s);
  assert.match(appShell, /\.app\.sidebar-collapsed\.chat-primary \.chat-tab-row \{[^}]*var\(--titlebar-controls-collapsed-width\)/s);

  const chat = read('web-src/src/features/agent-panel/agent-panel.css');
  // Entering message edit must not collapse the bubble (the textarea has
  // no intrinsic width): the head takes the full bubble width instead.
  assert.match(chat, /\.agent-turn-head:has\(\.agent-turn-edit\) \{[^}]*width: min\(85%, 620px\)/s);
  // No focus ring on the edit textarea ON PURPOSE (composer idiom): text
  // fields always match :focus-visible, so a halo would flash on every
  // edit open. The mode change is the affordance.
  assert.doesNotMatch(chat, /\.agent-turn-edit textarea:focus-visible/);

  const documentsCss = read('web-src/src/features/documents/documents.css');
  // Reading gutters follow the PANE, not the window.
  assert.match(documentsCss, /\.crepe-shell \{[^}]*container-type: inline-size/s);
  assert.match(documentsCss, /clamp\(24px, 6cqi, 48px\)/);
  // THREE-class selector on purpose: Crepe's packaged stylesheet ships
  // `.milkdown .ProseMirror { padding: 60px 120px }` in a LATER-loaded
  // chunk — equal specificity would hand the gutters back to the package.
  assert.match(documentsCss, /\.crepe-shell \.milkdown \.ProseMirror \{/);
  // Editable gutters seat the block handle (48px); under pane pressure
  // the ADD tile yields so the drag tile fits instead of clipping.
  assert.match(documentsCss, /\.crepe-shell:not\(\.crepe-readonly\) \.milkdown \.ProseMirror \{[^}]*padding-inline: 48px/s);
  assert.match(documentsCss, /\.crepe-shell:not\(\.crepe-readonly\) \.milkdown-block-handle \.operation-item:first-child \{[^}]*display: none/s);
  // Crepe names the handle `milkdown-block-handle`; a `crepe-`-prefixed
  // selector silently matches nothing. The scoped selector must also outrank
  // Crepe's later-loaded `.milkdown .milkdown-block-handle` display rule.
  assert.match(documentsCss, /\.crepe-shell\.crepe-readonly \.milkdown \.milkdown-block-handle \{ display: none; \}/);
  assert.doesNotMatch(documentsCss, /crepe-block-handle/);
});

/* The PDF viewer's load keying, Find registration lifetime, and
 * single-scroll-owner protocol used to be asserted here through six regexes
 * over `PdfPreview.tsx`. The viewer's split gave each of them a hook with an
 * interface to drive, so they now run in
 * `@/features/documents/__tests__/pdf-viewer.test.ts` — no source text left
 * in this file outside stylesheets and the repo-wide literal scans. */

/* ---------------------------------------------------------------------
 * Scale discipline: layering, motion, spacing.
 *
 * These three ramps have the same failure mode. Each is cheap to bypass
 * one component at a time (`z-[10001]`, `transition: .12s`, an off-ramp `px-` step),
 * every bypass looks locally reasonable, and the damage only becomes
 * visible in aggregate — at which point the app is carrying seventeen
 * z-indexes whose only ordering contract is edit order. Reading the source
 * is the assertion here for the same reason it is above: the rules are
 * about which TOKEN a declaration reaches for, which no render can observe.
 * ------------------------------------------------------------------- */

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Every walked path is repo-relative and POSIX-separated on EVERY
 * platform, which is why these join with `/` rather than `path.join`.
 *
 * The exemption tables below are keyed by path, and a key is written the
 * way the repo spells it — `features/workspace/workspace.css`. Under
 * `path.join` a Windows runner produced `features\workspace\workspace.css`,
 * so every lookup missed and one file was reported BOTH as carrying an
 * unexempted value and as a stale exemption in the same run. `read()`
 * takes forward slashes on Windows, so nothing is lost by keeping one
 * dialect; keep any new path constant in this file spelled the same way. */
function walkFiles(dir: string, extension: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walkFiles(rel, extension);
    return entry.name.endsWith(extension) ? [rel] : [];
  });
}

test('the layer ramp is the only source of stacking order', () => {
  const globals = read('web-src/src/styles/globals.css');
  const styles = read('web-src/src/styles.css');
  // Bottom to top. The order IS the contract: a tooltip may be raised from
  // a menu item and a toast may report a modal's own failure, so both of
  // those pairs have to stay the right way round. They did not before this
  // ramp existed — tooltips at 1000 sat behind menus at 1300.
  // `menu-backdrop`/`menu-modal` sit ABOVE `menu` on purpose: both nesting
  // directions are real and one linear order cannot serve both. A menu
  // opened from a modal (the library search's scope pill) needs menu over
  // modal; a confirmation opened from a menu row (the session-history
  // delete) needs the reverse, and gets this pair instead of the ramp being
  // flipped and the other case broken in its place.
  const ORDER = [
    'raised', 'sticky', 'chrome', 'banner', 'veil', 'picker',
    'backdrop', 'modal', 'menu', 'menu-backdrop', 'menu-modal',
    'tooltip', 'toast',
  ];
  const values = ORDER.map((role) => {
    const match = new RegExp(`--layer-${role}: (\\d+);`).exec(globals);
    assert.ok(match, `globals.css is missing --layer-${role}`);
    // Every role also needs the utility that spends it, or a component has
    // no way to name the role and goes back to picking a number.
    assert.match(styles, new RegExp(`@utility z-${role} \\{ z-index: var\\(--layer-${role}\\); \\}`));
    return Number(match[1]);
  });
  assert.deepEqual(values, [...values].sort((a, b) => a - b), 'layer ramp is out of order');
  assert.equal(new Set(values).size, values.length, 'two layers share a value');

  // `.ts` too, for the same reason the spacing scan walks both: the class
  // recipes several surfaces share live in plain modules (pickerChrome,
  // panelStyles, pickerChrome), so a `.tsx`-only scan does not see them.
  // That gap is not hypothetical — `z-1200` sat in the picker veil recipe
  // and shipped, putting every picker above the toast, tooltip, and modal
  // roles, so a toast raised while Quick Open was open rendered behind the
  // dim. One shared recipe reaches more surfaces than any component does.
  for (const file of [...walkFiles('web-src/src', '.tsx'), ...walkFiles('web-src/src', '.ts')]) {
    const source = stripComments(read(file));
    assert.doesNotMatch(source, /z-\[/, `${file} picks a z-index literal — use a z-<role> utility`);
    // Ordinals 1-3 stay legal: ordering two or three children inside one
    // component's own stacking context is local bookkeeping, not app-wide
    // layering. Anything that has to beat another SURFACE names a role.
    for (const [match] of source.matchAll(/(?<![\w-])z-(\d+)(?![\w.])/g)) {
      const step = Number(match.slice(2));
      assert.ok(step <= 3, `${file} uses ${match} — above 3 the value is cross-surface, so name a role`);
    }
  }
});

test('motion comes off the role scale, never a literal', () => {
  const globals = stripComments(read('web-src/src/styles/globals.css'));
  const styles = read('web-src/src/styles.css');
  for (const token of ['instant', 'fast', 'standard', 'slow']) {
    assert.match(globals, new RegExp(`--motion-${token}: \\d+ms;`));
  }
  // Three curves, because one cannot serve entering, moving, and tinting.
  assert.match(globals, /--motion-ease-out: cubic-bezier/);
  assert.match(globals, /--motion-ease-in-out: cubic-bezier/);
  assert.match(globals, /--motion-ease-hover:/);
  // `ease-out`/`ease-in-out` are deliberately REDEFINED over Tailwind's
  // built-ins; losing these two lines silently returns the whole app to the
  // stock curves, which is invisible in review and obvious in use.
  assert.match(styles, /--ease-out: var\(--motion-ease-out\);/);
  assert.match(styles, /--ease-in-out: var\(--motion-ease-in-out\);/);
  for (const role of ['control', 'tint', 'surface']) {
    assert.match(styles, new RegExp(`@utility transition-${role} \\{`));
  }

  for (const file of walkFiles('web-src/src', '.css')) {
    const source = stripComments(read(file));
    assert.doesNotMatch(source, /transition:[^;]*?\b\d+(\.\d+)?m?s\b/,
      `${file} hardcodes a transition duration — use var(--motion-*)`);
  }
  for (const file of walkFiles('web-src/src', '.tsx')) {
    const source = stripComments(read(file));
    assert.doesNotMatch(source, /transition-all/,
      `${file} uses transition-all — name the properties, or a transition-* role`);
    // `ease-in` alone starts slow, which delays exactly the first frame the
    // user is watching. `ease-in-out` is a different curve and stays legal.
    assert.doesNotMatch(source, /(?<![\w-])ease-in(?![\w-])/,
      `${file} uses ease-in — entering and exiting both take ease-out`);
    for (const line of source.split('\n')) {
      if (!line.includes('transition-')) continue;
      const named = /transition-(control|tint|surface)(?![\w-])/.test(line);
      assert.ok(named || line.includes('duration-'),
        `${file} has a transition with no token duration: ${line.trim().slice(0, 80)}`);
    }
  }
});

test('spacing stays on the derived ramp', () => {
  // One base, and it follows the interface-size preference like the type
  // ramp does — chrome text used to grow while padding stayed put, so every
  // dense row got tighter exactly as its text got bigger.
  assert.match(read('web-src/src/styles.css'), /--spacing: calc\(4px \* var\(--ui-scale\)\);/);
  // Half-steps to 4 (2px granularity where density is decided), whole
  // numbers above it. Quarter-steps and half-steps past 4 are eyeballed
  // values wearing scale notation: the app had 51 of them.
  const offRamp = /(?<![\w-])[a-z-]+-(?:\d+\.(?:25|75)|(?:[5-9]|\d{2,})\.5)(?![\w.])/g;
  // `.ts` too: the class recipes that several components share live in
  // plain modules (panelStyles, pickerChrome), and a scan that only saw
  // `.tsx` let `size-1.75` sit in one of them untouched.
  for (const file of [...walkFiles('web-src/src', '.tsx'), ...walkFiles('web-src/src', '.ts')]) {
    const source = stripComments(read(file));
    const found = source.match(offRamp);
    assert.equal(found, null, `${file} uses off-ramp spacing: ${found?.join(', ')}`);
    // An arbitrary `size-[Npx]` is the same violation spelled in brackets,
    // and it also steps off the 12/14/16 icon ramp — the lightbox's stage
    // glyphs were `size-[15px]` beside a `size-4` sibling in the same 40px
    // control, which is a value nobody could have chosen off a scale.
    assert.doesNotMatch(source, /size-\[\d+(?:\.\d+)?px\]/,
      `${file} hand-types a box or glyph size — use the spacing ramp (icons are 12/14/16)`);
  }
});

/* ---------------------------------------------------------------------
 * The same two ramps, enforced in the OTHER half of the renderer.
 *
 * Every scan above this point reads `.tsx` and `.ts` — that is, Tailwind
 * class strings. The colocated `.css` files were never scanned at all,
 * and they are where the app writes its longest-lived surfaces: the tree
 * row, the tab strip, the shell band, the transcript. So the two ramps
 * held on exactly the side of the renderer that is cheap to re-derive
 * from a utility name, and were unenforced on the side where a value is
 * typed by hand and then copied by the next rule.
 *
 * A regex is the assertion here for the reason the file's header gives:
 * a stylesheet has no rendered output, and `padding: 9px` is not
 * observable from any component — the text is the artefact.
 * ------------------------------------------------------------------- */

/** 1px hairlines, 2px half-steps to 16, whole 4px steps above it. */
const onSpacingRamp = (px: number): boolean =>
  px === 1 || (px <= 16 ? px % 2 === 0 : px % 4 === 0);

/**
 * Properties whose px is not a spacing decision, so the ramp does not
 * govern them:
 *
 * - anything `shadow` (`box-shadow`, `--shadow-raised`, `--crepe-shadow-1`):
 *   an offset and a blur radius are optical values calibrated against
 *   each other, not steps of air between two boxes. `0 1px 3px` is one
 *   shadow, not three spacing decisions.
 * - the type scale itself (`--text-*`, `--ui-font-size`,
 *   `--reading-font-size`, and the `font-size` / `font` declarations that
 *   spend them). It is deliberately NOT 4px-derived — 10/11/12/13/14 is
 *   a density ramp for text, and rounding it onto the spacing ramp would
 *   collapse five roles into three. Literals there are the next test's
 *   job, which is a different rule with a different answer.
 */
const NOT_A_SPACING_DECISION = /shadow|^font(-size)?$|^--text-|^--(ui|reading)-font-size$/;

/**
 * Off-ramp px that survives, with the reason it survives.
 *
 * Same shape and same bar as `RAW_CONTROL_EXEMPTIONS`: the VALUES are
 * pinned, not the file, so an exempt stylesheet cannot grow a second
 * unreasoned literal for free — and those are the files a new one is most
 * likely to land in, since they already look like precedent. A stale
 * entry fails too: it reads as standing permission for a declaration that
 * no longer exists.
 *
 * The bar is that the value is not answering "how much air", because
 * that is the only question the ramp answers. Geometry derived from
 * another value on the ramp clears it. "It looked right" does not — that
 * is precisely the reasoning that produced px-2.25 and py-1.75.
 */
const CSS_OFF_RAMP_EXEMPTIONS: Record<string, { values: string[]; why: string }> = {
  'common/styles/tree.css': {
    values: ['3px', '3px'],
    why: 'The tree row’s vertical padding is the largest value that keeps `min-height: 28px` the thing that DECLARES the row height. The line box is 20.15px at the default interface size and 21.7px at Large, so 3+20.15+3 and 3+21.7+3 both stay under 28 and every row lands on a whole pixel; the ramp’s 4 makes the content box 28.15px, which wins over the min-height and leaves each row a fraction taller than the last one’s offset. Not an amount of air: it is 28 minus the tallest line box the size preference can produce, halved.',
  },
  'features/workspace/workspace.css': {
    values: ['-3px'],
    why: 'The sidebar splitter’s `margin-left` is -width/2, the offset that straddles its 6px grab area evenly across the sidebar/main boundary that `left` puts it on. Not an amount of air: any other value hands more of the grab zone to one pane than the other.',
  },
};

test('spacing in colocated CSS stays on the derived ramp', () => {
  const seen = new Set<string>();
  // Collected rather than thrown per file: this is a repo-wide ban, and a
  // ban that reports only the alphabetically-first offender turns one
  // cleanup into one run per stylesheet.
  const problems: string[] = [];
  for (const file of walkFiles('web-src/src', '.css')) {
    const source = stripComments(read(file));
    const relative = path.posix.relative('web-src/src', file);
    const exemption = CSS_OFF_RAMP_EXEMPTIONS[relative];
    const offRamp: string[] = [];
    for (const match of source.matchAll(/-?\d+(?:\.\d+)?px/g)) {
      // The enclosing declaration, found by walking back to the nearest
      // `;`, `{` or `}` — cheaper and more exact than trying to parse
      // declarations forwards, and it cannot be fooled by a value that
      // spans lines (`box-shadow`, `transition`, `grid-template-columns`).
      const start = match.index;
      const boundary = Math.max(
        source.lastIndexOf(';', start),
        source.lastIndexOf('{', start),
        source.lastIndexOf('}', start),
      );
      const declaration = source.slice(boundary + 1, start);
      const colon = declaration.indexOf(':');
      const property = colon === -1 ? '' : declaration.slice(0, colon).trim();
      if (NOT_A_SPACING_DECISION.test(property)) continue;
      if (onSpacingRamp(Math.abs(Number(match[0].slice(0, -2))))) continue;
      offRamp.push(match[0]);
    }
    if (!exemption) {
      if (offRamp.length) {
        problems.push(`${relative} uses off-ramp spacing (${offRamp.join(', ')}) — snap it to the ramp surface by surface (9 is not 8 and it is not 10), or add an entry to CSS_OFF_RAMP_EXEMPTIONS saying what question the value is answering if it is not "how much air"`);
      }
      continue;
    }
    seen.add(relative);
    if (offRamp.join() !== exemption.values.join()) {
      problems.push(`${relative} is exempt for ${exemption.values.join(', ')} but carries ${offRamp.join(', ') || 'none'} — an exemption covers the values it was reasoned about, not the file`);
    }
  }
  for (const relative of Object.keys(CSS_OFF_RAMP_EXEMPTIONS)) {
    // A stale entry is worse than no entry: it reads as standing
    // permission for a declaration that no longer exists.
    if (!seen.has(relative)) {
      problems.push(`CSS_OFF_RAMP_EXEMPTIONS lists ${relative}, which no longer carries an off-ramp value — delete the entry`);
    }
    if (CSS_OFF_RAMP_EXEMPTIONS[relative].why.length < 80) {
      problems.push(`${relative} has no real reason recorded — say what the value is derived from, or snap it to the ramp`);
    }
  }
  assert.ok(problems.length === 0, `\n${problems.join('\n')}\n`);
});

test('font size in colocated CSS comes off the type scale, never a literal', () => {
  // The scale is nine roles, and until this landed every `.css` file
  // reached them by re-typing `calc(12px * var(--ui-scale))` — the
  // definition of `--text-sm`, spelled out, once per rule. That is not a
  // shortcut around the scale, it IS the scale copied by hand, which is
  // why the sizes had already drifted apart from the roles they meant:
  // nothing could rename a step, and nothing could add one.
  //
  // A `px` in a `font-size` is therefore always the defect, whether it is
  // wrapped in the `--ui-scale` calc or not — the bare form does not even
  // follow the interface-size preference. `em`, `%`, `inherit` and
  // `var(--reading-font-size)` all stay legal: content typography is a
  // separate scale on purpose, and prose headings sized in `em` are
  // relative to whichever role their container took.
  const ROLE_FOR_PX: Record<string, string> = {
    '10': '--text-2xs', '11': '--text-xs', '12': '--text-sm', '13': '--text-base',
    '14': '--text-lg', '16': '--text-xl', '20': '--text-2xl', '24': '--text-3xl',
    '30': '--text-4xl',
  };
  const problems: string[] = [];
  for (const file of walkFiles('web-src/src', '.css')) {
    const source = stripComments(read(file));
    // `font` (the shorthand) as well as `font-size`: `font: calc(11px *
    // var(--ui-scale)) var(--font-sans)` is the same violation with the
    // family bolted on, and it is how one of them hid. The boundary
    // prefix keeps `font-family`, `font-weight` and `-webkit-font-*` out.
    for (const declaration of source.matchAll(/(?:^|[;{}])\s*(font-size|font)\s*:\s*([^;{}]+)/g)) {
      const [, property, value] = declaration;
      const literal = /(\d+(?:\.\d+)?)px/.exec(value);
      if (!literal) continue;
      const role = ROLE_FOR_PX[literal[1]];
      problems.push(
        `${file} sets ${property} from the literal ${literal[0]} — ${role
          ? `that step is \`var(${role})\``
          : `and it is not even a step on the scale (10/11/12/13/14/16/20/24/30)`}. globals.css owns the ramp; nothing else restates it.`,
      );
    }
  }
  assert.ok(problems.length === 0, `\n${problems.join('\n')}\n`);
});

test('overlay geometry comes off the two size scales, never a literal', () => {
  const globals = stripComments(read('web-src/src/styles/globals.css'));
  const styles = read('web-src/src/styles.css');
  // Width steps, narrowest to widest, and the one viewport clamp they all
  // share. Before the scale there were nine widths and five different
  // spellings of "and never outgrow the window" (90vw, 92vw, 94vw, 100%,
  // calc(100vw - 16|24|32px)) — the same intent rounded five ways.
  assert.match(globals, /--overlay-fit: calc\(100vw - 32px\);/);
  const widths = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'].map((step) => {
    const match = new RegExp(`--overlay-w-${step}: min\\((\\d+)px, var\\(--overlay-fit\\)\\);`).exec(globals);
    assert.ok(match, `globals.css is missing --overlay-w-${step}`);
    // Every step also needs the bridge that spends it. `--container-*` is
    // the namespace that generates BOTH `w-` and `max-w-`, which these
    // roles need together — a tooltip caps, a picker sizes, a dialog does
    // both. (Dialogs need only the width now: the shadcn recipe's
    // responsive 384px cap is gone from `ui/dialog.tsx`.)
    assert.match(styles, new RegExp(`--container-overlay-${step}: var\\(--overlay-w-${step}\\);`));
    return Number(match[1]);
  });
  assert.deepEqual(widths, [...widths].sort((a, b) => a - b), 'the overlay width scale is out of order');
  assert.equal(new Set(widths).size, widths.length, 'two overlay widths share a value');

  // Measure is a SEPARATE scale on purpose: a content column inside a pane
  // clamps to its parent, so it narrows when the agent panel is dragged
  // narrow rather than when the window is. Folding it into the overlay
  // ramp would tie the transcript's measure to the Settings dialog.
  const measures = ['xs', 'sm', 'md', 'lg'].map((step) => {
    const match = new RegExp(`--measure-${step}: min\\((\\d+)px, 100%\\);`).exec(globals);
    assert.ok(match, `globals.css is missing --measure-${step}`);
    assert.match(styles, new RegExp(`--container-measure-${step}: var\\(--measure-${step}\\);`));
    return Number(match[1]);
  });
  assert.deepEqual(measures, [...measures].sort((a, b) => a - b), 'the measure scale is out of order');

  // Max-height steps: the px value is what the surface wants, `70vh` is the
  // one answer to "and never more than this much of a short window", and
  // the arguments stay in px-then-viewport order at every step. Half the
  // old call sites wrote that pair the other way round, which is the
  // clearest evidence each was typed rather than chosen.
  const heights = ['xs', 'sm', 'md', 'lg'].map((step) => {
    const match = new RegExp(`--overlay-h-${step}: min\\((\\d+)px, 70vh\\);`).exec(globals);
    assert.ok(match, `globals.css is missing --overlay-h-${step}`);
    return Number(match[1]);
  });
  assert.deepEqual(heights, [...heights].sort((a, b) => a - b), 'the overlay height scale is out of order');
  for (const role of ['xs', 'sm', 'md', 'lg', 'window', 'stage']) {
    // Tailwind's `max-h-*` reads the spacing ramp and has no namespace that
    // would generate these, so each role needs its own utility or a surface
    // has no way to name one and goes back to an arbitrary value.
    assert.match(styles, new RegExp(`@utility max-h-overlay-${role} \\{ max-height: var\\(--overlay-h-${role}\\); \\}`));
  }

  // `.ts` too, for the reason the layer and spacing scans walk both: the
  // shared class recipes live in plain modules, and `pickerChrome.ts` alone
  // carried four of these literals — one recipe reaching more surfaces than
  // any single component does.
  for (const file of [...walkFiles('web-src/src', '.tsx'), ...walkFiles('web-src/src', '.ts')]) {
    const source = stripComments(read(file));
    // Catches `max-w-[min(` and `min-w-[min(` as well, since both contain it.
    assert.doesNotMatch(source, /w-\[min\(/,
      `${file} hand-types an overlay width — use a w-overlay-* or w-measure-* role`);
    assert.doesNotMatch(source, /max-h-\[min\(/,
      `${file} hand-types a scroll height — use a max-h-overlay-* role`);
    // The viewport clamp on its own, with no `min()` around it. This is the
    // half the two checks above missed, and four call sites walked straight
    // through the gap — three of them spelling `calc(100vw-24px)`, a FIFTH
    // rounding of the one rule `--overlay-fit` exists to settle. A clamp is
    // a role like any other step: `max-w-overlay-fit` for a floating
    // surface, `max-w-overlay-stage` / `max-h-overlay-stage` for the
    // lightbox, `max-h-overlay-window` for a surface that takes the window.
    assert.doesNotMatch(source, /\[calc\(100v[wh]\s*-/,
      `${file} hand-types a viewport clamp — use max-w-overlay-fit, or an overlay-stage/-window role`);
  }
});

test('every var(--token) a component names actually resolves', () => {
  // A `var()` pointing at nothing does not fail loudly: the declaration is
  // dropped and the surface silently loses whatever it was painting. The
  // Button's `secondary` variant hovered to
  // `color-mix(in oklch, var(--secondary), var(--foreground) 5%)` and shipped
  // that way, because NEITHER name exists — Tailwind's `@theme` namespaces
  // mean the `--color-secondary` bridge in styles.css defines
  // `--color-secondary`, and the `bg-secondary` UTILITY, but never a bare
  // `--secondary` for a hand-written `color-mix()` to read. The whole
  // background vanished on hover and nothing failed.
  //
  // So: every name a component reaches for must be declared somewhere the
  // renderer actually ships — a stylesheet under `web-src/src`, or the
  // component layer itself, since a handful of properties are scoped to the
  // element that sets them (`--composer-min-h` on the composer, the dragged
  // `--sidebar-width` on the shell). Collecting declarations instead of
  // listing tokens is what keeps this honest as either side moves.
  const DEFINITION = /(--[a-zA-Z0-9-]+)['"]?\s*:/g;          // --x:, '--x':, [--x:4px]
  const IMPERATIVE = /setProperty\(\s*['"](--[a-zA-Z0-9-]+)/g; // el.style.setProperty('--x', …)
  const sources = [...walkFiles('web-src/src', '.tsx'), ...walkFiles('web-src/src', '.ts')];
  const defined = new Set<string>();
  for (const file of [...walkFiles('web-src/src', '.css'), ...sources]) {
    const source = stripComments(read(file));
    for (const [, name] of source.matchAll(DEFINITION)) defined.add(name);
    for (const [, name] of source.matchAll(IMPERATIVE)) defined.add(name);
  }
  for (const file of sources) {
    const source = stripComments(read(file));
    for (const [, name] of source.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
      assert.ok(defined.has(name), `${file} reads var(${name}), which nothing declares`);
    }
  }
});

test('a label needs a role to land on', () => {
  // `aria-label` on an element with no role is not exposed at all — the
  // generic role drops it. Four spans in this app carried one and announced
  // nothing: two file-preparation glyphs, a needs-attention dot, and a file
  // mention. A glyph that carries meaning is `role="img"`; a run of text
  // says what it means in the text layer.
  const openTag = /<(div|span)\b((?:[^>]|\n)*?)>/g;
  for (const file of walkFiles('web-src/src', '.tsx')) {
    const source = stripComments(read(file));
    for (const [, , attributes] of source.matchAll(openTag)) {
      if (!attributes.includes('aria-label')) continue;
      assert.ok(
        attributes.includes('role=') || attributes.includes('aria-hidden'),
        `${file} puts aria-label on a role-less element — give it the role its content has`,
      );
    }
  }
});

/* ---------------------------------------------------------------------
 * The primitive layer, from both sides.
 *
 * Below it: no feature may hand-roll a form control the layer already
 * owns. Above it: no primitive may sit in the layer with nobody calling
 * it. Both are source-text scans for the reason the ramps above are —
 * the rule is about which MODULE a surface reaches for, which no render
 * can observe.
 * ------------------------------------------------------------------- */

const UI_DIR = 'common/components/ui';

/**
 * The complete set of raw `<button>`/`<input>`/`<select>`/`<textarea>`
 * elements left outside the primitive layer, each with the count of them
 * in that file and the reason it is not a defect.
 *
 * The COUNT is what stops this becoming an escape hatch. An allowlist of
 * bare paths would let an exempt file grow a second, unreasoned raw
 * control for free — and the files here are exactly the ones a new
 * control is most likely to be added to, since they already look like
 * precedent. Pinning the number means every direction fails loudly: a
 * raw control in a file that is not listed, an extra one in a file that
 * is, or an entry whose call site has since been converted and whose
 * exemption is now stale text nobody reads.
 *
 * The bar for an entry is the one the styling contract states: adopting
 * the primitive has to START by cancelling half its decisions to arrive
 * back at the same markup. "It was quicker" is not on the list.
 */
const RAW_CONTROL_EXEMPTIONS: Record<string, { count: number; why: string }> = {
  'common/components/ErrorBoundary.tsx': {
    count: 3,
    why: 'The recovery path. These render precisely when something in the tree has already thrown, so they must not depend on the primitive stack that may have just crashed — the press scale is duplicated by hand for the same reason.',
  },
  'features/search/components/ManagedQuickOpen.tsx': {
    count: 1,
    why: 'Palette query field. `Input` is the BOX role (own fill, border, container corner, h-9); this is a seam across the top of a panel that is itself the box AND the focus affordance, whose overflow-hidden corners clip a ring into a stray bar.',
  },
  'features/search/components/ManagedLibrarySearch.tsx': {
    count: 1,
    why: 'Palette query field — the same seam as Quick Open, sharing the unlayered focus-suppression rule in globals.css.',
  },
  'features/documents/components/ManagedLinkFilePicker.tsx': {
    count: 1,
    why: 'Palette query field — the third veil named in that same focus-suppression rule, and the one that wore a clipped ring until it was added to it.',
  },
  'features/workspace/components/ManagedMoveFilePicker.tsx': {
    count: 1,
    why: 'Palette query field — the fourth veil named in that same focus-suppression rule, matching the other three pickers stroke for stroke.',
  },
  'features/workspace/components/NewFolderInput.tsx': {
    count: 1,
    why: 'Tree-row inline editor. A field that sits flush inside a 22px tree row at the row’s own indent, where the accent stroke IS the editing affordance; the box treatment would have to be cancelled decision by decision.',
  },
  'features/workspace/components/RenameInput.tsx': {
    count: 1,
    why: 'Tree-row inline editor. The bordered box here is the SPAN, not the field: the extension suffix has to sit inside the same stroke as the editable text.',
  },
  'features/agent-panel/components/AgentComposer.tsx': {
    count: 1,
    why: 'A hidden `type="file"` picker with no rendered surface at all — the composer’s + button opens it. `Input` is typed for Base UI’s text input and its box treatment would be dead weight.',
  },
  'features/settings/components/embedder/EmbeddingAuthChoice.tsx': {
    count: 2,
    why: 'Similarity Search setup cards. Not a radio group (each fires on click, nothing reads as pre-selected) and not `Button`s (that primitive is a centred single-line -ui-cornered ITEM; these are two-line, left-aligned, -container-cornered BOXES that keep full opacity when disabled).',
  },
  'features/settings/components/TranscriptionPanel.tsx': {
    count: 1,
    why: 'Known Gap: there is no `radio` primitive yet, and a feature may not import @base-ui/react itself. Semantics are already sound (FieldSet + FieldLegend, each input wrapped by its label), so what is missing is styling.',
  },
  'common/components/DocumentOutline.tsx': {
    count: 2,
    why: 'Outline row chevron and label. Both sit inside the unlayered `.tree-row` family, which wins over every utility the Button recipe would bring; the ROW is the affordance and these are hit areas inside it.',
  },
  'app/components/Sidebar.tsx': {
    count: 1,
    why: 'Section-header toggle. It is the full width of its own tinted strip, where the ghost variant’s aria-expanded:bg-muted would paint a permanent second background on exactly the state that drives it.',
  },
};

test('no feature hand-rolls a form control the primitive layer owns', () => {
  // Two component libraries meant two answers to "what is a button"; a
  // hand-rolled `<button>` is the same drift one element at a time. Each
  // of these carries focus, press, disabled and token decisions that the
  // ui/ recipe has already made once.
  const RAW_CONTROL = /<(?:button|input|select|textarea)[\s>/]/g;
  const seen = new Set<string>();
  for (const file of walkFiles('web-src/src', '.tsx')) {
    if (file.includes(UI_DIR)) continue;
    const relative = path.posix.relative('web-src/src', file);
    const found = stripComments(read(file)).match(RAW_CONTROL) ?? [];
    const exemption = RAW_CONTROL_EXEMPTIONS[relative];
    if (!exemption) {
      assert.equal(
        found.length, 0,
        `${relative} hand-rolls ${found.length} raw form control(s) — use common/components/ui, or add an entry to RAW_CONTROL_EXEMPTIONS saying which of the primitive's decisions you would have to cancel`,
      );
      continue;
    }
    seen.add(relative);
    assert.equal(
      found.length, exemption.count,
      `${relative} is exempt for ${exemption.count} raw control(s) but has ${found.length} — an exemption covers the elements it was reasoned about, not the file`,
    );
  }
  // A stale entry is worse than no entry: it reads as standing permission
  // for a call site that no longer exists.
  for (const relative of Object.keys(RAW_CONTROL_EXEMPTIONS)) {
    assert.ok(seen.has(relative), `RAW_CONTROL_EXEMPTIONS lists ${relative}, which no longer renders a raw control — delete the entry`);
    // The reason is the entry. One that does not carry an argument is a
    // path in a list, which is the shape this test exists to prevent.
    assert.ok(
      RAW_CONTROL_EXEMPTIONS[relative].why.length >= 80,
      `${relative} has no real reason recorded — say which of the primitive's decisions adopting it would start by cancelling`,
    );
  }
});

/**
 * `label.tsx` is the one file in `ui/` with no caller outside the layer,
 * and that is correct rather than dead: `Label` is the label PART of
 * `Field`, which generates the id and wires `htmlFor`/`aria-describedby`.
 * A feature reaching for `Label` on its own would be re-doing by hand the
 * pairing `Field` exists to do, so `Field` is its caller and its only one.
 */
const COMPOSED_ONLY_PRIMITIVES = new Set(['label']);

test('every primitive has a caller', () => {
  // "One with no caller is a guess about the next feature, not a design
  // system." A primitive nobody renders is also invisible to every other
  // test in this file: nothing asserts its tokens, nothing catches it
  // drifting, and its cost is paid in the entry chunk regardless.
  const uiFiles = fs
    .readdirSync(path.join(root, 'web-src/src', UI_DIR))
    .filter((entry) => entry.endsWith('.tsx'))
    .map((entry) => entry.replace(/\.tsx$/, ''));
  const sources = [...walkFiles('web-src/src', '.tsx'), ...walkFiles('web-src/src', '.ts')];
  const external = sources.filter((file) => !file.includes(UI_DIR)).map((file) => stripComments(read(file)));
  const internal = sources
    .filter((file) => file.includes(UI_DIR))
    .map((file) => [path.basename(file, '.tsx'), stripComments(read(file))] as const);

  for (const name of uiFiles) {
    const imports = new RegExp(`components/ui/${name}['"]`);
    const calledFromFeature = external.some((source) => imports.test(source));
    if (COMPOSED_ONLY_PRIMITIVES.has(name)) {
      // Ratchet both ways: the moment a feature calls it directly it is a
      // primitive in its own right and the exemption has to go.
      assert.ok(!calledFromFeature, `ui/${name} now has a caller outside the layer — drop it from COMPOSED_ONLY_PRIMITIVES`);
      assert.ok(
        internal.some(([other, source]) => other !== name && imports.test(source)),
        `ui/${name} is listed as composed-only but no other primitive composes it — it has no caller at all`,
      );
      continue;
    }
    assert.ok(
      calledFromFeature,
      `ui/${name} has no caller outside common/components/ui — a primitive with no caller is a guess about the next feature, not a design system`,
    );
  }
});

test('the renderer stands on one component library, behind one wrapper layer', () => {
  // Two component libraries means two focus models, two overlay stacks, and
  // two answers to "what is a button" — the agent panel ran on
  // react-aria-components while everything else ran on Base UI, and the
  // seam is where the hand-rolled recipes grew.
  const manifest = JSON.parse(read('package.json')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const banned of ['react-aria-components', '@radix-ui/react-dialog', '@headlessui/react']) {
    assert.ok(!(banned in declared), `${banned} is a second component library — use the ui/ primitives`);
  }

  // And the primitives are the only place Base UI is imported from. A
  // feature reaching past them re-decides focus, motion, and tokens per
  // surface, which is the exact drift the wrapper layer exists to stop.
  for (const file of [...walkFiles('web-src/src', '.tsx'), ...walkFiles('web-src/src', '.ts')]) {
    if (file.includes(UI_DIR)) continue;
    assert.doesNotMatch(
      stripComments(read(file)),
      /from ['"]@base-ui\/react/,
      `${file} imports Base UI directly — add or extend a primitive in common/components/ui`,
    );
  }
});

/**
 * Pull the balanced `{…}` expression out of every `className={…}` in a
 * source file. A regex cannot do this: the expressions nest braces
 * (template holes, object literals, arrow bodies) and run across lines.
 */
function classNameExpressions(source: string): string[] {
  const out: string[] = [];
  const marker = 'className={';
  for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
    let depth = 1;
    let cursor = at + marker.length;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '{') depth += 1;
      else if (source[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    out.push(source.slice(at + marker.length, cursor - 1));
  }
  return out;
}

test('cn() is the only way class names are composed', () => {
  // Three idioms used to coexist, and two of them defeat tailwind-merge:
  // `'base ' + (cond ? 'x' : '')` and `` `${BASE} extra` `` both emit BOTH
  // sides of a conflicting pair, so which one paints is decided by the
  // order Tailwind happened to generate the utilities in — not by the call
  // site that asked for the override. `cn()` runs twMerge, so the LAST
  // value for a property group wins, every time, everywhere.
  //
  // The rule is about composition, not about backticks: a template literal
  // INSIDE `cn()` (`cn('json-tree-type', `json-tree-type-${node.type}`)`)
  // builds one dynamic class name and still goes through the merge, which
  // is why the check exempts an expression that is itself a `cn(...)` call
  // rather than banning the character.
  for (const file of walkFiles('web-src/src', '.tsx')) {
    for (const expression of classNameExpressions(stripComments(read(file)))) {
      const trimmed = expression.trim();
      if (trimmed.startsWith('cn(')) continue;
      assert.ok(
        !trimmed.includes('`'),
        `${file} composes a className from a template literal (${trimmed.slice(0, 60)}…) — wrap it in cn() so tailwind-merge decides the winner`,
      );
      assert.ok(
        !/(^|[^+])\+(?!\+)/.test(trimmed),
        `${file} concatenates a className with + (${trimmed.slice(0, 60)}…) — wrap it in cn() so tailwind-merge decides the winner`,
      );
    }
  }
});

/**
 * Every JSX open tag for `name`, as `[tagName, attributeText]`.
 *
 * Attribute text cannot be read with `[^>]*`: the expressions in it hold
 * arrow functions (`onClick={() => …}`), comparisons, and generics, so the
 * first `>` is almost never the end of the tag. This walks the tag with the
 * brace and quote depth in hand, the same way `classNameExpressions` walks
 * a className — the difference between the two is only where they stop.
 */
function openTags(source: string, names: readonly string[]): { name: string; attributes: string }[] {
  const out: { name: string; attributes: string }[] = [];
  for (const name of names) {
    const marker = `<${name}`;
    for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
      // `<buttonish>` is a different element; only a delimiter ends the name.
      if (/[\w-]/.test(source[at + marker.length] ?? '')) continue;
      let cursor = at + marker.length;
      let depth = 0;
      let quote: string | null = null;
      while (cursor < source.length) {
        const character = source[cursor];
        if (quote) {
          if (character === quote) quote = null;
        } else if (character === '"' || character === "'" || character === '`') {
          quote = character;
        } else if (character === '{') depth += 1;
        else if (character === '}') depth -= 1;
        else if (character === '>' && depth === 0) break;
        cursor += 1;
      }
      out.push({ name, attributes: source.slice(at + marker.length, cursor) });
    }
  }
  return out;
}

test('a raw button spells the type it wants', () => {
  // A `<button>` with no `type` is a SUBMIT button. That was inert while the
  // renderer contained no `<form>` at all, and it stopped being inert the
  // moment the API-key dialogs, the inline key row, and the Docker port
  // field became real forms — a stray untyped button inside one of them
  // submits it, and the failure looks like "the dialog closed by itself".
  //
  // The primitive layer is exempt because it does not have this bug to
  // have: Base UI's `useButton` writes `type="button"` for every Button
  // that does not ask for something else. Which is the same fact from the
  // other side — a converted confirm action inside a form must spell
  // `type="submit"` explicitly, or the form has no submit control at all.
  // The elements this scan reaches are exactly the raw ones allowlisted in
  // RAW_CONTROL_EXEMPTIONS above, so nothing here can drift silently.
  for (const file of walkFiles('web-src/src', '.tsx')) {
    if (file.includes(UI_DIR)) continue;
    for (const { attributes } of openTags(stripComments(read(file)), ['button'])) {
      assert.match(
        attributes,
        /\stype=/,
        `${file} renders a raw <button> with no type — it defaults to submit, which now matters because this renderer has forms`,
      );
    }
  }
});

test('a control with a visible label does not also carry an aria-label', () => {
  // `aria-label` REPLACES the accessible name; it does not add to one. So a
  // field that already has a `FieldLabel htmlFor` and an `aria-label` ships
  // two names, only one of which is exposed — and the one that wins is the
  // invisible one, which is then free to drift away from the words printed
  // beside it. That is the exact failure the Field primitive exists to
  // stop, so it is worth a guard rather than a review habit.
  //
  // Scoped to controls a label in the SAME file already names, on purpose.
  // The broader shape ("this element has visible text AND an aria-label")
  // has legitimate members — the outline row prefixes its heading level,
  // the update banner names the version — and a guard that fires on those
  // teaches people to delete real information. A label/aria-label pair on
  // one control has no legitimate member.
  const LABEL_FOR = /htmlFor=["']([^"']+)["']/g;
  for (const file of walkFiles('web-src/src', '.tsx')) {
    const source = stripComments(read(file));
    const labelled = new Set([...source.matchAll(LABEL_FOR)].map(([, target]) => target));
    if (labelled.size === 0) continue;
    for (const { attributes } of openTags(source, ['input', 'select', 'textarea', 'Input', 'Select', 'Textarea', 'Checkbox'])) {
      const id = /\sid=["']([^"']+)["']/.exec(attributes)?.[1];
      if (!id || !labelled.has(id)) continue;
      assert.ok(
        !attributes.includes('aria-label='),
        `${file} gives #${id} an aria-label on top of the label that already names it — the invisible name wins and the visible one goes inert`,
      );
    }
  }
});
