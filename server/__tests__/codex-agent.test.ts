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
import { codexAccessOptions, isStashbaseWorkspaceEdit, isWorkspaceFileChange, permanentlyDeleteCodexThread } from '../codex-agent.ts';
import { CodexRpcPeer } from '../codex-rpc-transport.ts';
import { runtimeDescriptorFor } from '../agent-contract.ts';
import { BUILT_IN_AGENT_ADAPTERS } from '../agent-adapters.ts';
import { CodexSession } from '../codex-session-runtime.ts';
import { agentPersonaLibrary } from '../agent-persona.ts';
import { clearCurrentFolder, runWithWindowId, openProjectFolder } from '../folder.ts';

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

test('Codex sends a structured scope-retirement exit before closing', () => {
  const ws = new FakeWebSocket();
  const session = new CodexSession(ws as unknown as WebSocket, 'scope-retirement-window');

  session.dispose({ kind: 'scope-removed', folder: '/workspace' });

  assert.deepEqual(ws.sent.map((value) => JSON.parse(value)), [
    { t: 'exit', reason: 'scope-removed', folder: '/workspace' },
  ]);
  assert.equal(ws.readyState, 3);
});

function catalogProcess(
  models: Array<Record<string, unknown>> = [{ id: 'native-model', displayName: 'Native model' }],
  options: {
    pages?: Array<Record<string, unknown>[]>;
    skills?: Array<Record<string, unknown>>;
    skillsListError?: string;
    threadModel?: string;
    selectedTurnError?: string;
    interruptError?: string;
    turnIds?: string[];
    /** Answers `model/list` only once this settles, so a test can act while
     *  the catalog is still being read. */
    catalogGate?: Promise<void>;
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
    } else if (request.method === 'turn/interrupt' && options.interruptError) {
      proc.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32000, message: options.interruptError } })}\n`);
    } else if (request.method === 'model/list' && options.catalogGate) {
      void options.catalogGate.then(() => proc.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
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
  await runWithWindowId('model-window', () => openProjectFolder(folder));
  t.after(() => { runWithWindowId('model-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });
  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(ws as unknown as WebSocket, 'model-window', undefined, undefined, undefined, 'native-model', undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
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

test("Codex injects the Chat's Persona with hidden StashBase routing policy", async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-instructions-'));
  const persona = 'Prefer primary research notes.';
  await runWithWindowId('instructions-window', () => openProjectFolder(folder));
  const chosen = agentPersonaLibrary().create({ name: 'Researcher', description: '', icon: 'flask-conical', prompt: persona });
  t.after(() => {
    runWithWindowId('instructions-window', () => clearCurrentFolder());
    agentPersonaLibrary().remove(chosen.id);
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'instructions-window',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => native.proc as unknown as ChildProcessWithoutNullStreams,
  );
  session.persona = chosen.id;
  t.after(() => session.dispose());

  session.begin();
  await settle();
  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'summarize the PDFs' }));
  await settle();

  const developerInstructions = native.requests.find(
    (request) => request.method === 'thread/start',
  )?.params.developerInstructions;
  assert.equal(typeof developerInstructions, 'string');
  assert.match(String(developerInstructions), /StashBase MCP/i);
  assert.match(String(developerInstructions), /search_project/);
  assert.match(String(developerInstructions), /read_file/);
  assert.match(String(developerInstructions), /Prefer primary research notes\./);
  assert.notEqual(developerInstructions, persona);
});

test('Codex holds a model chosen while its catalog is still being read and applies it to the first turn', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-model-hold-'));
  await runWithWindowId('model-hold-window', () => openProjectFolder(folder));
  t.after(() => { runWithWindowId('model-hold-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });
  const ws = new FakeWebSocket();
  let releaseCatalog!: () => void;
  const catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
  const native = catalogProcess([
    { id: 'model-one', displayName: 'Model One', isDefault: true },
    { id: 'model-two', displayName: 'Model Two' },
  ], { catalogGate });
  const session = new CodexSession(ws as unknown as WebSocket, 'model-hold-window', undefined, undefined, undefined, undefined, undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
  session.begin();
  await settle();

  ws.emit('message', JSON.stringify({ t: 'set-model', model: 'model-two' }));
  await settle();
  const refused = ws.sent.map((item) => JSON.parse(item) as { fallback?: string }).some((event) => event.fallback);
  assert.equal(refused, false, 'a pick is not refused against a catalog that is not read yet');

  releaseCatalog();
  await settle();
  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'first turn' }));
  await settle();

  assert.equal(native.requests.find((request) => request.method === 'turn/start')?.params.model, 'model-two');
  session.dispose();
});

test('Codex changes the model for the next turn without replacing its thread', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-model-switch-'));
  await runWithWindowId('model-switch-window', () => openProjectFolder(folder));
  t.after(() => { runWithWindowId('model-switch-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });
  const ws = new FakeWebSocket();
  const native = catalogProcess([
    { id: 'model-one', displayName: 'Model One', isDefault: true },
    { id: 'model-two', displayName: 'Model Two' },
  ], { turnIds: ['turn-1', 'turn-2', 'turn-3'] });
  const session = new CodexSession(ws as unknown as WebSocket, 'model-switch-window', undefined, undefined, undefined, undefined, undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
  session.begin();
  await settle();

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'first turn' }));
  await settle();
  ws.emit('message', JSON.stringify({ t: 'set-model', model: 'model-two' }));
  emitCodexTurnCompleted(native.proc, 'turn-1', 'completed');
  await settle();

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'second turn' }));
  await settle();
  emitCodexTurnCompleted(native.proc, 'turn-2', 'completed');
  await settle();

  ws.emit('message', JSON.stringify({ t: 'set-model', model: 'model-two' }));
  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'third turn' }));
  await settle();

  const turns = native.requests.filter((request) => request.method === 'turn/start');
  assert.equal(turns.length, 3);
  assert.equal(turns[0]?.params.threadId, 'thread-1');
  assert.equal('model' in (turns[0]?.params ?? {}), false);
  assert.equal(turns[1]?.params.threadId, 'thread-1');
  assert.equal('model' in (turns[1]?.params ?? {}), false, 'a busy model change must not affect the next turn');
  assert.equal(turns[2]?.params.threadId, 'thread-1');
  assert.equal(turns[2]?.params.model, 'model-two');
  session.dispose();
});

test('Codex recovers unavailable selections to Default and never forwards an override while resuming', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-model-'));
  await runWithWindowId('stale-window', () => openProjectFolder(folder));
  await runWithWindowId('resume-window', () => openProjectFolder(folder));
  t.after(() => { runWithWindowId('stale-window', () => clearCurrentFolder()); runWithWindowId('resume-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });

  const staleWs = new FakeWebSocket();
  const staleNative = catalogProcess();
  const stale = new CodexSession(staleWs as unknown as WebSocket, 'stale-window', undefined, undefined, undefined, 'withdrawn-model', undefined, undefined, () => staleNative.proc as unknown as ChildProcessWithoutNullStreams);
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
  const resumed = new CodexSession(resumeWs as unknown as WebSocket, 'resume-window', undefined, 'thread-old', undefined, 'native-model', undefined, undefined, () => resumeNative.proc as unknown as ChildProcessWithoutNullStreams);
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
  await runWithWindowId('default-window', () => openProjectFolder(folder));
  t.after(() => { runWithWindowId('default-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });
  const ws = new FakeWebSocket();
  const native = catalogProcess(undefined, { threadModel: 'runtime-default' });
  const session = new CodexSession(ws as unknown as WebSocket, 'default-window', undefined, undefined, undefined, undefined, undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
  session.begin();
  await settle();
  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();
  const active = ws.sent.map((item) => JSON.parse(item) as { t: string; activeModel?: string }).filter((event) => event.t === 'models').at(-1);
  assert.equal(active?.activeModel, 'runtime-default');
  assert.equal('model' in (native.requests.find((request) => request.method === 'turn/start')?.params ?? {}), false);
  session.dispose();
});

test('Codex does not speculate about the active Default model before a new thread starts', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-default-truth-'));
  await runWithWindowId('default-truth-window', () => openProjectFolder(folder));
  t.after(() => { runWithWindowId('default-truth-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });
  const ws = new FakeWebSocket();
  const native = catalogProcess([
    { id: 'catalog-default', displayName: 'Catalog Default', isDefault: true },
    { id: 'thread-model', displayName: 'Thread Model' },
  ], { threadModel: 'thread-model' });
  const session = new CodexSession(ws as unknown as WebSocket, 'default-truth-window', undefined, undefined, undefined, undefined, undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
  session.begin();
  await settle();

  const beforeTurn = ws.sent
    .map((item) => JSON.parse(item) as { t: string; activeModel?: string })
    .find((event) => event.t === 'models');
  assert.equal(beforeTurn?.activeModel, undefined, 'Default remains unnamed until the native thread reports its model');

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();
  const afterTurn = ws.sent
    .map((item) => JSON.parse(item) as { t: string; activeModel?: string })
    .filter((event) => event.t === 'models')
    .at(-1);
  assert.equal(afterTurn?.activeModel, 'thread-model');
  assert.equal('model' in (native.requests.find((request) => request.method === 'turn/start')?.params ?? {}), false);
  session.dispose();
});

test('Codex invokes an enabled selected skill and never publishes disabled skills', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-skills-'));
  await runWithWindowId('skills-window', () => openProjectFolder(folder));
  t.after(() => { runWithWindowId('skills-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });
  const ws = new FakeWebSocket();
  const native = catalogProcess(undefined, {
    skills: [
      { name: 'release-notes', path: '/skills/release-notes/SKILL.md', enabled: true },
      { name: 'disabled-skill', path: '/skills/disabled-skill/SKILL.md', enabled: false },
    ],
  });
  const session = new CodexSession(ws as unknown as WebSocket, 'skills-window', undefined, undefined, undefined, undefined, undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
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
  await runWithWindowId('empty-skills-window', () => openProjectFolder(folder));
  await runWithWindowId('failed-skills-window', () => openProjectFolder(folder));
  t.after(() => { runWithWindowId('empty-skills-window', () => clearCurrentFolder()); runWithWindowId('failed-skills-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });

  const emptyWs = new FakeWebSocket();
  const empty = new CodexSession(emptyWs as unknown as WebSocket, 'empty-skills-window', undefined, undefined, undefined, undefined, undefined, undefined, () => catalogProcess().proc as unknown as ChildProcessWithoutNullStreams);
  empty.begin();
  await settle();
  assert.equal(emptyWs.sent.map((item) => JSON.parse(item) as { t: string; state?: string }).find((event) => event.t === 'skills')?.state, 'empty');
  assert.equal(emptyWs.sent.some((item) => (JSON.parse(item) as { t: string }).t === 'ready'), true);
  empty.dispose();

  const failedWs = new FakeWebSocket();
  const failedNative = catalogProcess(undefined, { skillsListError: 'skills unavailable' });
  const failed = new CodexSession(failedWs as unknown as WebSocket, 'failed-skills-window', undefined, undefined, undefined, undefined, undefined, undefined, () => failedNative.proc as unknown as ChildProcessWithoutNullStreams);
  failed.begin();
  await settle();
  assert.equal(failedWs.sent.map((item) => JSON.parse(item) as { t: string; state?: string }).find((event) => event.t === 'skills')?.state, 'failed');
  assert.equal(failedWs.sent.some((item) => (JSON.parse(item) as { t: string }).t === 'ready'), true);
  failed.dispose();
});

test('Codex forwards a runtime-native effort identifier without remapping it', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-effort-'));
  await runWithWindowId('native-effort-window', () => openProjectFolder(folder));
  t.after(() => { runWithWindowId('native-effort-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });
  const ws = new FakeWebSocket();
  const native = catalogProcess([{ id: 'native-model', displayName: 'Native model', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }] }]);
  const session = new CodexSession(ws as unknown as WebSocket, 'native-effort-window', 'ultra', undefined, undefined, 'native-model', undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
  session.begin();
  await settle();
  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();

  assert.equal(native.requests.find((request) => request.method === 'turn/start')?.params.effort, 'ultra');
  session.dispose();
});

test('Codex retries a rejected selected model with Default and publishes recovery', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-model-'));
  await runWithWindowId('reject-window', () => openProjectFolder(folder));
  t.after(() => { runWithWindowId('reject-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });
  const ws = new FakeWebSocket();
  const native = catalogProcess(undefined, { selectedTurnError: 'model unavailable' });
  const session = new CodexSession(ws as unknown as WebSocket, 'reject-window', undefined, undefined, undefined, 'native-model', undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
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
  await runWithWindowId('turn-error-window', () => openProjectFolder(folder));
  t.after(() => { runWithWindowId('turn-error-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });
  const ws = new FakeWebSocket();
  const native = catalogProcess(undefined, { selectedTurnError: 'sandbox service unavailable' });
  const session = new CodexSession(ws as unknown as WebSocket, 'turn-error-window', undefined, undefined, undefined, 'native-model', undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
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
  await runWithWindowId('pages-window', () => openProjectFolder(folder));
  t.after(() => { runWithWindowId('pages-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });
  const ws = new FakeWebSocket();
  const native = catalogProcess([], { pages: [
    [{ id: 'early-model', displayName: 'Early' }],
    [{ id: 'late-model', displayName: 'Late', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'xhigh' }] }],
  ] });
  const session = new CodexSession(ws as unknown as WebSocket, 'pages-window', undefined, undefined, undefined, 'late-model', undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
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
  await runWithWindowId('idle-exit-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('idle-exit-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(ws as unknown as WebSocket, 'idle-exit-window', undefined, undefined, undefined, undefined, undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
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
  await runWithWindowId('startup-exit-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('startup-exit-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const ws = new FakeWebSocket();
  const native = new FakeCodexProcess();
  native.stdin.once('data', () => native.emit('close', 23, null));
  const session = new CodexSession(ws as unknown as WebSocket, 'startup-exit-window', undefined, undefined, undefined, undefined, undefined, undefined, () => native as unknown as ChildProcessWithoutNullStreams);
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
  await runWithWindowId('busy-exit-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('busy-exit-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(ws as unknown as WebSocket, 'busy-exit-window', undefined, undefined, undefined, undefined, undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
  session.begin();
  await settle();
  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();

  native.proc.emit('close', null, 'SIGKILL');
  await settle();
  const adapter = BUILT_IN_AGENT_ADAPTERS.find((item) => item.id === 'codex')!;
  assert.equal(runtimeDescriptorFor(adapter, '/native/codex').state, 'available');

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
  await runWithWindowId('startup-timeout-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('startup-timeout-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const proc = new FakeCodexProcess();
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'startup-timeout-window',
    undefined, undefined, undefined, undefined, undefined, undefined,
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
  await runWithWindowId('turn-timeout-window', () => openProjectFolder(folder));
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
    undefined, undefined, undefined, undefined, undefined, undefined,
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
  await runWithWindowId('turn-timeout-fence-window', () => openProjectFolder(folder));
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
    undefined, undefined, undefined, undefined, undefined, undefined,
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
  await runWithWindowId('steer-timeout-window', () => openProjectFolder(folder));
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
    undefined, undefined, undefined, undefined, undefined, undefined,
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

test('Codex model compatibility recovery correlates metadata warnings with the rejected model', async (t) => {
  const model = 'gpt-6.1-sol';
  const rejection = JSON.stringify({ type: 'error', status: 400, error: {
    type: 'invalid_request_error',
    message: `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
  } });
  const warning = (id: string) => `Model metadata for \`${id}\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.`;
  const cases = [
    { name: 'terminal notification', warning: warning(model), terminal: 'error', update: true },
    { name: 'failed completion', warning: warning(model), terminal: 'completed', update: true },
    { name: 'start rejection', warning: warning(model), terminal: 'rpc', update: true },
    { name: 'no metadata warning', terminal: 'error', update: false },
    { name: 'another model warning', warning: warning('another-model'), terminal: 'error', update: false },
    { name: 'service tier warning alone', warning: `Configured service tier \`priority\` is not advertised as supported for model \`${model}\` and will be omitted from requests.`, terminal: 'error', update: false },
    { name: 'unrelated failure', warning: warning(model), terminal: 'error', message: 'sandbox service offline', update: false },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-model-recovery-'));
      const windowId = 'model-recovery-window';
      await runWithWindowId(windowId, () => openProjectFolder(folder));
      const ws = new FakeWebSocket();
      const native = catalogProcess([{ id: model }], { threadModel: model,
        ...(scenario.terminal === 'rpc' ? { selectedTurnError: rejection } : {}),
      });
      const session = new CodexSession(
        ws as unknown as WebSocket, windowId,
        undefined, undefined, undefined, scenario.terminal === 'rpc' ? model : undefined, undefined, undefined,
        () => native.proc as unknown as ChildProcessWithoutNullStreams,
      );
      t.after(() => {
        session.dispose();
        runWithWindowId(windowId, () => clearCurrentFolder());
        fs.rmSync(folder, { recursive: true, force: true });
      });
      session.begin();
      await settle();
      if (scenario.warning) native.proc.stdout.write(`${JSON.stringify({ method: 'warning', params: { message: scenario.warning } })}\n`);
      await settle();
      const events = () => ws.sent.map((item) => JSON.parse(item));
      assert.deepEqual(events().filter((event) => event.t === 'error' || event.t === 'turn-end'), []);
      if (scenario.warning) assert.ok(events().some((event) => event.t === 'notice' && event.message === scenario.warning));

      ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
      await settle();
      const message = scenario.message ?? rejection;
      if (scenario.terminal === 'error') emitCodexError(native.proc, 'turn-1', message, false);
      if (scenario.terminal !== 'rpc') emitCodexTurnCompleted(native.proc, 'turn-1', 'failed', message);
      await settle();

      assert.deepEqual(events().filter((event) => event.t === 'error'), [{
        t: 'error', message,
        ...(scenario.update ? { failure: { kind: 'runtime-outdated' } } : {}),
      }]);
      assert.deepEqual(events().filter((event) => event.t === 'turn-end'), [{ t: 'turn-end', isError: true }]);
      assert.equal(native.requests.filter((request) => request.method === 'turn/start').length, 1);
      assert.equal(ws.readyState, 1);
    });
  }
});

test('Codex Session failed turn completed with message preserves it', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-err-preserve-'));
  await runWithWindowId('err-preserve-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('err-preserve-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'err-preserve-window',
    undefined, undefined, undefined, undefined, undefined, undefined,
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

test('Codex Session suppresses successful automatic approval reviews but preserves actionable native warnings', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-notice-'));
  await runWithWindowId('notice-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('notice-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'notice-window',
    undefined, undefined, undefined, undefined, undefined, undefined,
    () => native.proc as unknown as ChildProcessWithoutNullStreams,
  );
  session.begin();
  await settle();

  assert.deepEqual(
    (native.requests.find((request) => request.method === 'initialize')?.params.capabilities as Record<string, unknown>)
      ?.optOutNotificationMethods,
    ['guardianWarning'],
    'the structured auto-review event replaces the duplicate prose summary',
  );
  native.proc.stdout.write(`${JSON.stringify({
    method: 'item/autoApprovalReview/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      review: {
        status: 'approved',
        riskLevel: 'low',
        userAuthorization: 'high',
        rationale: 'The user explicitly requested this reversible documentation edit.',
      },
    },
  })}\n`);
  native.proc.stdout.write(`${JSON.stringify({
    method: 'item/autoApprovalReview/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      review: {
        status: 'denied',
        riskLevel: 'high',
        userAuthorization: 'low',
        rationale: 'The requested action could remove unrelated files.',
      },
    },
  })}\n`);
  native.proc.stdout.write(`${JSON.stringify({
    method: 'guardianWarning',
    params: {
      threadId: 'thread-1',
      message: 'Legacy automatic approval review denied an unsafe action.',
    },
  })}\n`);
  native.proc.stdout.write(`${JSON.stringify({
    method: 'warning',
    params: {
      threadId: 'thread-1',
      message: 'Skill descriptions were shortened to fit the skills context budget.',
    },
  })}\n`);
  native.proc.stdout.write(`${JSON.stringify({
    method: 'configWarning',
    params: {
      summary: 'Configuration needs attention.',
      details: 'One setting was ignored.',
    },
  })}\n`);
  await settle();

  const events = ws.sent.map((item) => JSON.parse(item) as { t: string; message?: string });
  assert.deepEqual(events.filter((event) => event.t === 'notice'), [
    { t: 'notice', message: 'Automatic approval blocked an action.\n\nThe requested action could remove unrelated files.' },
    { t: 'notice', message: 'Legacy automatic approval review denied an unsafe action.' },
    { t: 'notice', message: 'Skill descriptions were shortened to fit the skills context budget.' },
    { t: 'notice', message: 'Configuration needs attention.\n\nOne setting was ignored.' },
  ]);
  assert.deepEqual(events.filter((event) => event.t === 'error'), []);
  session.dispose();
});

test('Codex Session classified turn failure carries its failure kind', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-err-kind-'));
  await runWithWindowId('err-kind-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('err-kind-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'err-kind-window',
    undefined, undefined, undefined, undefined, undefined, undefined,
    () => native.proc as unknown as ChildProcessWithoutNullStreams,
  );
  session.begin();
  await settle();

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();

  emitCodexTurnCompleted(native.proc, 'turn-1', 'failed', '401 Unauthorized: token expired');
  await settle();

  const events = ws.sent.map((item) => JSON.parse(item) as { t: string; message?: string; failure?: unknown });
  assert.deepEqual(events.filter((event) => event.t === 'error'), [
    { t: 'error', message: '401 Unauthorized: token expired', failure: { kind: 'auth-expired' } },
  ]);
  session.dispose();
});

test('Codex Session failed turn completed without message uses fallback', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-err-fallback-'));
  await runWithWindowId('err-fallback-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('err-fallback-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'err-fallback-window',
    undefined, undefined, undefined, undefined, undefined, undefined,
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
  await runWithWindowId('err-blank-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('err-blank-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'err-blank-window',
    undefined, undefined, undefined, undefined, undefined, undefined,
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
  await runWithWindowId('willretry-true-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('willretry-true-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'willretry-true-window',
    undefined, undefined, undefined, undefined, undefined, undefined,
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
  await runWithWindowId('willretry-false-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('willretry-false-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const native = catalogProcess(undefined, { turnIds: ['turn-1', 'turn-2'] });
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'willretry-false-window',
    undefined, undefined, undefined, undefined, undefined, undefined,
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
  await runWithWindowId('early-terminal-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('early-terminal-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const native = catalogProcess();
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'early-terminal-window',
    undefined, undefined, undefined, undefined, undefined, undefined,
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
  await runWithWindowId('cancel-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('cancel-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const native = catalogProcess(undefined, { turnIds: ['turn-1', 'turn-2'] });
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'cancel-window',
    undefined, undefined, undefined, undefined, undefined, undefined,
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

test('Codex Session treats an already-idle interrupt rejection as a completed stop', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-already-idle-'));
  await runWithWindowId('already-idle-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('already-idle-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const native = catalogProcess(undefined, { interruptError: 'no active turn to interrupt' });
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'already-idle-window',
    undefined, undefined, undefined, undefined, undefined, undefined,
    () => native.proc as unknown as ChildProcessWithoutNullStreams,
  );
  session.begin();
  await settle();

  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();
  ws.sent = [];

  ws.emit('message', JSON.stringify({ t: 'interrupt' }));
  await settle();

  const events = ws.sent.map((item) => JSON.parse(item) as { t: string; message?: string; isError?: boolean });
  assert.deepEqual(events.filter((event) => event.t === 'error'), []);
  assert.deepEqual(events.filter((event) => event.t === 'turn-end'), [{ t: 'turn-end', isError: false }]);
  const runtime = session as unknown as { busy: boolean; activeTurnId: string | null };
  assert.equal(runtime.busy, false);
  assert.equal(runtime.activeTurnId, null);
  session.dispose();
});

test('Codex Session keeps other interrupt rejections visible', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-interrupt-failure-'));
  await runWithWindowId('interrupt-failure-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('interrupt-failure-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const ws = new FakeWebSocket();
  const native = catalogProcess(undefined, { interruptError: 'interrupt transport unavailable' });
  const session = new CodexSession(
    ws as unknown as WebSocket,
    'interrupt-failure-window',
    undefined, undefined, undefined, undefined, undefined, undefined,
    () => native.proc as unknown as ChildProcessWithoutNullStreams,
  );
  session.begin();
  await settle();
  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'hello' }));
  await settle();
  ws.sent = [];

  ws.emit('message', JSON.stringify({ t: 'interrupt' }));
  await settle();

  const events = ws.sent.map((item) => JSON.parse(item) as { t: string; message?: string });
  assert.deepEqual(events.filter((event) => event.t === 'error'), [
    { t: 'error', message: 'interrupt transport unavailable' },
  ]);
  assert.deepEqual(events.filter((event) => event.t === 'turn-end'), []);
  assert.equal((session as unknown as { busy: boolean }).busy, true);
  session.dispose();
});

test('Codex forwards which model and level run by default and drops hidden entries', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-catalog-default-'));
  await runWithWindowId('catalog-default-window', () => openProjectFolder(folder));
  t.after(() => { runWithWindowId('catalog-default-window', () => clearCurrentFolder()); fs.rmSync(folder, { recursive: true, force: true }); });
  const ws = new FakeWebSocket();
  const native = catalogProcess([
    { id: 'newest', displayName: 'Newest', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] },
    // A declared default the model cannot run is not repeated as one.
    { id: 'odd', displayName: 'Odd', isDefault: false, defaultReasoningEffort: 'max', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
    { id: 'retired', displayName: 'Retired', hidden: true },
  ]);
  const session = new CodexSession(ws as unknown as WebSocket, 'catalog-default-window', undefined, undefined, undefined, undefined, undefined, undefined, () => native.proc as unknown as ChildProcessWithoutNullStreams);
  session.begin();
  await settle();

  const models = ws.sent
    .map((item) => JSON.parse(item) as { t: string; models?: Array<Record<string, unknown>> })
    .find((event) => event.t === 'models')?.models;
  assert.deepEqual(models, [
    { id: 'newest', label: 'Newest', supportedEfforts: ['low', 'medium'], defaultEffort: 'medium', isDefault: true },
    { id: 'odd', label: 'Odd', supportedEfforts: ['low'] },
  ]);
  session.dispose();
});
