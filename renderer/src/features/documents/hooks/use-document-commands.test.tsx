import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vite-plus/test';

import { createDocumentTabsRuntime } from '@/features/documents/public';
import { documentTabsRuntimeOptions } from '@/test/fakes/documents';

import { useDocumentCommands } from './use-document-commands';

function dispatchCommand(key: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    key,
    ...options,
  });
  globalThis.document.dispatchEvent(event);
  return event;
}

describe('document commands composition', () => {
  it('routes Find shortcuts to the active document navigation runtime', () => {
    // The navigation runtime is reached the way the shell reaches it: through
    // the tabs runtime that owns it.
    const tabs = createDocumentTabsRuntime(
      documentTabsRuntimeOptions({
        restored: {
          activeTabId: 'tab-1',
          tabs: [{ id: 'tab-1', source: { folderPath: '/project/notes', path: 'plan.md' } }],
        },
      }),
    );
    const runtime = tabs.navigation;
    const controller = {
      close: vi.fn(),
      next: vi.fn(() => ({ current: 2, total: 2 })),
      previous: vi.fn(() => ({ current: 1, total: 2 })),
      setQuery: vi.fn(() => ({ current: 1, total: 2 })),
    };
    runtime.claimFind('tab-1', Symbol('find'), controller);
    const { unmount } = renderHook(() => useDocumentCommands(runtime));

    expect(dispatchCommand('f').defaultPrevented).toBe(true);
    // Find is open, so the step chord is taken and reaches the controller.
    expect(dispatchCommand('g').defaultPrevented).toBe(true);
    expect(controller.next).toHaveBeenCalledOnce();
    dispatchCommand('g', { shiftKey: true });
    expect(controller.previous).toHaveBeenCalledOnce();

    const escape = dispatchCommand('Escape', { ctrlKey: false });
    expect(escape.defaultPrevented).toBe(true);
    expect(controller.close).toHaveBeenCalledOnce();
    // Find is closed, so the step chord falls through untouched.
    expect(dispatchCommand('g').defaultPrevented).toBe(false);
    expect(controller.next).toHaveBeenCalledOnce();

    unmount();
    tabs.dispose();
  });

  it('closes the active document tab on Cmd/Ctrl+W and always keeps the chord', async () => {
    const tabs = createDocumentTabsRuntime(
      documentTabsRuntimeOptions({
        createId: () => 'tab-2',
        restored: {
          activeTabId: 'tab-1',
          tabs: [{ id: 'tab-1', source: { folderPath: '/project/notes', path: 'plan.md' } }],
        },
      }),
    );
    const close = vi.spyOn(tabs, 'close');
    const { unmount } = renderHook(() => useDocumentCommands(tabs.navigation, tabs));

    // The chord is caught at the document root, so it works with focus
    // anywhere in the window, including inside the document's own editor.
    const editor = globalThis.document.createElement('textarea');
    globalThis.document.body.append(editor);
    editor.focus();
    const fromEditor = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: 'w',
    });
    editor.dispatchEvent(fromEditor);
    expect(fromEditor.defaultPrevented).toBe(true);
    expect(close).toHaveBeenCalledWith('tab-1');
    await vi.waitFor(() => expect(tabs.openSources()).toEqual([]));
    editor.remove();

    expect(dispatchCommand('w').defaultPrevented).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(dispatchCommand('w', { shiftKey: true }).defaultPrevented).toBe(false);

    unmount();
    tabs.dispose();
  });

  it('moves to the next or previous tab with Ctrl+Tab or Ctrl+PageDown, wrapping at the ends', async () => {
    const tabs = createDocumentTabsRuntime(
      documentTabsRuntimeOptions({
        restored: {
          activeTabId: 'tab-1',
          tabs: ['a.md', 'b.md', 'c.md'].map((path, index) => ({
            id: `tab-${index + 1}`,
            source: { folderPath: '/project/notes', path },
          })),
        },
      }),
    );
    const active = () => tabs.store.getState().activeTabId;
    const { unmount } = renderHook(() => useDocumentCommands(tabs.navigation, tabs));

    expect(dispatchCommand('Tab').defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(active()).toBe('tab-2'));
    dispatchCommand('PageDown');
    await vi.waitFor(() => expect(active()).toBe('tab-3'));
    // Past the last tab comes the first, and before the first, the last.
    dispatchCommand('Tab');
    await vi.waitFor(() => expect(active()).toBe('tab-1'));
    dispatchCommand('Tab', { shiftKey: true });
    await vi.waitFor(() => expect(active()).toBe('tab-3'));
    dispatchCommand('PageUp');
    await vi.waitFor(() => expect(active()).toBe('tab-2'));

    // Cmd+Tab is the system's on macOS, and Alt changes the chord.
    expect(dispatchCommand('Tab', { metaKey: true }).defaultPrevented).toBe(false);
    expect(dispatchCommand('Tab', { altKey: true }).defaultPrevented).toBe(false);
    expect(active()).toBe('tab-2');

    unmount();
    tabs.dispose();
  });

  it('leaves Ctrl+Tab to the page while only one tab is open', () => {
    const tabs = createDocumentTabsRuntime(
      documentTabsRuntimeOptions({
        restored: {
          activeTabId: 'tab-1',
          tabs: [{ id: 'tab-1', source: { folderPath: '/project/notes', path: 'plan.md' } }],
        },
      }),
    );
    const { unmount } = renderHook(() => useDocumentCommands(tabs.navigation, tabs));

    expect(dispatchCommand('Tab').defaultPrevented).toBe(false);
    expect(tabs.store.getState().activeTabId).toBe('tab-1');

    unmount();
    tabs.dispose();
  });

  it('opens a tab by its number with Cmd/Ctrl+1–8, and the last with Cmd/Ctrl+9', async () => {
    const tabs = threeTabs('tab-1');
    const active = () => tabs.store.getState().activeTabId;
    const { unmount } = renderHook(() => useDocumentCommands(tabs.navigation, tabs));

    expect(dispatchCommand('2').defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(active()).toBe('tab-2'));
    // Nine is the last tab however many are open.
    dispatchCommand('9');
    await vi.waitFor(() => expect(active()).toBe('tab-3'));
    dispatchCommand('1', { ctrlKey: false, metaKey: true });
    await vi.waitFor(() => expect(active()).toBe('tab-1'));

    // No fourth tab, so the chord is left to the page; Alt+digit is the
    // editor's heading shortcut, and Shift+digit is a symbol.
    expect(dispatchCommand('4').defaultPrevented).toBe(false);
    expect(dispatchCommand('2', { altKey: true }).defaultPrevented).toBe(false);
    expect(dispatchCommand('2', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(active()).toBe('tab-1');

    unmount();
    tabs.dispose();
  });

  it('opens a numbered document from New tab and closes New tab', async () => {
    for (const [key, expected] of [
      ['2', 'tab-2'],
      ['9', 'tab-3'],
    ] as const) {
      const tabs = threeTabs('tab-1');
      const newTab = { close: vi.fn(), open: true };
      const { unmount } = renderHook(() => useDocumentCommands(tabs.navigation, tabs, { newTab }));

      // Unmounted even when an expectation fails, so its listener cannot
      // answer the chords of the tests after it.
      try {
        expect(dispatchCommand(key).defaultPrevented).toBe(true);
        expect(newTab.close).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(tabs.store.getState().activeTabId).toBe(expected));
      } finally {
        unmount();
        tabs.dispose();
      }
    }

    // A number past the open documents names nothing, so New tab stays.
    const tabs = threeTabs('tab-1');
    const newTab = { close: vi.fn(), open: true };
    const { unmount } = renderHook(() => useDocumentCommands(tabs.navigation, tabs, { newTab }));
    expect(dispatchCommand('4').defaultPrevented).toBe(false);
    expect(newTab.close).not.toHaveBeenCalled();
    unmount();
    tabs.dispose();
  });

  it('steps from New tab, which sits last, to the first or last document and closes it', async () => {
    for (const [options, expected] of [
      [{}, 'tab-1'],
      [{ key: 'PageDown' }, 'tab-1'],
      [{ shiftKey: true }, 'tab-3'],
      [{ key: 'PageUp' }, 'tab-3'],
    ] as const) {
      const tabs = threeTabs('tab-2');
      const newTab = { close: vi.fn(), open: true };
      const { unmount } = renderHook(() => useDocumentCommands(tabs.navigation, tabs, { newTab }));

      const event = dispatchCommand('key' in options ? options.key : 'Tab', options);
      expect(event.defaultPrevented).toBe(true);
      expect(newTab.close).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(tabs.store.getState().activeTabId).toBe(expected));

      unmount();
      tabs.dispose();
    }
  });

  it('takes each step from where the step queued before it landed', async () => {
    const tabs = threeTabs('tab-1');
    const { unmount } = renderHook(() => useDocumentCommands(tabs.navigation, tabs));

    // Both presses arrive before the first activation has run.
    dispatchCommand('Tab');
    dispatchCommand('Tab');
    await vi.waitFor(() => expect(tabs.store.getState().activeTabId).toBe('tab-3'));

    // A step queued behind an open steps from the document that open brought in.
    void tabs.open({ folderPath: '/project/notes', path: 'd.md' });
    dispatchCommand('Tab', { shiftKey: true });
    await vi.waitFor(() => expect(tabs.store.getState().tabs).toHaveLength(4));
    await vi.waitFor(() => expect(tabs.store.getState().activeTabId).toBe('tab-3'));
    expect(tabs.activeSource()?.path).toBe('c.md');

    unmount();
    tabs.dispose();
  });
});

/** Three restored documents, a.md to c.md, with `activeTabId` in front. New
 *  ids continue after them. */
function threeTabs(activeTabId: string) {
  let next = 3;
  return createDocumentTabsRuntime(
    documentTabsRuntimeOptions({
      createId: () => `tab-${++next}`,
      restored: {
        activeTabId,
        tabs: ['a.md', 'b.md', 'c.md'].map((path, index) => ({
          id: `tab-${index + 1}`,
          source: { folderPath: '/project/notes', path },
        })),
      },
    }),
  );
}
