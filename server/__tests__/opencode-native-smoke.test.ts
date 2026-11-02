import './isolated-home.ts';
import { attachmentPdf } from './attachment-fixtures.ts';
import assert from 'node:assert/strict';
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import type { WebSocket } from 'ws';
import { createOpencodeClient, type Event as LegacyEvent } from '@opencode-ai/sdk';
import type { EventPermissionAsked } from '@opencode-ai/sdk/v2/types';
import { blocksForMessage, OpenCodeEventTranslator, OpenCodePanelSession } from '../opencode-agent.ts';
import { ensureMcpLauncher } from '../agent-mcp.ts';
import { filesystemPath } from '../filesystem-path.ts';
import { HostedAgentBroker } from '../hosted-agent-broker.ts';
import {
  BUNDLED_OPENCODE_VERSION,
  buildOpenCodeConfig,
  bundledOpenCodeExecutable,
  openCodeRuntimeEnvironment,
  createOpenCodeSessionRuntime,
  stopOpenCodeRuntime,
  openCodeClient,
} from '../opencode-runtime.ts';
import { telemetry } from '../telemetry.ts';
import { telemetryEventSchema, type TelemetryEvent } from '../../shared/protocols/http/telemetry.ts';
import { setHostedAccountSession } from '../app-config.ts';
import { setDefaultAgentTool } from '../default-agent-tools.ts';
import { parseToolCatalog } from '../agent-tool-catalog.ts';

type Event = LegacyEvent | EventPermissionAsked;

/** Two hosted profiles, one under the id the rest of this smoke sends. */
const SMOKE_PROFILES = [
  { id: 'stashbase-agent-default', version: 4, displayName: 'Writer Fast', contextTokenLimit: 1_000_000, outputTokenLimit: 65_536, isDefault: true },
  { id: 'writer-pro', version: 9, displayName: 'Writer Pro', contextTokenLimit: 200_000, outputTokenLimit: 16_000, isDefault: false },
];

class PanelSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  events: Array<{ t: string; id?: string }> = [];
  send(value: string): void {
    const event = JSON.parse(value);
    this.events.push(event);
    this.emit('server-event', event);
  }
  close(): void { this.readyState = 3; this.emit('close'); }
  waitFor(type: string, allowError = false): Promise<void> {
    return new Promise((resolve, reject) => {
      const listener = (event: { t: string; message?: string }) => {
        if ((event.t === 'error' && !allowError) || event.t === 'exit') {
          this.off('server-event', listener);
          reject(new Error(event.message ?? 'Panel exited'));
          return;
        }
        if (event.t !== type) return;
        this.off('server-event', listener);
        resolve();
      };
      this.on('server-event', listener);
    });
  }
  request(event: unknown): void { this.emit('message', Buffer.from(JSON.stringify(event))); }
}

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
  // Windows also runs the project-skill tool round trip in this fixture.
  timeout: 60_000,
}, async (t) => {
  let stage = 'startup';
  let completed = false;
  const skillEvents: string[] = [];
  const subscriptions = new AbortController();
  let panel: OpenCodePanelSession | undefined;
  let ownedBroker: HostedAgentBroker | undefined;
  let ownedChild: ReturnType<typeof spawn> | undefined;
  t.signal.addEventListener('abort', () => {
    if (!completed) {
      console.error(`Native OpenCode smoke stopped during: ${stage}`);
      if (stage === 'project skill invocation') console.error(`Skill event types: ${skillEvents.slice(-12).join(', ')}`);
    }
  });
  const executable = bundledOpenCodeExecutable();
  assert.ok(executable, 'bundled OpenCode postinstall target is missing');
  assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(), BUNDLED_OPENCODE_VERSION);

  // Windows TEMP can use an 8.3 alias; the SDK and panel must bind the same
  // canonical directory rather than canonicalizing only the panel's scope.
  const fixtureRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-opencode-native-')));
  const temporaryRoot = path.join(fixtureRoot, 'project');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  fs.mkdirSync(temporaryRoot);
  // Reproduce a project below a user's home without a Git boundary. Skills in
  // these ancestor directories must not enter the project model request.
  const skillSources = ['.agents/skills', '.claude/skills', '.opencode/skills', '.opencode/skill'];
  for (const [index, source] of skillSources.entries()) {
    for (const [scope, root] of [['ancestor', fixtureRoot], ['project', temporaryRoot]] as const) {
      const name = `${scope}-writing-${index}`;
      const folder = path.join(root, source, name);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${scope.toUpperCase()}_SKILL_${index}\n---\n${scope.toUpperCase()}_SKILL_BODY_${index}\n`);
    }
  }
  fs.writeFileSync(path.join(temporaryRoot, 'AGENTS.md'), 'PROJECT_INSTRUCTIONS_RETAINED\n');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-outside-probe-'));
  const externalFile = path.join(outside, 'reference.txt');
  fs.writeFileSync(externalFile, 'EXPLICIT_EXTERNAL_READ_OK');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const gatewayRequests: Array<Record<string, unknown>> = [];
  const gatewayModels: Array<{ profile: string | undefined; version: string | undefined }> = [];
  let nextTool: { name: string; arguments: string } | undefined;
  const reviews: Array<Record<string, unknown>> = [];
  let delayedReview: Promise<void> | undefined;
  let releaseReview: (() => void) | undefined;
  let reviewDisconnected = false;
  let finishReview: (() => void) | undefined;
  t.after(() => releaseReview?.());
  let emptyResponses = 0;
  let contextRefusals = 0;
  let emptyAfterTool = false;
  let interruptions = 0;
  let interruptionsAfterTool = 0;
  let partialInterruption = false;
  let finishPartial: () => void;
  const gateway = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    gatewayRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
    gatewayModels.push({
      profile: request.headers['x-stashbase-agent-profile'] as string | undefined,
      version: request.headers['x-stashbase-agent-profile-version'] as string | undefined,
    });
    const body = gatewayRequests.at(-1)!;
    if (contextRefusals > 0) {
      contextRefusals--;
      response.writeHead(413, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'agent_context_too_large', message: 'The Agent request exceeds the model context limit.' }));
      return;
    }
    const reviewing = Array.isArray(body.messages) && body.messages.some((message) =>
      message.role === 'system' && String(message.content).startsWith('Review one proposed action'));
    if (reviewing) {
      reviews.push(body);
      if (delayedReview) {
        response.on('close', () => { if (!response.writableEnded) reviewDisconnected = true; });
        response.on('finish', () => finishReview?.());
        await delayedReview;
      }
    }
    const tool = nextTool ?? (gatewayRequests.length === 1
      ? { name: 'read', arguments: JSON.stringify({ filePath: externalFile }) }
      : gatewayRequests.length === 3
        ? { name: 'bash', arguments: JSON.stringify({ command: 'node -p process.versions.node', description: 'Check installed Node' }) }
        : undefined);
    nextTool = undefined;
    const empty = !tool && emptyResponses > 0;
    if (empty) emptyResponses--;
    if (tool && emptyAfterTool) {
      emptyAfterTool = false;
      emptyResponses = 1;
    }
    if (tool && interruptionsAfterTool) {
      interruptions = interruptionsAfterTool;
      interruptionsAfterTool = 0;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'chatcmpl-stashbase-smoke', object: 'chat.completion.chunk', created: 1, model: 'stashbase-agent-default' };
    if (!tool && interruptions > 0) {
      interruptions--;
      if (partialInterruption) {
        partialInterruption = false;
        const observed = new Promise<void>(resolve => { finishPartial = resolve; response.once('close', resolve); });
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Partial reply retained' }, finish_reason: null }] })}\n\n`);
        await observed;
      }
      response.end('data: {"error":{"code":"agent_provider_unavailable","message":"The Agent model provider interrupted the response."}}\n\n');
      return;
    }
    response.write(`data: ${JSON.stringify({
      ...base,
      choices: [{
        index: 0,
        delta: tool ? {
          role: 'assistant',
          tool_calls: [{
            index: 0, id: `smoke-tool-${gatewayRequests.length}`, type: 'function', function: tool,
          }],
        } : { role: 'assistant', content: reviewing ? 'ALLOW' : empty ? '' : 'probe ok' },
        finish_reason: null,
      }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      ...base,
      choices: empty ? [] : [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: empty ? 0 : 2, total_tokens: empty ? 1 : 3 },
    })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  t.after(async () => {
    subscriptions.abort();
    panel?.dispose();
    try {
      await ownedBroker?.close();
    } finally {
      try {
        const child = ownedChild;
        if (child?.pid && child.exitCode == null && child.signalCode == null) {
          const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
          child.kill('SIGTERM');
          const force = setTimeout(() => child.kill('SIGKILL'), 1_500);
          try { await exited; } finally { clearTimeout(force); }
        }
      } finally {
        gateway.closeAllConnections();
        await new Promise<void>((resolve) => gateway.close(() => resolve()));
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    }
  });
  const gatewayPort = await listen(gateway);
  const broker = new HostedAgentBroker({
    accessToken: async () => 'fixture-account-token', fetch: globalThis.fetch,
    upstreamUrl: `http://127.0.0.1:${gatewayPort}/v1/chat/completions`, clientVersion: () => 'native-smoke',
  });
  ownedBroker = broker;
  await broker.start();
  const model = broker.runtime('native-smoke')!;
  broker.beginTurn('native-smoke', '00000000-0000-4000-8000-000000000001');
  const serverPort = await unusedPort();
  const username = 'stashbase';
  const password = 'native-smoke-secret';
  const config = buildOpenCodeConfig(model, '/unused/stashbase-mcp', {}, undefined, SMOKE_PROFILES, temporaryRoot);
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
    env: openCodeRuntimeEnvironment(config, username, password, runtimeRoot, {
      ...process.env,
      ...(process.platform === 'darwin' ? { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh' } : {}),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ownedChild = child;

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
    ?.permission.filter((rule) => (rule.permission === permission || rule.permission === '*') && rule.pattern === '*').at(-1)?.action;
  assert.equal(actionFor('stashbase-folder', 'bash'), 'ask');
  assert.equal(actionFor('stashbase-folder', 'edit'), 'ask');
  assert.equal(actionFor('stashbase-folder', 'stashbase_edit_file'), 'ask');
  assert.equal(actionFor('stashbase-folder', 'stashbase_write_file'), 'ask');
  assert.equal(actionFor('stashbase-folder', 'external_directory'), 'ask');
  for (const permission of ['bash', 'edit', 'task', 'stashbase_edit_file', 'stashbase_write_file', 'stashbase_delete_file', 'stashbase_create_project']) {
    assert.equal(actionFor('stashbase-plan', permission), 'deny', `Plan allowed ${permission}`);
  }
  assert.equal(actionFor('stashbase-plan', 'stashbase_read_file'), 'allow');
  stage = 'external read';
  const subscription = await client.event.subscribe({ signal: subscriptions.signal, sseMaxRetryAttempts: 1 });
  const events: Event[] = [];
  const translator = new OpenCodeEventTranslator();
  const session = (await client.session.create({ throwOnError: true, body: { title: 'New Chat' } })).data;
  assert.ok(filesystemPath.equal(session.directory, temporaryRoot),
    `SDK session scope ${JSON.stringify(session.directory)} differs from fixture ${JSON.stringify(temporaryRoot)}`);
  translator.bindSession(session.id);
  const consumed = (async () => {
    for await (const event of subscription.stream) {
      events.push(event);
      for (const translated of translator.translate(event)) {
        if (translated.t !== 'permission') continue;
        assert.equal(translated.name, 'Read');
        await client.postSessionIdPermissionsPermissionId({
          throwOnError: true,
          path: { id: session.id, permissionID: translated.id },
          body: { response: 'once' },
        });
      }
      if (event.type === 'session.idle') return;
    }
  })();
  await client.session.promptAsync({
    throwOnError: true,
    path: { id: session.id },
    body: {
      model: { providerID: 'stashbase', modelID: 'stashbase-agent-default' },
      agent: 'stashbase-folder',
      parts: [{ type: 'text', text: `Read ${externalFile} and reply with probe ok.` }],
    },
  });
  await consumed;
  assert.equal(gatewayRequests.length, 2, 'one read and its answer must not incur an extra title model call');
  const initialRequest = JSON.stringify(gatewayRequests[0]);
  assert.ok(!initialRequest.includes('ANCESTOR_SKILL_'), 'ancestor skills must not reach the model');
  assert.match(initialRequest, /PROJECT_INSTRUCTIONS_RETAINED/);
  for (const index of skillSources.keys()) assert.ok(initialRequest.includes(`PROJECT_SKILL_${index}`));
  assert.doesNotMatch(initialRequest, /PROJECT_SKILL_BODY_/);
  assert.ok(events.some(event => event.type === 'permission.asked'), 'external read must request permission');
  assert.ok(JSON.stringify(gatewayRequests.slice(1)).includes('EXPLICIT_EXTERNAL_READ_OK'), 'authorized external read must reach model');
  assert.ok(events.some((event) => (
    event.type === 'message.part.updated'
      && event.properties.part.type === 'text'
      && event.properties.part.text === 'probe ok'
  )), 'the fake gateway response did not reach the OpenCode event stream');
  assert.ok(events.some((event) => event.type === 'session.diff'));
  assert.ok(events.some((event) => event.type === 'session.idle'));

  stage = 'shell command';
  const commandSubscription = await client.event.subscribe({ signal: subscriptions.signal, sseMaxRetryAttempts: 1 });
  const commandEvents: Event[] = [];
  const commandConsumed = (async () => {
    for await (const event of commandSubscription.stream) {
      commandEvents.push(event);
      for (const translated of translator.translate(event)) {
        if (translated.t !== 'permission') continue;
        assert.equal(translated.name, 'Bash');
        await client.postSessionIdPermissionsPermissionId({
          throwOnError: true,
          path: { id: session.id, permissionID: translated.id },
          body: { response: 'once' },
        });
      }
      if (event.type === 'session.idle') return;
    }
  })();
  await client.session.promptAsync({
    throwOnError: true, path: { id: session.id },
    body: { agent: 'stashbase-folder', parts: [{ type: 'text', text: 'Check the installed Node version.' }] },
  });
  await commandConsumed;
  assert.ok(commandEvents.some(event => event.type === 'permission.asked'), 'Ask must still request command approval');
  const commandResult = commandEvents.find(event => event.type === 'message.part.updated'
    && event.properties.part.type === 'tool' && event.properties.part.tool === 'bash'
    && event.properties.part.state.status === 'completed');
  assert.ok(commandResult && commandResult.type === 'message.part.updated' && commandResult.properties.part.type === 'tool');
  const commandState = commandResult.properties.part.state;
  assert.equal(commandState.status, 'completed');
  if (commandState.status === 'completed') {
    assert.match(commandState.output, /\d+\.\d+\.\d+/);
    assert.ok(!commandState.output.includes('command not found'), commandState.output);
    assert.equal(commandState.metadata?.exit, 0);
  }

  // Use the real MCP permission protocol with an isolated file writer, so the
  // panel's Edit decision is exercised without relying on a running app host.
  const require = createRequire(import.meta.url);
  const moduleUrl = (name: string) => pathToFileURL(require.resolve(name)).href;
  const fixture = path.join(temporaryRoot, 'fixture-mcp.mjs');
  fs.writeFileSync(fixture, `
    import fs from 'node:fs';
    import { Server } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/server/index.js'))};
    import { StdioServerTransport } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/server/stdio.js'))};
    import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/types.js'))};
    const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
      name: 'write_file', description: 'Write a fixture file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    }] }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      fs.writeFileSync(params.arguments.path, params.arguments.content);
      return { content: [{ type: 'text', text: 'fixture written' }] };
    });
    await server.connect(new StdioServerTransport());
  `);
  await client.mcp.add({ throwOnError: true, body: {
    name: 'stashbase', config: { type: 'local', command: [process.execPath, fixture], enabled: true },
  } });
  const socket = new PanelSocket();
  stage = 'panel permission modes';
  panel = new OpenCodePanelSession(socket as unknown as WebSocket, {
    windowId: 'native-modes', folder: temporaryRoot, access: 'acceptEdits',
  }, {
    models: async () => SMOKE_PROFILES,
    client: async () => client,
    beginTurn: (turnId, selected) => broker.beginTurn('native-smoke', turnId, selected),
    tools: () => [],
    complete: (profile, messages, signal) => broker.complete('native-smoke', profile, messages, signal),
    runTool: async () => { throw new Error('No tools in this smoke.'); },
    endTurn: () => broker.endTurn('native-smoke'),
    onExit: () => () => {}, close: async () => {},
  });
  await socket.waitFor('ready');
  const modeFile = path.join(temporaryRoot, 'mode-result.md');
  const runPanelTurn = async (allowError = false, text = 'Run the fixture probe.') => {
    const ended = socket.waitFor('turn-end', allowError);
    socket.request({ t: 'prompt', text });
    await ended;
  };
  nextTool = { name: 'stashbase_write_file', arguments: JSON.stringify({ path: modeFile, content: 'Edit allowed' }) };
  await runPanelTurn();
  assert.equal(fs.readFileSync(modeFile, 'utf8'), 'Edit allowed');
  assert.equal(socket.events.filter(event => event.t === 'permission').length, 0, 'Edit should approve its scoped write automatically');
  socket.request({ t: 'set-mode', mode: 'plan' });
  nextTool = { name: 'stashbase_write_file', arguments: JSON.stringify({ path: modeFile, content: 'Plan must not overwrite' }) };
  await runPanelTurn();
  assert.equal(fs.readFileSync(modeFile, 'utf8'), 'Edit allowed', 'Plan must reject a provider that attempts a write');

  // The main agent stays on the default profile; a model pick is not a role.
  stage = 'panel main model';
  const firstPanelCall = gatewayModels.findIndex((entry) => entry.version !== undefined);
  assert.deepEqual(gatewayModels[firstPanelCall], { profile: 'stashbase-agent-default', version: '4' });
  socket.request({ t: 'set-model', model: 'writer-pro' });
  const beforeChoice = gatewayRequests.length;
  await runPanelTurn();
  assert.ok(gatewayRequests.length > beforeChoice);
  for (let index = beforeChoice; index < gatewayRequests.length; index++) {
    assert.equal(gatewayRequests[index]!.model, 'stashbase-agent-default');
    assert.deepEqual(gatewayModels[index], { profile: 'stashbase-agent-default', version: '4' });
  }
  nextTool = { name: 'bash', arguments: JSON.stringify({ command: `echo changed > '${modeFile}'`, description: 'Attempt a command in Plan' }) };
  await runPanelTurn();
  assert.equal(fs.readFileSync(modeFile, 'utf8'), 'Edit allowed', 'Plan must reject shell writes');
  socket.request({ t: 'set-mode', mode: 'default' });
  let allowPermission = true;
  socket.on('server-event', (event: { t: string; id?: string }) => {
    if (event.t === 'permission') socket.request({ t: 'permission-reply', id: event.id, allow: allowPermission });
  });
  nextTool = { name: 'stashbase_write_file', arguments: JSON.stringify({ path: modeFile, content: 'Ask approved' }) };
  await runPanelTurn();
  assert.equal(fs.readFileSync(modeFile, 'utf8'), 'Ask approved', 'switching out of Plan must restore approved writes');
  assert.equal(socket.events.filter(event => event.t === 'permission').length, 1);

  stage = 'Auto command review';
  socket.request({ t: 'set-mode', mode: 'auto' });
  const autoStart = socket.events.length;
  nextTool = { name: 'bash', arguments: JSON.stringify({ command: 'pwd', description: 'Show the project directory' }) };
  await runPanelTurn(false, 'Show the project directory with pwd.');
  assert.equal(reviews.length, 1, 'Auto must review the exact native command through the hosted broker');
  assert.equal(reviews[0].tools, undefined, 'the reviewer has no tools');
  assert.match(JSON.stringify(reviews[0].messages), /Show the project directory with pwd/);
  const autoEvents = socket.events.slice(autoStart) as Array<{ t: string; content?: string; isError?: boolean }>;
  assert.equal(autoEvents.filter(event => event.t === 'permission').length, 0);
  assert.ok(autoEvents.some(event => event.t === 'tool-result' && !event.isError && event.content?.includes(temporaryRoot)));

  stage = 'Auto decision timeout with delayed accounting';
  delayedReview = new Promise<void>(resolve => { releaseReview = resolve; });
  const drained = new Promise<void>(resolve => { finishReview = resolve; });
  const delayedStart = socket.events.length;
  nextTool = { name: 'bash', arguments: JSON.stringify({ command: 'pwd', description: 'Show the project directory again' }) };
  await runPanelTurn(false, 'Show the project directory again with pwd.');
  assert.equal(socket.events.slice(delayedStart).filter(event => event.t === 'permission').length, 1,
    'slow Auto review must fall back to manual approval');
  await runPanelTurn();
  releaseReview!();
  await drained;
  assert.equal(reviewDisconnected, false, 'manual fallback and the next turn must not abort an accepted review');
  assert.equal(reviews.length, 2);
  assert.equal(reviews[1].max_tokens, 256);
  delayedReview = undefined;

  stage = 'external native writes';
  socket.request({ t: 'set-mode', mode: 'acceptEdits' });
  const externalOutput = path.join(outside, 'draft.txt');
  const externalStart = socket.events.length;
  nextTool = { name: 'write', arguments: JSON.stringify({ filePath: externalOutput, content: 'Requested external draft' }) };
  await runPanelTurn(false, `Create ${externalOutput} with the requested draft.`);
  assert.equal(fs.readFileSync(externalOutput, 'utf8'), 'Requested external draft');
  assert.ok(socket.events.slice(externalStart).some(event => event.t === 'permission'), 'Edit must ask for external native writes');
  nextTool = { name: 'edit', arguments: JSON.stringify({ filePath: externalOutput, oldString: 'Requested', newString: 'Revised' }) };
  await runPanelTurn(false, `Revise ${externalOutput}.`);
  assert.equal(fs.readFileSync(externalOutput, 'utf8'), 'Revised external draft');
  allowPermission = false;
  nextTool = { name: 'write', arguments: JSON.stringify({ filePath: externalOutput, content: 'Rejected overwrite' }) };
  await runPanelTurn(false, `Overwrite ${externalOutput}.`);
  assert.equal(fs.readFileSync(externalOutput, 'utf8'), 'Revised external draft', 'rejection must preserve the external file');
  allowPermission = true;
  socket.request({ t: 'set-mode', mode: 'plan' });
  nextTool = { name: 'write', arguments: JSON.stringify({ filePath: externalOutput, content: 'Plan overwrite' }) };
  await runPanelTurn(false, `Discuss changes to ${externalOutput}.`);
  assert.equal(fs.readFileSync(externalOutput, 'utf8'), 'Revised external draft', 'Plan must still refuse native writes');

  socket.request({ t: 'set-mode', mode: 'acceptEdits' });
  stage = 'empty response recovery';
  const recoveryStart = socket.events.length;
  const callsBeforeRecovery = gatewayRequests.length;
  nextTool = { name: 'stashbase_write_file', arguments: JSON.stringify({ path: modeFile, content: 'Saved before empty response' }) };
  emptyAfterTool = true;
  await runPanelTurn();
  assert.equal(gatewayRequests.length - callsBeforeRecovery, 3, 'write, empty continuation, recovered continuation');
  const recoveryEvents = socket.events.slice(recoveryStart) as Array<{ t: string; delta?: string; isError?: boolean }>;
  assert.equal(recoveryEvents.filter(event => event.t === 'tool-result').length, 1, 'recovery must not execute the write again');
  assert.ok(recoveryEvents.some(event => event.t === 'text' && event.delta?.includes('probe ok')));
  assert.deepEqual(recoveryEvents.filter(event => event.t === 'turn-end'), [{ t: 'turn-end', isError: false }]);
  assert.equal(fs.readFileSync(modeFile, 'utf8'), 'Saved before empty response');

  stage = 'two empty responses';
  const failureStart = socket.events.length;
  const callsBeforeFailure = gatewayRequests.length;
  emptyResponses = 2;
  await runPanelTurn(true);
  assert.equal(gatewayRequests.length - callsBeforeFailure, 2, 'native runtime must not retry beyond the broker limit');
  const failureEvents = socket.events.slice(failureStart) as Array<{ t: string; message?: string; isError?: boolean }>;
  assert.ok(failureEvents.some(event => event.t === 'error' && event.message?.includes('empty response twice')));
  assert.deepEqual(failureEvents.filter(event => event.t === 'turn-end'), [{ t: 'turn-end', isError: true }]);
  stage = 'follow-up after failure';
  await runPanelTurn(); // The same native session remains usable after the failure.

  stage = 'hosted interruption after file write';
  const interruptedStart = socket.events.length;
  const callsBeforeInterruption = gatewayRequests.length;
  nextTool = { name: 'stashbase_write_file', arguments: JSON.stringify({ path: modeFile, content: 'Saved before interruption' }) };
  interruptionsAfterTool = 2;
  await runPanelTurn(true);
  const interruptedEvents = socket.events.slice(interruptedStart) as Array<{ t: string; message?: string; isError?: boolean }>;
  assert.equal(gatewayRequests.length - callsBeforeInterruption, 3, 'write plus exactly two failed continuation calls');
  assert.equal(interruptedEvents.filter(event => event.t === 'tool-result').length, 1, 'never replay the completed write');
  assert.equal(fs.readFileSync(modeFile, 'utf8'), 'Saved before interruption');
  assert.ok(interruptedEvents.some(event => event.t === 'error' && event.message?.includes('response was interrupted')));
  assert.ok(!interruptedEvents.some(event => event.message?.includes('Provider is overloaded')));
  assert.deepEqual(interruptedEvents.filter(event => event.t === 'turn-end'), [{ t: 'turn-end', isError: true }]);

  stage = 'hosted interruption after partial output';
  const partialStart = socket.events.length;
  const callsBeforePartial = gatewayRequests.length;
  interruptions = 1;
  partialInterruption = true;
  const partialText = socket.waitFor('text');
  const partialTurn = runPanelTurn(true);
  await partialText;
  finishPartial!();
  await partialTurn;
  const partialEvents = socket.events.slice(partialStart) as Array<{ t: string; delta?: string; message?: string; isError?: boolean }>;
  assert.equal(gatewayRequests.length - callsBeforePartial, 1, 'native runtime must not replay partial output');
  assert.ok(partialEvents.some(event => event.t === 'text' && event.delta?.includes('Partial reply retained')), JSON.stringify(partialEvents));
  assert.ok(partialEvents.some(event => event.t === 'error' && event.message?.includes('response was interrupted')));
  assert.deepEqual(partialEvents.filter(event => event.t === 'turn-end'), [{ t: 'turn-end', isError: true }]);
  await runPanelTurn();
  panel.dispose();

  const toolNames = (request: Record<string, unknown>) => (
    Array.isArray(request.tools)
      ? request.tools.flatMap((tool) => {
          const fn = tool && typeof tool === 'object' ? (tool as { function?: { name?: unknown } }).function : undefined;
          return typeof fn?.name === 'string' ? [fn.name] : [];
        })
      : []
  );
  const folderTools = toolNames(gatewayRequests[0]);
  for (const name of ['bash', 'read']) {
    assert.ok(folderTools.includes(name), `folder profile omitted ${name}`);
  }
  assert.ok(!folderTools.includes('task'), 'Default must not expose native sub-agents');
  for (const name of ['stashbase_read_file', 'stashbase_write_file']) {
    assert.ok(folderTools.includes(name), `folder profile omitted ${name}`);
  }

  // Exercise the pinned binary and its provider serializer, not an SDK mock.
  stage = 'native attachments';
  broker.beginTurn('native-smoke', '00000000-0000-4000-8000-000000000002');
  const attachmentsSession = (await client.session.create({ body: { title: 'Attachment probe' }, throwOnError: true })).data;
  const imageBytes = fs.readFileSync('build/icons/16x16.png');
  const pdfBytes = attachmentPdf();
  const attachmentPath = path.join(os.tmpdir(), 'stashbase-attachments', 'native-fixture', 'diagram.png');
  const firstAttachmentCall = gatewayRequests.length;
  await client.session.prompt({
    throwOnError: true, path: { id: attachmentsSession.id },
    body: { model: { providerID: 'stashbase', modelID: 'stashbase-agent-default' }, agent: 'stashbase-folder', parts: [
      { type: 'text', text: 'Describe the attachments.' },
      { type: 'file', mime: 'text/plain', filename: 'notes.txt', url: `data:text/plain;base64,${Buffer.from('ATTACHMENT_TEXT_OK').toString('base64')}` },
      { type: 'file', mime: 'image/png', filename: 'diagram.png', url: `data:image/png;base64,${imageBytes.toString('base64')}`,
        source: { type: 'file', path: attachmentPath, text: { value: 'diagram.png', start: 0, end: 11 } } },
      { type: 'file', mime: 'application/pdf', filename: 'report.pdf', url: `data:application/pdf;base64,${pdfBytes.toString('base64')}` },
    ] },
  });
  const firstBody = JSON.stringify(gatewayRequests[firstAttachmentCall]);
  assert.match(firstBody, /ATTACHMENT_TEXT_OK/);
  assert.match(firstBody, /image_url/);
  assert.ok(firstBody.includes(imageBytes.toString('base64')));
  assert.ok(firstBody.includes(pdfBytes.toString('base64')));
  const history = (await client.session.messages({ throwOnError: true, path: { id: attachmentsSession.id } })).data;
  const user = history.find(message => message.info.role === 'user')!;
  const replay = blocksForMessage(user.info, user.parts);
  assert.equal(replay[0]?.kind, 'user');
  assert.equal(replay[0]?.kind === 'user' && replay[0].text, 'Describe the attachments.');
  assert.equal(replay[0]?.kind === 'user' && replay[0].attachments?.[0]?.path, attachmentPath);
  stage = 'native attachment follow-up';
  await client.session.prompt({
    throwOnError: true, path: { id: attachmentsSession.id },
    body: { model: { providerID: 'stashbase', modelID: 'stashbase-agent-default' }, agent: 'stashbase-folder', parts: [{ type: 'text', text: 'Discuss the same attachments again.' }] },
  });
  const followUp = JSON.stringify(gatewayRequests.at(-1));
  assert.match(followUp, /ATTACHMENT_TEXT_OK/);
  assert.ok(followUp.includes(imageBytes.toString('base64')), 'the next model request retains image content');
  assert.ok(followUp.includes(pdfBytes.toString('base64')), 'the next model request retains PDF content');

  stage = 'fresh media refusal stops without lossy recovery';
  const mediaTranslator = new OpenCodeEventTranslator();
  mediaTranslator.bindSession(attachmentsSession.id);
  const mediaSubscription = await client.event.subscribe({ signal: subscriptions.signal, sseMaxRetryAttempts: 1 });
  const mediaEvents: ReturnType<OpenCodeEventTranslator['translate']> = [];
  const mediaConsumed = (async () => {
    for await (const event of mediaSubscription.stream) {
      mediaEvents.push(...mediaTranslator.translate(event));
      if (event.type === 'session.idle' && event.properties.sessionID === attachmentsSession.id) return;
    }
  })();
  const beforeMediaRefusal = gatewayRequests.length;
  contextRefusals = 1;
  await client.session.prompt({
    throwOnError: true, path: { id: attachmentsSession.id },
    body: { model: { providerID: 'stashbase', modelID: 'stashbase-agent-default' }, agent: 'stashbase-folder', parts: [
      { type: 'text', text: 'Read the exact text in the newly attached image and PDF.' },
      { type: 'file', mime: 'image/png', filename: 'unread-new-image.png', url: `data:image/png;base64,${imageBytes.toString('base64')}` },
      { type: 'file', mime: 'application/pdf', filename: 'unread-new.pdf', url: `data:application/pdf;base64,${pdfBytes.toString('base64')}` },
    ] },
  });
  await mediaConsumed;
  assert.equal(gatewayRequests.length - beforeMediaRefusal, 1, 'no summary or continuation may drop unread media');
  assert.ok(mediaEvents.some(event => event.t === 'error' && event.message.includes('new chat')), JSON.stringify(mediaEvents));
  assert.deepEqual(mediaEvents.filter(event => event.t === 'turn-end'), [{ t: 'turn-end', isError: true }], 'the queue must pause');
  const refusedHistory = (await client.session.messages({ throwOnError: true, path: { id: attachmentsSession.id } })).data;
  assert.ok(!refusedHistory.some(message => message.info.role === 'assistant' && message.info.summary));
  assert.ok(refusedHistory.some(message => message.parts.some(part => part.type === 'file' && part.filename === 'unread-new-image.png' && part.url.includes(imageBytes.toString('base64')))));
  assert.ok(refusedHistory.some(message => message.parts.some(part => part.type === 'file' && part.filename === 'unread-new.pdf' && part.url.includes(pdfBytes.toString('base64')))));
  // A deliberate retry in the same session still carries original bytes.
  await client.session.prompt({
    throwOnError: true, path: { id: attachmentsSession.id },
    body: { model: { providerID: 'stashbase', modelID: 'stashbase-agent-default' }, agent: 'stashbase-folder',
      parts: [{ type: 'text', text: 'Try reading those files again.' }] },
  });
  assert.ok(JSON.stringify(gatewayRequests.at(-1)).includes(imageBytes.toString('base64')));
  assert.ok(JSON.stringify(gatewayRequests.at(-1)).includes(pdfBytes.toString('base64')));

  stage = 'text-only context overflow recovery';
  const textRecoverySession = (await client.session.create({ body: { title: 'Text recovery probe' }, throwOnError: true })).data;
  await client.session.prompt({
    throwOnError: true, path: { id: textRecoverySession.id },
    body: { model: { providerID: 'stashbase', modelID: 'stashbase-agent-default' }, agent: 'stashbase-folder',
      parts: [{ type: 'text', text: 'PRIOR_TEXT_CONTEXT: We are revising a paper about birds.' }] },
  });
  const overflowTranslator = new OpenCodeEventTranslator();
  overflowTranslator.bindSession(textRecoverySession.id);
  const overflowSubscription = await client.event.subscribe({ signal: subscriptions.signal, sseMaxRetryAttempts: 1 });
  const translatedOverflow: ReturnType<OpenCodeEventTranslator['translate']> = [];
  const overflowConsumed = (async () => {
    for await (const event of overflowSubscription.stream) {
      translatedOverflow.push(...overflowTranslator.translate(event));
      if (event.type === 'session.idle' && event.properties.sessionID === textRecoverySession.id) return;
    }
  })();
  const firstOverflowCall = gatewayRequests.length;
  contextRefusals = 1;
  await client.session.prompt({
    throwOnError: true, path: { id: textRecoverySession.id },
    body: { model: { providerID: 'stashbase', modelID: 'stashbase-agent-default' }, agent: 'stashbase-folder',
      parts: [{ type: 'text', text: 'Continue after the context refusal.' }] },
  });
  await overflowConsumed;
  assert.ok(!translatedOverflow.some(event => event.t === 'error'), 'recoverable overflow must not fail the panel turn');
  assert.deepEqual(translatedOverflow.filter(event => event.t === 'turn-end'), [{ t: 'turn-end', isError: false }]);
  const recoveryCalls = gatewayRequests.slice(firstOverflowCall);
  assert.equal(recoveryCalls.length, 3, 'one refused request, one summary, one continuation');
  assert.match(JSON.stringify(recoveryCalls[1]), /PRIOR_TEXT_CONTEXT/, 'the summary receives prior text');
  assert.match(JSON.stringify(recoveryCalls[2]), /Continue after the context refusal/, 'continuation retains the current task');
  const recoveredHistory = (await client.session.messages({ throwOnError: true, path: { id: textRecoverySession.id } })).data;
  assert.ok(recoveredHistory.some(message => message.info.role === 'assistant' && message.info.summary && !message.info.error));
  const recoveredAssistant = recoveredHistory.at(-1)?.info;
  assert.equal(recoveredAssistant?.role === 'assistant' && recoveredAssistant.error, undefined);
  assert.deepEqual(gatewayModels.slice(firstOverflowCall), Array(3).fill(gatewayModels[firstOverflowCall]));

  stage = 'repeated context overflow stops safely';
  const beforeRepeated = gatewayRequests.length;
  contextRefusals = 2;
  await client.session.prompt({
    throwOnError: true, path: { id: textRecoverySession.id },
    body: { model: { providerID: 'stashbase', modelID: 'stashbase-agent-default' }, agent: 'stashbase-folder',
      parts: [{ type: 'text', text: 'Exercise a refusal during compaction too.' }] },
  });
  assert.equal(gatewayRequests.length - beforeRepeated, 2, 'failed compaction must stop instead of replaying forever');
  const failedHistory = (await client.session.messages({ throwOnError: true, path: { id: textRecoverySession.id } })).data;
  assert.ok(failedHistory.some(message => message.info.role === 'assistant' && message.info.summary && message.info.error),
    'failed compaction remains visible in native history');

  stage = 'project skill invocation';
  nextTool = { name: 'skill', arguments: JSON.stringify({ name: 'project-writing-0' }) };
  const skillSession = (await client.session.create({ body: { title: 'Project skill probe' }, throwOnError: true })).data;
  const firstSkillCall = gatewayRequests.length;
  // A direct SDK turn must answer native permissions as the panel does.
  const skillSubscription = await client.event.subscribe({ signal: subscriptions.signal, sseMaxRetryAttempts: 1 });
  const skillTranslator = new OpenCodeEventTranslator();
  skillTranslator.bindSession(skillSession.id);
  const skillConsumed = (async () => {
    for await (const event of skillSubscription.stream) {
      skillEvents.push(event.type);
      for (const translated of skillTranslator.translate(event)) {
        if (translated.t !== 'permission') continue;
        await client.postSessionIdPermissionsPermissionId({
          throwOnError: true,
          path: { id: skillSession.id, permissionID: translated.id },
          body: { response: 'once' },
        });
      }
      if (event.type === 'session.idle' && event.properties.sessionID === skillSession.id) return;
    }
  })();
  await client.session.promptAsync({
    throwOnError: true, path: { id: skillSession.id },
    body: { model: { providerID: 'stashbase', modelID: 'stashbase-agent-default' }, agent: 'stashbase-folder',
      parts: [{ type: 'text', text: 'Use the project writing skill.' }] },
  });
  await skillConsumed;
  assert.ok(JSON.stringify(gatewayRequests.slice(firstSkillCall + 1)).includes('PROJECT_SKILL_BODY_0'),
    'project skill contents must load on native invocation');

  // Hosted Claude models refuse a forced tool choice, so every model call the
  // pinned runtime makes, tool continuations included, must leave it open.
  const forced = gatewayRequests.map((body) => body.tool_choice)
    .filter((choice) => choice !== undefined && choice !== 'auto' && choice !== 'none');
  assert.deepEqual(forced, [], `OpenCode forced a tool choice: ${JSON.stringify(forced)}`);
  assert.ok(gatewayRequests.some((body) => Array.isArray(body.tools) && body.tools.length > 0));

  // A hardened-runtime signing mismatch can let Bun finish the request and
  // then have AMFI kill it while it returns to executable memory. Do not let
  // teardown hide that packaged-only failure as a successful smoke.
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  assert.equal(child.exitCode, null, `OpenCode exited unexpectedly (${child.exitCode ?? child.signalCode})`);
  assert.equal(child.signalCode, null, `OpenCode exited unexpectedly (${child.signalCode})`);
  completed = true;
});

test('prewarmed native chats retain attribution, refresh configuration and release late-closing runtimes', { timeout: 45_000 }, async (t) => {
  const starts: Extract<TelemetryEvent, { event: 'agent_runtime_start_result' }>[] = [];
  const stops: Extract<TelemetryEvent, { event: 'agent_runtime_stop_result' }>[] = [];
  t.mock.method(telemetry, 'scoped', () => (input: TelemetryEvent) => {
    const event = telemetryEventSchema.parse(input);
    if (event.event === 'agent_runtime_start_result') starts.push(event);
    if (event.event === 'agent_runtime_stop_result') stops.push(event);
  });
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-warm-native-')));
  setHostedAccountSession({
    userId: 'warm-fixture', email: 'fixture@example.invalid', accessToken: 'fixture-only', sessionToken: 'fixture-only',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  let profiles = SMOKE_PROFILES.map(profile => ({ ...profile,
    id: profile.isDefault ? profile.id : 'claude-sonnet-5-5',
  }));
  let reads = 0;
  const toolCatalog = parseToolCatalog({
    schemaVersion: 2,
    revision: 'smoke',
    models: [{ id: 'claude-sonnet-5-5', version: 1, name: 'Claude Sonnet 5.5', relativeCost: 2.7, contextTokenLimit: 200_000,
      outputTokenLimit: 64_000, availability: { status: 'available' } }],
    tools: [{ id: 'writer', kind: 'agent-role', version: 1, name: 'Writer', summary: 'Drafts', icon: 'pen-line',
      availability: { status: 'available' }, modelIds: ['claude-sonnet-5-5'], defaultModelId: 'claude-sonnet-5-5',
      agent: { toolName: 'write_draft', description: 'Writes the draft.' } }],
  });
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/v1/agent/models') {
      reads++;
      return Response.json({ models: profiles });
    }
    if (url.pathname === '/v2/agent/tools') {
      return Response.json({ schemaVersion: 2, revision: toolCatalog.revision, models: toolCatalog.models,
        tools: toolCatalog.tools.map(tool => ({ ...tool, kind: 'agent-role' })) });
    }
    assert.equal(url.hostname, '127.0.0.1', 'startup must not make model or other external requests');
    return originalFetch(input, init);
  });
  t.after(async () => {
    await stopOpenCodeRuntime();
    setHostedAccountSession(undefined);
    setDefaultAgentTool(toolCatalog, 'writer', { enabled: false });
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const context = { windowId: 'warm-window', directory: root, persona: undefined };
  const first = createOpenCodeSessionRuntime(context);
  const firstClient = await first.client(root);
  assert.equal((await firstClient.mcp.status({ throwOnError: true })).data.stashbase?.status, 'connected');
  const firstSession = (await firstClient.session.create({ body: { title: 'First chat' }, throwOnError: true })).data;
  first.endTurn();
  await new Promise<void>(resolve => setImmediate(resolve));

  const second = createOpenCodeSessionRuntime(context);
  const secondClient = await second.client(root);
  assert.notEqual(first.attributionId, second.attributionId);
  const config = (await secondClient.config.get({ throwOnError: true })).data;
  const mcp = config.mcp!.stashbase as { environment: Record<string, string> };
  assert.equal(mcp.environment.STASHBASE_AGENT_SESSION_ID, second.attributionId);
  assert.equal((await secondClient.session.list({ throwOnError: true })).data.length, 1, 'warming must not create blank history');
  const secondSession = (await secondClient.session.create({ body: { title: 'Second chat' }, throwOnError: true })).data;
  assert.notEqual(firstSession.id, secondSession.id);
  await first.close();
  assert.equal((await secondClient.session.get({ path: { id: secondSession.id }, throwOnError: true })).data.title, 'Second chat');
  second.endTurn();
  await new Promise<void>(resolve => setImmediate(resolve));

  // A saved choice made after warm-up must reach the new chat even when
  // the service's profiles themselves did not change.
  setDefaultAgentTool(toolCatalog, 'writer', { enabled: true });
  const third = createOpenCodeSessionRuntime(context);
  const thirdClient = await third.client(root);
  const thirdConfig = (await thirdClient.config.get({ throwOnError: true })).data;
  assert.deepEqual(JSON.parse((thirdConfig.mcp!.stashbase as typeof mcp).environment.STASHBASE_AGENT_TOOLS!).map((tool: { id: string }) => tool.id), ['writer']);
  third.endTurn();
  await new Promise<void>(resolve => setImmediate(resolve));

  profiles = profiles.map(profile => ({ ...profile, version: profile.version + 1, outputTokenLimit: 4096 }));
  const fourth = createOpenCodeSessionRuntime(context);
  const fourthClient = await fourth.client(root);
  const fourthConfig = (await fourthClient.config.get({ throwOnError: true })).data;
  assert.equal(fourthConfig.provider!.stashbase!.models!['stashbase-agent-default']!.limit!.output, 4096);
  assert.equal(reads, 4, 'a new chat must revalidate the service catalog before using a spare');
  await assert.rejects(fourth.client(path.dirname(root)), /another project/);
  // Drive the production history owner through a real native startup timeout
  // and successful retry. Readiness and retirement must have separate timings.
  const beforeRetry = starts.length;
  const timeout = globalThis.setTimeout;
  let forceTimeout = true;
  const forced = t.mock.method(globalThis, 'setTimeout', (fn: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    if (ms === 15_000 && forceTimeout) { forceTimeout = false; return timeout(fn, 1, ...args); }
    return timeout(fn, ms, ...args);
  });
  try {
    const [historyA, historyB] = await Promise.all([openCodeClient(root, true), openCodeClient(root, true)]);
    await historyA.session.list({ throwOnError: true });
    await historyB.session.list({ throwOnError: true });
    const attempts = starts.slice(beforeRetry);
    assert.deepEqual(attempts.map(event => event.outcome), ['failed', 'success'],
      'concurrent history readers share the failed startup and its one retry');
    assert.equal(attempts[1].retry_of, attempts[0].attempt_id);
    assert.equal(attempts[0].diagnostic?.code, 'OPENCODE_START_TIMEOUT');
    const measured = attempts[0].timings!;
    for (const phase of ['prepare_ms', 'spawn_ms', 'ready_wait_ms', 'cleanup_ms'] as const) {
      assert.ok(measured[phase] !== undefined, `failed startup omitted ${phase}`);
    }
    assert.ok(Object.values(measured).reduce((sum, value) => sum + value, 0) <= attempts[0].elapsed_ms + 3);
    assert.equal(attempts[1].timings?.cleanup_ms, undefined);
  } finally { forced.mock.restore(); }
  assert.equal(starts.at(-1)?.purpose, 'history');
  assert.ok(starts.some(event => event.purpose === 'chat' && event.outcome === 'success'));
  assert.ok(starts.some(event => event.purpose === 'prewarm' && event.outcome === 'success'));
  for (const event of starts.filter(event => event.outcome === 'success')) {
    assert.equal(event.stage, 'ready');
    assert.equal(event.context?.runtime_version, BUNDLED_OPENCODE_VERSION);
    assert.equal(event.context?.process_start_id, event.attempt_id);
    assert.ok(event.first_output_ms !== undefined && event.first_output_ms <= event.elapsed_ms);
    assert.ok(event.timings?.prepare_ms !== undefined);
    assert.ok(event.timings.spawn_ms !== undefined);
    assert.ok(event.timings.ready_wait_ms !== undefined);
    assert.equal(event.timings.cleanup_ms, undefined, 'successful starts have no failure retirement');
    assert.ok(event.first_output_ms >= event.timings.prepare_ms + event.timings.spawn_ms - 2,
      'first output includes preparation and spawn, not just native readiness');
  }
  assert.equal(new Set(starts.map(event => event.attempt_id)).size, starts.length);
  await second.close();
  await third.close();
  // Hold one real runtime's final notification, without preventing its OS exit.
  // A later shutdown must stop other owners and eventually forget this failure.
  const emit = EventEmitter.prototype.emit;
  let releaseClose: (() => void) | undefined;
  let released = false;
  const held = t.mock.method(ChildProcess.prototype, 'emit', function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (event === 'close' && !releaseClose && this.spawnargs.includes('serve')) {
      releaseClose = () => { if (!released) { released = true; emit.call(this, event, ...args); } };
      return true;
    }
    return emit.call(this, event, ...args);
  });
  try {
    const closing = fourth.close();
    await assert.rejects(closing, { code: 'AGENT_PROCESS_CLOSE_TIMEOUT' });
    await assert.rejects(stopOpenCodeRuntime(), { code: 'AGENT_PROCESS_CLOSE_TIMEOUT' });
    assert.ok(releaseClose);
    releaseClose();
    await new Promise<void>(resolve => setImmediate(resolve));
    await stopOpenCodeRuntime();
    await assert.rejects(closing, { code: 'AGENT_PROCESS_CLOSE_TIMEOUT' });
    const failure = stops.find(event => event.outcome === 'timeout');
    assert.ok(failure);
    assert.ok(starts.some(event => event.attempt_id === failure.context?.process_start_id));
    assert.deepEqual(stops.filter(event => event.attempt_id === failure.attempt_id).map(event => event.outcome),
      ['timeout', 'closed_after_timeout']);
  } finally { held.mock.restore(); releaseClose?.(); }
});
