import '@/common/__tests__/domEnvironment';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';
import { appActions, appState, mountApp, withDom } from '@/common/__tests__/renderHarness';
import { FolderHeaderMenu } from '@/features/workspace/components/FolderHeaderMenu';

test('Files menu exposes one accessible checked Show Hidden Files action', async () => {
  const originalFetch = globalThis.fetch;
  let toggles = 0;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ recent: [], homeDir: '' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    await withDom(async (dom) => {
      await mountApp(dom, h(FolderHeaderMenu, {
        name: 'notes',
        path: '/notes',
        favorite: false,
        canOpenInNewWindow: false,
        onOpenChange: () => undefined,
        onToggleFavorite: () => undefined,
        onOpenInNewWindow: () => undefined,
        onRemove: () => undefined,
      }), {
        state: appState({ workspace: { folder: 'notes', folderPath: '/notes', showHiddenFiles: true } }),
        actions: appActions({ toggleShowHiddenFiles: async () => { toggles += 1; } }),
      });
      const trigger = dom.byLabel('More actions for notes')[0];
      assert.ok(trigger);
      await dom.fire(trigger, new MouseEvent('click', { bubbles: true }));
      await dom.flush();
      const toggle = dom.byRole('menuitemradio').find((row) => row.textContent?.includes('Show Hidden Files'));
      assert.ok(toggle, 'the Files menu renders the hidden visibility action');
      assert.equal(toggle.getAttribute('aria-checked'), 'true');
      await dom.fire(toggle, new MouseEvent('click', { bubbles: true }));
      assert.equal(toggles, 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
