import './isolated-home.ts';
import assert from 'node:assert/strict';
import { EventEmitter, on } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
import { agentCliPath } from '../agent-cli.ts';
import type { AgentAccessMode } from '../../shared/agent-runtime.ts';

function modeHarness(access: AgentAccessMode, folder = '/workspace', nativeStart = true) {
  const ws = new FakeWebSocket();
  const feed = new EventEmitter();
  const prompts: Array<{ agent: string }> = [];
  const replies: Array<{ path: { permissionID: string }; body: { response: string } }> = [];
  const session = new OpenCodePanelSession(ws as unknown as WebSocket, {
    windowId: 'mode-window', folder, access,
  }, {
    async client(directory) {
      return {
        event: { subscribe: async ({ signal }: { signal: AbortSignal }) => ({
          stream: (async function* () {
            for await (const [event] of on(feed, 'event', { signal })) yield event;
          })(),
        }) },
        session: {
          create: async () => ({ data: { id: 'mode-session', title: 'New Chat', directory } }),
          promptAsync: async ({ body }: { body: { agent: string } }) => {
            prompts.push(body);
            if (nativeStart) feed.emit('event', { type: 'session.status', properties: { sessionID: 'mode-session', status: { type: 'busy' } } });
            return { data: true };
          },
          abort: async () => ({ data: true }),
        },
        postSessionIdPermissionsPermissionId: async (reply: typeof replies[number]) => { replies.push(reply); return { data: true }; },
      } as never;
    },
    beginTurn: () => {}, endTurn: () => {}, onExit: () => () => {}, close: async () => {},
  });
  return { ws, feed, session, prompts, replies,
    send: (event: unknown) => ws.emit('message', Buffer.from(JSON.stringify(event))),
    events: () => ws.sent.map(value => JSON.parse(value)),
  };
}

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

test('Default does not silently complete after tools followed by an empty unknown model response', async (t) => {
  const harness = modeHarness('acceptEdits');
  t.after(() => harness.session.dispose());
  await settle();
  harness.send({ t: 'prompt', text: 'Read my profile and finish the setup.' });
  await settle();
  const part = (value: Record<string, unknown>, messageID = 'read-message') => {
    harness.feed.emit('event', { type: 'message.part.updated', properties: { part: {
      id: `${messageID}-${value.type}`, sessionID: 'mode-session', messageID, ...value,
    } } });
  };
  part({ type: 'tool', callID: 'read-profile', tool: 'stashbase_read_file', state: {
    status: 'completed', input: { path: '/workspace/profile.md' }, output: 'Profile',
    title: 'Read profile', metadata: {}, time: { start: 1, end: 2 },
  } });
  // Sanitized replay of the reported turn: a completed read, then a model
  // message with no text/tools, zero output tokens and finish=unknown.
  const tokens = { input: 5476, output: 0, reasoning: 0, cache: { read: 15975, write: 0 } };
  part({ type: 'step-start' }, 'empty-message');
  part({ type: 'step-finish', reason: 'unknown', tokens, cost: 0 }, 'empty-message');
  harness.feed.emit('event', { type: 'message.updated', properties: { info: {
    id: 'empty-message', sessionID: 'mode-session', role: 'assistant',
    parentID: 'request', finish: 'unknown', tokens, time: { created: 3, completed: 4 },
  } } });
  harness.feed.emit('event', { type: 'session.status', properties: { sessionID: 'mode-session', status: { type: 'idle' } } });
  harness.feed.emit('event', { type: 'session.idle', properties: { sessionID: 'mode-session' } });
  await settle();
  assert.ok(harness.events().some(event => event.t === 'tool-result'));
  assert.equal(harness.events().some(event => event.t === 'turn-end' && !event.isError), false,
    'an empty unknown response must not report successful completion');
  assert.ok(harness.events().some(event => event.t === 'error'), 'the incomplete turn must explain the failure');
});

test('Default errors wait for native idle and late message errors cannot fail the next turn', () => {
  const translator = new OpenCodeEventTranslator();
  translator.bindSession('session-1');
  const busy: Event = { type: 'session.status', properties: { sessionID: 'session-1', status: { type: 'busy' } } };
  const idle: Event = { type: 'session.status', properties: { sessionID: 'session-1', status: { type: 'idle' } } };
  const error = { name: 'APIError', data: { message: 'The model returned an empty response.', isRetryable: false } } as const;
  const message = (id: string, failed = false) => ({
    type: 'message.updated', properties: { info: { id, sessionID: 'session-1', role: 'assistant', ...(failed ? { error } : {}) } },
  }) as unknown as Event;
  translator.beginTurn();
  translator.translate(busy);
  translator.translate(message('failed-message'));
  assert.deepEqual(translator.translate({ type: 'session.error', properties: { sessionID: 'session-1', error } }), [
    { t: 'error', message: error.data.message },
  ]);
  assert.equal(translator.isTurnActive(), true, 'native cleanup must finish before another prompt is admitted');
  assert.deepEqual(translator.translate(idle), [{ t: 'turn-end', isError: true }]);
  translator.beginTurn();
  assert.deepEqual(translator.translate(message('failed-message', true)), [], 'trailing error belongs to the old turn');
  translator.translate(busy);
  translator.translate(message('next-message'));
  assert.deepEqual(translator.translate(message('next-message', true)), [{ t: 'error', message: error.data.message }],
    'the same failure in a new message must still be reported');
  assert.deepEqual(translator.translate(idle), [{ t: 'turn-end', isError: true }]);
});

test('Default Agent applies the selected mode to each turn and freezes it while working', async () => {
  const { session, prompts, send, feed } = modeHarness('plan');
  try {
    await settle();
    send({ t: 'prompt', text: 'Explore the draft' });
    await settle();
    assert.equal(prompts[0]?.agent, 'stashbase-plan');
    feed.emit('event', { type: 'session.idle', properties: { sessionID: 'mode-session' } });
    await settle();
    send({ t: 'set-mode', mode: 'acceptEdits' });
    send({ t: 'prompt', text: 'Edit my draft' });
    await settle();
    assert.equal(prompts[1]?.agent, 'stashbase-edit');
    send({ t: 'set-mode', mode: 'default' });
    send({ t: 'prompt', text: 'Do not overlap a running turn' });
    await settle();
    assert.equal(prompts.length, 2);
    feed.emit('event', { type: 'session.idle', properties: { sessionID: 'mode-session' } });
    await settle();
    send({ t: 'prompt', text: 'The running turn did not change mode' });
    await settle();
    assert.equal(prompts[2]?.agent, 'stashbase-edit');
  } finally { session.dispose(); }
});

// Auto is not offered for Default; a chat that opens asking for it runs as Edit.
for (const access of ['default', 'acceptEdits', 'plan', 'auto'] as const) {
  test(`Default ${access} handles scoped edits, commands, and pending approvals`, async (t) => {
    const effective = access === 'auto' ? 'acceptEdits' : access;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-mode-'));
    const folder = path.join(root, 'project');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(folder); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(folder, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const harness = modeHarness(access, folder);
    t.after(() => { harness.session.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    await settle();
    harness.send({ t: 'prompt', text: 'Work on my draft' });
    await settle();
    for (const [id, tool, input] of [
      ['edit', 'stashbase_edit_file', { path: path.join(folder, 'note.md') }],
      ['write', 'stashbase_write_file', { path: path.join(folder, 'new.md') }],
      ['escape', 'stashbase_write_file', { path: path.join(folder, 'escape', 'new.md') }],
      ['delete', 'stashbase_delete_file', { path: path.join(folder, 'note.md') }],
      ['command', 'bash', { command: 'node workflows/scripts/x-search.mjs 24' }],
    ] as const) {
      harness.feed.emit('event', { type: 'message.part.updated', properties: {
        part: { id, sessionID: 'mode-session', messageID: 'message', type: 'tool', callID: id, tool,
          state: { status: 'running', input, time: { start: 1 } } },
      } });
      const permission = { type: 'permission.asked', properties: {
        id: `permission-${id}`, sessionID: 'mode-session', permission: tool, patterns: ['*'], always: ['*'],
        metadata: input, tool: { messageID: 'message', callID: id },
      } };
      harness.feed.emit('event', permission);
      harness.feed.emit('event', permission);
      await settle();
      const automatic = effective === 'plan' || (effective === 'acceptEdits' && (id === 'edit' || id === 'write'));
      assert.equal(harness.events().filter(event => event.t === 'permission' && event.id === `permission-${id}`).length, automatic ? 0 : 1);
      if (!automatic) harness.send({ t: 'permission-reply', id: `permission-${id}`, allow: true, always: true });
      await settle();
      assert.deepEqual(harness.replies.filter(reply => reply.path.permissionID === `permission-${id}`).map(reply => reply.body.response), [effective === 'plan' ? 'reject' : 'once']);
    }
    harness.send({ t: 'permission-reply', id: 'unrequested', allow: true });
    await settle();
    assert.equal(harness.replies.length, 5);
  });
}

test('Default approvals wait for MCP arguments and Stop rejects late grants', async (t) => {
  const harness = modeHarness('acceptEdits');
  t.after(() => harness.session.dispose());
  await settle();
  harness.send({ t: 'prompt', text: 'Edit the draft' });
  await settle();
  const permission = (id: string, tool = 'stashbase_write_file') => ({
    type: 'permission.asked', properties: {
      id, sessionID: 'mode-session', permission: tool, patterns: ['*'], always: ['*'], metadata: {},
      tool: { messageID: 'message', callID: id },
    },
  });
  harness.feed.emit('event', permission('early'));
  await settle();
  assert.equal(harness.replies.length, 0, 'a tool name alone grants no write');
  assert.equal(harness.events().filter(event => event.t === 'permission').length, 0);
  harness.feed.emit('event', { type: 'message.part.updated', properties: {
    part: { id: 'early', sessionID: 'mode-session', messageID: 'message', type: 'tool', callID: 'early', tool: 'stashbase_write_file',
      state: { status: 'running', input: { path: '/workspace/new.md' }, time: { start: 1 } } },
  } });
  await settle();
  assert.deepEqual(harness.replies.map(reply => reply.body.response), ['once']);
  harness.feed.emit('event', permission('command', 'bash'));
  await settle();
  assert.equal(harness.events().filter(event => event.t === 'permission').length, 1);
  harness.send({ t: 'interrupt' });
  harness.send({ t: 'permission-reply', id: 'command', allow: true });
  harness.feed.emit('event', permission('late'));
  await settle();
  assert.deepEqual(harness.replies.map(reply => [reply.path.permissionID, reply.body.response]), [['early', 'once'], ['late', 'reject']]);
});

test('Stop settles a Default submission even before native busy is published', async (t) => {
  const harness = modeHarness('default', '/workspace', false);
  t.after(() => harness.session.dispose());
  await settle();
  harness.send({ t: 'prompt', text: 'Start work' });
  await settle();
  assert.equal(harness.session.turnInFlight(), true);
  harness.send({ t: 'interrupt' });
  await settle();
  assert.equal(harness.session.turnInFlight(), false);
  assert.deepEqual(harness.events().filter(event => event.t === 'turn-end'), [{ t: 'turn-end', isError: false }]);
});

test('OpenCode history distinguishes allocated blanks from started conversations', () => {
  assert.equal(openCodeSessionHasContent({ title: 'New Chat' }, 0), false);
  assert.equal(openCodeSessionHasContent({ title: 'New Chat' }, 2), true);
  assert.equal(openCodeSessionHasContent({ title: 'Summarize the research folder' }, 0), true);
});

test('a trailing native idle event cannot finish the next submitted Default turn', () => {
  const translator = new OpenCodeEventTranslator();
  translator.bindSession('session-1');
  translator.beginTurn();
  translator.translate({ type: 'session.status', properties: { sessionID: 'session-1', status: { type: 'busy' } } });
  assert.deepEqual(translator.translate({ type: 'session.status', properties: { sessionID: 'session-1', status: { type: 'idle' } } }), [{ t: 'turn-end', isError: false }]);
  translator.beginTurn();
  assert.deepEqual(translator.translate({ type: 'session.idle', properties: { sessionID: 'session-1' } }), []);
  assert.equal(translator.isTurnActive(), true);
  translator.translate({ type: 'session.status', properties: { sessionID: 'session-1', status: { type: 'busy' } } });
  assert.deepEqual(translator.translate({ type: 'session.idle', properties: { sessionID: 'session-1' } }), [{ t: 'turn-end', isError: false }]);
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
    PATH: agentCliPath([], '/usr/bin'),
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    SSL_CERT_FILE: '/private/cert.pem',
  });
});

test('Default Agent commands find installed Node from a macOS desktop PATH', { skip: process.platform !== 'darwin' }, () => {
  const result = spawnSync('/bin/zsh', ['-c', 'node -p process.versions.node'], {
    encoding: 'utf8',
    env: safeOpenCodeInheritedEnvironment({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh' }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('bundled OpenCode config disables sharing and updates while asking for every risky local action', () => {
  const config = buildOpenCodeConfig({
    apiKey: 'loopback-secret', baseUrl: 'http://127.0.0.1:1234/v1', model: 'stashbase-agent-default',
  }, '/private/stashbase-mcp');
  assert.equal(config.autoupdate, false);
  assert.equal(config.share, 'disabled');
  assert.deepEqual(config.enabled_providers, ['stashbase']);
  assert.equal(config.permission?.edit, 'deny');
  assert.equal(config.permission?.bash, 'ask');
  assert.equal(config.permission?.external_directory, 'ask');
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
  assert.deepEqual(translator.translate({ type: 'session.status', properties: { sessionID: 'session-1', status: { type: 'busy' } } }), []);

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

test('OpenCode forwards current external-directory permission requests to the reader', () => {
  const translator = new OpenCodeEventTranslator();
  translator.bindSession('session-1');
  const event = {
    id: 'event-1', type: 'permission.asked' as const,
    properties: {
      id: 'permission-1', sessionID: 'session-1', permission: 'external_directory',
      patterns: ['/outside/*'], always: ['/outside/*'],
      metadata: { filepath: '/outside/reference.txt' },
      tool: { messageID: 'message-1', callID: 'call-1' },
    },
  };
  assert.deepEqual(translator.translate(event), [{
    t: 'permission', id: 'permission-1', toolUseId: 'call-1',
    name: 'external_directory', title: null, input: { filepath: '/outside/reference.txt' },
  }]);
  assert.deepEqual(translator.translate({
    ...event, properties: { ...event.properties, sessionID: 'other-session' },
  }), []);
});
