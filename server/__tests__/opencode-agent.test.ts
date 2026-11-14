import './isolated-home.ts';
import assert from 'node:assert/strict';
import { EventEmitter, on } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
import { composeAgentRuntimeInstructions } from '../agent-runtime-instructions.ts';
import { agentProcessExitDiagnostic, ownAgentProcess, retireAgentProcess } from '../agent-process.ts';
import { waitForOpenCodeServer, retryOpenCodeHistoryStartup, retireFailedOpenCode } from '../opencode-startup.ts';
import { PassThrough } from 'node:stream';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { errorDiagnostic } from '../error-diagnostics.ts';
import { agentCliPath } from '../agent-cli.ts';
import type { HostedAgentTurnModel } from '../hosted-agent-broker.ts';
import type { HostedAgentProfile } from '../hosted-agent-models.ts';
import { enabledAgentTools, setDefaultAgentTool, type EnabledAgentTool } from '../default-agent-tools.ts';
import { parseToolCatalog } from '../agent-tool-catalog.ts';
import { readAppConfigStrict, writeAppConfigStrict } from '../app-config.ts';
import { crewCallHistory, forgetCrewCalls } from '../agent-crew-history.ts';
import type { AgentAccessMode } from '../../shared/agent-runtime.ts';
import { DIRECTORY_LINK } from './filesystem-links.ts';

function modeHarness(access: AgentAccessMode, folder = '/workspace', nativeStart = true, abortFailure = false, diagnostic?: () => unknown,
  review?: (signal?: AbortSignal) => Promise<string>, abort?: () => Promise<void>) {
  const ws = new FakeWebSocket();
  const feed = new EventEmitter();
  const prompts: Array<{ agent: string }> = [];
  const replies: Array<{ path: { permissionID: string }; body: { response: string } }> = [];
  const reviews: unknown[] = [];
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
          abort: async () => { if (abortFailure) throw new Error('Abort transport failed'); await abort?.(); return { data: true }; },
        },
        postSessionIdPermissionsPermissionId: async (reply: typeof replies[number]) => { replies.push(reply); return { data: true }; },
      } as never;
    },
    models: async () => [],
    ...(diagnostic ? { diagnostic } : {}),
    beginTurn: () => {}, endTurn: () => {}, tools: () => [],
    complete: async (model, messages, signal) => { reviews.push({ model, messages }); return review ? review(signal) : 'ASK'; },
    runTool: async () => ({ text: '', tool: '', model: '' }),
    onExit: () => () => {}, close: async () => {},
  });
  return { ws, feed, session, prompts, replies, reviews,
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

test('OpenCode startup exit retains its code or signal and bounded stderr', async (t) => {
  for (const killed of [false, true]) {
    const child = spawn(process.execPath, ['-e', "require('fs').writeSync(2, 'startup failure token=private-secret'); " +
      (killed ? 'setInterval(() => {}, 1000)' : 'process.exit(7)')], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { child.kill('SIGKILL'); });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    const waiting = waitForOpenCodeServer(child, 12345, agentProcessExitDiagnostic(child));
    if (killed) child.stderr.once('data', () => child.kill('SIGKILL'));
    await assert.rejects(waiting, error => {
      const diagnostic = errorDiagnostic(error);
      assert.match(diagnostic.message, /during startup/);
      if (!killed) assert.equal(diagnostic.exit_code, 7);
      else assert.equal(diagnostic.signal, 'SIGKILL');
      assert.match(diagnostic.stderr!, /startup failure/);
      assert.doesNotMatch(JSON.stringify(diagnostic), /private-secret/);
      return true;
    });
    await closed;
  }
});

test('OpenCode startup timeout preserves separate redacted output and releases every startup listener', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcessByStdio<null, Readable, Readable>;
  const diagnostic = agentProcessExitDiagnostic(child);
  let firstOutput = 0;
  const waiting = waitForOpenCodeServer(child, 12345, diagnostic, { timeoutMs: 10, onFirstOutput: () => firstOutput++ });
  (child.stdout as PassThrough).write('preparing state\n');
  (child.stderr as PassThrough).write('database busy token=SECRET\n');
  await assert.rejects(waiting, error => {
    const captured = errorDiagnostic(error);
    assert.equal(captured.code, 'OPENCODE_START_TIMEOUT');
    assert.match(captured.stdout!, /preparing state/);
    assert.match(captured.stderr!, /database busy/);
    assert.doesNotMatch(JSON.stringify(captured), /SECRET/);
    return true;
  });
  assert.equal(firstOutput, 1);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 1, 'only the lifetime stderr tail remains');
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount('exit'), 0);
});

test('OpenCode readiness waits for the complete stdout address and removes listeners on success or refusal', async () => {
  for (const port of [12345, 12346]) {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcessByStdio<null, Readable, Readable>;
    let ready = false;
    const waiting = waitForOpenCodeServer(child, 12345, agentProcessExitDiagnostic(child));
    void waiting.then(() => { ready = true; }, () => {});
    (child.stderr as PassThrough).write('opencode server listening on http://127.0.0.1:12345\n');
    (child.stdout as PassThrough).write('opencode server listening on http://127.0.0.1:123');
    await settle();
    assert.equal(ready, false);
    (child.stdout as PassThrough).write(`${String(port).slice(3)}\n`);
    if (port === 12345) assert.equal(await waiting, 'http://127.0.0.1:12345');
    else await assert.rejects(waiting, /unexpected address/);
    assert.equal(child.stdout.listenerCount('data'), 0);
    assert.equal(child.listenerCount('exit'), 0);
  }
});

test('history startup retry cannot overtake retirement of the failed real child', async (t) => {
  const child = ownAgentProcess(spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50));
    process.stderr.write('fixture ready'); setInterval(() => {}, 1000);
  `], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }));
  t.after(() => retireAgentProcess(child));
  await new Promise<void>(resolve => child.stderr.once('data', () => resolve()));
  let closed = false;
  child.once('close', () => { closed = true; });
  const attempts: number[] = [];
  const result = await retryOpenCodeHistoryStartup(async attempt => {
    attempts.push(attempt);
    if (attempt === 0) {
      try { await waitForOpenCodeServer(child, 12345, agentProcessExitDiagnostic(child), { timeoutMs: 10 }); }
      catch (error) { return retireFailedOpenCode(child, error); }
    }
    assert.equal(closed, true, 'the first process and its pipes must have closed');
    return 'history readable';
  }, () => false);
  assert.equal(result, 'history readable');
  assert.deepEqual(attempts, [0, 1]);
});

test('history startup retry is bounded and excludes cancellation, cleanup and prerequisite failures', async () => {
  for (const [code, cancelled, count] of [
    ['OPENCODE_START_TIMEOUT', false, 2], ['AGENT_PROCESS_EXIT', false, 2],
    ['OPENCODE_START_TIMEOUT', true, 1], ['OPENCODE_CLEANUP_FAILED', false, 1], ['ENOENT', false, 1],
  ] as const) {
    let attempts = 0;
    const error = Object.assign(new Error(code), { code });
    await assert.rejects(retryOpenCodeHistoryStartup(async () => { attempts++; throw error; }, () => cancelled), error);
    assert.equal(attempts, count);
  }
});

test('Stop retires attachment preparation before another turn and does not report a cancelled read failure', async (t) => {
  const harness = modeHarness('acceptEdits');
  t.after(() => harness.session.dispose());
  await settle();
  harness.send({ t: 'prompt', text: 'Read this', attachments: ['/unregistered/secret.txt'] });
  harness.send({ t: 'interrupt' });
  await settle();
  assert.equal(harness.prompts.length, 0);
  assert.equal(harness.events().some(event => event.t === 'error'), false);
  assert.ok(harness.events().some(event => event.t === 'turn-end'));
  harness.send({ t: 'prompt', text: 'Continue without the attachment' });
  await settle();
  assert.equal(harness.prompts.length, 1);
});

test('a failed Stop reports its cause and releases the Default turn for retry', async (t) => {
  const harness = modeHarness('default', '/workspace', false, true);
  t.after(() => harness.session.dispose());
  await settle();
  harness.send({ t: 'prompt', text: 'Start work' });
  await settle();
  harness.send({ t: 'interrupt' });
  await settle();
  assert.equal(harness.session.turnInFlight(), false);
  assert.ok(harness.events().some(event => event.t === 'error' && /Abort transport failed/.test(event.message)));
  harness.send({ t: 'prompt', text: 'Try another task' });
  await settle();
  assert.equal(harness.prompts.length, 2);
});

test('Stop keeps an aborted Crew call pending until acknowledgement and preserves cancellation in history', async (t) => {
  let acknowledge!: () => void;
  const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
  const h = modeHarness('default', '/workspace', true, false, undefined, undefined, () => acknowledgement);
  t.after(() => h.session.dispose());
  await settle();
  h.send({ t: 'prompt', text: 'Draft with Writer' });
  await settle();
  const part = { id: 'part', sessionID: 'mode-session', messageID: 'message', type: 'tool',
    callID: 'crew-call', tool: 'stashbase_write_draft',
    state: { status: 'running', input: { task: 'Draft' }, time: { start: 1 } } };
  h.feed.emit('event', { type: 'message.part.updated', properties: { part } });
  await settle();
  h.send({ t: 'interrupt' });
  const error = { name: 'MessageAbortedError', data: { message: 'Aborted' } };
  const aborted = { ...part, state: { ...part.state, status: 'error', error: 'Tool execution aborted', time: { start: 1, end: 2 } } };
  h.feed.emit('event', { type: 'message.part.updated', properties: { part: aborted } });
  h.feed.emit('event', { type: 'session.error', properties: { sessionID: 'mode-session', error } });
  h.feed.emit('event', { type: 'message.updated', properties: { info: { id: 'message', sessionID: 'mode-session', role: 'assistant', error } } });
  h.feed.emit('event', { type: 'session.idle', properties: { sessionID: 'mode-session' } });
  await settle();
  assert.equal(h.events().some(event => ['error', 'tool-result', 'turn-end'].includes(event.t)), false);
  assert.equal(h.session.turnInFlight(), true);
  acknowledge();
  await settle();
  assert.deepEqual(h.events().filter(event => event.t === 'turn-end'), [{ t: 'turn-end', isError: false }]);
  const replay = blocksForMessage({ role: 'assistant', error } as never, [aborted] as never);
  assert.equal(replay[0]?.kind === 'tool' && replay[0].status, 'cancelled');
});

test('attachment preparation refusal is visible and never submits a partial prompt', async (t) => {
  const harness = modeHarness('acceptEdits');
  t.after(() => harness.session.dispose());
  await settle();
  harness.send({ t: 'prompt', text: 'Read this', attachments: ['/unregistered/secret.txt'] });
  await settle();
  assert.equal(harness.prompts.length, 0);
  assert.ok(harness.events().some(event => event.t === 'error' && /this project/.test(event.message)));
  assert.ok(harness.events().some(event => event.t === 'turn-end' && event.isError));
});

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

test('context overflow waits for continuation, fails unfinished recovery, and respects cancellation', () => {
  const translator = new OpenCodeEventTranslator();
  translator.bindSession('session-1');
  const busy: Event = { type: 'session.status', properties: { sessionID: 'session-1', status: { type: 'busy' } } };
  const idle: Event = { type: 'session.idle', properties: { sessionID: 'session-1' } };
  const error = { name: 'ContextOverflowError', data: { message: 'The Agent request exceeds the model context limit.' } } as const;
  const overflow: Parameters<OpenCodeEventTranslator['translate']>[0] = { type: 'session.error', properties: { sessionID: 'session-1', error } };
  const message = (id: string, summary = false, failed = false) => ({ type: 'message.updated', properties: { info: {
    id, sessionID: 'session-1', role: 'assistant', summary, finish: failed ? 'error' : 'stop',
    tokens: { input: 1, output: 1, reasoning: 0 }, ...(failed ? { error } : {}),
  } } }) as Event;
  translator.translate(busy);
  assert.equal(translator.translate(overflow)[0]?.t, 'notice');
  assert.deepEqual(translator.translate(overflow), []);
  translator.translate(message('summary', true));
  const unfinished = translator.translate(idle);
  assert.ok(unfinished.some(event => event.t === 'error'), 'a summary alone is not a successful continuation');
  assert.deepEqual(unfinished.at(-1), { t: 'turn-end', isError: true });

  translator.translate(busy);
  translator.translate(overflow);
  translator.translate(message('failed-summary', true, true));
  translator.translate(message('unrelated-later-output'));
  assert.deepEqual(translator.translate(idle), [{ t: 'turn-end', isError: true }], 'a terminal message error remains a failure');

  translator.translate(busy);
  translator.translate(overflow);
  assert.deepEqual(translator.endTurnAfterInterrupt(), [{ t: 'turn-end', isError: false }]);
  translator.translate(busy);
  translator.translate(message('fresh-answer'));
  assert.deepEqual(translator.translate(idle), [{ t: 'turn-end', isError: false }], 'pending overflow cannot leak into a new turn');
});

test('repeated native retry status does not repeat the same provider error in one turn', () => {
  const translator = new OpenCodeEventTranslator();
  translator.bindSession('session-1');
  const retry = (message: string) => ({ type: 'session.status', properties: {
    sessionID: 'session-1', status: { type: 'retry', message, attempt: 1, next: 1000 },
  } }) as Event;
  const error = 'Too many Agent requests or too much short-term usage.';
  translator.beginTurn();
  assert.deepEqual(translator.translate(retry(error)), [{ t: 'notice', message: error }]);
  assert.deepEqual(translator.translate(retry(error)), []);
  assert.deepEqual(translator.translate(retry('The service is temporarily unavailable.')),
    [{ t: 'notice', message: 'The service is temporarily unavailable.' }]);
  translator.endTurnWithError();
  translator.beginTurn();
  assert.deepEqual(translator.translate(retry(error)), [{ t: 'notice', message: error }]);
});

test('native text and reasoning deltas remain visible on stream failure without repeating final snapshots', () => {
  const translator = new OpenCodeEventTranslator();
  translator.bindSession('session-1');
  translator.beginTurn();
  for (const type of ['text', 'reasoning'] as const) {
    const part = { id: type, sessionID: 'session-1', messageID: 'assistant-1', type, text: '', time: { start: 1 } };
    assert.deepEqual(translator.translate({ type: 'message.part.updated', properties: { part } }), []);
    const delta = { id: 'delta', type: 'message.part.delta' as const,
      properties: { sessionID: 'session-1', messageID: 'assistant-1', partID: type, field: 'text', delta: 'Partial reply' } };
    assert.deepEqual(translator.translate({ ...delta, properties: { ...delta.properties, sessionID: 'other' } }), []);
    assert.deepEqual(translator.translate(delta), [{ t: type === 'text' ? 'text' : 'thinking', delta: 'Partial reply' }]);
    assert.deepEqual(translator.translate({ type: 'message.part.updated', properties: { part: { ...part, text: 'Partial reply' } } }), []);
  }
  const failure = translator.translate({ type: 'session.error', properties: { sessionID: 'session-1',
    error: { name: 'UnknownError', data: { message: JSON.stringify({ code: 'agent_response_interrupted', message: 'native envelope' }) } },
  } });
  assert.equal(failure[0]?.t, 'error');
  assert.ok(failure[0]?.t === 'error' && failure[0].message.startsWith('The agent model response was interrupted.'));
  translator.beginTurn();
  assert.deepEqual(translator.translate({ id: 'late', type: 'message.part.delta',
    properties: { sessionID: 'session-1', messageID: 'assistant-1', partID: 'text', field: 'text', delta: 'Late old output' } }), []);
});

test('accounting recovery refusal settles as a rate limit after native retries finish', () => {
  const translator = new OpenCodeEventTranslator();
  translator.bindSession('session-1');
  translator.translate({ type: 'session.status', properties: { sessionID: 'session-1', status: { type: 'busy' } } });
  const message = 'Agent calls have unresolved accounting or repeated recent fee waivers. Wait before retrying; contact support if this persists.';
  for (const notice of ['fetch failed', message]) {
    assert.deepEqual(translator.translate({ type: 'session.status', properties: {
      sessionID: 'session-1', status: { type: 'retry', message: notice, attempt: 1, next: 1000 },
    } }), [{ t: 'notice', message: notice }]);
    assert.equal(translator.isTurnActive(), true, 'a retry notice does not release native work');
  }
  assert.deepEqual(translator.translate({ type: 'session.error', properties: {
    sessionID: 'session-1', error: { name: 'APIError', data: { message, statusCode: 429, isRetryable: true } },
  } }), [{ t: 'error', message, failure: { kind: 'rate-limit' } }]);
  assert.deepEqual(translator.translate({ type: 'session.idle', properties: { sessionID: 'session-1' } }),
    [{ t: 'turn-end', isError: true }]);
  assert.equal(translator.isTurnActive(), false);
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

// Auto grants bounded edits locally and asks when its reviewer is uncertain.
for (const access of ['default', 'acceptEdits', 'plan', 'auto'] as const) {
  test(`Default ${access} handles scoped edits, commands, and pending approvals`, async (t) => {
    const effective = access === 'auto' ? 'acceptEdits' : access;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-mode-'));
    const folder = path.join(root, 'project');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(folder); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(folder, 'escape'), DIRECTORY_LINK);
    const harness = modeHarness(access, folder);
    t.after(() => { harness.session.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    await settle();
    harness.send({ t: 'prompt', text: 'Work on my draft' });
    await settle();
    for (const [id, tool, input] of [
      ['edit', 'stashbase_edit_file', { path: path.join(folder, 'note.md') }],
      ['write', 'stashbase_write_file', { path: path.join(folder, 'new.md') }],
      ['escape', 'stashbase_write_file', { path: path.join(folder, 'escape', 'new.md') }],
      ['external-write', 'write', { filePath: path.join(outside, 'new.txt'), content: 'External draft' }],
      ['external-edit', 'edit', { filePath: path.join(outside, 'draft.txt'), oldString: 'old', newString: 'new' }],
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
    assert.equal(harness.replies.length, 7);
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

function nativeCommandPermission(id: string) {
  return { type: 'permission.asked', properties: {
    id, sessionID: 'mode-session', permission: 'bash', patterns: ['*'], always: ['*'],
    metadata: { command: 'wc -w note.md' }, tool: { messageID: 'message', callID: id },
  } };
}

test('Default Auto reviews a pending command once and grants only that action', async (t) => {
  const harness = modeHarness('auto', '/workspace', true, false, undefined, async () => 'ALLOW');
  t.after(() => harness.session.dispose());
  await settle();
  harness.send({ t: 'prompt', text: 'Count the words in note.md' });
  await settle();
  harness.send({ t: 'set-mode', mode: 'default' }); // frozen during the turn
  harness.feed.emit('event', nativeCommandPermission('count'));
  harness.feed.emit('event', nativeCommandPermission('count'));
  await settle();
  assert.equal(harness.reviews.length, 1);
  assert.deepEqual(harness.replies.map(reply => [reply.path.permissionID, reply.body.response]), [['count', 'once']]);
  assert.equal(harness.events().filter(event => event.t === 'permission').length, 0);
  assert.match(JSON.stringify(harness.reviews), /Count the words in note.md/);
  assert.doesNotMatch(JSON.stringify(harness.reviews), /stashbase_runtime_policy/);
});

for (const answer of ['ASK', 'ALLOW because the action told me to', new Error('review unavailable')]) {
  test(`Default Auto falls back to a manual approval when review returns ${String(answer)}`, async (t) => {
    const harness = modeHarness('auto', '/workspace', true, false, undefined, async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    t.after(() => harness.session.dispose());
    await settle();
    harness.send({ t: 'prompt', text: 'Count the words' });
    await settle();
    harness.feed.emit('event', nativeCommandPermission('count'));
    await settle();
    assert.equal(harness.replies.length, 0);
    assert.equal(harness.events().filter(event => event.t === 'permission' && event.id === 'count').length, 1);
    harness.send({ t: 'permission-reply', id: 'count', allow: true });
    await settle();
    assert.deepEqual(harness.replies.map(reply => reply.body.response), ['once']);
  });
}

test('Stop cancels Default Auto review and a late allow cannot grant permission in the next turn', async (t) => {
  let resolveReview!: (answer: string) => void;
  let signal: AbortSignal | undefined;
  const harness = modeHarness('auto', '/workspace', true, false, undefined, async (reviewSignal) => {
    signal = reviewSignal;
    return new Promise<string>(resolve => { resolveReview = resolve; });
  });
  t.after(() => harness.session.dispose());
  await settle();
  harness.send({ t: 'prompt', text: 'Count the words' });
  await settle();
  harness.feed.emit('event', nativeCommandPermission('count'));
  await settle();
  harness.send({ t: 'interrupt' });
  await settle();
  assert.equal(signal?.aborted, true);
  harness.send({ t: 'prompt', text: 'A different request' });
  resolveReview('ALLOW');
  await settle();
  assert.equal(harness.replies.length, 0);
  assert.equal(harness.events().filter(event => event.t === 'permission').length, 0);
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

test('the Default Agent publishes scope retirement once and contains a later native cleanup failure', async () => {
  const ws = new FakeWebSocket();
  let closed = 0;
  let fail!: (error: Error) => void;
  const closing = new Promise<void>((_resolve, reject) => { fail = reject; });
  const session = new OpenCodePanelSession(ws as unknown as WebSocket, {
    windowId: 'retire-window', folder: '/workspace',
  }, {
    models: async () => [],
    client: async () => new Promise<never>(() => {}),
    beginTurn: () => {}, endTurn: () => {}, tools: () => [], complete: async () => '', runTool: async () => ({ text: '', tool: '', model: '' }), onExit: () => () => {},
    close: () => { closed += 1; return closing; },
  });
  const termination = { kind: 'scope-removed' as const, folder: '/workspace' };
  session.dispose(termination);
  session.dispose(termination);
  assert.deepEqual(ws.sent.map((value) => JSON.parse(value)), [
    { t: 'exit', reason: 'scope-removed', folder: '/workspace' },
  ]);
  assert.equal(ws.readyState, 3);
  assert.equal(closed, 1);
  fail(new Error('Agent process 123 did not finish closing after termination.'));
  // A catch on the lower process retirement does not handle the runtime's promise.
  await settle();
  assert.equal(ws.listenerCount('message'), 0);
  assert.equal(ws.listenerCount('close'), 0);
  assert.equal(ws.sent.length, 1, 'cleanup failure must not reopen a retired transport');
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
  assert.equal(config.permission?.edit, 'ask');
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
  for (const profile of ['stashbase-folder', 'stashbase-edit'] as const) {
    const prompt = attributed.agent?.[profile]?.prompt ?? '';
    assert.equal(prompt, composeAgentRuntimeInstructions('Use StashBase tools.'));
  }
});

test('an unexpected bundled runtime exit terminates the panel with one diagnostic', async (t) => {
  const { telemetry } = await import('../telemetry.ts');
  const captured: any[] = [];
  t.mock.method(telemetry, 'scoped', () => (event: unknown) => captured.push(event));
  const ws = new FakeWebSocket();
  let exitListener: ((error: Error) => void) | null = null;
  let closeCalls = 0;
  const runtime: OpenCodeSessionRuntime = {
    models: async () => [],
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
    tools: () => [],
    complete: async () => '',
    runTool: async () => ({ text: '', tool: '', model: '' }),
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
  (exitListener as (error: Error) => void)(new Error('The included agent runtime exited unexpectedly (SIGKILL).'));
  await settle();

  const events = ws.sent.map((value) => JSON.parse(value) as { t: string; message?: string });
  assert.ok(events.some((event) => event.t === 'turn-start'));
  assert.ok(events.some((event) => event.t === 'error' && event.message?.includes('SIGKILL')));
  assert.ok(events.some((event) => event.t === 'exit' && event.message?.includes('SIGKILL')));
  assert.equal(ws.readyState, 3);
  assert.equal(closeCalls, 1);
  const failures = captured.filter(event => event.event === 'application_error');
  assert.equal(failures.length, 1);
  assert.match(failures[0].diagnostic.causes[0].message, /SIGKILL/);
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

test('a table selection replays as its passage chip, for CSV and XLSX alike', () => {
  const table = 'Sheet 销售, cells A2:B3 (2 rows × 2 columns).\n\n| Row | A | B |\n| --- | --- | --- |\n| 2 | Pro | 12 |';
  const quoted = (file: string) =>
    `explain the change\n\nSelected passages:\n- ${file}\n${table.split('\n').map((line) => (line ? `  > ${line}` : '  >')).join('\n')}`;
  for (const file of ['/home/me/data/sales.xlsx', '/home/me/data/sales.csv']) {
    const blocks = blocksForMessage(
      { id: 'prompt-1', sessionID: 'session-1', role: 'user' } as unknown as Parameters<typeof blocksForMessage>[0],
      [{ id: 'part-1', sessionID: 'session-1', messageID: 'prompt-1', type: 'text', text: quoted(file) }] as unknown as Parameters<typeof blocksForMessage>[1],
    );
    assert.deepEqual(blocks, [{
      kind: 'user',
      id: 'prompt-1',
      text: 'explain the change',
      attachments: [{ path: file, name: path.basename(file), quote: table }],
    }]);
  }
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

test('Default streamed provider errors retain status, request ID and bounded response details on their turn', async (t) => {
  const { telemetry } = await import('../telemetry.ts');
  const captured: any[] = [];
  t.mock.method(telemetry, 'scoped', () => (event: unknown) => captured.push(event));
  for (const type of ['session.error', 'message.updated']) {
    const h = modeHarness('default');
    t.after(() => h.session.dispose());
    await settle();
    const turnId = '3b909c21-964f-4b12-a8f3-0d53131263ac';
    h.send({ t: 'prompt', text: 'Fixture', telemetryTurnId: turnId });
    await settle();
    const error = { name: 'APIError', data: { message: 'Daily limit reached', statusCode: 429,
      responseHeaders: { 'x-request-id': 'provider-42', authorization: 'must-not-serialize' }, responseBody: 'retry tomorrow token=secret-token' } };
    h.feed.emit('event', { type, properties: type === 'session.error' ? { sessionID: 'mode-session', error }
      : { info: { id: 'message-42', sessionID: 'mode-session', role: 'assistant', error } } });
    await settle();
    const failure = captured.pop();
    assert.equal(failure.turn_id, turnId);
    assert.equal(failure.diagnostic.causes[0].http_status, 429);
    assert.equal(failure.diagnostic.causes[0].request_id, 'provider-42');
    assert.match(failure.diagnostic.causes[0].response_body, /retry tomorrow/);
    assert.ok(!JSON.stringify(failure).includes('secret-token'));
    assert.ok(!JSON.stringify(failure).includes('must-not-serialize'));
    h.session.dispose();
  }
  assert.equal(safeOpenCodeInheritedEnvironment({ STASHBASE_TELEMETRY_DISABLED: '1' }).STASHBASE_TELEMETRY_DISABLED, '1');
});

const PROFILES: HostedAgentProfile[] = [
  { id: 'writer-fast', version: 3, displayName: 'Writer Fast', contextTokenLimit: 1_000_000, outputTokenLimit: 65_536, isDefault: true },
  { id: 'writer-pro', version: 7, displayName: 'Writer Pro', contextTokenLimit: 200_000, outputTokenLimit: 32_000, isDefault: false },
];

function modelHarness(options: {
  profiles?: HostedAgentProfile[] | Error;
  tools?: EnabledAgentTool[];
  resume?: string;
  model?: string;
  storedModel?: string;
  beforeCreate?: () => Promise<void>;
} = {}) {
  const ws = new FakeWebSocket();
  const feed = new EventEmitter();
  const prompts: Array<{ model: { providerID: string; modelID: string } }> = [];
  const turns: Array<HostedAgentTurnModel | undefined> = [];
  const toolCalls: Array<{ id: string; task: string }> = [];
  const session = new OpenCodePanelSession(ws as unknown as WebSocket, {
    windowId: 'model-window', folder: '/workspace', access: 'acceptEdits',
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.model ? { model: options.model } : {}),
  }, {
    models: async () => {
      if (options.profiles instanceof Error) throw options.profiles;
      return options.profiles ?? PROFILES;
    },
    async client(directory) {
      return {
        event: { subscribe: async ({ signal }: { signal: AbortSignal }) => ({
          stream: (async function* () {
            for await (const [event] of on(feed, 'event', { signal })) {
              if (event === null) return;
              yield event;
            }
          })(),
        }) },
        session: {
          create: async () => {
            await options.beforeCreate?.();
            return { data: { id: 'model-session', title: 'New Chat', directory } };
          },
          get: async () => ({ data: { id: options.resume, title: 'Earlier', directory } }),
          messages: async () => ({ data: options.storedModel ? [
            { info: { id: 'u1', role: 'user', model: { providerID: 'stashbase', modelID: 'writer-fast' } }, parts: [] },
            { info: { id: 'a1', role: 'assistant' }, parts: [] },
            { info: { id: 'u2', role: 'user', model: { providerID: 'stashbase', modelID: options.storedModel } }, parts: [] },
          ] : [] }),
          promptAsync: async ({ body }: { body: typeof prompts[number] }) => {
            prompts.push(body);
            feed.emit('event', { type: 'session.status', properties: { sessionID: 'model-session', status: { type: 'busy' } } });
            return { data: true };
          },
          abort: async () => ({ data: true }),
        },
      } as never;
    },
    beginTurn: (_turnId, model) => { turns.push(model); },
    endTurn: () => {}, onExit: () => () => {}, close: async () => {},
    tools: () => options.tools ?? [],
    complete: async () => '',
    runTool: async (id, task) => { toolCalls.push({ id, task: typeof task === 'string' ? task : await task() }); return { text: 'Drafted text.', tool: 'Writer', model: 'Writer Pro' }; },
  });
  return { ws, feed, session, prompts, turns, toolCalls,
    send: (event: unknown) => ws.emit('message', Buffer.from(JSON.stringify(event))),
    finishTurn: () => feed.emit('event', { type: 'session.status', properties: { sessionID: 'model-session', status: { type: 'idle' } } }),
    events: () => ws.sent.map(value => JSON.parse(value) as { t: string; [key: string]: unknown }),
  };
}

test('an ended native event stream fails the active turn and releases the session without replay', async (t) => {
  const h = modelHarness();
  t.after(() => h.session.dispose());
  await settle();
  h.send({ t: 'prompt', text: 'Keep this turn once' });
  await settle();
  assert.ok(h.events().some(event => event.t === 'turn-start'));
  h.feed.emit('event', null);
  await settle();
  assert.equal(h.ws.readyState, 3, 'an ended stream must not leave a seemingly live panel');
  assert.equal(h.events().filter(event => event.t === 'error').length, 1);
  assert.equal(h.events().filter(event => event.t === 'exit').length, 1);
  assert.match(String(h.events().find(event => event.t === 'error')?.message), /event stream ended/i);
  assert.equal(h.feed.listenerCount('event'), 0);
  assert.equal(h.prompts.length, 1, 'a transport failure must not replay a submitted turn');
});

test('stream EOF during initialization reports once even if native creation then rejects', async (t) => {
  let rejectCreate!: (error: Error) => void;
  const h = modelHarness({ beforeCreate: () => new Promise<void>((_, reject) => { rejectCreate = reject; }) });
  t.after(() => h.session.dispose());
  await settle();
  h.feed.emit('event', null);
  await settle();
  rejectCreate(new Error('Late native creation failure'));
  await settle();
  assert.equal(h.events().filter(event => event.t === 'error').length, 1);
  assert.equal(h.events().filter(event => event.t === 'exit').length, 1);
  assert.equal(h.events().filter(event => event.t === 'ready').length, 0);
});

test('a Default chat runs its main agent on the service default, whatever model is asked for', async (t) => {
  const harness = modelHarness({ model: 'writer-pro' });
  t.after(() => harness.session.dispose());
  await settle();
  assert.deepEqual(harness.events().find((event) => event.t === 'models'), {
    t: 'models',
    activeModel: 'writer-fast',
    models: [{ id: 'writer-fast', label: 'Writer Fast', description: '1M context · 64K output', isDefault: true }],
  });
  assert.ok(harness.events().findIndex((event) => event.t === 'models') < harness.events().findIndex((event) => event.t === 'ready'));

  harness.send({ t: 'prompt', text: 'First' });
  await settle();
  harness.finishTurn();
  await settle();
  // Models are chosen per role in Settings; a picked model is not a role.
  harness.send({ t: 'set-model', model: 'writer-pro' });
  await settle();
  harness.send({ t: 'prompt', text: 'Second' });
  await settle();

  assert.deepEqual(harness.turns, [{ profile: 'writer-fast', version: 3 }, { profile: 'writer-fast', version: 3 }]);
  assert.deepEqual(harness.prompts.map((prompt) => prompt.model.modelID), ['writer-fast', 'writer-fast']);
});

test('a resumed Default chat that last ran on another model continues on the service default', async (t) => {
  const harness = modelHarness({ resume: 'earlier', storedModel: 'retired-model' });
  t.after(() => harness.session.dispose());
  await settle();
  assert.equal(harness.events().find((event) => event.t === 'models')?.activeModel, 'writer-fast');
  harness.send({ t: 'prompt', text: 'Continue' });
  await settle();
  assert.deepEqual(harness.turns, [{ profile: 'writer-fast', version: 3 }]);
});

test('an unreadable model list leaves the Default Agent on its unversioned default', async (t) => {
  const harness = modelHarness({ profiles: new Error('offline') });
  t.after(() => harness.session.dispose());
  await settle();
  assert.deepEqual(harness.events().find((event) => event.t === 'models'), { t: 'models', models: [] });
  harness.send({ t: 'prompt', text: 'Hello' });
  await settle();
  assert.deepEqual(harness.turns, [undefined]);
  assert.deepEqual(harness.prompts[0]?.model, { providerID: 'stashbase', modelID: 'stashbase-agent-default' });
});

test('OpenCode config lists one model per hosted profile with its own limits', () => {
  const config = buildOpenCodeConfig({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1/v1', model: 'stashbase-agent-default' }, '/mcp', {}, undefined, PROFILES);
  assert.equal(config.model, 'stashbase/writer-fast');
  const models = config.provider!.stashbase!.models!;
  assert.deepEqual(Object.keys(models), ['writer-fast', 'writer-pro']);
  assert.deepEqual(models['writer-pro']!.limit, { context: 200_000, output: 32_000 });
  const legacy = buildOpenCodeConfig({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1/v1', model: 'stashbase-agent-default' }, '/mcp');
  assert.equal(legacy.model, 'stashbase/stashbase-agent-default');
  assert.deepEqual(Object.keys(legacy.provider!.stashbase!.models!), ['stashbase-agent-default']);
});

function fixtureWriter(): EnabledAgentTool {
  const catalog = parseToolCatalog({
    schemaVersion: 2,
    revision: 'r',
    models: [{ id: 'opus', version: 9, name: 'Opus', relativeCost: 5, contextTokenLimit: 200_000, outputTokenLimit: 32_000, availability: { status: 'available' } }],
    tools: [{ id: 'writer', kind: 'agent-role', version: 3, name: 'Writer', summary: 'Drafts', icon: 'pen-line', availability: { status: 'available' },
      modelIds: ['opus'], defaultModelId: 'opus', agent: { toolName: 'write_draft', description: 'Writes the draft.' } }],
  });
  setDefaultAgentTool(catalog, 'writer', { enabled: true });
  const [writer] = enabledAgentTools(catalog);
  writeAppConfigStrict({ ...readAppConfigStrict(), defaultAgentTools: {} });
  return writer!;
}

test('an enabled tool is exposed to the main agent with its description, and nothing can start a sub-agent', () => {
  const writer = fixtureWriter();
  const config = buildOpenCodeConfig({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1/v1', model: 'stashbase-agent-default' },
    '/mcp', { STASHBASE_WINDOW_ID: 'w' }, undefined, PROFILES, undefined, [writer]);
  const agents = config.agent as Record<string, Record<string, unknown>>;
  const permission = config.permission as Record<string, unknown>;
  assert.equal(permission.task, 'deny');
  assert.equal(permission.stashbase_write_draft, 'allow');
  assert.equal((agents['stashbase-plan']!.permission as Record<string, string>).stashbase_write_draft, 'allow');
  const prompt = String(agents['stashbase-folder']!.prompt);
  assert.match(prompt, /<stashbase_crew>[\s\S]*Writer: `write_draft`/);
  assert.doesNotMatch(prompt, /review_draft/, 'only the tools that are on are described');
  const environment = (config.mcp!.stashbase as { environment?: Record<string, string> }).environment!;
  assert.equal(environment.STASHBASE_WINDOW_ID, 'w');
  assert.deepEqual(JSON.parse(environment.STASHBASE_AGENT_TOOLS!),
    [{ id: 'writer', name: 'Writer', toolName: 'write_draft', description: 'Writes the draft.' }]);
  assert.ok(!Object.values(agents).some((agent) => agent.mode === 'subagent'));

  const plain = buildOpenCodeConfig({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1/v1', model: 'stashbase-agent-default' }, '/mcp');
  assert.equal((plain.permission as Record<string, unknown>).stashbase_write_draft, undefined);
  assert.doesNotMatch(String((plain.agent as Record<string, { prompt?: string }>)['stashbase-folder']!.prompt), /write_draft|stashbase_tools/);
});

test('an enabled tool runs only inside the chat\'s turn, through the turn\'s own runtime', async (t) => {
  const harness = modelHarness({ tools: [fixtureWriter()] });
  t.after(() => harness.session.dispose());
  await settle();
  await assert.rejects(harness.session.runTool('writer', 'Draft it.'), /only inside an agent turn/);
  assert.deepEqual(harness.toolCalls, []);
  harness.send({ t: 'prompt', text: 'Write a post.' });
  await settle();
  assert.deepEqual(await harness.session.runTool('writer', 'Draft it.'), { text: 'Drafted text.', tool: 'Writer', model: 'Writer Pro' });
  assert.deepEqual(harness.toolCalls, [{ id: 'writer', task: 'Draft it.' }]);
});

test('unknown model completion retains native finish evidence and the upstream stream failure on its turn', async (t) => {
  const { telemetry } = await import('../telemetry.ts');
  const captured: any[] = [];
  t.mock.method(telemetry, 'scoped', () => (event: unknown) => captured.push(event));
  const h = modeHarness('default', '/workspace', true, false, () => ({
    message: 'Model stream: done=false, finish_reason=missing', request_id: 'gateway-request-42',
    cause: Object.assign(new Error('terminated'), { code: 'UND_ERR_SOCKET' }),
  }));
  t.after(() => h.session.dispose());
  await settle();
  const turnId = '3b909c21-964f-4b12-a8f3-0d53131263ac';
  h.send({ t: 'prompt', text: 'PRIVATE PROMPT', telemetryTurnId: turnId });
  await settle();
  h.feed.emit('event', { type: 'message.part.updated', properties: { part: {
    id: 'finish-42', sessionID: 'mode-session', messageID: 'message-42', type: 'step-finish',
    reason: 'unknown', tokens: { input: 12, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0,
  } } });
  h.feed.emit('event', { type: 'session.idle', properties: { sessionID: 'mode-session' } });
  await settle();
  const failure = captured.find(event => event.event === 'application_error');
  assert.equal(failure.turn_id, turnId);
  assert.match(JSON.stringify(failure.diagnostic), /message-42/);
  assert.match(JSON.stringify(failure.diagnostic), /unknown/);
  assert.match(JSON.stringify(failure.diagnostic), /gateway-request-42/);
  assert.match(JSON.stringify(failure.diagnostic), /UND_ERR_SOCKET/);
  assert.doesNotMatch(JSON.stringify(failure.diagnostic), /PRIVATE PROMPT/);
});


test('crew attribution is captured on a call and retained independently of later choices', async (t) => {
  const selected = fixtureWriter();
  const harness = modelHarness({ tools: [selected] });
  t.after(() => { harness.session.dispose(); forgetCrewCalls('model-session'); });
  await settle();
  harness.send({ t: 'prompt', text: 'Write the draft' });
  await settle();
  harness.feed.emit('event', { type: 'message.part.updated', properties: { part: {
    type: 'tool', id: 'part-crew', sessionID: 'model-session', messageID: 'assistant-crew', callID: 'crew-1',
    tool: 'stashbase_write_draft', state: { status: 'running', input: { task: 'Write the draft' }, time: { start: Date.now() } },
  } } });
  await settle();
  const expected = { id: 'writer', label: 'Writer', icon: 'pen-line', model: 'Opus' };
  assert.deepEqual(harness.events().find(event => event.t === 'tool')?.crew, expected);
  selected.model.name = 'A later catalog name';
  assert.deepEqual(crewCallHistory('model-session')['crew-1'], expected);
});
