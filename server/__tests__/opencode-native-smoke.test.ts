import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOpencodeClient, type Event } from '@opencode-ai/sdk';
import { ensureMcpLauncher } from '../agent-mcp.ts';
import {
  BUNDLED_OPENCODE_VERSION,
  buildOpenCodeConfig,
  bundledOpenCodeExecutable,
} from '../opencode-runtime.ts';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listener has no TCP port');
  return address.port;
}

async function unusedPort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('packaged OpenCode resolves from the explicit resources path before dependency fallbacks', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-opencode-resource-'));
  const executable = path.join(temporaryRoot, 'opencode', 'opencode.exe');
  const previousResourcesRoot = process.env.STASHBASE_RESOURCES_PATH;
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'packaged runtime');
  process.env.STASHBASE_RESOURCES_PATH = temporaryRoot;

  try {
    assert.equal(bundledOpenCodeExecutable(), executable);
  } finally {
    if (previousResourcesRoot === undefined) delete process.env.STASHBASE_RESOURCES_PATH;
    else process.env.STASHBASE_RESOURCES_PATH = previousResourcesRoot;
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('pinned bundled OpenCode completes one SDK session against a fake compatible model gateway', {
  timeout: 30_000,
}, async (t) => {
  const executable = bundledOpenCodeExecutable();
  assert.ok(executable, 'bundled OpenCode postinstall target is missing');
  assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(), BUNDLED_OPENCODE_VERSION);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-opencode-native-'));
  const gatewayRequests: Array<Record<string, unknown>> = [];
  const gateway = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    gatewayRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'chatcmpl-stashbase-smoke', object: 'chat.completion.chunk', created: 1, model: 'stashbase-agent-default' };
    response.write(`data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'probe ok' }, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  const gatewayPort = await listen(gateway);
  const serverPort = await unusedPort();
  const username = 'stashbase';
  const password = 'native-smoke-secret';
  const config = buildOpenCodeConfig({
    apiKey: 'fake-loopback-key',
    baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
    model: 'stashbase-agent-default',
  }, '/unused/stashbase-mcp');
  config.mcp = {
    stashbase: {
      type: 'local',
      // Exercise the exact platform launcher used in production. In
      // particular, Windows must go through the generated `.cmd` wrapper
      // rather than a test-only Node/tsx command that bypasses its quoting.
      command: [ensureMcpLauncher(temporaryRoot)],
      environment: { STASHBASE_WINDOW_ID: 'native-smoke' },
      enabled: true,
      timeout: 10_000,
    },
  };

  const child = spawn(executable, [
    'serve', '--hostname=127.0.0.1', `--port=${serverPort}`, '--pure', '--log-level=WARN',
  ], {
    env: {
      ...process.env,
      HOME: temporaryRoot,
      USERPROFILE: temporaryRoot,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
      XDG_DATA_HOME: path.join(temporaryRoot, 'data'),
      XDG_CONFIG_HOME: path.join(temporaryRoot, 'config'),
      XDG_CACHE_HOME: path.join(temporaryRoot, 'cache'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    if (child.exitCode == null) child.kill('SIGTERM');
    if (child.exitCode == null) await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  let startupOutput = '';
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(startupOutput || 'OpenCode startup timed out')), 15_000);
    const inspect = (chunk: Buffer) => {
      startupOutput += chunk.toString('utf8');
      if (!startupOutput.includes('opencode server listening')) return;
      clearTimeout(timeout);
      resolve();
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', (code) => reject(new Error(`OpenCode exited during startup (${code}): ${startupOutput}`)));
  });

  const client = createOpencodeClient({
    baseUrl: `http://127.0.0.1:${serverPort}`,
    directory: temporaryRoot,
    headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` },
    throwOnError: true,
  });
  let mcpStatus: { status: string; error?: string } | undefined;
  const mcpDeadline = Date.now() + 10_000;
  while (Date.now() < mcpDeadline) {
    mcpStatus = (await client.mcp.status({ throwOnError: true })).data.stashbase as typeof mcpStatus;
    if (mcpStatus?.status === 'connected' || mcpStatus?.status === 'failed') break;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    mcpStatus?.status,
    'connected',
    `${mcpStatus?.error ?? 'StashBase MCP did not connect'}\n${startupOutput}`.trim(),
  );
  type PermissionRule = { permission: string; pattern: string; action: string };
  const agents = (await client.app.agents({ throwOnError: true })).data as unknown as Array<{
    name: string;
    permission: PermissionRule[];
  }>;
  const actionFor = (agent: string, permission: string) => agents
    .find((candidate) => candidate.name === agent)
    ?.permission.filter((rule) => rule.permission === permission && rule.pattern === '*').at(-1)?.action;
  assert.equal(actionFor('stashbase-folder', 'bash'), 'ask');
  assert.equal(actionFor('stashbase-folder', 'edit'), 'ask');
  assert.equal(actionFor('stashbase-folder', 'external_directory'), 'deny');
  for (const permission of ['bash', 'read', 'glob', 'grep', 'edit', 'task', 'apply_patch']) {
    assert.equal(actionFor('stashbase-library', permission), 'deny', `Library permission ${permission} is not denied`);
  }
  for (const permission of ['stashbase_write_file', 'stashbase_edit_file', 'stashbase_move_file', 'stashbase_delete_file', 'stashbase_create_project']) {
    assert.equal(actionFor('stashbase-library', permission), 'ask', `MCP permission ${permission} does not ask`);
  }
  const subscription = await client.event.subscribe({ sseMaxRetryAttempts: 1 });
  const nativeToolIds = ['invalid', 'question', 'bash', 'read', 'glob', 'grep', 'edit', 'write', 'task', 'webfetch', 'todowrite', 'websearch', 'skill', 'apply_patch'];
  assert.deepEqual(
    [...(await client.tool.ids({ throwOnError: true })).data].sort(),
    nativeToolIds.sort(),
    'the pinned OpenCode native tool surface changed; review the Library-profile deny list',
  );
  const events: Event[] = [];
  const consumed = (async () => {
    for await (const event of subscription.stream) {
      events.push(event);
      if (event.type === 'session.idle') return;
    }
  })();
  const session = (await client.session.create({ throwOnError: true, body: { title: 'Native Smoke' } })).data;
  await client.session.promptAsync({
    throwOnError: true,
    path: { id: session.id },
    body: {
      model: { providerID: 'stashbase', modelID: 'stashbase-agent-default' },
      agent: 'stashbase-folder',
      parts: [{ type: 'text', text: 'Reply with probe ok.' }],
    },
  });
  await consumed;
  const text = events.flatMap((event) => (
    event.type === 'message.part.updated' && event.properties.part.type === 'text'
      ? [event.properties.part.text]
      : []
  )).at(-1);
  assert.equal(text, 'probe ok');
  assert.ok(events.some((event) => event.type === 'session.diff'));
  assert.ok(events.some((event) => event.type === 'session.idle'));

  const toolNames = (request: Record<string, unknown>) => (
    Array.isArray(request.tools)
      ? request.tools.flatMap((tool) => {
          const fn = tool && typeof tool === 'object' ? (tool as { function?: { name?: unknown } }).function : undefined;
          return typeof fn?.name === 'string' ? [fn.name] : [];
        })
      : []
  );
  const folderTools = toolNames(gatewayRequests[0]);
  for (const name of ['bash', 'read', 'task']) {
    assert.ok(folderTools.includes(name), `folder profile omitted ${name}`);
  }
  for (const name of ['stashbase_read_file', 'stashbase_write_file']) {
    assert.ok(folderTools.includes(name), `folder profile omitted ${name}`);
  }

  const librarySession = (await client.session.create({ throwOnError: true, body: { title: 'Library Smoke' } })).data;
  await client.session.prompt({
    throwOnError: true,
    path: { id: librarySession.id },
    body: {
      model: { providerID: 'stashbase', modelID: 'stashbase-agent-default' },
      agent: 'stashbase-library',
      parts: [{ type: 'text', text: 'Reply with probe ok.' }],
    },
  });
  const libraryTools = toolNames(gatewayRequests[1]);
  for (const name of ['bash', 'read', 'glob', 'grep', 'edit', 'write', 'task', 'apply_patch']) {
    assert.equal(libraryTools.includes(name), false, `Library profile exposed ${name}`);
  }
  for (const name of ['stashbase_read_file', 'stashbase_write_file']) {
    assert.ok(libraryTools.includes(name), `Library profile omitted ${name}`);
  }
});
