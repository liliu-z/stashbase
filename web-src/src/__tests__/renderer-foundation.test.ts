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
  ]) {
    assert.match(styles, new RegExp(`--color-${token}:`));
  }
  assert.match(styles, /--spacing-density:/);
  assert.match(styles, /--radius-control:/);
});

test('shadcn generation is configured for Base UI and renderer aliases', () => {
  const config = JSON.parse(read('components.json')) as Record<string, unknown>;
  assert.equal(config.style, 'base-nova');
  assert.equal(config.rsc, false);
  assert.equal((config.tailwind as { css?: string }).css, 'web-src/src/styles.css');
  assert.equal((config.aliases as { ui?: string }).ui, '@/components/ui');
});

test('new foundation paths use Base UI and reduced-motion-aware Motion', () => {
  assert.match(read('web-src/src/components/ClipboardImportDialog.tsx'), /\.\/ui\/dialog/);
  assert.match(read('web-src/src/components/ClipboardImportDialog.tsx'), /\.\/ui\/button/);
  assert.match(read('web-src/src/components/ui/dialog.tsx'), /@base-ui\/react\/dialog/);
  assert.match(read('web-src/src/components/ui/dialog.tsx'), /bg-black\/35.*data-open:animate-in/);
  assert.match(read('web-src/src/components/ui/dialog.tsx'), /data-open:zoom-in-95/);
  assert.match(read('web-src/src/components/ClipboardImportDialog.tsx'), /<DialogTitle/);
  assert.match(read('web-src/src/components/ClipboardImportDialog.tsx'), /!w-\[min\(420px,90vw\)\] !max-w-\[90vw\] !gap-0/);
  assert.match(read('web-src/src/components/ClipboardImportModal.tsx'), /<ClipboardImportDialog/);
  assert.match(read('web-src/src/components/ClipboardImportDialog.tsx'), /autoFocus onClick=\{onAdd\}/);
  assert.doesNotMatch(read('web-src/src/components/ClipboardImportModal.tsx'), /window\.addEventListener/);
  assert.doesNotMatch(read('web-src/src/components/ModalShell.tsx'), /ClipboardImportDialog/);
  assert.match(read('web-src/src/components/MotionDropVeil.tsx'), /MotionConfig reducedMotion="user"/);
  assert.match(read('web-src/src/components/MotionDropVeil.tsx'), /animate=\{\{ opacity: 1 \}\}/);
  assert.match(read('web-src/src/components/Overlays.tsx'), /lazy\(\(\) => import\('\.\/MotionDropVeil'\)\)/);
  const globals = read('web-src/src/styles/globals.css');
  assert.match(globals, /transition-property: opacity, color, background-color/);
  assert.match(globals, /animation-duration: 0\.01ms !important/);
});

test('shared interaction surfaces delegate behavior to the renderer UI layer', () => {
  for (const [file, primitive] of [
    ['web-src/src/components/ui/alert-dialog.tsx', 'alert-dialog'],
    ['web-src/src/components/ui/menu.tsx', 'menu'],
    ['web-src/src/components/ui/popover.tsx', 'popover'],
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
  assert.match(app, /role="separator"/);
  assert.match(app, /aria-valuemin=/);
  assert.match(app, /resizeSidebarByKeyboard/);
  assert.match(app, /resizeChatByKeyboard/);
  assert.doesNotMatch(app, /classList\.add\('is-electron'\)/);

  const preload = read('electron/preload.cjs');
  assert.match(preload, /platform-\$\{process\.platform\}/);
  assert.match(read('web-src/src/styles/globals.css'), /platform-darwin \.app-chrome-left/);
});

test('shared overlays own loading modality, popup positioning, and focus return', () => {
  for (const file of [
    'web-src/src/components/ModalShell.tsx',
    'web-src/src/components/SettingsModal.tsx',
    'web-src/src/components/AlertConfirmModal.tsx',
    'web-src/src/components/ClipboardImportModal.tsx',
    'web-src/src/components/UnsupportedFilesModal.tsx',
  ]) {
    const source = read(file);
    assert.match(source, /useOverlayLayer/);
    assert.match(source, /<ModalLoadingStatus/);
  }

  const loadingStatus = read('web-src/src/components/ui/status.tsx');
  assert.match(loadingStatus, /dialog\.showModal\(\)/);
  assert.match(loadingStatus, /if \(isTopmost\) onCancel\(\)/);

  const unsupportedGate = read('web-src/src/components/UnsupportedFilesModal.tsx');
  assert.match(unsupportedGate, /lazyWithRetry\(\(\) => import\('\.\/ManagedUnsupportedFilesModal'\)\)/);
  assert.match(unsupportedGate, /type: 'UNSUPPORTED_MODAL_CLOSE'/);
  assert.match(unsupportedGate, /putOnboarding\(onboardingPatchForNotice\(confirmedCategories\)\)/);
  const unsupportedModal = read('web-src/src/components/ManagedUnsupportedFilesModal.tsx');
  assert.match(unsupportedModal, /\.\/ui\/button/);
  assert.match(unsupportedModal, /onCancel=\{onCancel\}/);
  assert.match(unsupportedModal, /onClick=\{onConfirm\}/);

  const popover = read('web-src/src/components/ui/popover.tsx');
  assert.match(popover, /<PopoverPrimitive\.Positioner[\s\S]*side=\{side\}/);
  assert.match(popover, /<PopoverPrimitive\.Popup[\s\S]*\{\.\.\.props\}/);

  const tree = read('web-src/src/components/FileTree.tsx');
  assert.match(tree, /tabIndex=\{-1\}/);
  assert.match(tree, /currentTarget as HTMLElement\)\.focus\(\{ preventScroll: true \}\)/);
});
