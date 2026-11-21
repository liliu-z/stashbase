import { useEffect } from 'react';

import type { DocumentNavigationRuntime } from '@/features/documents/application/navigation-runtime';
import type { DocumentTabsRuntime } from '@/features/documents/application/tabs-runtime';

/** Which way a tab-switching chord moves, or 0 when the event is not one.
 *  Ctrl+Tab and Ctrl+PageDown go right, with Shift or PageUp going left, as in
 *  browsers and editors. Control on every platform: Cmd+Tab belongs to macOS. */
function tabStep(event: KeyboardEvent): -1 | 0 | 1 {
  if (!event.ctrlKey || event.metaKey || event.altKey) return 0;
  if (event.key === 'Tab') return event.shiftKey ? -1 : 1;
  if (event.shiftKey) return 0;
  if (event.key === 'PageDown') return 1;
  if (event.key === 'PageUp') return -1;
  return 0;
}

/** The Documents keyboard contract: Cmd/Ctrl+W closes the active tab, Ctrl+Tab
 *  and Ctrl+Shift+Tab (or Ctrl+PageDown/PageUp) move to the next or previous
 *  tab, wrapping at the ends, Cmd/Ctrl+F
 *  opens Find, Cmd/Ctrl+G steps through it, Escape closes it. It lives with the
 *  feature that owns those verbs rather than in the shell, and every chord asks
 *  the runtime to act and reads back whether it did, so nothing inspects
 *  document state to decide. */
export function useDocumentCommands(
  runtime: DocumentNavigationRuntime | null,
  tabs: DocumentTabsRuntime | null = null,
  options: { enabled?: boolean; newTab?: { open: boolean; close(): void } } = {},
): void {
  const { enabled = true, newTab } = options;
  useEffect(() => {
    if (!runtime || !enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="dialog"], [role="alertdialog"], [data-command-surface="agent"]'))
        return;
      if (newTab?.open) {
        if (
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.shiftKey &&
          event.key.toLowerCase() === 'w'
        ) {
          event.preventDefault();
          newTab.close();
        }
        return;
      }
      if (event.key === 'Escape') {
        if (runtime.closeFind()) event.preventDefault();
        return;
      }
      const step = tabStep(event);
      if (step !== 0 && tabs) {
        const { activeTabId, tabs: open } = tabs.store.getState();
        const index = open.findIndex((tab) => tab.id === activeTabId);
        // A single tab has nowhere to go, so the chord stays with the page.
        if (index < 0 || open.length < 2) return;
        event.preventDefault();
        const next = open[(index + step + open.length) % open.length];
        if (next) void tabs.activate(next.id);
        return;
      }
      if ((!event.metaKey && !event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'w' && !event.shiftKey) {
        // Cmd/Ctrl+W closes the active document tab. The chord is always
        // taken, so with nothing open it can never fall through to a
        // window close.
        event.preventDefault();
        void tabs?.closeActive();
      } else if (key === 'f' && !event.shiftKey) {
        if (!runtime.openFind()) return;
        event.preventDefault();
      } else if (key === 'g') {
        if (event.shiftKey ? runtime.findPrevious() : runtime.findNext()) event.preventDefault();
      }
    };
    globalThis.document.addEventListener('keydown', onKeyDown);
    return () => globalThis.document.removeEventListener('keydown', onKeyDown);
  }, [enabled, newTab, runtime, tabs]);
}
