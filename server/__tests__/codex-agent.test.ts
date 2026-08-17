import './isolated-home.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { WebSocket } from 'ws';
import { clearAgentRuntimeFailure } from '../agent-contract.ts';
import { codexAccessOptions, isStashbaseWorkspaceEdit, isWorkspaceFileChange, permanentlyDeleteCodexThread } from '../codex-agent.ts';
import { CodexRpcPeer } from '../codex-rpc-transport.ts';
import { CodexSession } from '../codex-session-runtime.ts';
import { clearCurrentFolder, runWithWindowId, setCurrentFolder } from '../folder.ts';

class FakeCodexProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

class FakeWebSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

function catalogProcess(
  models: Array<Record<string, unknown>> = [{ id: 'native-model', displayName: 'Native model' }],
  options: {
    pages?: Array<Record<string, unknown>[]>;
    skills?: Array<Record<string, unknown>>;
    skillsListError?: string;
    threadModel?: string;
    selectedTurnError?: string;
    turnIds?: string[];
  } = {},
): { proc: FakeCodexProcess; requests: Array<{ method: string; params: Record<string, unknown> }> } {
  const proc = new FakeCodexProcess();
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let page = 0;
  let rejected = false;
  let turn = 0;
  proc.stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(String(chunk)) as { id: number; method: string; params: Record<string, unknown> };
    requests.push({ method: request.method, params: request.params });
    const catalog = options.pages ?? [models];
    const result = request.method === 'model/list' ? { data: catalog[page] ?? [], ...(page++ < catalog.length - 1 ? { nextCursor: `page-${page}` } : {}) }
      : request.method === 'skills/list' ? { data: [{ cwd: Array.isArray(request.params.cwds) ? request.params.cwds[0] : undefined, skills: options.skills ?? [] }] }
      : request.method === 'thread/start' ? { thread: { id: 'thread-1' }, model: options.threadModel ?? 'runtime-default' }
      : request.method === 'thread/resume' ? { thread: { id: 'thread-1' }, model: 'resumed-model' }
        : request.method === 'turn/start' ? { turn: { id: options.turnIds?.[turn++] ?? 'turn-1' } } : {};
    if (request.method === 'skills/list' && options.skillsListError) {
      proc.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32000, message: options.skillsListError } })}\n`);
    } else if (request.method === 'turn/start' && options.selectedTurnError && request.params.model && !rejected) {
      rejected = true;
      proc.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32000, message: options.selectedTurnError } })}\n`);
    } else {
      proc.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    }
  });
  return { proc, requests };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function emitCodexError(proc: FakeCodexProcess, turnId: string, message: string, willRetry: boolean): void {
  proc.stdout.write(`${JSON.stringify({
    method: 'error',
    params: {
      threadId: 'thread-1',
      turnId,
      error: { message },
      willRetry,
    },
  })}\n`);
}

function emitCodexTurnCompleted(
  proc: FakeCodexProcess,
  turnId: string,
  status: 'completed' | 'interrupted' | 'failed',
  message?: string,
): void {
  proc.stdout.write(`${JSON.stringify({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: turnId,
        items: [],
        status,
        ...(message === undefined ? {} : { error: { message } }),
      },
    },
  })}\n`);
}

function manualRpcTimers() {
  const callbacks = new Map<ReturnType<typeof setTimeout>, () => void>();
  let cancelledCount = 0;
  return {
    scheduleTimeout(callback: () => void): ReturnType<typeof setTimeout> {
      const handle = { unref: () => handle } as unknown as ReturnType<typeof setTimeout>;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelTimeout(handle: ReturnType<typeof setTimeout>): void {
      if (callbacks.delete(handle)) cancelledCount += 1;
    },
    expireNext(): void {
      const entry = callbacks.entries().next().value as [ReturnType<typeof setTimeout>, () => void] | undefined;
      assert.ok(entry, 'expected a pending RPC timeout');
      callbacks.delete(entry[0]);
      entry[1]();
    },
    activeCount: () => callbacks.size,
    cancelledCount: () => cancelledCount,
  };
}

test('Codex publishes its native model catalog before ready and forwards a selected model on the first turn', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-model-'));
  runWithWindowId('model-window', () => setCurrentFolder(folder));
  t.after(() => { runWithWindowId('model-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });
  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(ws as unknown as WebSocket, 'model-window', undefined, undefined, undefined, 'native-model', undefined, undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
  session.begin();
  await settle();

  const events = ws.sent.map((item) => JSON.parse(item) as { t: string; models?: Array<{ id: string }>; activeModel?: string });
  assert.equal(events[0]?.t, 'models', JSON.stringify(events));
  assert.equal(events[0]?.models?.[0]?.id, 'native-model');
  assert.equal(events[0]?.activeModel, undefined, 'selection is not active until the native turn accepts it');
  assert.equal(events.some((event) => event.t === 'skills'), true);
  assert.equal(events.some((event) => event.t === 'ready'), true);

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();
  assert.equal(native.requests.find((request) => request.method === 'turn/start')?.params.model, 'native-model');
  const active = ws.sent
    .map((item) => JSON.parse(item) as { t: string; activeModel?: string })
    .filter((event) => event.t === 'models')
    .at(-1);
  assert.equal(active?.activeModel, 'native-model');
  session.dispose();
});

test('Codex project rebind changes the next native turn cwd without replacing the thread', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-rebound-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const ws = new FakeWebSocket();
  const native = catalogProcess(undefined, { turnIds: ['turn-1', 'turn-2'] });
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'rebound-window',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    'library',
    undefined,
    () => native.proc as unknown as ChildProcessWithoutNullStreams,
  );
  session.begin();
  await settle();

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'create the project' }));
  await settle();
  emitCodexTurnCompleted(native.proc, 'turn-1', 'completed');
  await settle();

  assert.equal(session.rebindToFolder(project), true);
  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'continue in the project' }));
  await settle();

  const threads = native.requests.filter((request) => request.method === 'thread/start');
  const turns = native.requests.filter((request) => request.method === 'turn/start');
  assert.equal(threads.length, 1);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.params.threadId, 'thread-1');
  assert.notEqual(turns[0]?.params.cwd, project);
  assert.equal(turns[1]?.params.threadId, 'thread-1');
  assert.equal(turns[1]?.params.cwd, project);
  session.dispose();
});

test('Codex recovers unavailable selections to Default and never forwards an override while resuming', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-model-'));
  runWithWindowId('stale-window', () => setCurrentFolder(folder));
  runWithWindowId('resume-window', () => setCurrentFolder(folder));
  t.after(() => { runWithWindowId('stale-window', () => clearCurrentFolder()); runWithWindowId('resume-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });

  const staleWs = new FakeWebSocket();
  const staleNative = catalogProcess();
  const stale = new CodexSession(staleWs as unknown as WebSocket, 'stale-window', undefined, undefined, undefined, 'withdrawn-model', undefined, undefined, undefined, () => staleNative.proc as unknown as ChildProcessWithoutNullStreams);
  stale.begin();
  await settle();
  const staleModels = staleWs.sent.map((item) => JSON.parse(item) as { t: string; fallback?: string }).find((event) => event.t === 'models');
  assert.match(staleModels?.fallback ?? '', /no longer available/);
  staleWs.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();
  assert.equal('model' in (staleNative.requests.find((request) => request.method === 'turn/start')?.params ?? {}), false);
  stale.dispose();

  const resumeWs = new FakeWebSocket();
  const resumeNative = catalogProcess();
  const resumed = new CodexSession(resumeWs as unknown as WebSocket, 'resume-window', undefined, 'thread-old', undefined, 'native-model', undefined, undefined, undefined, () => resumeNative.proc as unknown as ChildProcessWithoutNullStreams);
  resumed.begin();
  await settle();
  const resumedModels = resumeWs.sent.map((item) => JSON.parse(item) as { t: string; activeModel?: string }).filter((event) => event.t === 'models').at(-1);
  assert.equal(resumedModels?.activeModel, 'resumed-model');
  resumeWs.emit('message', JSON.stringify({ t: 'prompt', text: 'continue' }));
  await settle();
  assert.equal(resumeNative.requests.some((request) => request.method === 'thread/resume'), true);
  assert.equal('model' in (resumeNative.requests.find((request) => request.method === 'turn/start')?.params ?? {}), false);
  resumed.dispose();
});

test('Codex reports the native Default model after starting a new thread', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-model-'));
  runWithWindowId('default-window', () => setCurrentFolder(folder));
  t.after(() => { runWithWindowId('default-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });
  const ws = new FakeWebSocket();
  const native = catalogProcess(undefined, { threadModel: 'runtime-default' });
  const session = new CodexSession(ws as unknown as WebSocket, 'default-window', undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
  session.begin();
  await settle();
  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();
  const active = ws.sent.map((item) => JSON.parse(item) as { t: string; activeModel?: string }).filter((event) => event.t === 'models').at(-1);
  assert.equal(active?.activeModel, 'runtime-default');
  assert.equal('model' in (native.requests.find((request) => request.method === 'turn/start')?.params ?? {}), false);
  session.dispose();
});

test('Codex invokes an enabled selected skill and never publishes disabled skills', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-skills-'));
  runWithWindowId('skills-window', () => setCurrentFolder(folder));
  t.after(() => { runWithWindowId('skills-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });
  const ws = new FakeWebSocket();
  const native = catalogProcess(undefined, {
    skills: [
      { name: 'release-notes', path: '/skills/release-notes/SKILL.md', enabled: true },
      { name: 'disabled-skill', path: '/skills/disabled-skill/SKILL.md', enabled: false },
    ],
  });
  const session = new CodexSession(ws as unknown as WebSocket, 'skills-window', undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
  session.begin();
  await settle();

  const skills = ws.sent.map((item) => JSON.parse(item) as { t: string; skills?: Array<{ id: string; label: string }> }).find((event) => event.t === 'skills');
  assert.deepEqual(skills?.skills?.map((skill) => skill.label), ['release-notes']);
  const skillId = skills?.skills?.[0]?.id;
  assert.ok(skillId);
  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'prepare the release', skill: skillId }));
  await settle();

  assert.deepEqual(native.requests.find((request) => request.method === 'turn/start')?.params.input, [
    { type: 'text', text: '$release-notes prepare the release', text_elements: [] },
    { type: 'skill', name: 'release-notes', path: '/skills/release-notes/SKILL.md' },
  ]);
  session.dispose();
});

test('Codex reports an empty or failed skill catalog without blocking the session', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-skills-'));
  runWithWindowId('empty-skills-window', () => setCurrentFolder(folder));
  runWithWindowId('failed-skills-window', () => setCurrentFolder(folder));
  t.after(() => { runWithWindowId('empty-skills-window', () => clearCurrentFolder()); runWithWindowId('failed-skills-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });

  const emptyWs = new FakeWebSocket();
  const empty = new CodexSession(emptyWs as unknown as WebSocket, 'empty-skills-window', undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => catalogProcess().proc as unknown as ChildProcessWithoutNullStreams);
  empty.begin();
  await settle();
  assert.equal(emptyWs.sent.map((item) => JSON.parse(item) as { t: string; state?: string }).find((event) => event.t === 'skills')?.state, 'empty');
  assert.equal(emptyWs.sent.some((item) => (JSON.parse(item) as { t: string }).t === 'ready'), true);
  empty.dispose();

  const failedWs = new FakeWebSocket();
  const failedNative = catalogProcess(undefined, { skillsListError: 'skills unavailable' });
  const failed = new CodexSession(failedWs as unknown as WebSocket, 'failed-skills-window', undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => failedNative.proc as unknown as ChildProcessWithoutNullStreams);
  failed.begin();
  await settle();
  assert.equal(failedWs.sent.map((item) => JSON.parse(item) as { t: string; state?: string }).find((event) => event.t === 'skills')?.state, 'failed');
  assert.equal(failedWs.sent.some((item) => (JSON.parse(item) as { t: string }).t === 'ready'), true);
  failed.dispose();
});

test('Codex forwards a runtime-native effort identifier without remapping it', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-effort-'));
  runWithWindowId('native-effort-window', () => setCurrentFolder(folder));
  t.after(() => { runWithWindowId('native-effort-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });
  const ws = new FakeWebSocket();
  const native = catalogProcess([{ id: 'native-model', displayName: 'Native model', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }] }]);
  const session = new CodexSession(ws as unknown as WebSocket, 'native-effort-window', 'ultra', undefined, undefined, 'native-model', undefined, undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
  session.begin();
  await settle();
  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();

  assert.equal(native.requests.find((request) => request.method === 'turn/start')?.params.effort, 'ultra');
  session.dispose();
});

test('Codex retries a rejected selected model with Default and publishes recovery', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-model-'));
  runWithWindowId('reject-window', () => setCurrentFolder(folder));
  t.after(() => { runWithWindowId('reject-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });
  const ws = new FakeWebSocket();
  const native = catalogProcess(undefined, { selectedTurnError: 'model unavailable' });
  const session = new CodexSession(ws as unknown as WebSocket, 'reject-window', undefined, undefined, undefined, 'native-model', undefined, undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
  session.begin();
  await settle();
  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();
  const turns = native.requests.filter((request) => request.method === 'turn/start');
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.params.model, 'native-model');
  assert.equal('model' in (turns[1]?.params ?? {}), false);
  const fallback = ws.sent
    .map((item) => JSON.parse(item) as { t: string; activeModel?: string; fallback?: string })
    .find((event) => event.fallback);
  assert.match(fallback?.fallback ?? '', /retrying/);
  assert.equal(fallback?.activeModel, 'runtime-default');
  session.dispose();
});

test('Codex does not misclassify an unrelated turn failure as a model fallback', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-model-'));
  runWithWindowId('turn-error-window', () => setCurrentFolder(folder));
  t.after(() => { runWithWindowId('turn-error-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });
  const ws = new FakeWebSocket();
  const native = catalogProcess(undefined, { selectedTurnError: 'sandbox service unavailable' });
  const session = new CodexSession(ws as unknown as WebSocket, 'turn-error-window', undefined, undefined, undefined, 'native-model', undefined, undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
  session.begin();
  await settle();
  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();

  assert.equal(native.requests.filter((request) => request.method === 'turn/start').length, 1);
  const events = ws.sent.map((item) => JSON.parse(item) as { t: string; message?: string; fallback?: string });
  assert.equal(events.some((event) => event.fallback), false);
  assert.match(events.find((event) => event.t === 'error')?.message ?? '', /sandbox service unavailable/);
  session.dispose();
});

test('Codex combines every catalog page and preserves advertised effort options', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-model-'));
  runWithWindowId('pages-window', () => setCurrentFolder(folder));
  t.after(() => { runWithWindowId('pages-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });
  const ws = new FakeWebSocket();
  const native = catalogProcess([], { pages: [
    [{ id: 'early-model', displayName: 'Early' }],
    [{ id: 'late-model', displayName: 'Late', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'xhigh' }] }],
  ] });
  const session = new CodexSession(ws as unknown as WebSocket, 'pages-window', undefined, undefined, undefined, 'late-model', undefined, undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
  session.begin();
  await settle();
  const modelsEvent = ws.sent.map((item) => JSON.parse(item) as { t: string; models?: Array<{ id: string; supportedEfforts?: string[] }>; activeModel?: string }).find((event) => event.t === 'models');
  assert.deepEqual(modelsEvent?.models?.map((model) => model.id), ['early-model', 'late-model']);
  assert.deepEqual(modelsEvent?.models?.[1]?.supportedEfforts, ['low', 'xhigh']);
  assert.equal(modelsEvent?.activeModel, undefined);
  assert.deepEqual(native.requests.filter((request) => request.method === 'model/list').map((request) => request.params), [{}, { cursor: 'page-1' }]);
  session.dispose();
});

test('Codex RPC peer correlates responses and dispatches inbound messages', async () => {
  const writes: string[] = [];
  const requests: string[] = [];
  const notifications: string[] = [];
  const peer = new CodexRpcPeer((line) => writes.push(line), {
    onRequest: ({ method }) => requests.push(method),
    onNotification: (method) => notifications.push(method),
  });

  const pending = peer.request('thread/read', { threadId: 'thread-123' });
  const request = JSON.parse(writes[0]!) as { id: number };
  peer.receiveLine(JSON.stringify({ id: request.id, result: { ok: true } }));
  peer.receiveLine(JSON.stringify({ id: 99, method: 'approval/request', params: {} }));
  peer.receiveLine(JSON.stringify({ method: 'turn/started', params: {} }));

  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(requests, ['approval/request']);
  assert.deepEqual(notifications, ['turn/started']);
});

test('Codex RPC peer rejects pending work when its owner closes', async () => {
  const peer = new CodexRpcPeer(() => {});
  const pending = peer.request('turn/start', {});
  peer.close(new Error('session closed'));
  await assert.rejects(pending, /session closed/);
});

test('stale Codex process events and stdout cannot affect a replacement generation', (t) => {
  t.after(() => clearAgentRuntimeFailure('codex'));
  const first = new FakeCodexProcess();
  const second = new FakeCodexProcess();
  const processes = [first, second];
  const session = new CodexSession(
    new FakeWebSocket() as unknown as WebSocket,
    'test-window',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => processes.shift() as unknown as ChildProcessWithoutNullStreams,
  );
  const runtime = session as unknown as {
    spawnAppServer(cwd: string): void;
    proc: ChildProcessWithoutNullStreams | null;
    rpc: CodexRpcPeer | null;
    busy: boolean;
    activeTurnId: string | null;
  };

  runtime.spawnAppServer(os.tmpdir());
  const staleRpc = runtime.rpc;
  runtime.spawnAppServer(os.tmpdir());
  const replacementRpc = runtime.rpc;
  runtime.busy = true;
  runtime.activeTurnId = 'replacement-turn';

  first.emit('error', new Error('first process failed'));
  staleRpc?.receiveLine(JSON.stringify({
    method: 'turn/completed',
    params: { turn: { id: 'stale-turn', status: 'completed' } },
  }));

  first.emit('close', 1, null);

  assert.equal(runtime.proc, second as unknown as ChildProcessWithoutNullStreams);
  assert.equal(runtime.rpc, replacementRpc);
  assert.equal(runtime.busy, true);
  assert.equal(runtime.activeTurnId, 'replacement-turn');
  session.dispose();
  assert.equal(second.killed, true);
});

test('Codex app-server exit after ready fatally ends an idle session once', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-exit-'));
  runWithWindowId('idle-exit-window', () => setCurrentFolder(folder));
  t.after(() => {
    clearAgentRuntimeFailure('codex');
    runWithWindowId('idle-exit-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(ws as unknown as WebSocket, 'idle-exit-window', undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
  session.begin();
  await settle();

  native.proc.emit('close', 7, null);
  await settle();

  const terminal = ws.sent.map((item) => JSON.parse(item) as { t: string; message?: string }).filter((event) => event.t === 'exit');
  assert.deepEqual(terminal, [{ t: 'exit', message: 'Codex app-server exited with code 7.' }]);
  assert.equal(ws.sent.some((item) => (JSON.parse(item) as { t: string }).t === 'error'), false);
  assert.equal(ws.readyState, 3);
});

test('Codex app-server exit during startup retains its fatal cause on exit', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-exit-'));
  runWithWindowId('startup-exit-window', () => setCurrentFolder(folder));
  t.after(() => {
    clearAgentRuntimeFailure('codex');
    runWithWindowId('startup-exit-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const ws = new FakeWebSocket();
  const native = new FakeCodexProcess();
  native.stdin.once('data', () => native.emit('close', 23, null));
  const session = new CodexSession(ws as unknown as WebSocket, 'startup-exit-window', undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => native as unknown as ChildProcessWithoutNullStreams);
  session.begin();
  await settle();

  const events = ws.sent.map((item) => JSON.parse(item) as { t: string; message?: string });
  assert.deepEqual(events.filter((event) => event.t === 'exit'), [
    { t: 'exit', message: 'Codex app-server exited with code 23.' },
  ]);
  assert.equal(events.some((event) => event.t === 'error'), false);
  assert.equal(ws.readyState, 3);
});

test('Codex app-server exit while working emits no duplicate failed turn', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-exit-'));
  runWithWindowId('busy-exit-window', () => setCurrentFolder(folder));
  t.after(() => {
    clearAgentRuntimeFailure('codex');
    runWithWindowId('busy-exit-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(ws as unknown as WebSocket, 'busy-exit-window', undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
  session.begin();
  await settle();
  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();

  native.proc.emit('close', null, 'SIGKILL');
  await settle();

  const events = ws.sent.map((item) => JSON.parse(item) as { t: string; message?: string });
  assert.deepEqual(events.filter((event) => event.t === 'exit'), [
    { t: 'exit', message: 'Codex app-server exited with signal SIGKILL.' },
  ]);
  assert.equal(events.filter((event) => event.t === 'turn-end').length, 0);
  assert.equal(events.filter((event) => event.t === 'error').length, 0);
});

test('closed Codex RPC peers ignore inbound requests and notifications', () => {
  const received: string[] = [];
  const peer = new CodexRpcPeer(() => {}, {
    onRequest: ({ method }) => received.push(method),
    onNotification: (method) => received.push(method),
  });

  peer.close();
  peer.receiveLine(JSON.stringify({ id: 1, method: 'approval/request', params: {} }));
  peer.receiveLine(JSON.stringify({ method: 'turn/completed', params: {} }));

  assert.deepEqual(received, []);
});

test('Codex Delete Chat uses the native irreversible thread/delete operation', async () => {
  const requests: Array<{ method: string; params: unknown }> = [];

  await permanentlyDeleteCodexThread(async (method, params) => {
    requests.push({ method, params });
  }, 'thread-123');

  assert.deepEqual(requests, [{ method: 'thread/delete', params: { threadId: 'thread-123' } }]);
});

test('Codex Edit keeps native approval requests enabled for sensitive actions', () => {
  assert.deepEqual(codexAccessOptions('acceptEdits'), {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'workspace-write',
  });
});

test('Codex Auto uses the app-server auto-reviewer wire value', () => {
  assert.deepEqual(codexAccessOptions('auto'), {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: 'workspace-write',
  });
});

test('Codex Edit auto-accepts only physical file-change grants inside the open folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-'));
  const folder = path.join(root, 'project');
  const outside = path.join(root, 'other');
  fs.mkdirSync(folder);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(folder, 'linked-outside'));
  try {
    assert.equal(isWorkspaceFileChange({ grantRoot: path.join(folder, 'src') }, folder), true);
    assert.equal(isWorkspaceFileChange({ grantRoot: folder }, folder), true);
    assert.equal(isWorkspaceFileChange({ grantRoot: outside }, folder), false);
    assert.equal(isWorkspaceFileChange({ grantRoot: root }, folder), false);
    assert.equal(isWorkspaceFileChange({ grantRoot: path.join(folder, 'linked-outside') }, folder), false);
    assert.equal(isWorkspaceFileChange({}, folder), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex Edit auto-accepts only ordinary StashBase MCP writes inside the open folder', () => {
  const folder = '/workspace/project';
  const approval = (tool: string, target: string, server = 'stashbase') => ({
    input: { server, tool, arguments: { path: target } },
  });

  assert.equal(isStashbaseWorkspaceEdit(approval('edit_file', '/workspace/project/note.md'), folder), true);
  assert.equal(isStashbaseWorkspaceEdit(approval('write_file', '/workspace/project/new.md'), folder), true);
  assert.equal(isStashbaseWorkspaceEdit(approval('delete_file', '/workspace/project/note.md'), folder), false);
  assert.equal(isStashbaseWorkspaceEdit(approval('edit_file', '/workspace/other/note.md'), folder), false);
  assert.equal(isStashbaseWorkspaceEdit(approval('edit_file', '/workspace/project/note.md', 'other'), folder), false);
});

test('Codex RPC peer enforces request timeout, clears timers, and ignores late responses', async () => {
  let written = '';
  const timers = manualRpcTimers();
  const peer = new CodexRpcPeer((line) => { written = line; }, {
    requestTimeoutMs: 20,
    scheduleTimeout: timers.scheduleTimeout,
    cancelTimeout: timers.cancelTimeout,
  });
  const pending = peer.request('turn/start', { threadId: 't1' });
  const req = JSON.parse(written) as { id: number };
  assert.equal(timers.activeCount(), 1);
  timers.expireNext();

  await assert.rejects(pending, (err: Error) => {
    assert.match(err.message, /Codex app-server request timed out: turn\/start/);
    return true;
  });
  assert.equal(timers.activeCount(), 0);
  assert.equal(timers.cancelledCount(), 0, 'an expired timer should not be cancelled again');

  assert.doesNotThrow(() => {
    peer.receiveLine(JSON.stringify({ id: req.id, result: { turn: { id: 'late-turn' } } }));
  });
});

test('Codex RPC peer clears timers on response, write failure, and peer close', async () => {
  const successTimers = manualRpcTimers();
  const successPeer = new CodexRpcPeer(() => {}, {
    requestTimeoutMs: 100,
    scheduleTimeout: successTimers.scheduleTimeout,
    cancelTimeout: successTimers.cancelTimeout,
  });
  const p1 = successPeer.request('initialize', {});
  successPeer.receiveLine(JSON.stringify({ id: 1, result: { ok: true } }));
  assert.deepEqual(await p1, { ok: true });
  assert.equal(successTimers.activeCount(), 0);
  assert.equal(successTimers.cancelledCount(), 1);

  const failTimers = manualRpcTimers();
  const failPeer = new CodexRpcPeer(() => { throw new Error('write error'); }, {
    requestTimeoutMs: 100,
    scheduleTimeout: failTimers.scheduleTimeout,
    cancelTimeout: failTimers.cancelTimeout,
  });
  await assert.rejects(failPeer.request('initialize', {}), /write error/);
  assert.equal(failTimers.activeCount(), 0);
  assert.equal(failTimers.cancelledCount(), 1);

  const closeTimers = manualRpcTimers();
  const closePeer = new CodexRpcPeer(() => {}, {
    requestTimeoutMs: 100,
    scheduleTimeout: closeTimers.scheduleTimeout,
    cancelTimeout: closeTimers.cancelTimeout,
  });
  const p3 = closePeer.request('initialize', {});
  closePeer.close(new Error('connection closed'));
  await assert.rejects(p3, /connection closed/);
  assert.equal(closeTimers.activeCount(), 0);
  assert.equal(closeTimers.cancelledCount(), 1);
});

test('Codex Session handles startup timeout by reaching fatal error path', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-timeout-'));
  runWithWindowId('startup-timeout-window', () => setCurrentFolder(folder));
  t.after(() => {
    runWithWindowId('startup-timeout-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const proc = new FakeCodexProcess();
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'startup-timeout-window',
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => proc as unknown as ChildProcessWithoutNullStreams,
    30,
  );

  session.begin();
  await new Promise((resolve) => setTimeout(resolve, 70));

  const events = ws.sent.map((item) => JSON.parse(item) as { t: string; message?: string });
  const exitEvent = events.find((e) => e.t === 'exit');
  assert.ok(exitEvent);
  assert.match(exitEvent.message ?? '', /request timed out: initialize/);
  assert.equal(ws.readyState, 3);
  session.dispose();
});

test('Codex Session handles turn/start timeout by sending error and clearing busy state', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-turn-timeout-'));
  runWithWindowId('turn-timeout-window', () => setCurrentFolder(folder));
  t.after(() => {
    runWithWindowId('turn-timeout-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const proc = new FakeCodexProcess();
  proc.stdin.on('data', (chunk: Buffer) => {
    const req = JSON.parse(String(chunk)) as { id: number; method: string };
    if (req.method === 'initialize') proc.stdout.write(`${JSON.stringify({ id: req.id, result: {} })}\n`);
    else if (req.method === 'model/list') proc.stdout.write(`${JSON.stringify({ id: req.id, result: { data: [] } })}\n`);
    else if (req.method === 'skills/list') proc.stdout.write(`${JSON.stringify({ id: req.id, result: { data: [] } })}\n`);
    else if (req.method === 'thread/start') proc.stdout.write(`${JSON.stringify({ id: req.id, result: { thread: { id: 'thread-1' } } })}\n`);
    // ignore turn/start
  });

  const session = new CodexSession(
    ws as unknown as WebSocket,
    'turn-timeout-window',
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => proc as unknown as ChildProcessWithoutNullStreams,
    30,
  );
  session.begin();
  await settle();

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await new Promise((resolve) => setTimeout(resolve, 70));

  const events = ws.sent.map((item) => JSON.parse(item) as { t: string; message?: string; isError?: boolean });
  const errorMsg = events.find((e) => e.t === 'error' && /request timed out: turn\/start/.test(e.message ?? ''));
  assert.ok(errorMsg, `Expected turn/start timeout error event, got: ${JSON.stringify(events)}`);

  const turnEnd = events.find((e) => e.t === 'turn-end');
  assert.ok(turnEnd);
  assert.equal(turnEnd.isError, true);

  const runtime = session as unknown as { busy: boolean; activeTurnId: string | null };
  assert.equal(runtime.busy, false);
  assert.equal(runtime.activeTurnId, null);
  session.dispose();
});

test('Codex Session fences a timed-out turn/start generation before accepting another turn', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-turn-timeout-fence-'));
  runWithWindowId('turn-timeout-fence-window', () => setCurrentFolder(folder));
  t.after(() => {
    runWithWindowId('turn-timeout-fence-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const first = new FakeCodexProcess();
  const second = new FakeCodexProcess();
  const processes = [first, second];
  let timedOutRequestId: number | null = null;

  const wireProcess = (proc: FakeCodexProcess, generation: number) => {
    proc.stdin.on('data', (chunk: Buffer) => {
      const req = JSON.parse(String(chunk)) as { id: number; method: string };
      const respond = (result: Record<string, unknown>) => {
        proc.stdout.write(`${JSON.stringify({ id: req.id, result })}\n`);
      };
      if (req.method === 'initialize') respond({});
      else if (req.method === 'model/list') respond({ data: [] });
      else if (req.method === 'skills/list') respond({ data: [] });
      else if (req.method === 'thread/start') respond({ thread: { id: 'thread-1' } });
      else if (req.method === 'thread/resume') respond({ thread: { id: 'thread-1' } });
      else if (req.method === 'turn/start' && generation === 1 && timedOutRequestId === null) {
        timedOutRequestId = req.id;
      } else if (req.method === 'turn/start') {
        respond({ turn: { id: 'turn-2' } });
      }
    });
  };
  wireProcess(first, 1);
  wireProcess(second, 2);

  const session = new CodexSession(
    ws as unknown as WebSocket,
    'turn-timeout-fence-window',
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => processes.shift() as unknown as ChildProcessWithoutNullStreams,
    30,
  );
  session.begin();
  await settle();

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'first' }));
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.notEqual(timedOutRequestId, null);

  first.stdout.write(`${JSON.stringify({ id: timedOutRequestId, result: { turn: { id: 'turn-1' } } })}\n`);
  first.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { turn: { id: 'turn-1' } } })}\n`);
  await settle();

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'second' }));
  await settle();

  first.stdout.write(`${JSON.stringify({
    method: 'turn/completed',
    params: { turn: { id: 'turn-1', status: 'completed' } },
  })}\n`);
  await settle();

  const runtime = session as unknown as { busy: boolean; activeTurnId: string | null };
  assert.equal(first.killed, true, 'the generation with an ambiguous mutating request must be retired');
  assert.equal(runtime.busy, true);
  assert.equal(runtime.activeTurnId, 'turn-2');
  session.dispose();
  assert.equal(second.killed, true);
});

test('Codex Session handles steer timeout without ending an active turn', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-steer-timeout-'));
  runWithWindowId('steer-timeout-window', () => setCurrentFolder(folder));
  t.after(() => {
    runWithWindowId('steer-timeout-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const proc = new FakeCodexProcess();
  proc.stdin.on('data', (chunk: Buffer) => {
    const req = JSON.parse(String(chunk)) as { id: number; method: string };
    if (req.method === 'initialize') proc.stdout.write(`${JSON.stringify({ id: req.id, result: {} })}\n`);
    else if (req.method === 'model/list') proc.stdout.write(`${JSON.stringify({ id: req.id, result: { data: [] } })}\n`);
    else if (req.method === 'skills/list') proc.stdout.write(`${JSON.stringify({ id: req.id, result: { data: [] } })}\n`);
    else if (req.method === 'thread/start') proc.stdout.write(`${JSON.stringify({ id: req.id, result: { thread: { id: 'thread-1' } } })}\n`);
    else if (req.method === 'turn/start') proc.stdout.write(`${JSON.stringify({ id: req.id, result: { turn: { id: 'turn-1' } } })}\n`);
    // ignore turn/steer
  });

  const session = new CodexSession(
    ws as unknown as WebSocket,
    'steer-timeout-window',
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => proc as unknown as ChildProcessWithoutNullStreams,
    30,
  );
  session.begin();
  await settle();

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();

  const runtime = session as unknown as { busy: boolean; activeTurnId: string | null };
  assert.equal(runtime.busy, true);
  assert.equal(runtime.activeTurnId, 'turn-1');

  ws.emit('message', JSON.stringify({ t: 'steer', id: 'steer-1', text: 'focus on tests' }));
  await new Promise((resolve) => setTimeout(resolve, 70));

  const events = ws.sent.map((item) => JSON.parse(item) as { t: string; id?: string; ok?: boolean; message?: string });
  const steerResult = events.find((e) => e.t === 'steer-result' && e.id === 'steer-1');
  assert.ok(steerResult);
  assert.equal(steerResult.ok, false);
  assert.match(steerResult.message ?? '', /request timed out: turn\/steer/);

  assert.equal(runtime.busy, true);
  assert.equal(runtime.activeTurnId, 'turn-1');
  session.dispose();
});

test('Codex Session failed turn completed with message preserves it', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-err-preserve-'));
  runWithWindowId('err-preserve-window', () => setCurrentFolder(folder));
  t.after(() => {
    clearAgentRuntimeFailure('codex');
    runWithWindowId('err-preserve-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'err-preserve-window',
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => native.proc as unknown as ChildProcessWithoutNullStreams,
  );
  session.begin();
  await settle();

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();

  emitCodexTurnCompleted(native.proc, 'turn-1', 'failed', 'sandbox service offline');
  await settle();

  const events = ws.sent.map((item) => JSON.parse(item) as { t: string; message?: string; isError?: boolean });
  assert.deepEqual(events.filter((event) => event.t === 'error'), [
    { t: 'error', message: 'sandbox service offline' },
  ]);
  assert.deepEqual(events.filter((event) => event.t === 'turn-end'), [
    { t: 'turn-end', isError: true },
  ]);
  session.dispose();
});

test('Codex Session failed turn completed without message uses fallback', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-err-fallback-'));
  runWithWindowId('err-fallback-window', () => setCurrentFolder(folder));
  t.after(() => {
    clearAgentRuntimeFailure('codex');
    runWithWindowId('err-fallback-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'err-fallback-window',
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => native.proc as unknown as ChildProcessWithoutNullStreams,
  );
  session.begin();
  await settle();

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();

  emitCodexTurnCompleted(native.proc, 'turn-1', 'failed');
  await settle();

  const events = ws.sent.map((item) => JSON.parse(item) as { t: string; message?: string; isError?: boolean });
  assert.deepEqual(events.filter((event) => event.t === 'error'), [
    { t: 'error', message: 'Codex failed before completing the turn.' },
  ]);
  assert.deepEqual(events.filter((event) => event.t === 'turn-end'), [
    { t: 'turn-end', isError: true },
  ]);
  session.dispose();
});

test('Codex Session failed turn completed with a blank message uses fallback', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-err-blank-'));
  runWithWindowId('err-blank-window', () => setCurrentFolder(folder));
  t.after(() => {
    clearAgentRuntimeFailure('codex');
    runWithWindowId('err-blank-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'err-blank-window',
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => native.proc as unknown as ChildProcessWithoutNullStreams,
  );
  session.begin();
  await settle();

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();

  emitCodexTurnCompleted(native.proc, 'turn-1', 'failed', '   ');
  await settle();

  const events = ws.sent.map((item) => JSON.parse(item) as { t: string; message?: string; isError?: boolean });
  assert.deepEqual(events.filter((event) => event.t === 'error'), [
    { t: 'error', message: 'Codex failed before completing the turn.' },
  ]);
  assert.deepEqual(events.filter((event) => event.t === 'turn-end'), [
    { t: 'turn-end', isError: true },
  ]);
  session.dispose();
});

test('Codex Session error with willRetry: true stays active through successful completion', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-willretry-true-'));
  runWithWindowId('willretry-true-window', () => setCurrentFolder(folder));
  t.after(() => {
    clearAgentRuntimeFailure('codex');
    runWithWindowId('willretry-true-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'willretry-true-window',
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => native.proc as unknown as ChildProcessWithoutNullStreams,
  );
  session.begin();
  await settle();

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();

  emitCodexError(native.proc, 'turn-1', 'transient rate limit', true);
  await settle();

  const runtime = session as unknown as { busy: boolean };
  let events = ws.sent.map((item) => JSON.parse(item) as { t: string; isError?: boolean });
  assert.deepEqual(events.filter((event) => event.t === 'error'), []);
  assert.deepEqual(events.filter((event) => event.t === 'turn-end'), []);
  assert.equal(runtime.busy, true);

  emitCodexTurnCompleted(native.proc, 'turn-1', 'completed');
  await settle();

  events = ws.sent.map((item) => JSON.parse(item) as { t: string; isError?: boolean });
  assert.deepEqual(events.filter((event) => event.t === 'error'), []);
  assert.deepEqual(events.filter((event) => event.t === 'turn-end'), [
    { t: 'turn-end', isError: false },
  ]);
  assert.equal(runtime.busy, false);
  session.dispose();
});

test('Codex Session terminal errors settle only their matching active turn once', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-willretry-false-'));
  runWithWindowId('willretry-false-window', () => setCurrentFolder(folder));
  t.after(() => {
    clearAgentRuntimeFailure('codex');
    runWithWindowId('willretry-false-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const native = catalogProcess(undefined, { turnIds: ['turn-1', 'turn-2'] });
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'willretry-false-window',
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => native.proc as unknown as ChildProcessWithoutNullStreams,
  );
  session.begin();
  await settle();

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();

  emitCodexError(native.proc, 'turn-1', 'fatal crash', false);
  await settle();

  let events = ws.sent.map((item) => JSON.parse(item) as { t: string; message?: string; isError?: boolean });
  assert.deepEqual(events.filter((event) => event.t === 'error'), [
    { t: 'error', message: 'fatal crash' },
  ]);
  assert.deepEqual(events.filter((event) => event.t === 'turn-end'), [
    { t: 'turn-end', isError: true },
  ]);

  ws.sent = [];
  emitCodexError(native.proc, 'turn-1', 'fatal crash', false);
  emitCodexTurnCompleted(native.proc, 'turn-1', 'failed', 'fatal crash');
  await settle();

  events = ws.sent.map((item) => JSON.parse(item) as { t: string });
  assert.deepEqual(events.filter((event) => event.t === 'error' || event.t === 'turn-end'), []);

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'next turn' }));
  await settle();

  const runtime = session as unknown as { busy: boolean; activeTurnId: string | null };
  assert.equal(runtime.busy, true);
  assert.equal(runtime.activeTurnId, 'turn-2');

  ws.sent = [];
  emitCodexError(native.proc, 'turn-1', 'late fatal crash', false);
  emitCodexTurnCompleted(native.proc, 'turn-1', 'failed', 'late fatal crash');
  await settle();

  events = ws.sent.map((item) => JSON.parse(item) as { t: string });
  assert.deepEqual(events.filter((event) => event.t === 'error' || event.t === 'turn-end'), []);
  assert.equal(runtime.busy, true);
  assert.equal(runtime.activeTurnId, 'turn-2');

  emitCodexTurnCompleted(native.proc, 'turn-2', 'completed');
  await settle();

  events = ws.sent.map((item) => JSON.parse(item) as { t: string; isError?: boolean });
  assert.deepEqual(events.filter((event) => event.t === 'error'), []);
  assert.deepEqual(events.filter((event) => event.t === 'turn-end'), [
    { t: 'turn-end', isError: false },
  ]);
  session.dispose();
});

test('Codex Session retains a terminal error received before its turn/start continuation', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-early-terminal-'));
  runWithWindowId('early-terminal-window', () => setCurrentFolder(folder));
  t.after(() => {
    clearAgentRuntimeFailure('codex');
    runWithWindowId('early-terminal-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'early-terminal-window',
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => native.proc as unknown as ChildProcessWithoutNullStreams,
  );
  session.begin();
  await settle();

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  native.proc.stdout.write(`${JSON.stringify({ method: 'error', params: {
    threadId: 'thread-1', turnId: 'turn-1', willRetry: false, error: { message: 'early fatal crash' },
  } })}\n`);
  await settle();

  const events = ws.sent.map((item) => JSON.parse(item) as { t: string; message?: string; isError?: boolean });
  assert.deepEqual(events.filter((event) => event.t === 'error'), [{ t: 'error', message: 'early fatal crash' }]);
  assert.deepEqual(events.filter((event) => event.t === 'turn-end'), [{ t: 'turn-end', isError: true }]);
  session.dispose();
});

test('Codex Session user interruption stays non-error across terminal notification forms', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-cancel-'));
  runWithWindowId('cancel-window', () => setCurrentFolder(folder));
  t.after(() => {
    clearAgentRuntimeFailure('codex');
    runWithWindowId('cancel-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const native = catalogProcess(undefined, { turnIds: ['turn-1', 'turn-2'] });
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'cancel-window',
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => native.proc as unknown as ChildProcessWithoutNullStreams,
  );
  session.begin();
  await settle();

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();

  ws.emit('message', JSON.stringify({ t: 'interrupt' }));
  await settle();

  emitCodexTurnCompleted(native.proc, 'turn-1', 'interrupted');
  await settle();

  let events = ws.sent.map((item) => JSON.parse(item) as { t: string; isError?: boolean });
  assert.deepEqual(events.filter((event) => event.t === 'error'), []);
  assert.deepEqual(events.filter((event) => event.t === 'turn-end'), [
    { t: 'turn-end', isError: false },
  ]);

  ws.sent = [];
  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'try again' }));
  await settle();
  ws.emit('message', JSON.stringify({ t: 'interrupt' }));
  await settle();

  emitCodexError(native.proc, 'turn-2', 'turn interrupted', false);
  await settle();

  events = ws.sent.map((item) => JSON.parse(item) as { t: string; isError?: boolean });
  assert.deepEqual(events.filter((event) => event.t === 'error'), []);
  assert.deepEqual(events.filter((event) => event.t === 'turn-end'), [
    { t: 'turn-end', isError: false },
  ]);

  session.dispose();
});
