import { useSyncExternalStore } from 'react';

import {
  darkThemeTokens,
  lightThemeTokens,
  THEME_TOKENS,
  type ThemeToken,
} from '@/contracts/appearance-themes';
import type { AppearanceSurface } from '@/shared/domain/appearance';

function stampTokens(
  root: HTMLElement,
  side: 'light' | 'dark',
  tokens: Record<ThemeToken, string> | null,
) {
  for (const token of THEME_TOKENS) {
    const name = `--${side}-${token}`;
    if (tokens) root.style.setProperty(name, tokens[token]);
    else root.style.removeProperty(name);
  }
}

/** A chosen family always carries the bundled stack behind it, so a font
 *  uninstalled since it was chosen falls back to the default rather than to
 *  the browser's. The name is quoted, and the schema has already refused
 *  anything that could close the quote. */
function stampFont(root: HTMLElement, name: string, family: string | null, fallback: string) {
  if (family) root.style.setProperty(name, `"${family}", ${fallback}`);
  else root.style.removeProperty(name);
}

let applied: AppearanceSurface | null = null;
const listeners = new Set<() => void>();
let nativeAppearance: ((surface: AppearanceSurface) => void) | undefined;

/** Stamps the surface on the document root. `globals.css` declares
 *  `color-scheme` inside the `.light` and `.dark` rules themselves and leaves
 *  `:root { color-scheme: light dark }` as the system default, so neither
 *  class is the whole instruction for following the operating system. Theme
 *  tokens land as `--light-*` and `--dark-*` overrides the stylesheet's
 *  `light-dark()` pairs read; a StashBase theme removes them. */
export function applyAppearanceSurface(surface: AppearanceSurface): void {
  nativeAppearance?.(surface);
  const root = document.documentElement;
  root.classList.toggle('light', surface.theme === 'light');
  root.classList.toggle('dark', surface.theme === 'dark');
  stampTokens(root, 'light', lightThemeTokens(surface.lightTheme));
  stampTokens(root, 'dark', darkThemeTokens(surface.darkTheme));
  stampFont(root, '--writing-font', surface.writingFont, 'var(--font-sans)');
  stampFont(root, '--code-font', surface.codeFont, 'var(--font-mono)');
  root.dataset.uiScale = surface.uiScale;
  root.dataset.readingTextSize = surface.readingTextSize;
  root.dataset.readingFont = surface.readingFont;
  root.dataset.lineSpacing = surface.lineSpacing;
  root.dataset.lineWidth = surface.lineWidth;
  root.dataset.reduceMotion = surface.reduceMotion;
  root.dataset.focusMode = surface.focusMode ? 'on' : 'off';
  applied = surface;
  for (const listener of listeners) listener();
}

/** The surface this window last applied, or null before the first. For code
 *  outside React that has to ask at the moment it acts (an editor plugin
 *  deciding whether to scroll). */
export function appliedAppearance(): AppearanceSurface | null {
  return applied;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppliedAppearance(): AppearanceSurface | null {
  return useSyncExternalStore(subscribe, appliedAppearance, appliedAppearance);
}

/** Reduced motion as this window resolves it: the reader's explicit choice,
 *  else the operating system's. For motion that is not framer-driven, which
 *  reads `MotionConfig` instead. */
export function prefersReducedMotion(view: Window | null | undefined): boolean {
  if (applied?.reduceMotion === 'on') return true;
  return view?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? true;
}

/** Every surface this window applies (its own change, another window's, or
 *  the startup read) also reaches the desktop, which owns the native chrome
 *  and spellchecker the stylesheet cannot reach. */
export function connectNativeAppearance(report: (surface: AppearanceSurface) => void): () => void {
  nativeAppearance = report;
  return () => {
    if (nativeAppearance === report) nativeAppearance = undefined;
  };
}

let channel: BroadcastChannel | undefined;

function appearanceChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined;
  channel ??= new BroadcastChannel('stashbase-appearance');
  return channel;
}

/** Keeps the other open windows in step without adding appearance state to the
 *  server's per-window folder context. A `BroadcastChannel` never delivers to
 *  the context that posted, which is why the window making the change is the
 *  one that applies it here. */
export function publishAppearanceSurface(surface: AppearanceSurface): void {
  applyAppearanceSurface(surface);
  appearanceChannel()?.postMessage(surface);
}

export function subscribeToAppearanceSurface(
  apply: (surface: AppearanceSurface) => void,
): () => void {
  const current = appearanceChannel();
  if (!current) return () => {};
  const onMessage = (event: MessageEvent<AppearanceSurface>) => apply(event.data);
  current.addEventListener('message', onMessage);
  return () => current.removeEventListener('message', onMessage);
}
