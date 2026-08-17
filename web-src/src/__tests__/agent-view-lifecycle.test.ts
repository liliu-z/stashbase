import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { AgentView } from '../components/AgentView';
import { MessageList } from '../components/agent/AgentMessages';
import { AgentComposer } from '../components/agent/AgentComposer';
import { AGENT_META } from '../agentCatalog';
import { api } from '../api';
import { AppContext, type AppActions } from '../store/AppContext';
import { initialState, type State } from '../store/state';

class LifecycleWebSocket {
  static OPEN = 1;
  static instances: LifecycleWebSocket[] = [];
  readyState = LifecycleWebSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    LifecycleWebSocket.instances.push(this);
  }

  send(value: string): void { this.sent.push(value); }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  event(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
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

function rendererState(): State {
  return {
    ...initialState,
    folder: 'workspace',
    folderPath: '/workspace',
    agents: [{
      id: 'codex',
      label: 'Codex',
      vendor: 'OpenAI',
      installHint: 'npm install -g @openai/codex',
      installed: true,
      launchCommand: 'codex',
      endpoint: '/ws/agent',
      state: 'available',
      capabilities: AGENT_META.codex.capabilities,
    }],
  };
}

function renderedText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function buttonNamed(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAll((node) => node.type === 'button' && node.children.includes(label))[0];
  assert.ok(button, `expected ${label} button`);
  return button;
}

async function mountAgentView(t: TestContext, state = rendererState()) {
  const previousWebSocket = globalThis.WebSocket;
  const previousWindow = globalThis.window;
  const previousLocation = globalThis.location;
  const previousDocument = globalThis.document;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousSVGElement = globalThis.SVGElement;
  const previousAddEventListener = globalThis.addEventListener;
  const previousRemoveEventListener = globalThis.removeEventListener;
  const previousActFlag = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  const previousReact = (globalThis as { React?: typeof React }).React;
  LifecycleWebSocket.instances = [];
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: LifecycleWebSocket });
  const browserWindow = Object.assign(globalThis, {
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browserWindow });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      addEventListener: () => {},
      removeEventListener: () => {},
      documentElement: { lang: 'en', dir: 'ltr' },
      body: {},
    },
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  });
  Object.defineProperty(globalThis, 'HTMLElement', {
    configurable: true,
    value: class TestHTMLElement { focus(): void {} },
  });
  Object.defineProperty(globalThis, 'SVGElement', {
    configurable: true,
    value: class TestSVGElement {},
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { protocol: 'http:', host: 'localhost:47831' },
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { React?: typeof React }).React = React;

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(
      AppContext.Provider,
      { value: { state, dispatch: () => {}, actions: actionsStub() } },
      React.createElement(AgentView, { active: true, id: 'tab-1', title: 'Untitled', agent: 'codex' }),
    ));
  });
  t.after(() => {
    act(() => renderer.unmount());
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: previousWebSocket });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, 'location', { configurable: true, value: previousLocation });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: previousRequestAnimationFrame });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: previousCancelAnimationFrame });
    Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, 'SVGElement', { configurable: true, value: previousSVGElement });
    Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value: previousAddEventListener });
    Object.defineProperty(globalThis, 'removeEventListener', { configurable: true, value: previousRemoveEventListener });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActFlag;
    (globalThis as { React?: typeof React }).React = previousReact;
  });

  return { renderer, first: LifecycleWebSocket.instances[0]! };
}

test('failed runtime setup keeps Check again available after external recovery', async (t) => {
  const state = rendererState();
  state.agents = [{
    ...state.agents[0]!,
    installed: false,
    source: null,
    state: 'unavailable',
    bootstrap: {
      phase: 'failed',
      failure: {
        stage: 'installation',
        code: 'operation-failed',
        message: 'Download failed.',
        retryable: true,
        manualRecovery: 'install-command',
      },
    },
  }];

  let checks = 0;
  t.mock.method(api, 'prepareAgent', async () => {
    checks += 1;
    return { clis: state.agents };
  });
  const { renderer } = await mountAgentView(t, state);

  buttonNamed(renderer.root, 'Check again');
  buttonNamed(renderer.root, 'Retry');
  const checkAgain = renderer.root.findAll((node) => (
    node.props.children === 'Check again' && typeof node.props.onPress === 'function'
  ))[0];
  assert.ok(checkAgain);
  await act(async () => { checkAgain.props.onPress(); });
  assert.equal(checks, 1);
});

test('Codex authentication recovery starts login with the installed runtime', async (t) => {
  const state = rendererState();
  state.agents = [{
    ...state.agents[0]!,
    installed: true,
    source: 'managed',
    state: 'available',
    bootstrap: {
      phase: 'failed',
      failure: {
        stage: 'authentication',
        code: 'authentication-required',
        message: 'Codex is installed, but it is not signed in.',
        retryable: true,
      },
    },
  }];

  let logins = 0;
  t.mock.method(api, 'prepareAgent', async (
    _agent: 'claude' | 'codex',
    action: 'check' | 'bootstrap' | 'login',
  ) => {
    if (action === 'login') logins += 1;
    return {
      clis: [{
        ...state.agents[0]!,
        bootstrap: { phase: 'authenticating', message: 'Finish signing in to Codex in your browser…' },
      }],
    };
  });
  const { renderer } = await mountAgentView(t, state);

  buttonNamed(renderer.root, 'Sign in with ChatGPT');
  const signIn = renderer.root.findAll((node) => (
    node.props.children === 'Sign in with ChatGPT' && typeof node.props.onPress === 'function'
  ))[0];
  assert.ok(signIn);
  await act(async () => { signIn.props.onPress(); });
  assert.equal(logins, 1);
});

test('mounted AgentView ready → raw close renders recovery and reconnects with transcript + resume', async (t) => {
  const { renderer, first } = await mountAgentView(t);
  await act(async () => {
    first.event({ t: 'ready' });
    first.event({ t: 'session-id', id: 'thread-123' });
    first.event({ t: 'turn-start' });
    first.event({ t: 'text', delta: String.raw`Streamed formula: \(x^2` });
    first.event({ t: 'text', delta: String.raw` + 1\).` });
    first.event({ t: 'turn-end', isError: false });
  });
  assert.match(renderedText(renderer), /Streamed formula:.*x\^2.*1/);

  await act(async () => {
    first.event({ t: 'turn-start' });
    first.event({ t: 'text', delta: 'Partial answer survives.' });
    first.event({ t: 'tool', id: 'tool-1', name: 'Bash', input: {} });
  });
  await act(async () => { first.close(); });

  let output = renderedText(renderer);
  assert.match(output, /"role":"log"/);
  assert.match(output, /"aria-label":"Agent conversation"/);
  assert.match(output, /Partial answer survives/);
  assert.match(output, /Codex disconnected unexpectedly/);
  assert.match(output, /Reconnect/);
  assert.doesNotMatch(output, /Codex is working/);
  assert.doesNotMatch(output, /Running/);
  assert.equal(renderer.root.findByType(AgentComposer).props.effort.locked, true);

  buttonNamed(renderer.root, 'Reconnect');
  await act(async () => { renderer.root.findByType(MessageList).props.onRetry(); });

  assert.equal(LifecycleWebSocket.instances.length, 2);
  assert.match(LifecycleWebSocket.instances[1]!.url, /[?&]resume=thread-123(?:&|$)/);
  output = renderedText(renderer);
  assert.match(output, /Partial answer survives/);
  assert.doesNotMatch(output, /Codex disconnected unexpectedly/);

  await act(async () => {
    LifecycleWebSocket.instances[1]!.event({ t: 'ready' });
    LifecycleWebSocket.instances[1]!.event({ t: 'exit', message: 'Codex app-server exited with code 9.' });
    LifecycleWebSocket.instances[1]!.close();
  });
  output = renderedText(renderer);
  assert.match(output, /Codex app-server exited with code 9/);
  assert.equal((output.match(/Codex app-server exited with code 9/g) ?? []).length, 1);
  assert.match(output, /Reconnect/);
});

test('edit-and-resend interrupts an active turn before starting the edited prompt', async (t) => {
  const { renderer, first } = await mountAgentView(t);
  await act(async () => {
    first.event({ t: 'ready' });
    renderer.root.findByType(AgentComposer).props.onSend('Original prompt');
    first.event({ t: 'turn-start' });
    first.event({ t: 'thinking', delta: 'Working on the original prompt' });
  });

  const sentBeforeResend = first.sent.length;
  await act(async () => {
    renderer.root.findByType(MessageList).props.onResendUserMessage('Edited prompt');
  });

  const resendWire = first.sent.slice(sentBeforeResend).map((entry) => JSON.parse(entry));
  assert.deepEqual(resendWire, [{ t: 'interrupt' }]);
  assert.deepEqual(renderer.root.findByType(MessageList).props.queuedTurns.map((turn: { text: string }) => turn.text), [
    'Edited prompt',
  ]);

  await act(async () => {
    first.event({ t: 'turn-end', isError: false });
  });

  const messages = renderer.root.findByType(MessageList).props;
  assert.equal(messages.queuedTurns.length, 0);
  assert.equal(messages.blocks.at(-1)?.kind, 'user');
  assert.equal(messages.blocks.at(-1)?.text, 'Edited prompt');
  assert.equal(messages.turnActive, true);
  assert.deepEqual(JSON.parse(first.sent.at(-1)!), { t: 'prompt', text: 'Edited prompt' });

  const output = renderedText(renderer);
  const editedPosition = output.indexOf('Edited prompt');
  const workingPosition = output.indexOf(' is working');
  assert.match(output, /You stopped/);
  assert.ok(
    editedPosition >= 0 && workingPosition >= 0 && editedPosition < workingPosition,
    JSON.stringify({ editedPosition, workingPosition }),
  );
});
