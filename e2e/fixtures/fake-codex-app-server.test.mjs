import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXECUTABLE = path.join(HERE, 'fake-codex-app-server.mjs');

function protocolPeer(child) {
  const messages = [];
  const waiters = new Set();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  function waitFor(predicate, label) {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`timed out waiting for ${label}; received ${JSON.stringify(messages)}`));
        }, 5_000),
      };
      waiters.add(waiter);
    });
  }
  return {
    messages,
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    response(id) {
      return waitFor((message) => message.id === id && ('result' in message || 'error' in message), `response ${id}`);
    },
    notification(method, predicate = () => true) {
      return waitFor((message) => message.method === method && predicate(message.params ?? {}), method);
    },
    request(method) {
      return waitFor((message) => message.method === method && 'id' in message, method);
    },
    close() {
      lines.close();
      for (const waiter of waiters) clearTimeout(waiter.timer);
      waiters.clear();
    },
  };
}

async function runFakeCodex(args) {
  const child = spawn(EXECUTABLE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

test('fake Codex executable supports readiness and browser-login commands', async () => {
  const status = await runFakeCodex(['login', 'status']);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Logged in/);

  const login = await runFakeCodex(['login']);
  assert.equal(login.code, 0, login.stderr);
  assert.match(login.stdout, /browser login completed/);
});

test('fake Codex executable speaks the app-server lifecycle used by StashBase', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-fake-codex-'));
  const cwd = path.join(root, 'workspace');
  const logFile = path.join(root, 'protocol.jsonl');
  fs.mkdirSync(cwd);
  const spawnedCwd = fs.realpathSync(cwd);
  const child = spawn(EXECUTABLE, ['app-server', '--listen', 'stdio://'], {
    cwd: spawnedCwd,
    env: {
      ...process.env,
      STASHBASE_FAKE_CODEX_LOG: logFile,
      STASHBASE_WINDOW_ID: 'window-fixture',
      STASHBASE_AGENT_SESSION_ID: 'session-fixture',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const peer = protocolPeer(child);
  t.after(async () => {
    peer.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'close');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  peer.send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'StashBase' } } });
  assert.deepEqual((await peer.response(1)).result, {});
  peer.send({ id: 2, method: 'model/list', params: {} });
  assert.deepEqual((await peer.response(2)).result.data, [{
    id: 'fake-codex-model',
    displayName: 'Fake Codex Model',
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
  }]);
  peer.send({ id: 3, method: 'skills/list', params: { cwds: [spawnedCwd] } });
  assert.deepEqual((await peer.response(3)).result, { data: [{ cwd: spawnedCwd, skills: [] }] });
  peer.send({ id: 4, method: 'thread/start', params: { cwd: spawnedCwd, threadSource: 'user' } });
  assert.equal((await peer.response(4)).result.thread.id, 'fake-thread-1');
  peer.send({ id: 5, method: 'thread/name/set', params: { threadId: 'fake-thread-1', name: 'Approval turn' } });
  assert.deepEqual((await peer.response(5)).result, {});
  const requestedHistoryCwd = path.join(root, 'workspace-spelling');
  peer.send({ id: 51, method: 'thread/list', params: { cwd: requestedHistoryCwd } });
  const historyRows = (await peer.response(51)).result.data;
  assert.deepEqual(historyRows.map((thread) => thread.id), ['fake-history-thread']);
  assert.equal(historyRows[0].cwd, requestedHistoryCwd);
  peer.send({ id: 52, method: 'thread/read', params: { threadId: 'fake-history-thread', includeTurns: true } });
  const history = (await peer.response(52)).result.thread;
  assert.equal(history.cwd, requestedHistoryCwd);
  assert.match(history.turns[0].items[1].text, /Restored formula from history:/);
  assert.match(history.turns[0].items[1].text, /\\boxed\{/);

  peer.send({ id: 6, method: 'turn/start', params: {
    threadId: 'fake-thread-1',
    cwd: spawnedCwd,
    input: [{ type: 'text', text: 'approval turn', text_elements: [] }],
  } });
  assert.equal((await peer.response(6)).result.turn.id, 'fake-turn-1');
  await peer.notification('turn/started', (params) => params.turn?.id === 'fake-turn-1');
  await peer.notification('item/started', (params) => params.item?.id === 'fake-command-1');
  const approval = await peer.request('item/commandExecution/requestApproval');
  assert.equal(approval.params.command, 'printf fake-codex-approved');
  peer.send({ id: approval.id, result: { decision: 'accept' } });
  await peer.notification('item/completed', (params) => params.item?.id === 'fake-command-1');
  assert.equal((await peer.notification('item/agentMessage/delta')).params.delta, 'Deterministic approval completed.');
  assert.equal((await peer.notification('turn/completed')).params.turn.status, 'completed');

  peer.send({ id: 7, method: 'turn/start', params: {
    threadId: 'fake-thread-1',
    cwd: spawnedCwd,
    input: [{ type: 'text', text: 'wait for stop', text_elements: [] }],
  } });
  assert.equal((await peer.response(7)).result.turn.id, 'fake-turn-2');
  await peer.notification('turn/started', (params) => params.turn?.id === 'fake-turn-2');
  peer.send({ id: 8, method: 'turn/interrupt', params: { threadId: 'fake-thread-1', turnId: 'fake-turn-2' } });
  assert.deepEqual((await peer.response(8)).result, {});
  assert.equal((await peer.notification('turn/completed', (params) => params.turn?.id === 'fake-turn-2')).params.turn.status, 'interrupted');

  peer.send({ id: 9, method: 'turn/start', params: {
    threadId: 'fake-thread-1',
    cwd: spawnedCwd,
    input: [{ type: 'text', text: 'terminal error', text_elements: [] }],
  } });
  assert.equal((await peer.response(9)).result.turn.id, 'fake-turn-3');
  assert.deepEqual((await peer.notification('error', (params) => params.turnId === 'fake-turn-3')).params, {
    threadId: 'fake-thread-1',
    turnId: 'fake-turn-3',
    willRetry: false,
    message: 'Deterministic fake Agent failure.',
  });

  peer.send({ id: 10, method: 'turn/start', params: {
    threadId: 'fake-thread-1',
    cwd: spawnedCwd,
    input: [{ type: 'text', text: 'math reply', text_elements: [] }],
  } });
  assert.equal((await peer.response(10)).result.turn.id, 'fake-turn-4');
  const firstMathDelta = await peer.notification('item/agentMessage/delta', (params) => params.turnId === 'fake-turn-4');
  assert.equal(firstMathDelta.params.delta, String.raw`Streamed formula: \(x^2`);
  assert.equal((await peer.notification('turn/completed', (params) => params.turn?.id === 'fake-turn-4')).params.turn.status, 'completed');

  peer.send({ id: 11, method: 'turn/start', params: {
    threadId: 'fake-thread-1',
    cwd: spawnedCwd,
    input: [{ type: 'text', text: 'journey:j11 create project denied', text_elements: [] }],
  } });
  assert.equal((await peer.response(11)).result.turn.id, 'fake-turn-5');
  await peer.notification('item/started', (params) => (
    params.turnId === 'fake-turn-5'
    && params.item?.type === 'mcpToolCall'
    && params.item?.tool === 'create_project'
  ));
  const mcpApproval = await peer.request('mcpServer/elicitation/request');
  assert.equal(mcpApproval.params.message, 'Allow Codex to create conversation-project?');
  assert.deepEqual(mcpApproval.params._meta.tool_params, { name: 'conversation-project' });
  peer.send({ id: mcpApproval.id, result: { action: 'decline', content: null, _meta: null } });
  assert.equal((await peer.notification('item/completed', (params) => (
    params.turnId === 'fake-turn-5' && params.item?.tool === 'create_project'
  ))).params.item.status, 'failed');
  assert.equal((await peer.notification('turn/completed', (params) => params.turn?.id === 'fake-turn-5')).params.turn.status, 'failed');
  assert.equal(fs.existsSync(path.join(spawnedCwd, 'conversation-project')), false);

  child.kill('SIGTERM');
  await once(child, 'close');
  const log = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(log[0], {
    event: 'launch',
    argv: ['app-server', '--listen', 'stdio://'],
    cwd: spawnedCwd,
    windowId: 'window-fixture',
    agentSessionId: 'session-fixture',
    networkDenied: true,
  });
  assert.equal(log.find((entry) => entry.event === 'approval-response').decision, 'accept');
  assert.deepEqual(log.find((entry) => entry.event === 'interrupt').params, {
    threadId: 'fake-thread-1',
    turnId: 'fake-turn-2',
  });
});

test('fake Agent network policy rejects high- and low-level clients', async () => {
  const probe = path.join(HERE, 'network-denial-probe.mjs');
  const child = spawn(process.execPath, [probe], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {
    fetch: 'network access is forbidden in the deterministic fake Agent',
    http: 'network access is forbidden in the deterministic fake Agent',
    socket: 'network access is forbidden in the deterministic fake Agent',
  });
});
