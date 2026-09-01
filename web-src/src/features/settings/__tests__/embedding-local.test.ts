import '@/common/__tests__/domEnvironment';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';
import { appState, mountApp, withDom } from '@/common/__tests__/renderHarness';
import { EmbeddingAuthChoice } from '@/features/settings/components/embedder/EmbeddingAuthChoice';
import { EmbedderRequireKeyGate } from '@/features/settings/components/EmbedderRequireKeyGate';
import { OPEN_EMBEDDING_SETUP_EVENT } from '@/common/lib/embeddingSetupTrigger';
import { setSimilaritySearchSetupSeen } from '@/common/lib/embeddingAuth';
import { OverlayStackProvider } from '@/common/components/OverlayStack';

test('Similarity Search setup offers only hosted account and BYOK sources', async () => {
  await withDom(async (dom) => {
    let signIns = 0;
    let keySelections = 0;
    await dom.render(h(EmbeddingAuthChoice, {
      onSignIn: () => { signIns += 1; },
      onUseOwnKey: () => { keySelections += 1; },
    }));

    const buttons = dom.queryAll('button');
    assert.deepEqual(
      buttons.map((button) => button.textContent?.replace(/\s+/g, ' ').trim()),
      [
        'Sign in to StashBaseIncluded monthly allowance',
        'Use your own API keyOpenAI or OpenRouter',
      ],
    );
    await dom.fire(buttons[0], new MouseEvent('click', { bubbles: true }));
    await dom.fire(buttons[1], new MouseEvent('click', { bubbles: true }));
    assert.equal(signIns, 1);
    assert.equal(keySelections, 1);
    assert.doesNotMatch(dom.html(), /Use this device|local model/i);
  });
});

test('Similarity Search setup keeps the deliberate exit beside the two source choices', async () => {
  await withDom(async (dom) => {
    let skips = 0;
    await dom.render(h(EmbeddingAuthChoice, {
      onSignIn: () => {},
      onUseOwnKey: () => {},
      onSkip: () => { skips += 1; },
    }));

    const buttons = dom.queryAll('button');
    assert.equal(buttons.length, 3);
    assert.match(buttons[2].textContent ?? '', /Not now/);
    await dom.fire(buttons[2], new MouseEvent('click', { bubbles: true }));
    assert.equal(skips, 1);
  });
});

test('Similarity Search setup opens for the first active folder, remembers Not now, and remains manually reachable', async () => {
  const realFetch = globalThis.fetch;
  setSimilaritySearchSetupSeen(false);
  globalThis.fetch = (async () => new Response(JSON.stringify({
    provider: 'openai',
    hasKey: false,
    authorized: false,
    source: null,
    model: 'text-embedding-3-small',
    account: {},
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    await withDom(async (dom) => {
      await mountApp(dom, h(OverlayStackProvider, null, h(EmbedderRequireKeyGate)), {
        state: appState(),
      });
      await dom.flush();
      assert.equal(dom.byRole('dialog').length, 0, 'an empty Library does not interrupt the user');

      await mountApp(dom, h(OverlayStackProvider, null, h(EmbedderRequireKeyGate)), {
        state: appState({ workspace: { folder: 'workspace', folderPath: '/workspace' } }),
      });
      await dom.flush();
      await dom.flush();
      assert.equal(dom.byRole('dialog').length, 1, 'the first active folder offers Similarity Search setup');
      assert.match(document.body.textContent ?? '', /Set up Similarity Search/);
      const notNow = dom.queryAll('button').find((button) => button.textContent?.trim() === 'Not now');
      assert.ok(notNow);
      await dom.fire(notNow, new MouseEvent('click', { bubbles: true }));
      await dom.flush();
      assert.equal(dom.byRole('dialog').length, 0);

      await mountApp(dom, h(OverlayStackProvider, null, h(EmbedderRequireKeyGate)), {
        state: appState({ workspace: { folder: 'other', folderPath: '/other' } }),
      });
      await dom.flush();
      await dom.flush();
      assert.equal(dom.byRole('dialog').length, 0, 'Not now suppresses automatic prompts in later folders');

      await dom.fire(window as unknown as Element, new CustomEvent(OPEN_EMBEDDING_SETUP_EVENT));
      await dom.flush();
      await dom.flush();
      assert.equal(dom.byRole('dialog').length, 1);
    });
  } finally {
    setSimilaritySearchSetupSeen(false);
    globalThis.fetch = realFetch;
  }
});
