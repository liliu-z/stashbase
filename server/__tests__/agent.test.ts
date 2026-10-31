import './isolated-home.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CanUseTool, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { WebSocket } from 'ws';
import {
  AgentSession,
  ClaudeNativeSessionOwnership,
  claudeActiveModelEvent,
  claudeModelCatalogFailureEvent,
  claudePermissionMode,
  claudeSkillCatalogEvent,
  claudeSkillPrompt,
  selectClaudeModel,
} from '../agent.ts';
import { agentPersonaLibrary } from '../agent-persona.ts';
import { composeAgentRuntimeInstructions } from '../agent-runtime-instructions.ts';
import { agentBootstrapStatus } from '../agent-runtime-installer.ts';
import { clearCurrentFolder, runWithWindowId, openProjectFolder, registerProjectFolderAsync } from '../folder.ts';
import { derivedNoteFor, registerDerivedSource } from '../derived-store.ts';
import { claudeTranscriptEffort } from '../claude-history.ts';

class FakeAgentWebSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(value: string): void { this.sent.push(value); }
  close(): void { this.readyState = 3; this.emit('close'); }
}

test('Claude sends a structured scope-retirement exit before closing', () => {
  const ws = new FakeAgentWebSocket();
  const session = new AgentSession(ws as unknown as WebSocket, 'scope-retirement-window');

  session.dispose({ kind: 'scope-removed', folder: '/workspace' });

  assert.deepEqual(ws.sent.map((value) => JSON.parse(value)), [
    { t: 'exit', reason: 'scope-removed', folder: '/workspace' },
  ]);
  assert.equal(ws.readyState, 3);
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function fakeClaudeQuery(failureOrMessages?: Error | SDKMessage[], failure?: Error): Query {
  return {
    async *[Symbol.asyncIterator]() {
      if (Array.isArray(failureOrMessages)) {
        for (const msg of failureOrMessages) {
          yield msg;
        }
      }
      const err = failure ?? (failureOrMessages instanceof Error ? failureOrMessages : undefined);
      if (err) throw err;
    },
    supportedModels: async () => [],
    supportedCommands: async () => [],
    setModel: async () => {},
    setPermissionMode: async () => {},
    interrupt: async () => {},
  } as unknown as Query;
}

test("Claude appends the Chat's Persona before hidden StashBase routing policy", async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-claude-instructions-'));
  const persona = 'Prefer primary research notes.';
  const chosen = agentPersonaLibrary().create({ name: 'Researcher', description: '', icon: 'flask-conical', prompt: persona });
  t.after(() => {
    agentPersonaLibrary().remove(chosen.id);
    fs.rmSync(folder, { recursive: true, force: true });
  });

  let appended = '';
  const ws = new FakeAgentWebSocket();
  const session = new AgentSession(
    ws as unknown as WebSocket,
    'claude-instructions-window',
    undefined,
    undefined,
    'default',
    undefined,
    undefined,
    ((request: { options: { systemPrompt?: { append?: string }; disallowedTools?: string[] } }) => {
      appended = request.options.systemPrompt?.append ?? '';
      for (const tool of ['Edit', 'MultiEdit', 'Write']) {
        assert.ok(!request.options.disallowedTools?.includes(tool), `${tool} must remain available for external files`);
      }
      return fakeClaudeQuery();
    }) as never,
    () => '/fake/claude',
    undefined,
    folder,
  );
  session.persona = chosen.id;
  t.after(() => session.dispose());

  session.begin();
  await settle();
  // The project's Math mode is off in this isolated config, and the policy
  // names the delimiters that follows from it.
  assert.equal(appended, composeAgentRuntimeInstructions(persona, false));
});

interface TurnEvent {
  t: string;
  message?: string;
  isError?: boolean;
}

function claudeErrorResult(
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries',
  errors: unknown,
): SDKMessage {
  return {
    type: 'result',
    subtype,
    is_error: true,
    errors,
    duration_ms: 100,
    duration_api_ms: 50,
    num_turns: 1,
    stop_reason: 'error',
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: {},
    permission_denials: [],
    uuid: 'test-result',
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

function claudeSuccessResult(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 100,
    duration_api_ms: 50,
    num_turns: 1,
    result: 'Finished',
    stop_reason: 'end_turn',
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: {},
    permission_denials: [],
    uuid: 'test-result',
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

function claudeSessionState(state: 'running' | 'requires_action' | 'idle'): SDKMessage {
  return {
    type: 'system', subtype: 'session_state_changed', state,
    uuid: randomUUID(), session_id: 'test-session',
  };
}

function streamingClaudeQuery(prompt: AsyncIterable<unknown>, sessionId = 'test-session'): Query {
  async function* stream() {
    yield {
      type: 'system', subtype: 'init', session_id: sessionId, model: 'native-model',
    } as unknown as SDKMessage;
    for await (const _message of prompt) {
      yield { ...claudeSuccessResult(), session_id: sessionId } as unknown as SDKMessage;
    }
  }
  return Object.assign(stream(), {
    supportedModels: async () => [],
    supportedCommands: async () => [],
    setModel: async () => {},
    setPermissionMode: async () => {},
    interrupt: async () => {},
  }) as unknown as Query;
}

test('Claude permission callback asks for mutations and unknown tools, and settles replies or cancellation', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-read-redirect-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const ws = new FakeAgentWebSocket();
  let canUseTool: CanUseTool | undefined;
  const session = new AgentSession(
    ws as unknown as WebSocket, 'permission-window', undefined, undefined, 'default', undefined, undefined,
    ((request: { prompt: AsyncIterable<unknown>; options: { canUseTool: CanUseTool } }) => {
      canUseTool = request.options.canUseTool;
      return streamingClaudeQuery(request.prompt);
    }) as never,
    () => '/fake/claude', undefined, project,
  );
  t.after(() => session.dispose());
  session.begin();
  await settle();
  assert.ok(canUseTool);
  const permissionEvents = () => ws.sent.map((s) => JSON.parse(s)).filter((event) => event.t === 'permission');
  for (const name of ['Read', 'Grep', 'mcp__stashbase__read_file', 'mcp__stashbase__search_project', 'mcp__stashbase__reindex']) {
    const result = await canUseTool(name, {}, { signal: new AbortController().signal, toolUseID: name });
    assert.equal(result.behavior, 'allow');
  }
  assert.equal(permissionEvents().length, 0);
  await registerProjectFolderAsync(project);
  const pdf = path.join(project, 'document.pdf');
  fs.writeFileSync(pdf, 'updated source');
  fs.utimesSync(pdf, 300, 300);
  registerDerivedSource(pdf);
  const prepared = derivedNoteFor(pdf);
  fs.mkdirSync(path.dirname(prepared), { recursive: true });
  fs.writeFileSync(prepared, 'old text\n<!-- stashbase-pdf-conversion: complete -->');
  fs.utimesSync(prepared, 100, 100);
  const nativeRead = () => canUseTool!('Read', { file_path: pdf }, { signal: new AbortController().signal, toolUseID: 'pdf' });
  assert.equal((await nativeRead()).behavior, 'allow', 'stale preparation must not redirect a native read');
  fs.utimesSync(prepared, 400, 400);
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-external-read-'));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  await registerProjectFolderAsync(external);
  const externalPdf = path.join(external, 'reference.pdf');
  fs.writeFileSync(externalPdf, 'external source');
  fs.utimesSync(externalPdf, 300, 300);
  registerDerivedSource(externalPdf);
  const externalPrepared = derivedNoteFor(externalPdf);
  fs.mkdirSync(path.dirname(externalPrepared), { recursive: true });
  fs.copyFileSync(prepared, externalPrepared);
  fs.utimesSync(externalPrepared, 400, 400);
  assert.equal((await canUseTool!('Read', { file_path: externalPdf }, { signal: new AbortController().signal, toolUseID: 'external-pdf' })).behavior, 'allow', 'external reads must not be redirected to project-scoped MCP');
  const redirect = await nativeRead();
  assert.equal(redirect.behavior, 'deny');
  if (redirect.behavior === 'deny') assert.match(redirect.message, /read_file/);
  assert.equal((await nativeRead()).behavior, 'allow', 'the source redirect is only a one-time hint');
  // A workbook is parsed when read_file asks, so there is no preparation to wait for.
  const workbook = path.join(project, 'sales.xlsx');
  fs.writeFileSync(workbook, 'workbook bytes');
  const workbookRead = () => canUseTool!('Read', { file_path: workbook }, { signal: new AbortController().signal, toolUseID: 'xlsx' });
  const workbookRedirect = await workbookRead();
  assert.equal(workbookRedirect.behavior, 'deny');
  if (workbookRedirect.behavior === 'deny') assert.match(workbookRedirect.message, /worksheet tables ready for this XLSX/);
  assert.equal((await workbookRead()).behavior, 'allow', 'the workbook redirect is only a one-time hint');
  for (const name of ['mcp__stashbase__edit_file', 'mcp__stashbase__move_file', 'mcp__stashbase__write_file', 'mcp__stashbase__create_interactive_note', 'mcp__stashbase__delete_file', 'Bash', 'new_tool', 'mcp__other__read_file']) {
    let settled = false;
    const input = { path: '/project/note.md' };
    const result = canUseTool(name, input, { signal: new AbortController().signal, toolUseID: name });
    void result.then(() => { settled = true; });
    await settle();
    assert.equal(settled, false, name);
    const event = permissionEvents().at(-1);
    assert.equal(event.name, name);
    assert.equal(event.toolUseId, name);
    ws.emit('message', JSON.stringify({ t: 'permission-reply', id: event.id, allow: name.endsWith('edit_file') }));
    assert.equal((await result).behavior, name.endsWith('edit_file') ? 'allow' : 'deny');
  }
  ws.emit('message', JSON.stringify({ t: 'set-mode', mode: 'acceptEdits' }));
  const beforeEdit = permissionEvents().length;
  for (const name of ['edit_file', 'write_file']) {
    const result = await canUseTool(`mcp__stashbase__${name}`, { path: path.join(project, 'draft.md') }, {
      signal: new AbortController().signal, toolUseID: name,
    });
    assert.equal(result.behavior, 'allow', 'Edit mode applies bounded MCP writes without another prompt');
  }
  assert.equal(permissionEvents().length, beforeEdit);
  const outsideEdit = canUseTool('mcp__stashbase__edit_file', { path: externalPdf }, {
    signal: new AbortController().signal, toolUseID: 'outside-edit',
  });
  await settle();
  const outsidePermission = permissionEvents().at(-1);
  assert.equal(outsidePermission.toolUseId, 'outside-edit');
  ws.emit('message', JSON.stringify({ t: 'permission-reply', id: outsidePermission.id, allow: false }));
  assert.equal((await outsideEdit).behavior, 'deny');
  for (const name of ['Write', 'Edit', 'MultiEdit']) {
    const input = { file_path: path.join(external, 'requested.txt'), content: 'External draft' };
    const pending = canUseTool(name, input, { signal: new AbortController().signal, toolUseID: `external-${name}` });
    await settle();
    const approval = permissionEvents().at(-1);
    assert.equal(approval.toolUseId, `external-${name}`, 'external native writes ask instead of receiving a project grant');
    const allow = name !== 'MultiEdit';
    ws.emit('message', JSON.stringify({ t: 'permission-reply', id: approval.id, allow }));
    assert.equal((await pending).behavior, allow ? 'allow' : 'deny');
  }
  const controller = new AbortController();
  const pending = canUseTool('mcp__stashbase__move_file', {}, { signal: controller.signal, toolUseID: 'abort' });
  await settle();
  controller.abort();
  assert.equal((await pending).behavior, 'deny');
  const count = permissionEvents().length;
  assert.equal((await canUseTool('Bash', {}, { signal: controller.signal, toolUseID: 'already-aborted' })).behavior, 'deny');
  assert.equal(permissionEvents().length, count);
  const closing = canUseTool('Bash', {}, { signal: new AbortController().signal, toolUseID: 'close' });
  await settle();
  session.dispose();
  assert.equal((await closing).behavior, 'deny');
});

test('Claude clarifying questions return the reader\'s answers as the question tool\'s input, and no other tool takes them', async (t) => {
  const ws = new FakeAgentWebSocket();
  let canUseTool: CanUseTool | undefined;
  const session = new AgentSession(
    ws as unknown as WebSocket, 'question-window', undefined, undefined, 'default', undefined, undefined,
    ((request: { prompt: AsyncIterable<unknown>; options: { canUseTool: CanUseTool } }) => {
      canUseTool = request.options.canUseTool;
      return streamingClaudeQuery(request.prompt);
    }) as never,
    () => '/fake/claude', undefined, process.cwd(),
  );
  t.after(() => session.dispose());
  session.begin();
  await settle();
  assert.ok(canUseTool);
  const permissionEvents = () => ws.sent.map((s) => JSON.parse(s)).filter((event) => event.t === 'permission');
  const questions = [{
    question: 'Which format?', header: 'Format', multiSelect: false,
    options: [{ label: 'Summary', description: 'Brief' }, { label: 'Detailed', description: 'Full' }],
  }];
  const answers = { 'Which format?': 'Summary' };
  const asked = canUseTool('AskUserQuestion', { questions }, { signal: new AbortController().signal, toolUseID: 'ask' });
  await settle();
  const ask = permissionEvents().at(-1);
  assert.equal(ask.name, 'AskUserQuestion');
  assert.deepEqual(ask.input, { questions });
  ws.emit('message', JSON.stringify({ t: 'permission-reply', id: ask.id, allow: true, answers }));
  const answered = await asked;
  assert.equal(answered.behavior, 'allow');
  if (answered.behavior === 'allow') assert.deepEqual(answered.updatedInput, { questions, answers });
  const command = canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'bash' });
  await settle();
  const run = permissionEvents().at(-1);
  ws.emit('message', JSON.stringify({ t: 'permission-reply', id: run.id, allow: true, answers }));
  const allowed = await command;
  assert.equal(allowed.behavior, 'allow');
  if (allowed.behavior === 'allow') assert.deepEqual(allowed.updatedInput, { command: 'ls' });
});

function claudeRetryMessage(): SDKMessage {
  return {
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 3,
    retry_delay_ms: 1000,
    error_status: null,
    error: 'unknown',
    uuid: 'test-retry',
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

async function startScriptedClaudeTurn(
  t: { after(callback: () => void): void },
  windowId: string,
  messages: SDKMessage[] | AsyncIterable<SDKMessage>,
  interrupt: () => Promise<void> = async () => {},
): Promise<{
  ws: FakeAgentWebSocket;
  /** Every user message the session pushed into Claude's input stream. */
  inputs: Array<{ uuid?: string; priority?: string; message: { content: unknown } }>;
  releaseMessages(): void;
  turnEvents(): TurnEvent[];
}> {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), `stashbase-${windowId}-`));
  await runWithWindowId(windowId, () => openProjectFolder(folder));

  let releaseMessages!: () => void;
  const messageGate = new Promise<void>((resolve) => { releaseMessages = resolve; });
  let finishStream!: () => void;
  const streamGate = new Promise<void>((resolve) => { finishStream = resolve; });
  let emitSessionState = false;
  const inputs: Array<{ uuid?: string; priority?: string; message: { content: unknown } }> = [];
  const nativeQuery = {
    async *[Symbol.asyncIterator]() {
      await messageGate;
      for await (const message of messages) {
        // The installed CLI only emits state transitions when requested.
        if (message.type === 'system' && message.subtype === 'session_state_changed' && !emitSessionState) continue;
        yield message;
      }
      await streamGate;
    },
    supportedModels: async () => [],
    supportedCommands: async () => [],
    setModel: async () => {},
    setPermissionMode: async () => {},
    interrupt,
  } as unknown as Query;
  const ws = new FakeAgentWebSocket();
  const session = new AgentSession(
    ws as unknown as WebSocket,
    windowId,
    undefined,
    undefined,
    'default',
    undefined,
    undefined,
    ((request: { prompt: AsyncIterable<(typeof inputs)[number]>; options: { env: NodeJS.ProcessEnv } }) => {
      emitSessionState = request.options.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS === '1';
      void (async () => { for await (const input of request.prompt) inputs.push(input); })();
      return nativeQuery;
    }) as never,
    () => '/fake/claude',
  );
  t.after(() => {
    finishStream();
    session.dispose();

    runWithWindowId(windowId, () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  session.begin();
  await settle();
  ws.emit('message', JSON.stringify({ t: 'prompt', text: 'run query' }));
  await settle();

  return {
    ws,
    inputs,
    releaseMessages,
    turnEvents: () => ws.sent
      .map((value) => JSON.parse(value) as TurnEvent)
      .filter((event) => event.t === 'turn-start' || event.t === 'error' || event.t === 'turn-end'),
  };
}

test('Claude adapter preserves supported Shared Agent Contract access modes', () => {
  assert.equal(claudePermissionMode('default'), 'default');
  assert.equal(claudePermissionMode('acceptEdits'), 'acceptEdits');
  assert.equal(claudePermissionMode('plan'), 'plan');
  assert.equal(claudePermissionMode('auto'), 'auto');
});

test('Claude adapter defaults invalid access modes to Ask', () => {
  assert.equal(claudePermissionMode(), 'default');
  assert.equal(claudePermissionMode('bypassPermissions'), 'default');
});

test('Claude replay recovers Max from the latest active transcript chain', () => {
  assert.equal(claudeTranscriptEffort([
    { type: 'assistant', uuid: 'a1', parentUuid: null, message: { effort: 'high' } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', message: {} },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', effort: 'max', message: {} },
  ], [
    { type: 'assistant', uuid: 'a1' },
    { type: 'user', uuid: 'u2' },
    { type: 'assistant', uuid: 'a2' },
  ]), 'max');
});

test('Claude replay ignores newer sidechain effort metadata', () => {
  assert.equal(claudeTranscriptEffort([
    { type: 'assistant', uuid: 'active', parentUuid: null, message: { effort: 'max' } },
    { type: 'assistant', uuid: 'branch', parentUuid: null, isSidechain: true, message: { effort: 'high' } },
    { type: 'user', uuid: 'leaf', parentUuid: 'active', message: {} },
  ], [
    { type: 'assistant', uuid: 'active' },
    { type: 'user', uuid: 'leaf' },
  ]), 'max');
});

test('Claude replay treats missing and future effort metadata as unknown', () => {
  assert.equal(claudeTranscriptEffort([
    { type: 'assistant', uuid: 'old', parentUuid: null, message: { effort: 'max' } },
    { type: 'assistant', uuid: 'new', parentUuid: 'old', message: { effort: 'ultra' } },
  ], [
    { type: 'assistant', uuid: 'old' },
    { type: 'assistant', uuid: 'new' },
  ]), null);
  assert.equal(claudeTranscriptEffort([
    { type: 'assistant', uuid: 'only', parentUuid: null, message: {} },
  ], [{ type: 'assistant', uuid: 'only' }]), null);
});

test('Claude native ownership is active before reconnect and serializes acquisition through retirement', async () => {
  let retire!: () => void;
  const retired = new Promise<void>((resolve) => { retire = resolve; });
  let disposed = false;
  const oldSession = {
    dispose() { disposed = true; },
    retirement() { return retired; },
  } as unknown as AgentSession;
  const replacement = {} as AgentSession;
  const ownership = new ClaudeNativeSessionOwnership();
  ownership.register('native-1', oldSession);

  let acquired = false;
  const acquiring = ownership.acquire('native-1', replacement).then(() => { acquired = true; });
  await settle();
  assert.equal(disposed, true);
  assert.equal(acquired, false);
  retire();
  await acquiring;
  assert.equal(acquired, true);
});

test('Claude resume validates folder scope before acquiring native ownership', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-claude-resume-scope-'));
  await runWithWindowId('claude-resume-scope-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('claude-resume-scope-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const ws = new FakeAgentWebSocket();
  let acquired = false;
  let queryStarted = false;
  const session = new AgentSession(
    ws as unknown as WebSocket,
    'claude-resume-scope-window',
    'max',
    'native-other-folder',
    'default',
    undefined,
    undefined,
    (() => { queryStarted = true; return fakeClaudeQuery(); }) as never,
    () => '/fake/claude',
    async () => false,
  );

  session.begin(async () => { acquired = true; return true; });
  await settle();

  assert.equal(acquired, false);
  assert.equal(queryStarted, false);
  assert.equal(ws.sent.some((item) => JSON.parse(item).message === 'That session belongs to a different folder.'), true);
});

test('Claude native ownership does not retain closed acquisitions', async () => {
  let closedDisposed = 0;
  const closed = {
    isClosed: true,
    dispose() { closedDisposed += 1; },
    retirement() { return Promise.resolve(); },
  } as unknown as AgentSession;
  const ownership = new ClaudeNativeSessionOwnership();

  assert.equal(await ownership.acquire('native-closed', closed), false);

  let registeredDisposed = false;
  const registered = {
    isClosed: false,
    dispose() { registeredDisposed = true; },
    retirement() { return Promise.resolve(); },
  } as unknown as AgentSession;
  ownership.register('native-closed', registered);
  assert.equal(await ownership.acquire('native-closed', { isClosed: false } as AgentSession), true);
  assert.equal(registeredDisposed, true);
  assert.equal(closedDisposed, 0);
});

test('Claude native ownership releases every id claimed by a disposed session', async () => {
  const ownership = new ClaudeNativeSessionOwnership();
  const owner = { isClosed: false } as AgentSession;
  ownership.register('resume-id', owner);
  ownership.register('native-id', owner);
  ownership.release(owner);

  let resumeOwnerDisposed = false;
  let nativeOwnerDisposed = false;
  const resumeOwner = {
    isClosed: false,
    dispose() { resumeOwnerDisposed = true; },
    retirement() { return Promise.resolve(); },
  } as unknown as AgentSession;
  const nativeOwner = {
    isClosed: false,
    dispose() { nativeOwnerDisposed = true; },
    retirement() { return Promise.resolve(); },
  } as unknown as AgentSession;
  ownership.register('resume-id', resumeOwner);
  ownership.register('native-id', nativeOwner);

  assert.equal(await ownership.acquire('resume-id', { isClosed: false } as AgentSession), true);
  assert.equal(await ownership.acquire('native-id', { isClosed: false } as AgentSession), true);
  assert.equal(resumeOwnerDisposed, true);
  assert.equal(nativeOwnerDisposed, true);
});

test('Claude retirement waits for the SDK stream to exit after interrupt acknowledgement', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-claude-retire-'));
  await runWithWindowId('claude-retire-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('claude-retire-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });
  let finishStream!: () => void;
  const streamGate = new Promise<void>((resolve) => { finishStream = resolve; });
  async function* stream() {
    yield { type: 'system', subtype: 'init', session_id: 'native-retire', model: 'native-model' } as never;
    await streamGate;
  }
  const native = Object.assign(stream(), {
    supportedModels: async () => [],
    supportedCommands: async () => [],
    setModel: async () => {},
    setPermissionMode: async () => {},
    interrupt: async () => {},
  }) as unknown as Query;
  const ws = new FakeAgentWebSocket();
  let retirement: Promise<void> | undefined;
  const session = new AgentSession(
    ws as unknown as WebSocket,
    'claude-retire-window',
    undefined,
    undefined,
    'default',
    undefined,
    (_session, pending) => { retirement = pending; },
    (() => native) as never,
    () => '/fake/claude',
  );
  session.begin();
  await settle();
  session.dispose();
  await settle();
  assert.ok(retirement);
  let retired = false;
  void retirement.then(() => { retired = true; });
  await settle();
  assert.equal(retired, false);
  finishStream();
  await retirement;
  assert.equal(retired, true);
});

test('Claude model selection recovers visibly when the SDK rejects a discovered model', async () => {
  const calls: Array<string | undefined> = [];
  const result = await selectClaudeModel('native-model', [{ id: 'native-model', label: 'Native model' }], async (model) => {
    calls.push(model);
    throw new Error('model withdrawn');
  }, false);
  assert.deepEqual(calls, ['native-model']);
  assert.match(result.fallback ?? '', /could not be selected/);
});

test('Claude leaves the runtime on its own configured model when nothing is chosen', async () => {
  let called = false;
  const result = await selectClaudeModel(undefined, [{ id: 'native-model', label: 'Native model' }], async () => {
    called = true;
  }, false);
  assert.deepEqual(result, {});
  assert.equal(called, false, 'an SDK reset would replace the settings model with the CLI built-in default');
});

test('Claude applies a fresh idle model choice before the first prompt', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-claude-model-'));
  await runWithWindowId('claude-model-window', () => openProjectFolder(folder));
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const selected: Array<string | undefined> = [];
  const native = {
    async *[Symbol.asyncIterator]() {
      await finished;
    },
    supportedModels: async () => [{ value: 'native-model', displayName: 'Native model' }],
    supportedCommands: async () => [],
    setModel: async (model?: string) => {
      selected.push(model);
    },
    setPermissionMode: async () => {},
    interrupt: async () => {},
  } as unknown as Query;
  const ws = new FakeAgentWebSocket();
  const session = new AgentSession(
    ws as unknown as WebSocket,
    'claude-model-window',
    undefined,
    undefined,
    'default',
    undefined,
    undefined,
    (() => native) as never,
    () => '/fake/claude',
  );
  t.after(() => {
    finish();
    session.dispose();
    runWithWindowId('claude-model-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  session.begin();
  await settle();
  assert.deepEqual(selected, [], 'nothing chosen leaves the runtime on its own configured model');
  ws.emit('message', JSON.stringify({ t: 'set-model', model: 'native-model' }));
  await settle();

  assert.deepEqual(selected, ['native-model']);
  assert.deepEqual(
    ws.sent.map((value) => JSON.parse(value)).filter((event) => event.t === 'models').at(-1),
    {
      activeModel: 'native-model',
      models: [{ id: 'native-model', label: 'Native model' }],
      t: 'models',
    },
  );
});

test('Claude holds a model picked while the runtime is still starting and applies it with the catalog', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-claude-early-model-'));
  await runWithWindowId('claude-early-model-window', () => openProjectFolder(folder));
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let releaseCatalog!: () => void;
  const catalog = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });
  const selected: string[] = [];
  const native = {
    async *[Symbol.asyncIterator]() {
      await finished;
    },
    supportedModels: async () => {
      await catalog;
      return [{ value: 'native-model', displayName: 'Native model' }];
    },
    supportedCommands: async () => [],
    setModel: async (model: string) => {
      selected.push(model);
    },
    setPermissionMode: async () => {},
    interrupt: async () => {},
  } as unknown as Query;
  const ws = new FakeAgentWebSocket();
  const session = new AgentSession(
    ws as unknown as WebSocket,
    'claude-early-model-window',
    undefined,
    undefined,
    'default',
    undefined,
    undefined,
    (() => native) as never,
    () => '/fake/claude',
  );
  t.after(() => {
    finish();
    releaseCatalog();
    session.dispose();
    runWithWindowId('claude-early-model-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });

  session.begin();
  await settle();
  ws.emit('message', JSON.stringify({ t: 'set-model', model: 'native-model' }));
  await settle();
  assert.deepEqual(selected, [], 'the pick waits for the catalog instead of being refused against an empty one');

  releaseCatalog();
  await settle();

  assert.deepEqual(selected, ['native-model']);
  const events = ws.sent.map((value) => JSON.parse(value));
  assert.deepEqual(
    events.filter((event) => event.t === 'models').at(-1),
    { models: [{ id: 'native-model', label: 'Native model' }], t: 'models' },
  );
  assert.ok(events.some((event) => event.t === 'ready'), 'ready follows the applied choice');
});

test('Claude resume preserves the native model and waits for its init event', async () => {
  let called = false;
  const result = await selectClaudeModel('old-tab-model', [{ id: 'old-tab-model', label: 'Old tab model' }], async () => { called = true; }, true);
  assert.equal(called, false);
  assert.equal(result.fallback, undefined);
});

test('Claude init-event model becomes the visible active model, including a runtime alias absent from discovery', () => {
  const event = claudeActiveModelEvent([{ id: 'sonnet', label: 'Sonnet' }], 'claude-sonnet-native');
  assert.equal(event.activeModel, 'claude-sonnet-native');
  assert.deepEqual(event.models.at(-1), { id: 'claude-sonnet-native', label: 'claude-sonnet-native' });
});

test('Claude init-event model maps a resolved release name onto its catalog context variant', () => {
  const models = [{ id: 'claude-fable-5[1m]', label: 'Fable' }, { id: 'claude-fable-5-1[1m]', label: 'Fable' }];
  const event = claudeActiveModelEvent(models, 'claude-fable-5-1');
  assert.equal(event.activeModel, 'claude-fable-5-1[1m]');
  assert.deepEqual(event.models, models, 'no raw entry is added when the catalog already lists the model');
});

test('Claude catalog failure clears an unverifiable fresh selection with a visible fallback', () => {
  const event = claudeModelCatalogFailureEvent('claude-opus-native', false);
  assert.deepEqual(event.models, []);
  assert.match(event.fallback ?? '', /runtime default/);
});

test('Claude catalog failure does not claim a fallback for a resumed native session', () => {
  const event = claudeModelCatalogFailureEvent('stale-tab-model', true);
  assert.deepEqual(event.models, []);
  assert.equal(event.fallback, undefined);
});

test('Claude publishes single-slash skill labels and sends the selected native command', () => {
  const event = claudeSkillCatalogEvent([{ name: 'release-notes', description: 'Prepare release notes', argumentHint: '<version>' }]);
  assert.deepEqual(event, {
    t: 'skills',
    state: 'available',
    skills: [{ id: 'release-notes', label: 'release-notes', description: 'Prepare release notes', argumentHint: '<version>' }],
  });
  assert.equal(claudeSkillPrompt('prepare the release', 'release-notes'), '/release-notes prepare the release');
  assert.deepEqual(claudeSkillCatalogEvent([]), { t: 'skills', state: 'empty', skills: [] });
});

test('folder-trust pre-acceptance merges into ~/.claude.json without clobbering', async () => {
  const { ensureClaudeFolderTrust } = await import('../agent-rules.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-trust-'));
  const file = path.join(dir, 'claude.json');

  ensureClaudeFolderTrust('/Users/me/Notes', file);
  let config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(config.projects['/Users/me/Notes'].hasTrustDialogAccepted, true);

  fs.writeFileSync(file, JSON.stringify({
    numStartups: 7,
    projects: {
      '/Users/me/Notes': { history: ['x'], hasTrustDialogAccepted: false },
      '/elsewhere': { hasTrustDialogAccepted: false },
    },
  }));
  ensureClaudeFolderTrust('/Users/me/Notes', file);
  config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(config.numStartups, 7);
  assert.deepEqual(config.projects['/Users/me/Notes'].history, ['x']);
  assert.equal(config.projects['/Users/me/Notes'].hasTrustDialogAccepted, true);
  assert.equal(config.projects['/elsewhere'].hasTrustDialogAccepted, false);

  const before = fs.readFileSync(file, 'utf8');
  ensureClaudeFolderTrust('/Users/me/Notes', file);
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  fs.writeFileSync(file, '{not json');
  ensureClaudeFolderTrust('/Users/me/Notes', file);
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Claude unexpected iterator EOF after ready emits one useful fatal exit', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-claude-exit-'));
  await runWithWindowId('claude-eof-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('claude-eof-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const ws = new FakeAgentWebSocket();
  const session = new AgentSession(
    ws as unknown as WebSocket,
    'claude-eof-window',
    undefined,
    undefined,
    'default',
    undefined,
    undefined,
    (() => fakeClaudeQuery()) as never,
    () => '/fake/claude',
  );
  session.begin();
  await settle();

  const events = ws.sent.map((value) => JSON.parse(value) as { t: string; message?: string });
  assert.equal(events.some((event) => event.t === 'ready'), true);
  assert.deepEqual(events.filter((event) => event.t === 'exit'), [
    { t: 'exit', message: 'Claude session ended unexpectedly.' },
  ]);
  assert.equal(events.some((event) => event.t === 'error'), false);
});

test('Claude iterator rejection after ready emits its cause once without a duplicate error', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-claude-exit-'));
  await runWithWindowId('claude-failure-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('claude-failure-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const ws = new FakeAgentWebSocket();
  const session = new AgentSession(
    ws as unknown as WebSocket,
    'claude-failure-window',
    undefined,
    undefined,
    'default',
    undefined,
    undefined,
    (() => fakeClaudeQuery(new Error('Claude stream failed.'))) as never,
    () => '/fake/claude',
  );
  session.begin();
  await settle();

  const events = ws.sent.map((value) => JSON.parse(value) as { t: string; message?: string });
  assert.deepEqual(events.filter((event) => event.t === 'exit'), [
    { t: 'exit', message: 'Claude stream failed.' },
  ]);
  assert.equal(events.some((event) => event.t === 'error'), false);
});

test('Claude startup failure puts its cause on the terminal exit', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-claude-exit-'));
  await runWithWindowId('claude-startup-window', () => openProjectFolder(folder));
  t.after(() => {
    runWithWindowId('claude-startup-window', () => clearCurrentFolder());
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const ws = new FakeAgentWebSocket();
  const session = new AgentSession(
    ws as unknown as WebSocket,
    'claude-startup-window',
    undefined,
    undefined,
    'default',
    undefined,
    undefined,
    (() => fakeClaudeQuery()) as never,
    () => null,
  );
  session.begin();
  await settle();

  const events = ws.sent.map((value) => JSON.parse(value) as { t: string; message?: string });
  assert.equal(events.some((event) => event.t === 'ready'), false);
  assert.equal(events.some((event) => event.t === 'error'), false);
  assert.match(events.find((event) => event.t === 'exit')?.message ?? '', /Claude CLI not found/);
});

test('Claude keeps the turn running until background work and its continuation become idle', async (t) => {
  let continueAgent!: () => void;
  const backgroundGate = new Promise<void>((resolve) => { continueAgent = resolve; });
  let finishContinuation!: () => void;
  const continuationGate = new Promise<void>((resolve) => { finishContinuation = resolve; });
  let becomeIdle!: () => void;
  const idleGate = new Promise<void>((resolve) => { becomeIdle = resolve; });
  t.after(() => { continueAgent(); finishContinuation(); becomeIdle(); });
  async function* messages(): AsyncIterable<SDKMessage> {
    yield claudeSessionState('running');
    yield {
      type: 'system', subtype: 'task_started', task_id: 'research',
      description: 'Verify sources', task_type: 'local_agent',
      uuid: randomUUID(), session_id: 'test-session',
    };
    yield claudeSuccessResult();
    await backgroundGate;
    yield {
      type: 'system', subtype: 'task_notification', task_id: 'research',
      status: 'completed', output_file: '/tmp/research.output', summary: 'Sources verified',
      uuid: randomUUID(), session_id: 'test-session',
    };
    await continuationGate;
    yield claudeSuccessResult();
    await idleGate;
    yield claudeSessionState('idle');
    yield claudeSessionState('idle');
  }
  const turn = await startScriptedClaudeTurn(t, 'claude-background-window', messages());
  turn.releaseMessages();
  await settle();
  turn.ws.emit('message', JSON.stringify({ t: 'prompt', text: 'concurrent follow-up' }));
  assert.deepEqual(turn.turnEvents(), [{ t: 'turn-start' }],
    'Completed must not be published while the subagent is still running');
  continueAgent();
  await settle();
  assert.deepEqual(turn.turnEvents(), [{ t: 'turn-start' }],
    'A subagent notification must not finish its parent continuation');
  finishContinuation();
  await settle();
  assert.deepEqual(turn.turnEvents(), [{ t: 'turn-start' }],
    'The last result still waits for native idle');
  becomeIdle();
  await settle();
  assert.deepEqual(turn.turnEvents(), [
    { t: 'turn-start' }, { t: 'turn-end', isError: false },
  ]);
  turn.ws.emit('message', JSON.stringify({ t: 'prompt', text: 'next turn' }));
  assert.deepEqual(turn.turnEvents(), [
    { t: 'turn-start' }, { t: 'turn-end', isError: false }, { t: 'turn-start' },
  ]);
});

function claudeLifecycle(commandUuid: string, state: 'queued' | 'started' | 'completed' | 'cancelled'): SDKMessage {
  return {
    type: 'command_lifecycle', command_uuid: commandUuid, state,
    uuid: randomUUID(), session_id: 'test-session',
  } as unknown as SDKMessage;
}

function steerResults(ws: FakeAgentWebSocket): unknown[] {
  return ws.sent.map((value) => JSON.parse(value) as { t: string }).filter((event) => event.t === 'steer-result');
}

test('Claude takes a follow-up into the running turn once it starts reading it', async (t) => {
  let pushed!: () => void;
  const pushedGate = new Promise<void>((resolve) => { pushed = resolve; });
  let steerUuid = '';
  const turnRef: { inputs?: Array<{ uuid?: string }> } = {};
  async function* messages(): AsyncIterable<SDKMessage> {
    yield claudeSessionState('running');
    // The prompt's own report shows this CLI confirms what it reads.
    yield claudeLifecycle(turnRef.inputs?.[0]?.uuid ?? '', 'started');
    await pushedGate;
    steerUuid = turnRef.inputs?.at(-1)?.uuid ?? '';
    yield claudeLifecycle(steerUuid, 'queued');
    yield claudeLifecycle(steerUuid, 'started');
    yield claudeSuccessResult();
    yield claudeLifecycle(steerUuid, 'completed');
    yield claudeSessionState('idle');
  }
  const turn = await startScriptedClaudeTurn(t, 'claude-steer-window', messages());
  turnRef.inputs = turn.inputs;
  turn.releaseMessages();
  await settle();
  turn.ws.emit('message', JSON.stringify({ t: 'steer', id: 'follow-up', text: 'Also check the dates' }));
  await settle();
  const steer = turn.inputs.at(-1);
  assert.equal(steer?.message.content, 'Also check the dates');
  assert.equal(steer?.priority, 'next');
  assert.ok(steer?.uuid, 'Claude reports the follow-up under the uuid it was pushed with');
  assert.deepEqual(steerResults(turn.ws), [], 'Nothing is confirmed before Claude starts reading it');
  pushed();
  await settle();
  assert.deepEqual(steerResults(turn.ws), [{ t: 'steer-result', id: 'follow-up', ok: true }]);
  assert.deepEqual(turn.turnEvents(), [{ t: 'turn-start' }, { t: 'turn-end', isError: false }]);

  turn.ws.emit('message', JSON.stringify({ t: 'steer', id: 'late', text: 'After the turn' }));
  assert.deepEqual(steerResults(turn.ws).at(-1), {
    t: 'steer-result', id: 'late', ok: false, message: 'Claude is not running a turn that can take this.',
  });
});

test('Claude holds a follow-up sent before its first state event, then pushes it', async (t) => {
  const turnRef: { inputs?: Array<{ uuid?: string }> } = {};
  async function* messages(): AsyncIterable<SDKMessage> {
    yield claudeSessionState('running');
    yield claudeLifecycle(turnRef.inputs?.[0]?.uuid ?? '', 'started');
    yield claudeSuccessResult();
    yield claudeSessionState('idle');
  }
  const turn = await startScriptedClaudeTurn(t, 'claude-steer-early-window', messages());
  turnRef.inputs = turn.inputs;
  turn.ws.emit('message', JSON.stringify({ t: 'steer', id: 'city', text: 'Shanghai' }));
  await settle();
  assert.equal(turn.inputs.length, 1, 'only the prompt is in before Claude reports its state');
  turn.releaseMessages();
  await settle();
  assert.equal(turn.inputs.at(1)?.message.content, 'Shanghai');
  // The script never starts it, so the turn's end hands it back.
  assert.deepEqual(steerResults(turn.ws), [{
    t: 'steer-result', id: 'city', ok: false, message: 'Claude did not read this before the turn ended.',
  }]);
});

test('Claude never pushes a follow-up into a CLI that does not report reading input', async (t) => {
  let steered!: () => void;
  const steerGate = new Promise<void>((resolve) => { steered = resolve; });
  async function* messages(): AsyncIterable<SDKMessage> {
    // An older CLI reports its state but not when it reads the prompt.
    yield claudeSessionState('running');
    await steerGate;
    yield claudeSuccessResult();
    yield claudeSessionState('idle');
  }
  const turn = await startScriptedClaudeTurn(t, 'claude-steer-unconfirmed-window', messages());
  assert.ok(turn.inputs[0]?.uuid, 'the prompt carries a uuid the CLI can report');
  turn.releaseMessages();
  await settle();
  turn.ws.emit('message', JSON.stringify({ t: 'steer', id: 'city', text: 'Shanghai' }));
  await settle();
  steered();
  await settle();
  assert.equal(turn.inputs.length, 1, 'a follow-up Claude could read unannounced would be sent twice');
  assert.deepEqual(steerResults(turn.ws), [{
    t: 'steer-result', id: 'city', ok: false, message: 'Claude did not read this before the turn ended.',
  }]);
  assert.deepEqual(turn.turnEvents(), [{ t: 'turn-start' }, { t: 'turn-end', isError: false }]);
});

test('Claude hands back a follow-up that a Stop overtook, interrupting it as it starts', async (t) => {
  let stopped!: () => void;
  const stopGate = new Promise<void>((resolve) => { stopped = resolve; });
  let interrupts = 0;
  const turnRef: { inputs?: Array<{ uuid?: string }> } = {};
  async function* messages(): AsyncIterable<SDKMessage> {
    yield claudeSessionState('running');
    yield claudeLifecycle(turnRef.inputs?.[0]?.uuid ?? '', 'started');
    await stopGate;
    const steerUuid = turnRef.inputs?.at(-1)?.uuid ?? '';
    yield claudeErrorResult('error_during_execution', []);
    // The CLI runs the queued follow-up as a turn of its own after a Stop.
    yield claudeLifecycle(steerUuid, 'started');
    yield claudeErrorResult('error_during_execution', []);
    yield claudeSessionState('idle');
  }
  const turn = await startScriptedClaudeTurn(t, 'claude-steer-stop-window', messages(), async () => {
    interrupts += 1;
  });
  turnRef.inputs = turn.inputs;
  turn.releaseMessages();
  await settle();
  turn.ws.emit('message', JSON.stringify({ t: 'steer', id: 'follow-up', text: 'Also check the dates' }));
  turn.ws.emit('message', JSON.stringify({ t: 'interrupt' }));
  await settle();
  stopped();
  await settle();
  assert.equal(interrupts, 2, 'The follow-up is interrupted as it starts');
  assert.deepEqual(steerResults(turn.ws), [{
    t: 'steer-result', id: 'follow-up', ok: false, message: 'Claude did not read this before the turn ended.',
  }]);
  assert.deepEqual(turn.turnEvents(), [{ t: 'turn-start' }, { t: 'turn-end', isError: false }]);
});

test('Claude reports a failed continuation instead of its earlier successful result', async (t) => {
  const turn = await startScriptedClaudeTurn(t, 'claude-continuation-failed-window', [
    claudeSessionState('running'),
    claudeSuccessResult(),
    claudeSessionState('requires_action'),
    claudeSessionState('running'),
    claudeErrorResult('error_during_execution', ['Continuation failed']),
    claudeSessionState('idle'),
  ]);
  turn.releaseMessages();
  await settle();
  assert.deepEqual(turn.turnEvents(), [
    { t: 'turn-start' },
    { t: 'error', message: 'Continuation failed' },
    { t: 'turn-end', isError: true },
  ]);
});

test('Claude stopping background work waits for both native idle and interrupt acknowledgement', async (t) => {
  let becomeIdle!: () => void;
  const idleGate = new Promise<void>((resolve) => { becomeIdle = resolve; });
  let acknowledge!: () => void;
  const interruptGate = new Promise<void>((resolve) => { acknowledge = resolve; });
  t.after(() => { becomeIdle(); acknowledge(); });
  async function* messages(): AsyncIterable<SDKMessage> {
    yield claudeSessionState('running');
    yield claudeSuccessResult();
    await idleGate;
    // The live CLI interrupts background agents without another result.
    yield claudeSessionState('idle');
  }
  const turn = await startScriptedClaudeTurn(t, 'claude-background-stop-window', messages(), () => interruptGate);
  turn.releaseMessages();
  await settle();
  turn.ws.emit('message', JSON.stringify({ t: 'interrupt' }));
  becomeIdle();
  await settle();
  assert.deepEqual(turn.turnEvents(), [{ t: 'turn-start' }]);
  acknowledge();
  await settle();
  assert.deepEqual(turn.turnEvents(), [
    { t: 'turn-start' }, { t: 'turn-end', isError: false },
  ]);
});

test('Claude final errors are normalized, bounded, and ordered before turn-end', async (t) => {
  const oversized = 'x'.repeat(2100);
  const expectedMessage = `Request timed out; ${oversized}`.slice(0, 2000);
  const turn = await startScriptedClaudeTurn(t, 'claude-error-window', [
    claudeErrorResult('error_during_execution', [
      ' Request timed out ',
      'Request timed out',
      oversized,
    ]),
  ]);

  turn.releaseMessages();
  await settle();

  assert.equal(expectedMessage.length, 2000);
  assert.deepEqual(turn.turnEvents(), [
    { t: 'turn-start' },
    { t: 'error', message: expectedMessage },
    { t: 'turn-end', isError: true },
  ]);
});

test('Claude classified turn failures carry their failure kind', async (t) => {
  const turn = await startScriptedClaudeTurn(t, 'claude-classified-window', [
    claudeErrorResult('error_during_execution', ['Invalid API key · Please run /login']),
  ]);

  turn.releaseMessages();
  await settle();

  assert.equal(agentBootstrapStatus('claude').failure?.code, 'authentication-required');

  assert.deepEqual(turn.turnEvents(), [
    { t: 'turn-start' },
    { t: 'error', message: 'Invalid API key · Please run /login', failure: { kind: 'auth-expired' } },
    { t: 'turn-end', isError: true },
  ]);
});

test('Claude signed-out result surfaces the provider text with its failure kind', async (t) => {
  // Observed live shape: a signed-out CLI reports is_error with subtype
  // 'success', NO errors array, and the real cause only in `result`.
  const turn = await startScriptedClaudeTurn(t, 'claude-signed-out-window', [
    {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Not logged in · Please run /login',
      duration_ms: 56,
      duration_api_ms: 0,
      num_turns: 1,
      stop_reason: 'stop_sequence',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      uuid: 'test-signed-out',
      session_id: 'test-session',
    } as unknown as SDKMessage,
  ]);

  turn.releaseMessages();
  await settle();

  assert.deepEqual(turn.turnEvents(), [
    { t: 'turn-start' },
    { t: 'error', message: 'Not logged in · Please run /login', failure: { kind: 'auth-expired' } },
    { t: 'turn-end', isError: true },
  ]);
});

test('Claude malformed or empty error lists use stable subtype fallbacks', async (t) => {
  const cases = [
    ['error_max_turns', null, 'Claude stopped after reaching the maximum number of turns.'],
    ['error_max_budget_usd', 'not-an-array', 'Claude stopped after reaching the configured budget.'],
    ['error_max_structured_output_retries', [null, '  '], 'Claude could not produce the requested structured response.'],
    ['error_during_execution', undefined, 'Claude failed before completing the turn.'],
  ] as const;

  for (const [index, [subtype, errors, expectedMessage]] of cases.entries()) {
    const turn = await startScriptedClaudeTurn(t, `claude-fallback-window-${index}`, [
      claudeErrorResult(subtype, errors),
    ]);
    turn.releaseMessages();
    await settle();

    assert.deepEqual(turn.turnEvents(), [
      { t: 'turn-start' },
      { t: 'error', message: expectedMessage },
      { t: 'turn-end', isError: true },
    ]);
  }
});

test('Claude api_retry followed by success emits no permanent error', async (t) => {
  const turn = await startScriptedClaudeTurn(t, 'claude-retry-window', [
    claudeRetryMessage(),
    claudeSuccessResult(),
  ]);

  turn.releaseMessages();
  await settle();

  assert.deepEqual(turn.turnEvents(), [
    { t: 'turn-start' },
    { t: 'turn-end', isError: false },
  ]);
});

test('Claude api_retry followed by failure emits one ordered terminal error', async (t) => {
  const turn = await startScriptedClaudeTurn(t, 'claude-retry-fail-window', [
    claudeRetryMessage(),
    claudeErrorResult('error_during_execution', ['Request timed out']),
  ]);

  turn.releaseMessages();
  await settle();

  assert.deepEqual(turn.turnEvents(), [
    { t: 'turn-start' },
    { t: 'error', message: 'Request timed out' },
    { t: 'turn-end', isError: true },
  ]);
});

test('Claude ignores repeated terminal results for an already settled turn', async (t) => {
  const failure = claudeErrorResult('error_during_execution', ['Request timed out']);
  const turn = await startScriptedClaudeTurn(t, 'claude-duplicate-result-window', [failure, failure]);

  turn.releaseMessages();
  await settle();

  assert.deepEqual(turn.turnEvents(), [
    { t: 'turn-start' },
    { t: 'error', message: 'Request timed out' },
    { t: 'turn-end', isError: true },
  ]);
});

test('Claude user cancellation stays non-red when its terminal result repeats', async (t) => {
  const interrupted = claudeErrorResult('error_during_execution', ['Interrupted by user']);
  const turn = await startScriptedClaudeTurn(t, 'claude-cancel-window', [interrupted, interrupted]);

  turn.ws.emit('message', JSON.stringify({ t: 'interrupt' }));
  await settle();
  turn.releaseMessages();
  await settle();

  assert.deepEqual(turn.turnEvents(), [
    { t: 'turn-start' },
    { t: 'turn-end', isError: false },
  ]);
});

test('Claude interrupt rejection does not hide a later execution failure', async (t) => {
  let rejectInterrupt!: (error: Error) => void;
  const interruptResult = new Promise<void>((_resolve, reject) => { rejectInterrupt = reject; });
  const turn = await startScriptedClaudeTurn(
    t,
    'claude-interrupt-failure-window',
    [claudeErrorResult('error_during_execution', ['Request timed out'])],
    () => interruptResult,
  );

  turn.ws.emit('message', JSON.stringify({ t: 'interrupt' }));
  turn.releaseMessages();
  await settle();
  rejectInterrupt(new Error('interrupt unavailable'));
  await settle();

  assert.deepEqual(turn.turnEvents(), [
    { t: 'turn-start' },
    { t: 'error', message: 'Request timed out' },
    { t: 'turn-end', isError: true },
  ]);
});
