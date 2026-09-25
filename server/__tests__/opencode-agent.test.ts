import './isolated-home.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Event } from '@opencode-ai/sdk';
import type { WebSocket } from 'ws';
import {
  blocksForMessage,
  OpenCodeEventTranslator,
  OpenCodePanelSession,
  openCodeSessionHasContent,
} from '../opencode-agent.ts';
import { buildOpenCodeConfig, safeOpenCodeInheritedEnvironment, type OpenCodeSessionRuntime } from '../opencode-runtime.ts';

class FakeWebSocket extends EventEmitter {
  OPEN = 1;
  readyState = this.OPEN;
  sent: string[] = [];

  send(value: string): void { this.sent.push(value); }
  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('OpenCode history distinguishes allocated blanks from started conversations', () => {
  assert.equal(openCodeSessionHasContent({ title: 'New Chat' }, 0), false);
  assert.equal(openCodeSessionHasContent({ title: 'New Chat' }, 2), true);
  assert.equal(openCodeSessionHasContent({ title: 'Summarize the research folder' }, 0), true);
});

test('the Default Agent publishes scope retirement once before closing its transport', () => {
  const ws = new FakeWebSocket();
  let closed = 0;
  const session = new OpenCodePanelSession(ws as unknown as WebSocket, {
    windowId: 'retire-window', folder: '/workspace',
  }, {
    client: async () => new Promise<never>(() => {}),
    beginTurn: () => {}, endTurn: () => {}, onExit: () => () => {},
    close: async () => { closed += 1; },
  });
  const termination = { kind: 'scope-removed' as const, folder: '/workspace' };
  session.dispose(termination);
  session.dispose(termination);
  assert.deepEqual(ws.sent.map((value) => JSON.parse(value)), [
    { t: 'exit', reason: 'scope-removed', folder: '/workspace' },
  ]);
  assert.equal(ws.readyState, 3);
  assert.equal(closed, 1);
});

test('bundled OpenCode inherits launch plumbing but no ambient credentials or injection flags', () => {
  assert.deepEqual(safeOpenCodeInheritedEnvironment({
    PATH: '/usr/bin',
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    SSL_CERT_FILE: '/private/cert.pem',
    OPENAI_API_KEY: 'provider-secret',
    STASHBASE_ACCESS_TOKEN: 'account-secret',
    OPENCODE_CONFIG: '/user/config.json',
    HTTPS_PROXY: 'https://user:secret@proxy.invalid',
    NODE_OPTIONS: '--require /tmp/inject.cjs',
    ELECTRON_RUN_AS_NODE: '1',
  }), {
    PATH: '/usr/bin',
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    SSL_CERT_FILE: '/private/cert.pem',
  });
});

test('bundled OpenCode config disables sharing and updates while asking for every risky local action', () => {
  const config = buildOpenCodeConfig({
    apiKey: 'loopback-secret', baseUrl: 'http://127.0.0.1:1234/v1', model: 'stashbase-agent-default',
  }, '/private/stashbase-mcp');
  assert.equal(config.autoupdate, false);
  assert.equal(config.share, 'disabled');
  assert.deepEqual(config.enabled_providers, ['stashbase']);
  assert.equal(config.permission?.edit, 'ask');
  assert.equal(config.permission?.bash, 'ask');
  assert.equal(config.permission?.external_directory, 'deny');
  assert.equal(config.agent?.['stashbase-folder']?.mode, 'primary');
  assert.equal((config.permission as Record<string, unknown>).stashbase_write_file, 'ask');
  assert.equal((config.permission as Record<string, unknown>).stashbase_delete_file, 'ask');
  assert.equal((config.permission as Record<string, unknown>).stashbase_create_project, 'ask');
  assert.deepEqual(config.mcp?.stashbase, {
    type: 'local', command: ['/private/stashbase-mcp'], enabled: true, timeout: 10_000,
  });
  assert.equal(config.provider?.stashbase.options?.apiKey, 'loopback-secret');
  assert.equal(config.provider?.stashbase.options?.baseURL, 'http://127.0.0.1:1234/v1');

  const attributed = buildOpenCodeConfig({
    apiKey: 'loopback-secret', baseUrl: 'http://127.0.0.1:1234/v1', model: 'stashbase-agent-default',
  }, '/private/stashbase-mcp', { STASHBASE_WINDOW_ID: 'window-1', STASHBASE_AGENT_SESSION_ID: 'session-1' }, 'Use StashBase tools.');
  assert.deepEqual(attributed.mcp?.stashbase, {
    type: 'local',
    command: ['/private/stashbase-mcp'],
    environment: { STASHBASE_WINDOW_ID: 'window-1', STASHBASE_AGENT_SESSION_ID: 'session-1' },
    enabled: true,
    timeout: 10_000,
  });
  for (const profile of ['stashbase-folder'] as const) {
    const prompt = attributed.agent?.[profile]?.prompt ?? '';
    assert.match(prompt, /StashBase MCP/i);
    assert.match(prompt, /search_project/);
    assert.match(prompt, /read_file/);
    assert.match(prompt, /Use StashBase tools\./);
    assert.notEqual(prompt, 'Use StashBase tools.');
  }
});

test('an unexpected bundled runtime exit terminates the panel instead of leaving a turn working', async () => {
  const ws = new FakeWebSocket();
  let exitListener: ((error: Error) => void) | null = null;
  let closeCalls = 0;
  const runtime: OpenCodeSessionRuntime = {
    async client(directory) {
      return {
        event: {
          subscribe: async ({ signal }: { signal?: AbortSignal } = {}) => ({
            stream: (async function* () {
              await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
            })(),
          }),
        },
        session: {
          create: async () => ({ data: { id: 'session-1', title: 'New Chat', directory } }),
          update: async () => ({ data: true }),
          promptAsync: async () => ({ data: true }),
          abort: async () => ({ data: true }),
        },
      } as never;
    },
    beginTurn: () => {},
    endTurn: () => {},
    onExit(listener) {
      exitListener = listener;
      return () => { exitListener = null; };
    },
    close: async () => { closeCalls += 1; },
  };
  new OpenCodePanelSession(ws as unknown as WebSocket, {
    windowId: 'runtime-exit-window',
    folder: '/workspace',
  }, runtime);
  await settle();
  ws.emit('message', Buffer.from(JSON.stringify({ t: 'prompt', text: 'hi' })));
  await settle();

  assert.ok(exitListener);
  (exitListener as (error: Error) => void)(new Error('The included Agent runtime exited unexpectedly (SIGKILL).'));
  await settle();

  const events = ws.sent.map((value) => JSON.parse(value) as { t: string; message?: string });
  assert.ok(events.some((event) => event.t === 'turn-start'));
  assert.ok(events.some((event) => event.t === 'error' && event.message?.includes('SIGKILL')));
  assert.ok(events.some((event) => event.t === 'exit' && event.message?.includes('SIGKILL')));
  assert.equal(ws.readyState, 3);
  assert.equal(closeCalls, 1);
});

test('OpenCode events normalize into the Shared Agent Contract without duplicate cumulative content', () => {
  const translator = new OpenCodeEventTranslator();
  translator.bindSession('session-1');
  assert.deepEqual(translator.beginTurn(), [{ t: 'turn-start' }]);

  const text = (value: string, delta?: string) => translator.translate({
    type: 'message.part.updated',
    properties: {
      part: { id: 'part-1', sessionID: 'session-1', messageID: 'message-1', type: 'text', text: value },
      ...(delta == null ? {} : { delta }),
    },
  });
  assert.deepEqual(text('Hel'), [{ t: 'text', delta: 'Hel' }]);
  assert.deepEqual(text('Hello'), [{ t: 'text', delta: 'lo' }]);
  assert.deepEqual(text('Hello!', '!'), [{ t: 'text', delta: '!' }]);

  const pending: Event = {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'tool-part', sessionID: 'session-1', messageID: 'message-1', type: 'tool',
        callID: 'call-1', tool: 'read',
        state: { status: 'pending', input: {}, raw: '{"path":' },
      },
    },
  };
  assert.deepEqual(translator.translate(pending), []);

  const running: Event = {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'tool-part', sessionID: 'session-1', messageID: 'message-1', type: 'tool',
        callID: 'call-1', tool: 'read',
        state: { status: 'running', input: { path: 'notes.md' }, time: { start: 1 } },
      },
    },
  };
  assert.deepEqual(translator.translate(running), [
    { t: 'tool', id: 'call-1', name: 'Read', input: { path: 'notes.md' } },
  ]);
  assert.deepEqual(translator.translate(running), []);

  assert.deepEqual(translator.translate({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'tool-part', sessionID: 'session-1', messageID: 'message-1', type: 'tool',
        callID: 'call-1', tool: 'read',
        state: {
          status: 'completed', input: { path: 'notes.md' }, output: 'contents', title: 'Read notes.md',
          metadata: {}, time: { start: 1, end: 2 },
        },
      },
    },
  }), [{ t: 'tool-result', id: 'call-1', content: 'contents', isError: false }]);

  assert.deepEqual(translator.translate({
    type: 'permission.updated',
    properties: {
      id: 'permission-1', sessionID: 'session-1', messageID: 'message-1', callID: 'call-1',
      type: 'bash', title: 'Run command?', metadata: { command: 'pwd' }, time: { created: 1 },
    },
  }), [{
    t: 'permission', id: 'permission-1', toolUseId: 'call-1', name: 'Read', title: 'Run command?',
    input: { command: 'pwd' },
  }]);

  assert.deepEqual(translator.translate({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'bash-part', sessionID: 'session-1', messageID: 'message-1', type: 'tool',
        callID: 'call-2', tool: 'bash',
        state: { status: 'running', input: { command: 'pwd' }, time: { start: 1 } },
      },
    },
  }), [{ t: 'tool', id: 'call-2', name: 'Bash', input: { command: 'pwd' } }]);
  assert.deepEqual(translator.translate({
    type: 'permission.updated',
    properties: {
      id: 'permission-2', sessionID: 'session-1', messageID: 'message-1', callID: 'call-2',
      type: 'bash', title: 'Run command?', metadata: { command: 'pwd' }, time: { created: 1 },
    },
  }), [{
    t: 'permission', id: 'permission-2', toolUseId: 'call-2', name: 'Bash', title: 'Run command?',
    input: { command: 'pwd' },
  }]);

  const diff: Event = {
    type: 'session.diff',
    properties: {
      sessionID: 'session-1',
      diff: [{ file: 'notes.md', before: 'old', after: 'new', additions: 1, deletions: 1 }],
    },
  };
  assert.deepEqual(translator.translate(diff), [{
    t: 'file-diff', id: 'diff:session-1:1', file: 'notes.md', before: 'old', after: 'new', additions: 1, deletions: 1,
  }]);
  assert.deepEqual(translator.translate(diff), []);
  assert.deepEqual(translator.translate({ type: 'session.idle', properties: { sessionID: 'session-1' } }), [
    { t: 'turn-end', isError: false },
  ]);
});

test('OpenCode translator never replays the reader\'s own prompt as Agent text', () => {
  const translator = new OpenCodeEventTranslator();
  translator.bindSession('session-1');
  translator.beginTurn();
  const message = (id: string, role: 'user' | 'assistant') => translator.translate({
    type: 'message.updated',
    properties: { info: { id, sessionID: 'session-1', role } },
  } as unknown as Event);
  const part = (messageID: string, text: string) => translator.translate({
    type: 'message.part.updated',
    properties: { part: { id: `${messageID}-part`, sessionID: 'session-1', messageID, type: 'text', text } },
  });

  assert.deepEqual(message('prompt-1', 'user'), []);
  assert.deepEqual(part('prompt-1', 'what do you understand?\n\nSelected passages:\n- /a.md\n  > quote'), []);
  assert.deepEqual(message('reply-1', 'assistant'), []);
  assert.deepEqual(part('reply-1', 'The passage says…'), [{ t: 'text', delta: 'The passage says…' }]);
});

test('OpenCode history returns a prompt\'s passage to its chip instead of raw text', () => {
  const quoted = 'what do you understand?\n\nSelected passages:\n- /home/me/notes/essay.md\n  > The tide rises.';
  const blocks = blocksForMessage(
    { id: 'prompt-1', sessionID: 'session-1', role: 'user' } as unknown as Parameters<typeof blocksForMessage>[0],
    [{ id: 'part-1', sessionID: 'session-1', messageID: 'prompt-1', type: 'text', text: quoted }] as unknown as Parameters<typeof blocksForMessage>[1],
  );
  assert.deepEqual(blocks, [{
    kind: 'user',
    id: 'prompt-1',
    text: 'what do you understand?',
    attachments: [{ path: '/home/me/notes/essay.md', name: 'essay.md', quote: 'The tide rises.' }],
  }]);
});

test('OpenCode translator isolates sessions and classifies hosted allowance failures', () => {
  const translator = new OpenCodeEventTranslator();
  translator.bindSession('ours');
  assert.deepEqual(translator.translate({ type: 'session.idle', properties: { sessionID: 'other' } }), []);
  translator.beginTurn();
  const events = translator.translate({
    type: 'session.error',
    properties: {
      sessionID: 'ours',
      error: { name: 'APIError', data: { message: 'Free Agent credits are exhausted', isRetryable: false } },
    },
  });
  assert.deepEqual(events, [
    { t: 'error', message: 'Free Agent credits are exhausted', failure: { kind: 'allowance-exhausted' } },
    { t: 'turn-end', isError: true },
  ]);
});
