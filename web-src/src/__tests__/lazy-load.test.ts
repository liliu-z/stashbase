import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import test from 'node:test';
import { ChatSessionBoundary, chatStatusClass } from '../components/ChatPane';
import { LazyLoadBoundary, loadWithRetry, reloadForRecovery } from '../components/ErrorBoundary';

test('lazy module loading retries one transient failure', async () => {
  let attempts = 0;
  const loaded = await loadWithRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary chunk failure');
    return 'loaded';
  }, 1, 0);

  assert.equal(loaded, 'loaded');
  assert.equal(attempts, 2);
});

test('lazy module loading surfaces the final error after its retry budget', async () => {
  let attempts = 0;
  await assert.rejects(
    loadWithRetry(async () => {
      attempts += 1;
      throw new Error(`chunk failure ${attempts}`);
    }, 1, 0),
    /chunk failure 2/,
  );
  assert.equal(attempts, 2);
});

test('lazy load boundary clears a captured error when its resource identity changes', () => {
  const error = new Error('broken preview');
  const state = { error, resetKey: 'first.md:v1' };
  const props = {
    children: null,
    className: 'doc-loading',
    label: 'Markdown preview',
    resetKey: 'second.md:v1',
  };

  assert.deepEqual(LazyLoadBoundary.getDerivedStateFromProps(props, state), {
    error: null,
    resetKey: 'second.md:v1',
  });
  assert.equal(
    LazyLoadBoundary.getDerivedStateFromProps({ ...props, resetKey: state.resetKey }, state),
    null,
  );
});

test('Electron error recovery delegates reload to the main-process save barrier', async () => {
  let bridgeCalls = 0;
  let browserCalls = 0;
  const reloaded = await reloadForRecovery(
    { reloadWindow: async () => { bridgeCalls += 1; return true; } },
    () => { browserCalls += 1; },
  );

  assert.equal(reloaded, true);
  assert.equal(bridgeCalls, 1);
  assert.equal(browserCalls, 0);
});

test('browser error recovery retains its unload-aware fallback', async () => {
  let browserCalls = 0;
  const reloaded = await reloadForRecovery({}, () => { browserCalls += 1; });

  assert.equal(reloaded, true);
  assert.equal(browserCalls, 1);
});

test('each chat session gets an independently resettable error boundary', () => {
  const child = createElement('span', null, 'session');
  const element = ChatSessionBoundary({
    tabId: 'chat-1',
    active: true,
    children: child,
  }) as ReactElement<{
    children: unknown;
    className: string;
    resetKey: string;
  }>;

  assert.equal(element.type, LazyLoadBoundary);
  assert.equal(element.props.className, chatStatusClass);
  assert.equal(element.props.resetKey, 'chat-1:active');
  assert.equal(element.props.children, child);
});
