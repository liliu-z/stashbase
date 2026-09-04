/**
 * Keyboard-navigation modality for the focus ring.
 *
 * Chromium's :focus-visible heuristic flips to "keyboard" on ANY keydown —
 * a bare modifier is enough. macOS screenshot chords (⌘⇧4/5) deliver their
 * modifier keydowns to the focused window first, so the last mouse-clicked
 * row or button suddenly wore the cyan ring in the middle of taking a
 * screenshot. The ring therefore keys off actual keyboard NAVIGATION: it
 * arms on the keys that move focus and disarms the moment the pointer
 * takes over. The :focus-visible outline rule in `globals.css` is gated on
 * the `kbd-nav` class this maintains.
 */
const NAVIGATION_KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

export function installKeyboardModalityTracker(): void {
  window.addEventListener(
    'keydown',
    (event) => {
      if (NAVIGATION_KEYS.has(event.key)) document.documentElement.classList.add('kbd-nav');
    },
    true,
  );
  window.addEventListener(
    'pointerdown',
    () => {
      document.documentElement.classList.remove('kbd-nav');
    },
    true,
  );
}
