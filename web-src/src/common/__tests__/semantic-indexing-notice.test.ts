import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SemanticIndexingNoticeView } from '@/common/components/SemanticIndexingNotice';
import { api, ApiError } from '@/common/api/api';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('awaiting notice renders live guidance and dispatches both decisions without autofocus', async () => {
  const decisions: string[] = [];
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(SemanticIndexingNoticeView, {
      awaiting: true,
      count: 3_400,
      estimatedBytes: 100 * 1024 * 1024,
      failureMessage: 'one stale row could not be removed',
      onStart: () => decisions.push('start'),
      onDefer: () => decisions.push('defer'),
    }));
  });
  // The card itself is a plain named section, NOT a live region: it holds a
  // heading and action buttons, structure that must be navigated rather than
  // read out as one announcement. Only the text-only failure line is live —
  // polite, and no longer an alert nested inside a status region.
  const section = renderer!.root.findByType('section');
  assert.equal(section.props.role, undefined);
  assert.equal(section.props['aria-live'], undefined);
  const heading = renderer!.root.findByType('h2');
  assert.equal(section.props['aria-labelledby'], heading.props.id);
  assert.equal(heading.children.join(''), 'Many files need Similarity Search preparation');
  const status = renderer!.root.findByProps({ role: 'status' });
  assert.equal(status.props['aria-live'], 'polite');
  assert.match(status.children.join(''), /stale row/);
  assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 0);
  const buttons = renderer!.root.findAllByType('button');
  assert.deepEqual(buttons.map((button) => button.children.join('')), ['Prepare files', 'Not now']);
  assert.ok(buttons.every((button) => button.props.autoFocus == null));
  await act(async () => { buttons[0].props.onClick(); buttons[1].props.onClick(); });
  assert.deepEqual(decisions, ['start', 'defer']);
  await act(async () => { renderer!.unmount(); });
});

test('durably paused notice keeps the recoverable start action only', async () => {
  let starts = 0;
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(SemanticIndexingNoticeView, {
      awaiting: false,
      count: 1_200,
      onStart: () => { starts += 1; },
      onDefer: () => assert.fail('paused state must not offer defer again'),
    }));
  });
  const buttons = renderer!.root.findAllByType('button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].children.join(''), 'Resume preparation');
  await act(async () => { buttons[0].props.onClick(); });
  assert.equal(starts, 1);
  await act(async () => { renderer!.unmount(); });
});

test('decision API sends folder-explicit start/defer requests and surfaces failures', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: unknown }> = [];
  try {
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await api.semanticIndexingDecision('start', '/library/one');
    await api.semanticIndexingDecision('defer', '/library/two');
    assert.deepEqual(requests, [
      { url: '/api/semantic-indexing/decision', body: { decision: 'start', folder: '/library/one' } },
      { url: '/api/semantic-indexing/decision', body: { decision: 'defer', folder: '/library/two' } },
    ]);
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'state unavailable' }), {
      status: 503, headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    await assert.rejects(api.semanticIndexingDecision('start', '/library/one'), ApiError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
