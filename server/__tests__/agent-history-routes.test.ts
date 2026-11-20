import './isolated-home.ts';
import { writeAppConfigStrict } from '../app-config.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import type { WebSocket } from 'ws';
import { registerAgentAdapter, type AgentHistoryActions } from '../agent-contract.ts';
import * as claudeHistory from '../claude-history.ts';
import * as sharedRoutes from '../routes/agent-sessions.ts';

const member = fs.mkdtempSync(path.join(os.homedir(), 'history-project-'));
writeAppConfigStrict({ recentFolders: [{ path: member, openedAt: new Date().toISOString() }] });

async function invoke(app: express.Express, path: string, params: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const layer = (app as any)._router.stack.find((entry: any) => entry.route?.path === path);
  assert.ok(layer, `route ${path} mounted`);
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      status(code: number) { status = code; return this; },
      json(body: unknown) { resolve({ status, body }); return this; },
    };
    Promise.resolve(layer.route.stack[0].handle({ params, query: { folder: member }, body: {} }, res, reject)).catch(reject);
  });
}

test('shared replay adds metadata without changing messages responses', async () => {
  const messages = [{ kind: 'assistant', id: 'h0', text: 'persisted' }];
  const history: AgentHistoryActions = {
    list: async () => [],
    messages: async () => messages,
    replay: async () => ({ protocol: 2, messages, effort: 'max' }),
    rename: async () => ({}),
    remove: async () => {},
  };
  registerAgentAdapter({
    id: 'claude',
    label: 'Claude',
    vendor: 'Anthropic',
    capabilities: {
      connection: true, prompts: true, interrupt: true, transcript: true,
      approvals: true, history: true, attachments: true, modes: ['default', 'acceptEdits', 'plan', 'auto'], effort: true, models: true,
      skills: true, steering: false, titleHint: false,
    },
    attach: (_ws: WebSocket) => {},
    stop: () => {},
    stopFolder: () => {},
    history,
  });

  const app = express();
  sharedRoutes.mount(app);

  assert.deepEqual(await invoke(app, '/api/agents/:agent/sessions/:id/replay', { agent: 'claude', id: 's1' }),
    { status: 200, body: { protocol: 2, messages, effort: 'max' } });
  assert.deepEqual(await invoke(app, '/api/agents/:agent/sessions/:id/messages', { agent: 'claude', id: 's1' }),
    { status: 200, body: messages });
});

test('shared replay reports unavailable metadata without weakening messages compatibility', async () => {
  const messages = [{ kind: 'assistant', id: 'h0', text: 'legacy' }];
  registerAgentAdapter({
    id: 'codex',
    label: 'Codex',
    vendor: 'OpenAI',
    capabilities: {
      connection: true, prompts: true, interrupt: true, transcript: true,
      approvals: true, history: true, attachments: true, modes: ['default', 'acceptEdits', 'plan', 'auto'], effort: true, models: true,
      skills: true, steering: true, titleHint: true,
    },
    attach: (_ws: WebSocket) => {},
    stop: () => {},
    stopFolder: () => {},
    history: {
      list: async () => [],
      messages: async () => messages,
      rename: async () => ({}),
      remove: async () => {},
    },
  });
  const app = express();
  sharedRoutes.mount(app);

  assert.deepEqual(await invoke(app, '/api/agents/:agent/sessions/:id/replay', { agent: 'codex', id: 's1' }),
    { status: 404, body: { error: 'replay metadata unavailable' } });
  assert.deepEqual(await invoke(app, '/api/agents/:agent/sessions/:id/messages', { agent: 'codex', id: 's1' }),
    { status: 200, body: messages });
});

test('production Claude replay joins SDK-selected active UUIDs to raw JSONL effort metadata', async (t) => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-claude-history-'));
  const project = path.join(config, 'projects', '-workspace');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: 'assistant', uuid: 'active-max', sessionId, parentUuid: null,
      isSidechain: false, effort: 'max',
      message: { role: 'assistant', content: [{ type: 'text', text: 'active answer' }] },
    }),
    JSON.stringify({
      type: 'assistant', uuid: 'stale-sidechain', sessionId, parentUuid: null,
      isSidechain: true, effort: 'high',
      message: { role: 'assistant', content: [{ type: 'text', text: 'stale answer' }] },
    }),
    '',
  ].join('\n'));
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(() => {
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    fs.rmSync(config, { recursive: true, force: true });
  });

  // This is the SDK's real sanitized SessionMessage shape: the active-chain
  // selector retained UUID/type/message but removed parent/sidechain/effort.
  const sanitized = [{
    type: 'assistant' as const,
    uuid: 'active-max',
    session_id: sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text: 'active answer' }] },
    parent_tool_use_id: null,
  }];
  const history = claudeHistory.claudeHistoryActions({
    belongsToFolder: async () => true,
    getMessages: async () => sanitized,
  });
  assert.deepEqual(await history.replay!(sessionId, '/workspace'), {
    protocol: 2,
    messages: [{ kind: 'assistant', id: 'h0', text: 'active answer' }],
    effort: 'max',
  });
});

test('Claude replay shows a follow-up Claude read mid-turn where it read it', async (t) => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-claude-follow-up-'));
  const project = path.join(config, 'projects', '-workspace');
  const sessionId = '22222222-2222-4222-8222-222222222222';
  fs.mkdirSync(project, { recursive: true });
  const entry = (value: Record<string, unknown>) => JSON.stringify({ sessionId, isSidechain: false, ...value });
  // The shape Claude writes: the follow-up is an attachment chained behind
  // another attachment that hangs from the tool result it arrived with.
  fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), [
    entry({ type: 'user', uuid: 'prompt', parentUuid: null, message: { role: 'user', content: 'Run the checks' } }),
    entry({ type: 'assistant', uuid: 'call', parentUuid: 'prompt', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'make check' } }] } }),
    entry({ type: 'user', uuid: 'result', parentUuid: 'call', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } }),
    entry({ type: 'attachment', uuid: 'snapshot', parentUuid: 'result', attachment: { type: 'prompt_snapshot' } }),
    entry({ type: 'attachment', uuid: 'follow-up', parentUuid: 'snapshot', timestamp: '2026-10-23T09:49:48.004Z', attachment: { type: 'queued_command', prompt: 'Also check the dates', commandMode: 'prompt' } }),
    entry({ type: 'assistant', uuid: 'reply', parentUuid: 'follow-up', message: { role: 'assistant', content: [{ type: 'text', text: 'Checks pass; dates too.' }] } }),
    '',
  ].join('\n'));
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(() => {
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    fs.rmSync(config, { recursive: true, force: true });
  });
  // The SDK's reader keeps the conversation and drops every attachment.
  const sanitized = [
    { type: 'user' as const, uuid: 'prompt', session_id: sessionId, parent_tool_use_id: null, message: { role: 'user', content: 'Run the checks' } },
    { type: 'assistant' as const, uuid: 'call', session_id: sessionId, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'make check' } }] } },
    { type: 'user' as const, uuid: 'result', session_id: sessionId, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } },
    { type: 'assistant' as const, uuid: 'reply', session_id: sessionId, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Checks pass; dates too.' }] } },
  ];
  const history = claudeHistory.claudeHistoryActions({
    belongsToFolder: async () => true,
    getMessages: async () => sanitized,
  });
  const replay = await history.replay!(sessionId, '/workspace') as { messages: Array<{ kind: string; text?: string; at?: number }> };
  assert.deepEqual(
    replay.messages.map((block) => [block.kind, block.text]),
    [['user', 'Run the checks'], ['tool', undefined], ['user', 'Also check the dates'], ['assistant', 'Checks pass; dates too.']],
  );
  assert.equal(replay.messages[2]?.at, Date.parse('2026-10-23T09:49:48.004Z'));
});

test('history rejects aggregate scope before calling a runtime', async () => {
  const app = express();
  sharedRoutes.mount(app);
  const layer = (app as any)._router.stack.find((entry: any) => entry.route?.path === '/api/agents/:agent/sessions');
  let status = 200;
  let body: unknown;
  await layer.route.stack[0].handle(
    { params: { agent: 'claude' }, query: { scope: 'all' } },
    { status(code: number) { status = code; return this; }, json(value: unknown) { body = value; } },
  );
  assert.equal(status, 400);
  assert.match((body as { error: string }).error, /scope/);
});
