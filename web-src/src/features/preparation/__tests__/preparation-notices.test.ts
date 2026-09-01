/**
 * The Preparation feature's Similarity Search disclosure surface, asserted by
 * rendering it. File-format visibility is now explained in the tree itself.
 */
import '@/common/__tests__/domEnvironment';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';
import { withDom, type DomHarness } from '@/common/__tests__/renderHarness';
import type { EmbedderState } from '@/common/api/api';
import { OPEN_EMBEDDING_SETUP_EVENT } from '@/common/lib/embeddingSetupTrigger';
import { ACCOUNT_CHANGED_EVENT } from '@/common/lib/accountEvents';
import EmbeddingSetupCallout from '@/features/preparation/components/EmbeddingSetupCallout';

function click(dom: DomHarness, target: Element): Promise<void> {
  return dom.fire(target, new MouseEvent('click', { bubbles: true }));
}

function visibleText(): string {
  return document.body.textContent ?? '';
}

// ------------------------------------------------------- embedding offer

function embedder(authorized: boolean): EmbedderState {
  return {
    provider: 'openai',
    hasKey: authorized,
    authorized,
    source: 'key',
    model: 'text-embedding-3-small',
    account: {},
  } as unknown as EmbedderState;
}

/** Serves `/api/embedder` from a mutable slot and counts the reads. */
function stubEmbedder(initial: EmbedderState | 'fail'): {
  set: (next: EmbedderState) => void;
  reads: () => number;
  restore: () => void;
} {
  const realFetch = globalThis.fetch;
  let current = initial;
  let reads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (!String(input).includes('/api/embedder')) return new Response('{}', { status: 200 });
    reads += 1;
    if (current === 'fail') return new Response('boom', { status: 500 });
    return new Response(JSON.stringify(current), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    set: (next) => { current = next; },
    reads: () => reads,
    restore: () => { globalThis.fetch = realFetch; },
  };
}

test('the Similarity Search offer stays hidden until the server says it is needed', async () => {
  // Unknown embedder state (the boot race) and an authorized one are both
  // silence — the offer only exists for a user who does NOT have it on.
  const failing = stubEmbedder('fail');
  try {
    await withDom(async (dom) => {
      await dom.render(h(EmbeddingSetupCallout));
      await dom.flush();
      assert.equal(dom.host.innerHTML, '', 'a failed read never renders a stale offer');
    });
  } finally {
    failing.restore();
  }

  const authorized = stubEmbedder(embedder(true));
  try {
    await withDom(async (dom) => {
      await dom.render(h(EmbeddingSetupCallout));
      await dom.flush();
      assert.equal(dom.host.innerHTML, '', 'nothing to offer once indexing is authorized');
    });
  } finally {
    authorized.restore();
  }
});

test('an unauthorized folder gets one quiet line that opens setup', async () => {
  const stub = stubEmbedder(embedder(false));
  try {
    await withDom(async (dom) => {
      await dom.render(h(EmbeddingSetupCallout));
      await dom.flush();
      assert.match(visibleText(), /Similarity Search isn't set up/);

      const buttons = dom.queryAll('button');
      assert.equal(buttons.length, 1, 'one action, no dismiss — the line IS the calm route');
      assert.equal(buttons[0].textContent, 'Set up');

      // It asks the Settings gate to open rather than owning a dialog.
      const opened: Event[] = [];
      const listener = (event: Event) => opened.push(event);
      window.addEventListener(OPEN_EMBEDDING_SETUP_EVENT, listener);
      try {
        await click(dom, buttons[0]);
      } finally {
        window.removeEventListener(OPEN_EMBEDDING_SETUP_EVENT, listener);
      }
      assert.equal(opened.length, 1);
    });
  } finally {
    stub.restore();
  }
});

test('signing in re-reads the embedder so the offer clears itself', async () => {
  const stub = stubEmbedder(embedder(false));
  try {
    await withDom(async (dom) => {
      await dom.render(h(EmbeddingSetupCallout));
      await dom.flush();
      assert.match(visibleText(), /Similarity Search isn't set up/);
      const before = stub.reads();

      // An account change can authorize indexing without this component
      // being told anything else; it must not keep offering setup.
      stub.set(embedder(true));
      await dom.fire(window as unknown as Element, new CustomEvent(ACCOUNT_CHANGED_EVENT));
      await dom.flush();
      assert.ok(stub.reads() > before, 'the account event triggers a re-read');
      assert.equal(dom.host.innerHTML, '', 'and the offer withdraws itself');
    });
  } finally {
    stub.restore();
  }
});
