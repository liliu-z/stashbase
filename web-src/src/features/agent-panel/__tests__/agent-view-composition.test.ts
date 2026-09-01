import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AgentView } from '@/features/agent-panel/components/AgentView';
import { AgentComposer } from '@/features/agent-panel/components/AgentComposer';
import { BuildWikiPagesAction } from '@/features/agent-panel/components/AgentEmptyState';
import { ScopeMenu } from '@/common/components/ScopeMenu';
import { notifyAgentInstructionsSaved } from '@/common/lib/agentInstructionsTrigger';
import type { LibraryScope } from '@/common/lib/libraryScope';
import { SimilaritySearchControl } from '@/features/agent-panel/components/SimilaritySearchControl';
import { AGENT_META } from '@/common/lib/agentCatalog';
import { AppProviders, type AppActions } from '@/store/contexts/AppContext';
import { initialState, type State } from '@/store/state/state';

/** Smoke coverage for AgentView's post-decomposition wiring: does the
 *  runtime gate render from `useAgentSession`'s discovery state, and does
 *  the composer receive the scope/model/effort shape `useAgentSession`
 *  computes. Full protocol/turn behavior is covered end-to-end by
 *  `agent-view-lifecycle.test.ts`; this file only guards that AgentView's
 *  extracted pieces (`useAgentSession`, `useAgentAttachments`,
 *  `AgentRuntimeGate`) are actually composed together correctly. */

class StubWebSocket {
  static OPEN = 1;
  static instances: StubWebSocket[] = [];
  readyState = StubWebSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string) { StubWebSocket.instances.push(this); }
  send(value: string): void { this.sent.push(value); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  event(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

function actionsStub(): AppActions {
  return new Proxy({}, {
    get: (_target, property) => {
      if (property === 'toast') return () => 'toast';
      if (property === 'loadFiles') return async () => [];
      return async () => undefined;
    },
  }) as AppActions;
}

function rendererState(withRuntime: boolean): State {
  return {
    ...initialState,
    workspace: { ...initialState.workspace, folder: 'workspace', folderPath: '/workspace', embedderHasKey: withRuntime ? true : null },
    chat: { ...initialState.chat, agents: withRuntime ? [{
      id: 'codex',
      label: 'Codex',
      vendor: 'OpenAI',
      installHint: 'npm install -g @openai/codex',
      installed: true,
      launchCommand: 'codex',
      endpoint: '/ws/agent',
      state: 'available',
      capabilities: AGENT_META.codex.capabilities,
    }] : [] },
  };
}

async function mountAgentView(t: TestContext, withRuntime: boolean) {
  const previous: Record<string, unknown> = {};
  const keys = ['WebSocket', 'window', 'location', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', 'HTMLElement', 'SVGElement'];
  for (const key of keys) previous[key] = (globalThis as Record<string, unknown>)[key];
  const previousActFlag = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  const previousReact = (globalThis as { React?: typeof React }).React;
  StubWebSocket.instances = [];
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: StubWebSocket });
  /* A real (tiny) event bus, not a pair of no-ops: the panel now takes one
   * input through a window CustomEvent — a saved Agent Instructions edit —
   * and a swallowed listener would let that path pass by never running. */
  const listeners = new Map<string, Set<(event: Event) => void>>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: Object.assign(globalThis, {
      addEventListener: (type: string, fn: (event: Event) => void) => {
        const set = listeners.get(type) ?? new Set<(event: Event) => void>();
        listeners.set(type, set);
        set.add(fn);
      },
      removeEventListener: (type: string, fn: (event: Event) => void) => {
        listeners.get(type)?.delete(fn);
      },
      dispatchEvent: (event: Event) => {
        for (const fn of listeners.get(event.type) ?? []) fn(event);
        return true;
      },
    }),
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { addEventListener: () => {}, removeEventListener: () => {}, documentElement: { lang: 'en', dir: 'ltr' }, body: {} },
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (cb: FrameRequestCallback) => { cb(0); return 1; } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: class TestHTMLElement { focus(): void {} } });
  Object.defineProperty(globalThis, 'SVGElement', { configurable: true, value: class TestSVGElement {} });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'http:', host: 'localhost:47831' } });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { React?: typeof React }).React = React;

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(AppProviders, {
      state: rendererState(withRuntime),
      dispatch: () => {},
      actions: actionsStub(),
      children: React.createElement(AgentView, { active: true, id: 'tab-1', title: 'Untitled', agent: 'codex' }),
    }));
  });
  t.after(() => {
    act(() => renderer.unmount());
    for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActFlag;
    (globalThis as { React?: typeof React }).React = previousReact;
  });
  return { renderer, first: StubWebSocket.instances[0] };
}

test('AgentRuntimeGate renders the checking card while useAgentSession has no runtime descriptor yet', async (t) => {
  const { renderer, first } = await mountAgentView(t, false);
  assert.equal(first, undefined, 'no socket connects before a runtime descriptor exists');
  const output = JSON.stringify(renderer.toJSON());
  assert.match(output, /Checking whether its local CLI is installed/);
  assert.match(output, /"Codex"/);
  assert.match(output, /Build Wiki/);
  assert.throws(() => renderer.root.findByType(AgentComposer));
});

test('useAgentSession wires connected scope/model/effort state into the composer once a runtime is available', async (t) => {
  const { renderer, first } = await mountAgentView(t, true);
  assert.ok(first, 'a runtime descriptor opens the socket');
  await act(async () => { first!.event({ t: 'ready' }); });

  const composer = renderer.root.findByType(AgentComposer);
  assert.equal(composer.props.phase, 'live');
  assert.equal(composer.props.disabled, false);
  assert.equal(typeof composer.props.scope.onSet, 'function');
  assert.equal(typeof composer.props.model.onSet, 'function');
  assert.equal(typeof composer.props.effort.onSet, 'function');
  assert.equal(composer.props.scope.current.kind, 'folder');
  assert.deepEqual(composer.props.attachments.items, []);
  assert.equal(composer.props.attachments.uploading, false);
});

/** The retrieval policy rides the session scope popup's footer slot, which
 *  only mounts while the menu is open. Reading the slot element's props is
 *  what proves the wiring without driving a portal open. */
function similarityPolicy(renderer: ReactTestRenderer): {
  enabled: boolean;
  availabilityKnown: boolean;
  onChange: (enabled: boolean) => void;
} {
  const { footer } = renderer.root.findByType(ScopeMenu).props;
  assert.ok(React.isValidElement(footer) && footer.type === SimilaritySearchControl);
  return (footer as React.ReactElement<{
    enabled: boolean;
    availabilityKnown: boolean;
    onChange: (enabled: boolean) => void;
  }>).props;
}

test('Similarity Search is a live product policy carried by session scope, not the Agent mode control', async (t) => {
  const { renderer, first } = await mountAgentView(t, true);
  await act(async () => { first!.event({ t: 'ready' }); });

  const control = similarityPolicy(renderer);
  assert.equal(control.enabled, true);
  assert.equal(control.availabilityKnown, true);
  assert.ok(first!.sent.some((value) => {
    const event = JSON.parse(value) as { t: string; enabled?: boolean };
    return event.t === 'set-similarity-search' && event.enabled === true;
  }));

  await act(async () => { control.onChange(false); });
  assert.equal(similarityPolicy(renderer).enabled, false);
  assert.ok(first!.sent.some((value) => {
    const event = JSON.parse(value) as { t: string; enabled?: boolean };
    return event.t === 'set-similarity-search' && event.enabled === false;
  }));
  assert.equal(renderer.root.findByType(AgentComposer).props.mode.value, 'auto');
});

test('saving Agent Instructions for the connected scope remounts that session, another scope does not', async (t) => {
  const { renderer, first } = await mountAgentView(t, true);
  await act(async () => { first!.event({ t: 'ready' }); });
  const mounted = StubWebSocket.instances.length;

  // A different scope is somebody else's guidance.
  await act(async () => { notifyAgentInstructionsSaved({ kind: 'folder', path: '/another/folder' }); });
  assert.equal(StubWebSocket.instances.length, mounted, 'an unrelated scope leaves the session alone');

  // The session's own scope: instructions are injected at mount, so applying
  // the edit means mounting again.
  const scope = renderer.root.findByType(AgentComposer).props.scope.current as LibraryScope;
  assert.equal(scope.kind, 'folder');
  await act(async () => { notifyAgentInstructionsSaved(scope); });
  assert.ok(
    StubWebSocket.instances.length > mounted,
    'the connected scope remounts so the next turn runs with the new guidance',
  );
});

test('Build Wiki sends the same explicit action shown in the transcript', async (t) => {
  const { renderer, first } = await mountAgentView(t, true);
  await act(async () => { first!.event({ t: 'ready' }); });

  const action = renderer.root.findByType(BuildWikiPagesAction);
  assert.equal(action.props.pending, false);
  await act(async () => { action.props.onBuild(); });

  const prompt = first!.sent.map((value) => JSON.parse(value) as { t: string; text?: string }).find((message) => message.t === 'prompt');
  assert.equal(prompt?.text, 'Build or update Wiki Pages from these Sources.');
  const output = JSON.stringify(renderer.toJSON());
  assert.match(output, /Build or update Wiki Pages from these Sources\./);
});
