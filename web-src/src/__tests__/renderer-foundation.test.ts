import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');

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
  // Every text-* utility scales with the interface-size preference.
  for (const step of ['2xs', 'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl']) {
    assert.match(styles, new RegExp(`--text-${step}: calc\\([0-9]+px \\* var\\(--ui-scale\\)\\);`));
  }
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
  // Buttons are items, not boxes. If the base ever reaches for a container
  // step, every 32px button silently becomes a capsule.
  const button = read('web-src/src/components/ui/button.tsx');
  assert.doesNotMatch(button, /rounded-(lg|xl|2xl)/);

  // Legacy CSS stays on the shared scale: no half-pixel chrome sizes, no
  // off-palette accent blues, no odd font weights.
  const legacy = ['globals', 'chat', 'sidebar', 'mainpane']
    .map((name) => read(`web-src/src/styles/${name}.css`))
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
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walkSources(rel);
      return /\.tsx?$/.test(entry.name) ? [rel] : [];
    });
  for (const file of walkSources('web-src/src')) {
    assert.doesNotMatch(read(file), legacyBlue, `${file} carries a legacy accent blue`);
  }
  // Corners come off the scale too. The transcript's jump-to-latest
  // capsule is the one sanctioned literal — a 999px pill is a shape, not
  // a scale step, and it opts out of the squircle for the same reason.
  assert.deepEqual(legacy.match(/border-radius: *\d+px/g) ?? [], ['border-radius: 999px']);
  // The squircle is what makes the corners read as continuous rather than
  // merely large; losing it silently would flatten the whole app.
  assert.match(legacy, /corner-shape: squircle;/);

  // Migrated components consume named tokens, not arbitrary-value escapes.
  const componentDirs = ['web-src/src/components', 'web-src/src/components/ui', 'web-src/src/components/agent', 'web-src/src/components/settings', 'web-src/src/components/embedder'];
  for (const dir of componentDirs) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of fs.readdirSync(full)) {
      if (!file.endsWith('.tsx')) continue;
      const source = read(path.join(dir, file));
      assert.doesNotMatch(source, /text-\[calc\(/, `${dir}/${file} uses an arbitrary scaled font size — use the text-* ramp`);
      assert.doesNotMatch(source, /bg-\[var\(--hover\)\]/, `${dir}/${file} uses bg-[var(--hover)] — use bg-muted`);
      assert.doesNotMatch(source, /rounded-\[\d+(?:\.\d+)?px\]/, `${dir}/${file} uses a literal radius — use the rounded-* role scale`);
      // Placeholders are one role, not a per-field opacity guess. Four
      // fields had drifted to three different values before this landed.
      assert.doesNotMatch(source, /placeholder:text-(?!placeholder\b)/, `${dir}/${file} styles a placeholder off-role — use placeholder:text-placeholder`);
    }
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
  assert.equal((config.aliases as { ui?: string }).ui, '@/components/ui');
});

test('new foundation paths use Base UI and reduced-motion-aware Motion', () => {
  // The clipboard prompt rides the shared shell; the shell owns the one
  // Base UI dialog recipe (surface, width, title role) for every modal.
  assert.match(read('web-src/src/components/ManagedClipboardImport.tsx'), /\.\/ManagedModalShell/);
  assert.match(read('web-src/src/components/ManagedClipboardImport.tsx'), /\.\/ui\/button/);
  assert.match(read('web-src/src/components/ui/dialog.tsx'), /@base-ui\/react\/dialog/);
  assert.match(read('web-src/src/components/ui/dialog.tsx'), /bg-veil.*data-open:animate-in/);
  assert.match(read('web-src/src/components/ui/dialog.tsx'), /data-open:zoom-in-95/);
  const checkbox = read('web-src/src/components/ui/checkbox.tsx');
  assert.match(checkbox, /@base-ui\/react\/checkbox/);
  assert.doesNotMatch(checkbox, /\bmt-/);
  assert.match(read('web-src/src/components/ManagedModalShell.tsx'), /\.\/ui\/dialog/);
  assert.match(read('web-src/src/components/ManagedModalShell.tsx'), /<DialogTitle/);
  assert.match(read('web-src/src/components/ManagedModalShell.tsx'), /w-\[min\(420px,90vw\)\]/);
  assert.match(read('web-src/src/components/ClipboardImportModal.tsx'), /<ManagedClipboardImport/);
  assert.match(read('web-src/src/components/ManagedClipboardImport.tsx'), /autoFocus onClick=\{onAdd\}/);
  assert.doesNotMatch(read('web-src/src/components/ClipboardImportModal.tsx'), /window\.addEventListener/);
  assert.doesNotMatch(read('web-src/src/components/ModalShell.tsx'), /ManagedClipboardImport/);
  assert.match(read('web-src/src/components/ManagedDropVeil.tsx'), /MotionConfig reducedMotion="user"/);
  assert.match(read('web-src/src/components/ManagedDropVeil.tsx'), /animate=\{\{ opacity: 1 \}\}/);
  assert.match(read('web-src/src/components/DropVeil.tsx'), /lazyWithRetry\(\(\) => import\('\.\/ManagedDropVeil'\)\)/);
  const globals = read('web-src/src/styles/globals.css');
  assert.match(globals, /transition-property: opacity, color, background-color/);
  assert.match(globals, /animation-duration: 0\.01ms !important/);
});

test('Markdown Find controller registration is independent of changing action-bag identity', () => {
  const markdown = read('web-src/src/components/CrepeDocument.tsx');
  assert.match(markdown, /const registerFindController = actions\.registerFindController/);
  assert.match(markdown, /\[active, creationState, registerFindController\]/);
  assert.doesNotMatch(markdown, /registerFindController\(null\);\n  \}, \[actions, active\]\)/);
});

test('PDF load and Find registration are independent of changing action-bag identity', () => {
  const pdf = read('web-src/src/components/PdfPreview.tsx');
  assert.match(pdf, /\}, \[fileUrl\]\);/);
  assert.match(pdf, /\[doc, numPages, registerFindController\]/);
  assert.match(pdf, /function scrollToPage[\s\S]*updateTabPdfPage\(activeTab\.id, targetPage\)/);
  assert.match(pdf, /programmaticPageRef\.current = behavior === 'smooth' \? page : null/);
  assert.match(pdf, /bestPage !== programmaticPage\) return/);
  assert.doesNotMatch(pdf, /\[fileUrl, actions\]/);
});

test('JSON Find registration is independent of changing action-bag identity', () => {
  const json = read('web-src/src/components/JsonDocument.tsx');
  assert.match(json, /const registerFindController = actions\.registerFindController/);
  assert.match(json, /\[registerFindController, active, viewMode\]/);
  assert.doesNotMatch(json, /\[actions, active\]/);
});

test('shared interaction surfaces delegate behavior to the renderer UI layer', () => {
  for (const [file, primitive] of [
    ['web-src/src/components/ui/alert-dialog.tsx', 'alert-dialog'],
    ['web-src/src/components/ui/menu.tsx', 'menu'],
    ['web-src/src/components/ui/toast.tsx', 'toast'],
    ['web-src/src/components/ui/tooltip.tsx', 'tooltip'],
  ]) {
    assert.match(read(file), new RegExp(`@base-ui/react/${primitive}`));
  }

  const modal = read('web-src/src/components/ModalShell.tsx');
  assert.match(modal, /lazyWithRetry\(\(\) => import\('\.\/ManagedModalShell'\)\)/);
  assert.match(read('web-src/src/components/ManagedModalShell.tsx'), /\.\/ui\/dialog/);
  assert.match(modal, /<ModalLoadingStatus/);
  assert.doesNotMatch(modal, /createPortal|addEventListener/);
  assert.doesNotMatch(read('web-src/src/components/SettingsModal.tsx'), /addEventListener\('keydown'/);
  assert.doesNotMatch(read('web-src/src/components/CascadePromptModal.tsx'), /addEventListener/);

  const menu = read('web-src/src/components/Menu.tsx');
  assert.match(menu, /lazyWithRetry\(\(\) => import\('\.\/ManagedMenu'\)\)/);
  const managedMenu = read('web-src/src/components/ManagedMenu.tsx');
  assert.match(managedMenu, /\.\/ui\/menu/);
  assert.doesNotMatch(managedMenu, /useLayoutEffect|addEventListener|getBoundingClientRect\(\).*set/);

  assert.match(read('web-src/src/components/Toasts.tsx'), /lazyWithRetry\(\(\) => import\('\.\/ManagedToasts'\)\)/);
  assert.match(read('web-src/src/components/ManagedToasts.tsx'), /\.\/ui\/toast/);
  assert.doesNotMatch(read('web-src/src/store/state.ts'), /TOAST_(ADD|DISMISS|CLEAR)/);
  assert.doesNotMatch(read('web-src/src/store/stateReducer.ts'), /case 'TOAST_/);

  const managedTooltipButton = read('web-src/src/components/ManagedTooltipButton.tsx');
  assert.match(managedTooltipButton, /<TooltipTrigger\s+\{\.\.\.triggerProps\}/);
  assert.match(managedTooltipButton, /render=\{<button disabled=\{disabled\} \/>}/);
  assert.match(managedTooltipButton, /triggerRef\.current\?\.focus\(\)/);

  const app = read('web-src/src/App.tsx');
  assert.match(app, /<OverlayStackProvider>/);
  assert.doesNotMatch(app, /classList\.add\('is-electron'\)/);
  const splitters = read('web-src/src/components/WorkspaceSplitters.tsx');
  assert.match(splitters, /role="separator"/);
  assert.match(splitters, /aria-valuemin=/);
  assert.match(splitters, /resizeSidebarByKeyboard/);
  assert.match(splitters, /resizeChatByKeyboard/);

  const preload = read('electron/preload.cjs');
  assert.match(preload, /platform-\$\{process\.platform\}/);
  // Cursor-style chrome: no titlebar strip — the traffic lights float
  // over the sidebar's top drag zone and the tab strip's empty
  // background doubles as the other macOS drag surface.
  const globals = read('web-src/src/styles/globals.css');
  assert.doesNotMatch(globals, /app-chrome/);
  assert.match(globals, /platform-darwin \.sidebar-drag-zone/);
  assert.match(globals, /platform-darwin \.tab-strip/);
  assert.match(read('web-src/src/components/Sidebar.tsx'), /className="sidebar-drag-zone"/);
});

test('shared overlays own loading modality, popup positioning, and focus return', () => {
  for (const file of [
    'web-src/src/components/ModalShell.tsx',
    'web-src/src/components/SettingsModal.tsx',
    'web-src/src/components/AlertConfirmModal.tsx',
    'web-src/src/components/ClipboardImportModal.tsx',
  ]) {
    const source = read(file);
    assert.match(source, /useOverlayLayer/);
    assert.match(source, /<ModalLoadingStatus/);
  }

  const loadingStatus = read('web-src/src/components/ui/status.tsx');
  assert.match(loadingStatus, /dialog\.showModal\(\)/);
  assert.match(loadingStatus, /if \(isTopmost\) onCancel\(\)/);

  const tree = read('web-src/src/components/FileTree.tsx');
  assert.match(tree, /tabIndex=\{treeFocus\.rovingPath === node\.path \? 0 : -1\}/);
  assert.match(tree, /tabIndex=\{treeFocus\.rovingPath === path \? 0 : -1\}/);
  assert.match(tree, /currentTarget as HTMLElement\)\.focus\(\{ preventScroll: true \}\)/);
  assert.match(tree, /role="tree"/);
  assert.match(tree, /aria-label="Files"/);
  assert.match(tree, /role="treeitem"/);
  assert.match(tree, /aria-selected=\{isActive\}/);

  const tabs = read('web-src/src/components/TabStrip.tsx');
  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /aria-label="Open documents"/);
  assert.match(tabs, /role="tab"/);
  assert.match(tabs, /aria-selected=\{isActive\}/);
  assert.match(tabs, /aria-label=\{`Close \$\{label\}`\}/);
  assert.match(tabs, /aria-controls="document-panel"/);
  assert.doesNotMatch(tabs, /aria-controls=\{`document-panel-\$\{t\.id\}`\}/);

  const mainPane = read('web-src/src/components/MainPane.tsx');
  assert.match(mainPane, /id=\{activeTab \? 'document-panel' : undefined\}/);

  const sidebar = read('web-src/src/components/Sidebar.tsx');
  assert.match(sidebar, /aria-label=\{`Select \$\{name\} folder root`\}/);
  assert.match(sidebar, /aria-label=\{'New note in ' \+ target\}/);
  assert.match(sidebar, /<Button\s+type="button"\s+variant="ghost"[\s\S]{0,400}aria-label=\{`Select \$\{name\} folder root`\}/);

  const chat = read('web-src/src/components/ChatPane.tsx');
  assert.match(chat, /role="tablist"/);
  assert.match(chat, /aria-label="Chat sessions"/);
  assert.match(chat, /aria-controls=\{chatPanelId\(tab\.id\)\}/);
  assert.match(chat, /aria-labelledby=\{chatTabId\(tab\.id\)\}/);

  const messages = read('web-src/src/components/agent/AgentMessages.tsx');
  assert.match(messages, /role="log"/);
  assert.match(messages, /aria-label="Agent conversation"/);

  const markdown = read('web-src/src/components/CrepeDocument.tsx');
  assert.match(markdown, /role="region"/);
  assert.match(markdown, /aria-label=\{`\$\{basename\(name\)\} Markdown document`\}/);

  const json = read('web-src/src/components/JsonDocument.tsx');
  assert.match(json, /role="region"/);
  assert.match(json, /aria-label="JSON document"/);
});

test('shell geometry and reading-surface fixes stay pinned', () => {
  const globals = read('web-src/src/styles/globals.css');
  // Drag surfaces never overlap controls: the sidebar drag zone stops at
  // the titlebar controls (per-element no-drag carve-outs proved
  // intermittently stale on windowed macOS — geometry, not carving).
  assert.match(globals, /\.sidebar-drag-zone \{[^}]*width: var\(--titlebar-controls-left\)/s);
  // The left cluster ellipsizes at the sidebar column edge instead of
  // bleeding onto the tab strip…
  assert.match(globals, /\.titlebar-controls \{[^}]*max-width: calc\(var\(--sidebar-width\) - var\(--titlebar-controls-left\) - 8px\)/s);
  // …and the collapsed-sidebar budget is ONE token shared by the cluster
  // cap and both tab-row reserves, so the floating controls never overlap
  // a tab.
  assert.match(globals, /--titlebar-controls-collapsed-width:/);
  assert.match(globals, /\.app\.sidebar-collapsed \.tab-strip \{[^}]*var\(--titlebar-controls-collapsed-width\)/s);
  assert.match(globals, /\.app\.sidebar-collapsed \.titlebar-controls \{[^}]*max-width: var\(--titlebar-controls-collapsed-width\)/s);
  assert.match(read('web-src/src/styles/chat.css'), /\.app\.sidebar-collapsed\.chat-primary \.chat-tab-row \{[^}]*var\(--titlebar-controls-collapsed-width\)/s);

  const chat = read('web-src/src/styles/chat.css');
  // Entering message edit must not collapse the bubble (the textarea has
  // no intrinsic width): the head takes the full bubble width instead.
  assert.match(chat, /\.agent-turn-head:has\(\.agent-turn-edit\) \{[^}]*width: min\(85%, 620px\)/s);
  // No focus ring on the edit textarea ON PURPOSE (composer idiom): text
  // fields always match :focus-visible, so a halo would flash on every
  // edit open. The mode change is the affordance.
  assert.doesNotMatch(chat, /\.agent-turn-edit textarea:focus-visible/);

  const mainpane = read('web-src/src/styles/mainpane.css');
  // Reading gutters follow the PANE, not the window.
  assert.match(mainpane, /\.crepe-shell \{[^}]*container-type: inline-size/s);
  assert.match(mainpane, /clamp\(20px, 6cqi, 48px\)/);
  // THREE-class selector on purpose: Crepe's packaged stylesheet ships
  // `.milkdown .ProseMirror { padding: 60px 120px }` in a LATER-loaded
  // chunk — equal specificity would hand the gutters back to the package.
  assert.match(mainpane, /\.crepe-shell \.milkdown \.ProseMirror \{/);
  // Editable gutters seat the block handle (48px); under pane pressure
  // the ADD tile yields so the drag tile fits instead of clipping.
  assert.match(mainpane, /\.crepe-shell:not\(\.crepe-readonly\) \.milkdown \.ProseMirror \{[^}]*padding-inline: 48px/s);
  assert.match(mainpane, /\.crepe-shell:not\(\.crepe-readonly\) \.milkdown-block-handle \.operation-item:first-child \{[^}]*display: none/s);
  // Crepe names the handle `milkdown-block-handle`; a `crepe-`-prefixed
  // selector silently matches nothing.
  assert.match(mainpane, /\.crepe-readonly \.milkdown-block-handle \{ display: none; \}/);
  assert.doesNotMatch(mainpane, /crepe-block-handle/);

  // Composer pills yield width under pressure (min-w-0 + label truncate)
  // so a tight chat panel truncates labels instead of clipping Send.
  assert.match(read('web-src/src/components/agent/panelStyles.ts'), /pillClass =\n?\s*'inline-flex min-w-0 /);
});
