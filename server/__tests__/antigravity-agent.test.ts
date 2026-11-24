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
import { AntigravitySession } from '../antigravity-session-runtime.ts';
import { createAntigravityHistoryStore } from '../antigravity-history.ts';
import express from 'express';
import { mount } from '../routes/antigravity-hook.ts';
import { registerAttributedAgentSession, unregisterAttributedAgentSession } from '../agent-session-registry.ts';

class FakeAgy extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  lines: string[] = [];

  constructor(readonly args: string[], readonly env: NodeJS.ProcessEnv) {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => { this.lines.push(...chunk.split('\n').filter(Boolean)); });
  }

  kill(signal = 'SIGTERM'): boolean {
    this.signals.push(signal);
    return true;
  }

  emitEvent(event: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  exit(code: number): void {
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
}

class FakeWebSocket extends EventEmitter {
  readyState = 1;
  sent: Record<string, unknown>[] = [];

  send(value: string): void {
    this.sent.push(JSON.parse(value));
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  client(event: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(event));
  }

  events(type: string): Record<string, unknown>[] {
    return this.sent.filter((event) => event.t === type);
  }
}

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function harness(t: test.TestContext, options: { access?: string; model?: string; effort?: string; resume?: string; remembered?: Array<{ id: string; label: string }> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-antigravity-'));
  const folder = path.join(root, 'project');
  fs.mkdirSync(folder);
  const history = createAntigravityHistoryStore(path.join(root, 'history'));
  const ws = new FakeWebSocket();
  const processes: FakeAgy[] = [];
  const session = new AntigravitySession(
    ws as unknown as WebSocket,
    'antigravity-window',
    options.effort,
    options.resume,
    options.access,
    options.model,
    folder,
    undefined,
    (_cwd, args, env) => {
      const proc = new FakeAgy(args, env);
      processes.push(proc);
      return proc as unknown as ChildProcessWithoutNullStreams;
    },
    history,
    {
      remembered: () => options.remembered ?? [],
      fresh: async () => [{ id: 'gemini-pro', label: 'Gemini Pro' }, { id: 'gemini-flash', label: 'Gemini Flash' }],
    },
  );
  t.after(() => {
    session.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { session, ws, processes, folder, history };
}

async function startTurn(h: ReturnType<typeof harness>, text: string, conversation = 'conv-1'): Promise<FakeAgy> {
  const before = h.ws.events('turn-start').length;
  h.ws.client({ t: 'prompt', text, titleHint: text });
  await until(() => h.ws.events('turn-start').length > before && h.processes.length > 0, 'turn start');
  const proc = h.processes.at(-1)!;
  await until(() => proc.lines.length > 0, 'prompt on stdin');
  proc.emitEvent({ event: 'init', conversation_id: conversation, init: { cwd: h.folder, model: 'gemini-pro' } });
  await until(() => h.ws.events('session-id').some((event) => event.id === conversation), 'session id');
  return proc;
}

test('a turn runs agy in stream-json mode with the chat\'s choices and records what the chat showed', async (t) => {
  const h = harness(t, { access: 'acceptEdits', model: 'gemini-flash', effort: 'high' });
  h.session.begin();
  await until(() => h.ws.events('ready').length === 1, 'ready');

  const proc = await startTurn(h, 'Outline the essay');
  assert.deepEqual(proc.args, [
    '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--dangerously-skip-permissions', '--mode', 'accept-edits', '--model', 'gemini-flash', '--effort', 'high',
  ]);
  assert.equal(proc.env.STASHBASE_AGENT_SESSION_ID, h.session.attributionId);
  const first = JSON.parse(proc.lines[0]!);
  assert.equal(first.event, 'user');
  assert.match(first.message.content, /^<stashbase_session_instructions>[\s\S]*edit_file[\s\S]*<\/stashbase_session_instructions>\n\nOutline the essay$/);
  // agy's own system prompt casts it as a pair programmer; StashBase's role
  // leads what it reads first.
  assert.match(first.message.content, /^<stashbase_session_instructions>\nYou are an agent working in StashBase/);

  proc.emitEvent({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Looking.' } });
  proc.emitEvent({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } } });
  proc.emitEvent({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' }, output: 'draft.md' } } });
  proc.emitEvent({ event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: ' Done.' } });
  proc.emitEvent({ event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: ' Done.' } });
  await until(() => h.ws.events('turn-end').length === 1, 'turn end');

  assert.deepEqual(h.ws.events('session-title'), [{ t: 'session-title', title: 'Outline the essay' }]);
  assert.deepEqual(h.ws.events('text').map((event) => event.delta), ['Looking.', ' Done.'], 'the final response is not repeated after streaming');
  const [tool] = h.ws.events('tool');
  assert.match(String(tool?.id), /^step-.+-2$/);
  assert.deepEqual(tool, { t: 'tool', id: tool?.id, name: 'Bash', input: { command: 'ls' } });
  assert.deepEqual(h.ws.events('tool-result'), [{ t: 'tool-result', id: tool?.id, content: 'draft.md', isError: false }]);
  assert.deepEqual(h.ws.events('turn-end'), [{ t: 'turn-end', isError: false }]);

  const actions = h.history.actions();
  await until(() => h.history.title('conv-1') !== null, 'history record');
  const [row] = await actions.list(h.folder) as Array<Record<string, unknown>>;
  assert.equal(row?.id, 'conv-1');
  assert.equal(row?.title, 'Outline the essay');
  const blocks = await actions.messages('conv-1', h.folder) as Array<Record<string, unknown>>;
  assert.deepEqual(blocks.map((block) => [block.kind, block.text ?? block.name]), [
    ['user', 'Outline the essay'], ['assistant', 'Looking.'], ['tool', 'Bash'], ['assistant', ' Done.'],
  ]);
  await assert.rejects(actions.messages('conv-1', path.join(h.folder, '..')), /not found/, 'another project cannot read the chat');
  // Attachments travel as the prompt's `Attached files:` paths and come back as cards.
  await h.history.appendTurn('conv-2', h.folder, [
    { kind: 'user', id: 'u2', text: `Summarize this\n\nAttached files:\n- ${path.join(h.folder, 'notes.md')}` },
  ], 'Summarize this');
  const [restored] = await actions.messages('conv-2', h.folder) as Array<Record<string, unknown>>;
  assert.equal(restored?.text, 'Summarize this');
  assert.deepEqual(restored?.attachments, [{ path: path.join(h.folder, 'notes.md'), name: 'notes.md' }]);

  // The next turn reuses the process; a model change restarts it on the same conversation.
  h.ws.client({ t: 'prompt', text: 'Again' });
  await until(() => proc.lines.length === 2, 'second prompt');
  assert.equal(JSON.parse(proc.lines[1]!).message.content, 'Again');
  proc.emitEvent({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_info: { name: 'view_file', parameters: {}, output: 'x' } } });
  await until(() => h.ws.events('tool').length === 2, 'second turn tool');
  assert.notEqual(h.ws.events('tool')[1]!.id, tool?.id, 'a step number reused by a later turn is a new tool row');
  proc.emitEvent({ event: 'result', result: { status: 'SUCCESS', response: 'Sure.' } });
  await until(() => h.ws.events('turn-end').length === 2, 'second turn end');
  h.ws.client({ t: 'set-model', model: 'gemini-pro' });
  h.ws.client({ t: 'prompt', text: 'Third' });
  await until(() => h.processes.length === 2, 'restart');
  assert.deepEqual(h.processes[1]!.args.slice(-6), ['--model', 'gemini-pro', '--effort', 'high', '--conversation', 'conv-1']);
  assert.ok(proc.stdin.writableEnded, 'the replaced process is retired');
});

test('a chat opens on the remembered models at once and takes the runtime\'s current list when it lands', async (t) => {
  const h = harness(t, { remembered: [{ id: 'gemini-old', label: 'Gemini Old' }] });
  h.session.begin();
  await until(() => h.ws.events('ready').length === 1, 'ready');
  assert.deepEqual(h.ws.events('models')[0], { t: 'models', models: [{ id: 'gemini-old', label: 'Gemini Old' }] });
  await until(() => h.ws.events('models').length === 2, 'fresh models');
  assert.deepEqual(
    (h.ws.events('models')[1]!.models as Array<{ id: string }>).map((model) => model.id),
    ['gemini-pro', 'gemini-flash'],
  );
});

test('the approval hook passes reads, asks the reader before changes, and refuses them in Plan', async (t) => {
  const h = harness(t);
  h.session.begin();
  await until(() => h.ws.events('ready').length === 1, 'ready');
  await startTurn(h, 'Tidy the notes');
  const signal = new AbortController().signal;
  const review = (name: string, args: Record<string, unknown>, conversationId = 'conv-1') =>
    h.session.reviewToolCall({ conversationId, stepIdx: 4, toolCall: { name, args } }, signal);

  assert.deepEqual(await review('view_file', { AbsolutePath: path.join(h.folder, 'a.md') }), { decision: 'allow' });
  assert.deepEqual(await review('read_file', { path: path.join(h.folder, 'a.md') }), { decision: 'allow' }, 'StashBase reads pass');

  const write = review('write_to_file', { TargetFile: path.join(h.folder, 'a.md'), CodeContent: 'new' });
  await until(() => h.ws.events('permission').length === 1, 'approval card');
  const card = h.ws.events('permission')[0]!;
  assert.equal(card.name, 'Write');
  assert.match(String(card.toolUseId), /^step-.+-4$/, 'the card names the step the stream shows');
  assert.equal((card.input as Record<string, unknown>).file_path, path.join(h.folder, 'a.md'));
  h.ws.client({ t: 'permission-reply', id: card.id, allow: true });
  assert.deepEqual(await write, { decision: 'allow' });

  const declined = review('run_command', { CommandLine: 'rm -rf notes' });
  await until(() => h.ws.events('permission').length === 2, 'second card');
  h.ws.client({ t: 'permission-reply', id: h.ws.events('permission')[1]!.id, allow: false });
  assert.equal((await declined).decision, 'deny');

  const once = review('run_command', { CommandLine: 'git status' });
  await until(() => h.ws.events('permission').length === 3, 'third card');
  h.ws.client({ t: 'permission-reply', id: h.ws.events('permission')[2]!.id, allow: true });
  assert.deepEqual(await once, { decision: 'allow' });

  assert.equal((await review('view_file', {}, 'another-conversation')).decision, 'deny', 'a call from another conversation is refused');

  const withdrawn = new AbortController();
  const pending = h.session.reviewToolCall({ conversationId: 'conv-1', toolCall: { name: 'run_command', args: { CommandLine: 'make' } } }, withdrawn.signal);
  await until(() => h.ws.events('permission').length === 4, 'fourth card');
  withdrawn.abort();
  assert.equal((await pending).decision, 'deny', 'a hook that gave up is not granted');

  h.ws.client({ t: 'set-mode', mode: 'plan' });
  assert.equal((await review('write_to_file', { TargetFile: path.join(h.folder, 'a.md') })).decision, 'deny');
  assert.equal((await review('edit_file', { path: path.join(h.folder, 'a.md') })).decision, 'deny');
  assert.equal((await review('run_command', { CommandLine: 'git status' })).decision, 'deny');
  assert.deepEqual(await review('grep_search', { Query: 'x' }), { decision: 'allow' });

  // Auto is StashBase's rule set: edits, read-only commands, searches and plain page reads pass.
  h.ws.client({ t: 'set-mode', mode: 'auto' });
  assert.deepEqual(await review('call_mcp_tool', { ServerName: 'stashbase', ToolName: 'edit_file', Arguments: { path: path.join(h.folder, 'a.md') } }), { decision: 'allow' });
  if (process.platform !== 'win32') {
    assert.deepEqual(await review('run_command', { CommandLine: 'cat notes.md | head -20' }), { decision: 'allow' });
  }
  assert.deepEqual(await review('search_web', { query: 'tide tables' }), { decision: 'allow' });
  assert.deepEqual(await review('read_url_content', { Url: 'https://example.com/tides' }), { decision: 'allow' });
  const leak = review('read_url_content', { Url: 'https://example.com/collect?text=draft' });
  await until(() => h.ws.events('permission').length === 5, 'query-string card');
  h.ws.client({ t: 'permission-reply', id: h.ws.events('permission')[4]!.id, allow: false });
  assert.equal((await leak).decision, 'deny');
  const push = review('run_command', { CommandLine: 'git push' });
  await until(() => h.ws.events('permission').length === 6, 'push card');
  h.ws.client({ t: 'permission-reply', id: h.ws.events('permission')[5]!.id, allow: false });
  assert.equal((await push).decision, 'deny', 'Auto still asks before a command that can change things');

  h.ws.client({ t: 'set-mode', mode: 'acceptEdits' });
  const editCommand = review('run_command', { CommandLine: 'ls' });
  await until(() => h.ws.events('permission').length === 7, 'Edit asks before every command');
  h.ws.client({ t: 'permission-reply', id: h.ws.events('permission')[6]!.id, allow: true });
  assert.deepEqual(await editCommand, { decision: 'allow' });
  assert.deepEqual(await review('mcp_stashbase_edit_file', { path: path.join(h.folder, 'a.md') }), { decision: 'allow' });
  assert.deepEqual(await review('mcp_stashbase_create_interactive_note', { path: h.folder, name: 'Notebook' }), { decision: 'allow' });
  assert.deepEqual(await review('replace_file_content', { TargetFile: path.join(h.folder, 'b.md') }), { decision: 'allow' });
  const outside = review('replace_file_content', { TargetFile: path.join(os.tmpdir(), 'elsewhere.md') });
  await until(() => h.ws.events('permission').length === 8, 'outside-project card');

  h.ws.client({ t: 'interrupt' });
  assert.equal((await outside).decision, 'deny', 'Stop withdraws an open approval');
  assert.equal((await review('view_file', {})).decision, 'deny', 'nothing is approved after Stop');
});

test('explicit session command approval covers later commands but not other tools, chats or modes', async (t) => {
  const h = harness(t, { access: 'auto' });
  h.session.begin();
  await until(() => h.ws.events('ready').length === 1, 'ready');
  const proc = await startTurn(h, 'Work through several commands');
  const review = (name: string, args: Record<string, unknown> = {}, conversationId = 'conv-1') =>
    h.session.reviewToolCall({ conversationId, toolCall: { name, args } }, new AbortController().signal);
  const command = () => review('run_command', { CommandLine: 'pwd && ls' });
  const answer = async (pending: ReturnType<typeof review>, scope?: string, allow = true) => {
    const card = h.ws.events('permission').at(-1)!;
    h.ws.client({ t: 'permission-reply', id: card.id, allow, ...(scope ? { scope } : {}) });
    return pending;
  };

  assert.equal((await answer(command())).decision, 'allow');
  const remembered = command();
  assert.equal(h.ws.events('permission').length, 2, 'Allow only grants one command');
  assert.deepEqual(h.ws.events('permission').at(-1)!.approvalScopes, ['session-commands']);
  assert.equal((await answer(remembered, 'session-commands')).decision, 'allow');
  assert.equal((await review('run_command', { CommandLine: 'python export.py' })).decision, 'allow');
  assert.equal((await review('send_command_input', { Input: 'continue\n' })).decision, 'allow');
  assert.equal(h.ws.events('permission').length, 2, 'different commands and terminal input reuse the grant');
  assert.equal((await review('run_command', {}, 'another-chat')).decision, 'deny');
  assert.equal((await h.session.reviewToolCall({ toolCall: { name: 'run_command' } }, AbortSignal.abort())).decision, 'deny');

  for (const [name, args] of [
    ['delete_file', { path: path.join(h.folder, 'draft.md') }],
    ['replace_file_content', { TargetFile: path.join(h.folder, '..', 'outside.md') }],
    ['read_url_content', { Url: 'https://example.com/?draft=private' }],
  ] as const) {
    const pending = review(name, args);
    assert.deepEqual(h.ws.events('permission').at(-1)!.approvalScopes, []);
    assert.equal((await answer(pending, undefined, false)).decision, 'deny');
  }

  proc.emitEvent({ event: 'result', result: { status: 'SUCCESS', response: 'Done.' } });
  await startTurn(h, 'Continue');
  const before = h.ws.events('permission').length;
  assert.equal((await command()).decision, 'allow', 'the grant survives a completed turn');
  assert.equal(h.ws.events('permission').length, before);
  h.ws.client({ t: 'set-mode', mode: 'plan' });
  assert.equal((await command()).decision, 'deny', 'Plan still refuses commands');
  h.ws.client({ t: 'set-mode', mode: 'auto' });
  assert.equal((await answer(command(), 'session-commands')).decision, 'allow');
  assert.equal(h.ws.events('permission').length, before + 1, 'returning to Auto needs a fresh grant');

  h.session.dispose();
  assert.equal((await command()).decision, 'deny');
  const reopened = harness(t, { access: 'auto', resume: 'conv-1' });
  reopened.session.begin();
  await until(() => reopened.ws.events('ready').length === 1, 'reopened ready');
  await startTurn(reopened, 'Reopened');
  const pending = reopened.session.reviewToolCall({ toolCall: { name: 'run_command', args: { CommandLine: 'pwd && ls' } } }, new AbortController().signal);
  assert.equal(reopened.ws.events('permission').length, 1, 'a new live session never inherits command authority');
  reopened.ws.client({ t: 'permission-reply', id: reopened.ws.events('permission')[0]!.id, allow: false });
  assert.equal((await pending).decision, 'deny');
});

test('withdrawn, stale, rejected and unsupported approval replies cannot grant session commands', async (t) => {
  const h = harness(t, { access: 'default' });
  h.session.begin();
  await until(() => h.ws.events('ready').length === 1, 'ready');
  await startTurn(h, 'Run a command');
  const review = (signal = new AbortController().signal, name = 'run_command') =>
    h.session.reviewToolCall({ toolCall: { name, args: { CommandLine: 'pwd && ls' } } }, signal);
  const reply = (id: unknown, scope: string, allow = true) =>
    h.ws.client({ t: 'permission-reply', id, allow, scope });

  for (const outcome of ['withdrawn', 'mode', 'rejected', 'unsupported', 'non-command', 'stop'] as const) {
    const controller = new AbortController();
    const pending = review(controller.signal, outcome === 'non-command' ? 'delete_file' : 'run_command');
    const card = h.ws.events('permission').at(-1)!;
    const count = h.ws.events('permission').length;
    if (outcome === 'withdrawn') controller.abort();
    if (outcome === 'mode') h.ws.client({ t: 'set-mode', mode: 'acceptEdits' });
    if (outcome === 'stop') h.ws.client({ t: 'interrupt' });
    reply(card.id, outcome === 'unsupported' ? 'always' : 'session-commands', outcome !== 'rejected');
    assert.equal((await pending).decision, 'deny', outcome);
    const probe = review();
    if (outcome === 'stop') {
      assert.equal((await probe).decision, 'deny');
    } else {
      assert.equal(h.ws.events('permission').length, count + 1, `${outcome} did not remember a grant`);
      reply(h.ws.events('permission').at(-1)!.id, 'session-commands', false);
      assert.equal((await probe).decision, 'deny');
    }
  }
});

test('Stop interrupts agy, retires it, and the next prompt resumes the conversation', async (t) => {
  const h = harness(t, { resume: 'conv-9' });
  h.session.begin();
  await until(() => h.ws.events('ready').length === 1, 'ready');
  assert.deepEqual(h.ws.events('session-id'), [{ t: 'session-id', id: 'conv-9' }]);
  const proc = await startTurn(h, 'Long task', 'conv-9');
  assert.deepEqual(proc.args.slice(-2), ['--conversation', 'conv-9']);
  assert.equal(h.ws.events('session-title').length, 0, 'a resumed chat keeps its title');

  h.ws.client({ t: 'interrupt' });
  await until(() => proc.signals.includes('SIGINT'), 'SIGINT');
  proc.emitEvent({ event: 'result', result: { status: 'INTERRUPTED', response: '' } });
  await until(() => h.ws.events('turn-end').length === 1, 'turn end');
  assert.deepEqual(h.ws.events('turn-end'), [{ t: 'turn-end', isError: false }]);
  assert.equal(h.ws.events('error').length, 0);
  assert.ok(proc.stdin.writableEnded);

  h.ws.client({ t: 'prompt', text: 'Continue' });
  await until(() => h.processes.length === 2, 'respawn');
  assert.deepEqual(h.processes[1]!.args.slice(-2), ['--conversation', 'conv-9']);
});

test('a turn that ends without an answer, or with its process, fails visibly and the chat recovers', async (t) => {
  const h = harness(t);
  h.session.begin();
  await until(() => h.ws.events('ready').length === 1, 'ready');
  const proc = await startTurn(h, 'Summarize');
  proc.emitEvent({ event: 'result', result: { status: 'SUCCESS', response: '' } });
  await until(() => h.ws.events('turn-end').length === 1, 'empty turn end');
  assert.deepEqual(h.ws.events('turn-end'), [{ t: 'turn-end', isError: true }]);
  assert.match(String(h.ws.events('error')[0]?.message), /without a response/);

  h.ws.client({ t: 'prompt', text: 'Try again' });
  await until(() => proc.lines.length === 2, 'second prompt');
  proc.emitEvent({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'A reply before the crash.' } });
  proc.stderr.write('AGY_ERROR: {"short_error":"Model quota exhausted for today","retryable":false}\n');
  await new Promise((resolve) => setTimeout(resolve, 10));
  proc.exit(3);
  await until(() => h.ws.events('turn-end').length === 2, 'crash turn end');
  assert.equal(h.ws.events('turn-end')[1]!.isError, true);
  const error = h.ws.events('error')[1]!;
  assert.match(String(error.message), /Model quota exhausted/);
  assert.deepEqual(error.failure, { kind: 'quota' });
  assert.equal(h.ws.events('exit').length, 0, 'a failed turn does not end the chat');

  h.ws.client({ t: 'prompt', text: 'Once more' });
  await until(() => h.processes.length === 2, 'respawn after crash');
  assert.deepEqual(h.processes[1]!.args.slice(-2), ['--conversation', 'conv-1']);
});

const streamInterruption = 'The stream was interrupted. Please continue the task you were working on.';

test('a completed Antigravity reply survives a recovered or historical stream interruption without replay', async (t) => {
  const h = harness(t);
  h.session.begin();
  await until(() => h.ws.events('ready').length === 1, 'ready');
  const proc = await startTurn(h, 'First reply');
  const step = (step_index: number, step_type: string, state: string, text_delta = '') =>
    proc.emitEvent({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index, step_type, state, text_delta } });

  // The native runtime retries an interruption inside this turn, then finishes.
  step(1, 'error_message', 'DONE', streamInterruption);
  step(2, 'agent_response', 'ACTIVE', 'First reply.');
  step(2, 'agent_response', 'DONE'); // DONE need not repeat the streamed text.
  step(3, 'checkpoint', 'DONE');
  proc.emitEvent({ event: 'result', result: { conversation_id: 'conv-1', status: 'ERROR', finished_reason: 'error', error: streamInterruption, response: 'First reply.' } });
  assert.deepEqual(h.ws.events('turn-end'), [{ t: 'turn-end', isError: false }]);

  h.ws.client({ t: 'prompt', text: 'Second reply' });
  await until(() => proc.lines.length === 2, 'next prompt');
  // A later turn has no new error step but inherits the same terminal error.
  step(4, 'user_input', 'DONE');
  step(5, 'agent_response', 'DONE', 'Second reply.');
  proc.emitEvent({ event: 'result', result: { conversation_id: 'conv-1', status: 'ERROR', error: streamInterruption.replace('. ', '.\n'), response: 'Second reply.' } });
  assert.deepEqual(h.ws.events('turn-end'), [{ t: 'turn-end', isError: false }, { t: 'turn-end', isError: false }]);
  assert.equal(h.ws.events('error').length, 0);
  assert.equal(h.ws.events('notice').length, 2, 'the contradictory native result remains visible without a retry card');
  assert.deepEqual(h.ws.events('text').map((event) => event.delta), ['First reply.', 'Second reply.']);
  assert.equal(proc.lines.length, 2, 'only the reader submits another prompt');
  assert.equal(h.processes.length, 1, 'the conversation remains usable on its process');
  await until(() => h.history.title('conv-1') !== null, 'history');
  const blocks = await h.history.actions().messages('conv-1', h.folder) as Array<Record<string, unknown>>;
  assert.deepEqual(blocks.filter((block) => block.kind === 'assistant').map((block) => block.text), ['First reply.', 'Second reply.']);

  h.ws.client({ t: 'prompt', text: 'Third reply' });
  await until(() => proc.lines.length === 3, 'third prompt');
  proc.emitEvent({ event: 'result', result: { status: 'ERROR', error: streamInterruption } });
  assert.equal(h.ws.events('turn-end').at(-1)!.isError, true, 'previous turns cannot prove this turn completed');
});

test('Antigravity interruption recovery requires a completed main reply and no unfinished work', async (t) => {
  const reply = { conversation_id: 'conv-1', step_index: 2, step_type: 'agent_response', state: 'DONE', text_delta: 'Answer.' };
  const tool = { conversation_id: 'conv-1', step_index: 3, step_type: 'tool', state: 'ACTIVE', tool_info: { name: 'view_file' } };
  const cases = [
    { name: 'still streaming', steps: [{ ...reply, state: 'ACTIVE' }] },
    { name: 'response failed', steps: [{ ...reply, state: 'ERROR' }] },
    { name: 'unknown response state', steps: [{ ...reply, state: 'STOPPED' }] },
    { name: 'empty response step', steps: [{ ...reply, text_delta: ' ' }] },
    { name: 'only a child replied', steps: [{ ...reply, conversation_id: 'child' }] },
    { name: 'later work unfinished', steps: [reply, tool] },
    { name: 'earlier work unfinished', steps: [{ ...tool, step_index: 1 }, reply] },
    { name: 'later tool even if done', steps: [reply, { ...tool, state: 'DONE' }] },
    { name: 'later interruption', steps: [reply, { ...reply, step_index: 3, step_type: 'error_message', text_delta: streamInterruption }] },
    { name: 'unfinished checkpoint', steps: [reply, { ...reply, step_index: 3, step_type: 'checkpoint', state: 'ACTIVE' }] },
    { name: 'another error', steps: [reply], result: { error: 'Quota exhausted' } },
    { name: 'another step error', steps: [{ ...reply, step_index: 1, step_type: 'error_message', text_delta: 'Quota exhausted' }, reply] },
    { name: 'timeout', steps: [reply], result: { finished_reason: 'print_timeout' } },
    { name: 'cancellation reason', steps: [reply], result: { finished_reason: 'interrupted' } },
    { name: 'interrupted status', steps: [reply], result: { status: 'INTERRUPTED' } },
    { name: 'different result conversation', steps: [reply], result: { conversation_id: 'child' } },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (t) => {
    const h = harness(t);
    h.session.begin();
    await until(() => h.ws.events('ready').length === 1, 'ready');
    const proc = await startTurn(h, 'Task');
    for (const step of scenario.steps) proc.emitEvent({ event: 'step_update', step_update: step });
    proc.emitEvent({ event: 'result', result: { conversation_id: 'conv-1', status: 'ERROR', error: streamInterruption, response: 'Answer.', ...scenario.result } });
    assert.equal(h.ws.events('turn-end')[0]!.isError, true);
    assert.equal(h.ws.events('error').length, 1);
    assert.equal(h.ws.events('notice').length, 0);
    assert.equal(proc.lines.length, 1, 'a genuine failure never replays the request');
  });
});

test('the hook route refuses a chat it does not know and leaves other runtimes\' runs to their own rules', async (t) => {
  const app = express();
  app.use(express.json());
  mount(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  registerAttributedAgentSession('codex-session', { agentId: 'codex', windowId: 'w', boundFolder: () => null, turnInFlight: () => true });
  t.after(() => { unregisterAttributedAgentSession('codex-session'); server.close(); });
  const ask = async (session?: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`http://127.0.0.1:${port}/api/agent/antigravity/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(session ? { 'x-stashbase-agent-session-id': session } : {}) },
      body: JSON.stringify({ toolCall: { name: 'run_command', args: {} } }),
    });
    return await response.json() as Record<string, unknown>;
  };
  assert.equal((await ask()).decision, 'deny');
  assert.equal((await ask('ended-session')).decision, 'deny');
  assert.deepEqual(await ask('codex-session'), { decision: 'allow' });
});
