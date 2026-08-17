#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { fakeAgentNetworkPolicy } from './deny-network.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const MCP_SERVER = path.join(PROJECT_ROOT, 'mcp', 'server.ts');
const logFile = process.env.STASHBASE_FAKE_CODEX_LOG;
let turnSequence = 0;
let toolSequence = 0;
let nextServerRequestId = 10_000;
let historyCwd = process.cwd();
const pendingApprovals = new Map();
const HISTORY_MATH_REPLY = String.raw`Restored formula from history:

\[
\boxed{a_1 + a_2 + a_3 + a_4 + a_5 + a_6 + a_7 + a_8 + a_9 + a_{10} + a_{11} + a_{12} + a_{13} + a_{14} + a_{15} + a_{16} + a_{17} + a_{18} + a_{19} + a_{20} = 210}
\]`;

record({
  event: 'launch',
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  windowId: process.env.STASHBASE_WINDOW_ID ?? null,
  agentSessionId: process.env.STASHBASE_AGENT_SESSION_ID ?? null,
  networkDenied: fakeAgentNetworkPolicy.denied,
});

if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  process.stdout.write('Logged in using deterministic fixture\n');
  process.exit(0);
}
if (process.argv[2] === 'login') {
  process.stdout.write('Deterministic browser login completed\n');
  process.exit(0);
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  record({ event: 'receive', message });
  if (typeof message.method === 'string' && 'id' in message) {
    handleRequest(message);
    return;
  }
  if ('id' in message && ('result' in message || 'error' in message)) {
    void handleResponse(message);
  }
});

function handleRequest(request) {
  const params = objectValue(request.params);
  switch (request.method) {
    case 'initialize':
      respond(request.id, {});
      break;
    case 'model/list':
      respond(request.id, {
        data: [{
          id: 'fake-codex-model',
          displayName: 'Fake Codex Model',
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
        }],
      });
      break;
    case 'skills/list': {
      const cwds = Array.isArray(params.cwds) ? params.cwds : [];
      respond(request.id, { data: cwds.map((cwd) => ({ cwd, skills: [] })) });
      break;
    }
    case 'thread/start':
      record({ event: 'thread-start', params });
      respond(request.id, { thread: { id: 'fake-thread-1', model: 'fake-codex-model' } });
      break;
    case 'thread/resume':
      respond(request.id, { thread: { id: String(params.threadId || 'fake-thread-1'), model: 'fake-codex-model' } });
      break;
    case 'thread/name/set':
      record({ event: 'thread-name', params });
      respond(request.id, {});
      break;
    case 'thread/list':
      if (typeof params.cwd === 'string' && params.cwd) historyCwd = params.cwd;
      respond(request.id, {
        data: [{
          id: 'fake-history-thread',
          name: 'Fixture history session',
          preview: 'Fixture history session',
          cwd: historyCwd,
          updatedAt: 1_786_444_800,
        }],
        nextCursor: null,
      });
      break;
    case 'thread/read':
      respond(request.id, {
        thread: {
          id: String(params.threadId || 'fake-history-thread'),
          name: 'Fixture history session',
          cwd: historyCwd,
          turns: [{
            id: 'fake-history-turn',
            items: [
              { type: 'userMessage', content: [{ type: 'text', text: 'History fixture question' }] },
              { type: 'agentMessage', text: HISTORY_MATH_REPLY },
            ],
          }],
        },
      });
      break;
    case 'thread/delete':
      record({ event: 'thread-delete', params });
      respond(request.id, {});
      break;
    case 'turn/start':
      startTurn(request.id, params);
      break;
    case 'turn/interrupt':
      record({ event: 'interrupt', params });
      respond(request.id, {});
      notify('turn/completed', {
        threadId: String(params.threadId || 'fake-thread-1'),
        turn: { id: String(params.turnId || 'fake-turn-2'), items: [], status: 'interrupted' },
      });
      break;
    default:
      reject(request.id, `Fake Codex does not implement ${request.method}.`, -32601);
      break;
  }
}

function startTurn(requestId, params) {
  const turnId = `fake-turn-${++turnSequence}`;
  const prompt = Array.isArray(params.input)
    ? params.input.find((item) => item?.type === 'text')?.text ?? ''
    : '';
  record({ event: 'turn-start', turnId, prompt, params });
  respond(requestId, { turn: { id: turnId } });
  notify('turn/started', { threadId: String(params.threadId || 'fake-thread-1'), turn: { id: turnId, status: 'inProgress' } });

  if (/stop/i.test(prompt)) return;
  if (/terminal error/i.test(prompt)) {
    record({ event: 'terminal-error', turnId, prompt });
    notify('error', {
      threadId: String(params.threadId || 'fake-thread-1'),
      turnId,
      willRetry: false,
      message: 'Deterministic fake Agent failure.',
    });
    return;
  }
  if (/math reply/i.test(prompt)) {
    const itemId = `fake-message-${turnSequence}`;
    notify('item/agentMessage/delta', {
      threadId: String(params.threadId || 'fake-thread-1'),
      turnId,
      itemId,
      delta: String.raw`Streamed formula: \(x^2`,
    });
    notify('item/agentMessage/delta', {
      threadId: String(params.threadId || 'fake-thread-1'),
      turnId,
      itemId,
      delta: String.raw` + 1\).`,
    });
    notify('turn/completed', {
      threadId: String(params.threadId || 'fake-thread-1'),
      turn: { id: turnId, items: [], status: 'completed' },
    });
    return;
  }
  if (/journey:j07 converge canvas/i.test(prompt)) {
    requestMcpApproval({
      turnId,
      threadId: String(params.threadId || 'fake-thread-1'),
      tool: 'write_file',
      title: 'Allow Codex to write Canvas.md?',
      args: {
        path: path.join(String(params.cwd || process.cwd()), 'Canvas.md'),
        content: [
          '---',
          'generated_by: stashbase-agent',
          '---',
          '# Canvas',
          '',
          'Accepted conclusion from the scoped conversation.',
          '',
          '## Open questions',
          '',
          '- Confirm the next implementation step.',
          '',
        ].join('\n'),
      },
      successMessage: 'Canvas.md now contains the accepted conclusions.',
    });
    return;
  }
  if (/journey:j11 create project/i.test(prompt)) {
    requestMcpApproval({
      turnId,
      threadId: String(params.threadId || 'fake-thread-1'),
      tool: 'create_project',
      title: 'Allow Codex to create conversation-project?',
      args: { name: 'conversation-project' },
      successMessage: 'conversation-project is ready and this conversation moved into it.',
    });
    return;
  }
  if (/journey:j11 continue in project/i.test(prompt)) {
    requestMcpApproval({
      turnId,
      threadId: String(params.threadId || 'fake-thread-1'),
      tool: 'write_file',
      title: 'Allow Codex to write Project Plan.md?',
      args: {
        path: path.join(String(params.cwd || process.cwd()), 'Project Plan.md'),
        content: '# Project Plan\n\nAccepted goal from the continued project conversation.\n',
      },
      successMessage: 'Project Plan.md was written inside conversation-project.',
    });
    return;
  }
  if (/journey:j10 synthesize retrieved evidence/i.test(prompt)) {
    void startJ10Turn({
      turnId,
      threadId: String(params.threadId || 'fake-thread-1'),
      cwd: String(params.cwd || process.cwd()),
    });
    return;
  }

  const itemId = `fake-command-${turnSequence}`;
  notify('item/started', {
    threadId: String(params.threadId || 'fake-thread-1'),
    turnId,
    item: {
      type: 'commandExecution',
      id: itemId,
      command: 'printf fake-codex-approved',
      cwd: process.cwd(),
      status: 'inProgress',
      commandActions: [{ type: 'read', path: 'Welcome.md' }],
    },
  });
  const approvalId = nextServerRequestId++;
  pendingApprovals.set(approvalId, { kind: 'command', turnId, itemId, threadId: String(params.threadId || 'fake-thread-1') });
  send({
    id: approvalId,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: String(params.threadId || 'fake-thread-1'),
      turnId,
      itemId,
      command: 'printf fake-codex-approved',
      cwd: process.cwd(),
      reason: 'Confirm the deterministic E2E command',
    },
  });
}

function requestMcpApproval({ turnId, threadId, tool, title, args, successMessage }) {
  const itemId = `fake-mcp-${++toolSequence}`;
  notify('item/started', {
    threadId,
    turnId,
    item: {
      type: 'mcpToolCall',
      id: itemId,
      server: 'stashbase',
      tool,
      arguments: args,
      status: 'inProgress',
    },
  });
  const approvalId = nextServerRequestId++;
  pendingApprovals.set(approvalId, {
    kind: 'mcp',
    turnId,
    threadId,
    itemId,
    tool,
    args,
    successMessage,
  });
  send({
    id: approvalId,
    method: 'mcpServer/elicitation/request',
    params: {
      message: title,
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        connector_name: 'stashbase',
        tool_name: tool,
        tool_title: tool,
        codex_mcp_tool_call_id: itemId,
        tool_params: args,
      },
    },
  });
}

async function startJ10Turn({ turnId, threadId, cwd }) {
  const evidence = 'J10 prepared screenshot evidence.';
  const source = 'Prepared Evidence.png';
  const searchArgs = {
    query: evidence,
    mode: 'keyword',
    folder: cwd,
    top_k: 4,
  };
  const itemId = `fake-mcp-${++toolSequence}`;
  notify('item/started', {
    threadId,
    turnId,
    item: {
      type: 'mcpToolCall',
      id: itemId,
      server: 'stashbase',
      tool: 'search_library',
      arguments: searchArgs,
      status: 'inProgress',
    },
  });
  let result;
  try {
    result = await callStashbaseTool('search_library', searchArgs);
  } catch (error) {
    failMcpItemAndTurn({
      turnId,
      threadId,
      itemId,
      tool: 'search_library',
      args: searchArgs,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const resultText = mcpResultText(result);
  if (result?.isError === true || !resultText.includes(evidence) || !resultText.includes(source)) {
    failMcpItemAndTurn({
      turnId,
      threadId,
      itemId,
      tool: 'search_library',
      args: searchArgs,
      error: resultText || 'Expected project evidence was not retrieved.',
    });
    return;
  }
  notify('item/completed', {
    threadId,
    turnId,
    item: {
      type: 'mcpToolCall',
      id: itemId,
      server: 'stashbase',
      tool: 'search_library',
      arguments: searchArgs,
      status: 'completed',
      result,
    },
  });
  requestMcpApproval({
    turnId,
    threadId,
    tool: 'write_file',
    title: 'Allow Codex to write Core Loop.md?',
    args: {
      path: path.join(cwd, 'Core Loop.md'),
      content: [
        '---',
        'generated_by: stashbase-agent',
        '---',
        '# Core Loop',
        '',
        '## Retrieved evidence',
        '',
        `- Source: ${source}`,
        `- Evidence: ${evidence}`,
        '',
        '## Accepted result',
        '',
        'Use the retrieved project evidence as the durable starting point.',
        '',
      ].join('\n'),
    },
    successMessage: 'Core Loop.md contains the retrieved project evidence.',
  });
}

function failMcpItemAndTurn({ turnId, threadId, itemId, tool, args, error }) {
  notify('item/completed', {
    threadId,
    turnId,
    item: {
      type: 'mcpToolCall',
      id: itemId,
      server: 'stashbase',
      tool,
      arguments: args,
      status: 'failed',
      error,
    },
  });
  notify('turn/completed', {
    threadId,
    turn: { id: turnId, items: [], status: 'failed', error: { message: error } },
  });
}

function completeAssistantTurn({ turnId, threadId, text }) {
  notify('item/agentMessage/delta', {
    threadId,
    turnId,
    itemId: `fake-message-${turnSequence}`,
    delta: text,
  });
  notify('turn/completed', {
    threadId,
    turn: { id: turnId, items: [], status: 'completed' },
  });
}

async function handleResponse(response) {
  const pending = pendingApprovals.get(response.id);
  if (!pending) return;
  pendingApprovals.delete(response.id);
  if (pending.kind === 'mcp') {
    await handleMcpApproval(response, pending);
    return;
  }
  const decision = response.result?.decision ?? 'error';
  record({ event: 'approval-response', decision, response });
  const accepted = decision === 'accept' || decision === 'acceptForSession';
  notify('item/completed', {
    threadId: pending.threadId,
    turnId: pending.turnId,
    item: {
      type: 'commandExecution',
      id: pending.itemId,
      command: 'printf fake-codex-approved',
      cwd: process.cwd(),
      status: accepted ? 'completed' : 'failed',
      aggregatedOutput: accepted ? 'fake-codex-approved' : 'permission declined',
      exitCode: accepted ? 0 : 1,
      commandActions: [{ type: 'read', path: 'Welcome.md' }],
    },
  });
  if (accepted) {
    notify('item/agentMessage/delta', {
      threadId: pending.threadId,
      turnId: pending.turnId,
      itemId: `fake-message-${turnSequence}`,
      delta: 'Deterministic approval completed.',
    });
  }
  notify('turn/completed', {
    threadId: pending.threadId,
    turn: {
      id: pending.turnId,
      items: [],
      status: accepted ? 'completed' : 'failed',
      ...(accepted ? {} : { error: { message: 'Permission was declined.' } }),
    },
  });
}

async function handleMcpApproval(response, pending) {
  const decision = response.result?.action ?? 'error';
  record({ event: 'mcp-approval-response', decision, tool: pending.tool, response });
  if (decision !== 'accept') {
    completeMcpTurn(pending, {
      accepted: false,
      error: 'permission declined',
    });
    return;
  }
  try {
    const result = await callStashbaseTool(pending.tool, pending.args);
    const failed = result?.isError === true;
    completeMcpTurn(pending, {
      accepted: true,
      result,
      error: failed ? mcpResultText(result) || 'MCP tool failed.' : '',
    });
  } catch (error) {
    completeMcpTurn(pending, {
      accepted: true,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function callStashbaseTool(tool, args) {
  const port = Number(process.env.STASHBASE_FAKE_MCP_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('STASHBASE_FAKE_MCP_PORT is required for Journey MCP calls.');
  }
  const client = new Client({ name: 'stashbase-e2e-fake-agent', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', MCP_SERVER, `--port=${port}`],
    cwd: PROJECT_ROOT,
    env: {
      ...(process.env.STASHBASE_WINDOW_ID ? { STASHBASE_WINDOW_ID: process.env.STASHBASE_WINDOW_ID } : {}),
      ...(process.env.STASHBASE_AGENT_SESSION_ID ? { STASHBASE_AGENT_SESSION_ID: process.env.STASHBASE_AGENT_SESSION_ID } : {}),
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => record({ event: 'mcp-stderr', text: String(chunk) }));
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: tool, arguments: args });
    record({ event: 'mcp-result', tool, args, result });
    return result;
  } finally {
    await client.close();
  }
}

function completeMcpTurn(pending, { accepted, result, error }) {
  const success = accepted && !error;
  notify('item/completed', {
    threadId: pending.threadId,
    turnId: pending.turnId,
    item: {
      type: 'mcpToolCall',
      id: pending.itemId,
      server: 'stashbase',
      tool: pending.tool,
      arguments: pending.args,
      status: success ? 'completed' : 'failed',
      ...(success ? { result } : { error: error || 'MCP tool failed.' }),
    },
  });
  if (success && pending.successMessage) {
    notify('item/agentMessage/delta', {
      threadId: pending.threadId,
      turnId: pending.turnId,
      itemId: `fake-message-${turnSequence}`,
      delta: pending.successMessage,
    });
  }
  notify('turn/completed', {
    threadId: pending.threadId,
    turn: {
      id: pending.turnId,
      items: [],
      status: success ? 'completed' : 'failed',
      ...(success ? {} : { error: { message: error || 'MCP tool failed.' } }),
    },
  });
}

function mcpResultText(result) {
  return Array.isArray(result?.content)
    ? result.content.filter((item) => item?.type === 'text').map((item) => item.text).join('\n')
    : '';
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function respond(id, result) {
  send({ id, result });
}

function reject(id, message, code) {
  send({ id, error: { code, message } });
}

function notify(method, params) {
  send({ method, params });
}

function send(message) {
  record({ event: 'send', message });
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function record(entry) {
  if (!logFile) return;
  fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, 'utf8');
}
