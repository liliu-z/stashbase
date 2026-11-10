import './isolated-home.ts';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { antigravityAuthState, antigravityIsAuthenticated, loginToAntigravity } from '../antigravity-setup.ts';
import { AgentAccountRefusedError } from '../agent-setup-diagnostic.ts';
import { AgentBootstrapCoordinator, verifyAgentExecutable } from '../agent-runtime-installer.ts';
import { antigravityCurrentModel, antigravityModelsFromListing, withCurrentModel } from '../antigravity-model-catalog.ts';
import { antigravityErrorFromStderr, isReadOnlyCommand, parseAntigravityLine } from '../antigravity-protocol.ts';
import { antigravityHookLauncher, ensureAgentMcp } from '../agent-mcp.ts';

const geminiConfigurationFailure = 'modelProvider is set to "gemini" in settings.json, but the GEMINI_API_KEY environment variable is not set. Set GEMINI_API_KEY to your Gemini API key, or remove "modelProvider" from settings.json to use the default backend.';

test('an explicit Antigravity backend configuration failure rechecks without opening sign-in', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-agy configuration '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repaired = path.join(root, 'repaired');
  const script = path.join(root, 'probe.cjs');
  fs.writeFileSync(script, `const fs = require('node:fs');
if (process.argv.includes('--version')) console.log('1.4.0');
else if (fs.existsSync(${JSON.stringify(repaired)})) console.log('{"status":"SUCCESS"}');
else { console.error(${JSON.stringify(geminiConfigurationFailure)}); process.exit(1); }
`);
  const executable = path.join(root, process.platform === 'win32' ? 'agy.cmd' : 'agy');
  fs.writeFileSync(executable, process.platform === 'win32'
    ? `@"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 });
  let terminals = 0;
  let browsers = 0;
  let configured = 0;
  const coordinator = new AgentBootstrapCoordinator({
    resolveExecutable: () => executable,
    resolveNativeExecutable: () => executable,
    installRuntime: async () => { throw new Error('Configuration recovery must not reinstall a working CLI.'); },
    verifyExecutable: (_id, selected, signal) => verifyAgentExecutable(selected, 'Antigravity', process.env, 1000, signal),
    isAuthenticated: (_id, selected, signal) => antigravityIsAuthenticated(selected, signal),
    login: (_id, selected, signal) => loginToAntigravity(selected, signal, {
      spawnSignIn: () => { terminals++; throw new Error('Configuration repair cannot start sign-in.'); },
    }, { onBrowserSignIn: () => { browsers++; } }),
    configureMcp: () => { configured++; },
    consumeFailure: () => false,
  });
  coordinator.connectIfInstalled('antigravity');
  const failure = (await coordinator.wait('antigravity')).failure;
  assert.equal(failure?.code, 'authentication-check-failed');
  assert.equal(failure?.retryAction, 'bootstrap');
  assert.match(failure?.message ?? '', /settings\.json/);
  assert.match(failure?.message ?? '', /default backend/i);
  assert.ok(failure?.message.includes(`Remove "modelProvider" from ${path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json')}`));
  assert.doesNotMatch(failure?.message ?? '', /GEMINI_API_KEY/);
  coordinator.login('antigravity');
  const login = await coordinator.wait('antigravity');
  assert.equal(login.failure?.code, 'authentication-check-failed');
  assert.equal(login.failure?.retryAction, 'bootstrap');
  assert.equal(terminals, 0);
  assert.equal(browsers, 0);
  assert.equal(configured, 0);
  fs.writeFileSync(repaired, '');
  coordinator.begin('antigravity');
  assert.equal((await coordinator.wait('antigravity')).phase, 'ready');
  assert.equal(configured, 1);
});

test('the sign-in check tells signed out, refused, and unknown apart', () => {
  for (const result of [
    { status: 1, stdout: '', stderr: geminiConfigurationFailure },
    { status: 0, stdout: JSON.stringify({ status: 'ERROR', error: geminiConfigurationFailure }), stderr: '' },
  ]) assert.equal(antigravityAuthState(result).state, 'configuration-error');
  assert.deepEqual(antigravityAuthState({ status: 0, stdout: '{"status":"SUCCESS","command":{"name":"usage"}}', stderr: '' }), { state: 'signed-in' });
  assert.deepEqual(antigravityAuthState({ status: 1, stdout: '', stderr: 'error: authentication required' }), { state: 'signed-out' });
  assert.deepEqual(antigravityAuthState({ status: 0, stdout: '{"status":"ERROR","error":"Not signed in"}', stderr: '' }), { state: 'signed-out' });
  assert.deepEqual(antigravityAuthState({ status: 3, stdout: '', stderr: 'AGY_ERROR: {"short_error":"deadline exceeded"}' }), { state: 'unknown' });
  assert.deepEqual(antigravityAuthState({ status: 0, stdout: '{"status":"ERROR","error":"backend unavailable"}', stderr: '' }), { state: 'unknown' });
  // Recorded from agy 1.4.0 for a signed-in account outside the available regions.
  const refusal = 'Your current account is not eligible for Gemini Code Assist for individuals because it is not currently available in your location.';
  const chain = `/usage failed: retrieving quota summary: failed to retrieve user quota summary: PERMISSION_DENIED (code 403): ${refusal}`;
  assert.deepEqual(antigravityAuthState({
    status: 1,
    stdout: JSON.stringify({ conversation_id: '', status: 'ERROR', response: '', error: chain }),
    stderr: `error: ${chain}`,
  }), { state: 'refused', reason: refusal });
});

test('a refused account fails setup as refused, not as a failed sign-in check', async () => {
  const coordinator = new AgentBootstrapCoordinator({
    resolveExecutable: () => '/native/agy',
    resolveNativeExecutable: () => '/native/agy',
    installRuntime: async () => {},
    verifyExecutable: async () => {},
    isAuthenticated: () => { throw new AgentAccountRefusedError('Antigravity is signed in, but Google refused this account: not available in your location.'); },
    login: async () => {},
    configureMcp: () => {},
    consumeFailure: () => false,
  });
  coordinator.begin('antigravity');
  const status = await coordinator.wait('antigravity');
  assert.equal(status.failure?.stage, 'authentication');
  assert.equal(status.failure?.code, 'account-refused');
  assert.match(status.failure?.message ?? '', /Google refused this account: not available in your location\./);
});

test('sign-in reuses the selected CLI account without starting an interactive login', async () => {
  const signal = new AbortController().signal;
  await loginToAntigravity('/native/agy', signal, {
    isAuthenticated: async (executable, receivedSignal) => {
      assert.equal(executable, '/native/agy');
      assert.equal(receivedSignal, signal);
      return true;
    },
    spawnSignIn: () => { throw new Error('An existing sign-in must not open another login.'); },
  }, {
    onBrowserSignIn: () => { throw new Error('An existing sign-in must not ask for the browser.'); },
  });
});

test('a refused account does not start an interactive login', async () => {
  const error = new AgentAccountRefusedError('refused');
  await assert.rejects(loginToAntigravity('/native/agy', new AbortController().signal, {
    isAuthenticated: async () => { throw error; },
    spawnSignIn: () => { throw new Error('A refused account must not start login.'); },
  }), (received) => received === error);
});

// A signed-out answer in words the check does not read must still leave a way
// to sign in: Settings offers sign-in as the retry, and the sign-in opens.
test('a check that cannot answer offers sign-in, and the production terminal opens and finishes it', { skip: process.platform === 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-agy 新用户 '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'agy');
  const marker = path.join(root, 'signed-in');
  fs.writeFileSync(executable, `#!/bin/sh
test -t 0 && test -t 1 || exit 42
echo $$ > '${marker}'
while :; do sleep 1; done
`, { mode: 0o755 });
  let checks = 0;
  const check = async () => {
    checks += 1;
    if (fs.existsSync(marker)) return true;
    throw new Error('Could not check Antigravity sign-in using /native/agy (exit 1: Login required).');
  };
  const coordinator = new AgentBootstrapCoordinator({
    resolveExecutable: () => executable,
    resolveNativeExecutable: () => executable,
    installRuntime: async () => { throw new Error('A copy that runs must not be reinstalled.'); },
    verifyExecutable: async () => {},
    isAuthenticated: check,
    login: (_id, executable, signal, options) => loginToAntigravity(executable, signal, {
      pollMs: 20,
      timeoutMs: 5000,
      isAuthenticated: check,
    }, { onBrowserSignIn: options.onBrowserSignIn }),
    configureMcp: () => {},
    consumeFailure: () => false,
  });
  coordinator.connectIfInstalled('antigravity');
  const failed = await coordinator.wait('antigravity');
  assert.equal(failed.failure?.code, 'authentication-check-failed');
  assert.equal(failed.failure?.retryAction, 'login');
  coordinator.login('antigravity');
  assert.equal((await coordinator.wait('antigravity')).phase, 'ready');
  const pid = Number(fs.readFileSync(marker, 'utf8').trim());
  assert.ok(pid > 0, 'the sign-in ran with a terminal for input and output');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the login process was retired');
  assert.ok(checks >= 3);
});

test('cancelling the initial check neither starts login nor reports successful sign-in', async () => {
  for (const signedIn of [false, true]) {
    const cancel = new AbortController();
    const reason = new Error('cancelled during the initial check');
    await assert.rejects(loginToAntigravity('/native/agy', cancel.signal, {
      isAuthenticated: async () => { cancel.abort(reason); return signedIn; },
      spawnSignIn: () => { throw new Error('A cancelled sign-in must not start login.'); },
    }), (received) => received === reason);
  }
});

test('sign-in keeps the interactive run until the check passes, then retires it', { skip: process.platform === 'win32' }, async () => {
  let child: ReturnType<typeof spawn> | undefined;
  let checks = 0;
  let browserAt: number | undefined;
  await loginToAntigravity('/unused/agy', new AbortController().signal, {
    pollMs: 5,
    spawnSignIn: () => (child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })),
    isAuthenticated: async () => ++checks >= 3,
  }, { onBrowserSignIn: () => { browserAt = checks; } });
  assert.equal(checks, 3);
  assert.equal(browserAt, 1, 'the browser is asked for once the first check finds no sign-in');
  assert.ok(child!.exitCode !== null || child!.signalCode !== null, 'the interactive run is retired once signed in');

  let refusalChecks = 0;
  await assert.rejects(loginToAntigravity('/unused/agy', new AbortController().signal, {
    pollMs: 5,
    timeoutMs: 60_000,
    spawnSignIn: () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] }),
    isAuthenticated: async () => {
      if (++refusalChecks === 1) return false;
      throw new AgentAccountRefusedError('refused');
    },
  }), AgentAccountRefusedError, 'a refused account ends sign-in at once');

  await assert.rejects(loginToAntigravity('/unused/agy', new AbortController().signal, {
    pollMs: 20,
    spawnSignIn: () => spawn(process.execPath, ['-e', 'console.log("Sign-in window closed"); process.exit(1)'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] }),
    isAuthenticated: async () => false,
  }), /closed before sign-in finished\. Sign-in window closed/);

  const cancel = new AbortController();
  const cancelled = loginToAntigravity('/unused/agy', cancel.signal, {
    pollMs: 5,
    spawnSignIn: () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] }),
    isAuthenticated: async () => false,
  });
  setTimeout(() => cancel.abort(), 30);
  await assert.rejects(cancelled, /cancelled/);
});

test('model variants that differ only by effort become one model with those efforts', () => {
  const listing = JSON.stringify({
    status: 'SUCCESS',
    command: { name: 'models', data: { models: [
      { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { id: 'gemini-4-pro', label: 'Gemini 4 Pro', default: true },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'tiny-max', label: 'Tiny Max' },
    ] } },
  });
  assert.deepEqual(antigravityModelsFromListing(listing), {
    models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', supportedEfforts: ['low', 'high'] },
      { id: 'gemini-4-pro', label: 'Gemini 4 Pro', isDefault: true },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'tiny-max', label: 'Tiny Max' },
    ],
    defaultModel: 'gemini-4-pro',
  });
  assert.deepEqual(antigravityModelsFromListing('not json').models, []);
});

test('Auto runs a command unasked only when the line itself shows it only reads', () => {
  for (const command of ['ls -la', 'git log --oneline -5', 'grep -rn TODO .', 'cat notes.md | head -20', 'find . -name "*.md"']) {
    assert.equal(isReadOnlyCommand(command), true, command);
  }
  for (const command of ['rm -rf drafts', 'ls; rm x', 'ls && pwd', 'ls > out.txt', 'echo $(whoami)', 'find . -delete',
    'git push', 'git -C . status', 'sort -o x y', 'rg --pre=sh x', 'npm install', 'python script.py', '']) {
    assert.equal(isReadOnlyCommand(command), false, command);
  }
});

test('the model agy runs unchosen is the catalog default, with its effort', () => {
  // Recorded from agy 1.4.0: `--output-format json models` and `-p /model`.
  const listing = antigravityModelsFromListing(JSON.stringify({ status: 'SUCCESS', command: { name: 'models', data: { models: [
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
  ] } } }));
  assert.equal(listing.defaultModel, undefined, 'the listing alone names no default');
  const current = antigravityCurrentModel('{"status":"SUCCESS","command":{"name":"model","data":{"id":"gemini-3.8-flash-high","label":"Gemini 3.8 Flash (High)","effort":"high","is_default":false}}}');
  assert.deepEqual(current, { id: 'gemini-3.8-flash-high', effort: 'high' });
  const reading = withCurrentModel(listing, current);
  assert.equal(reading.defaultModel, 'gemini-3.8-flash');
  assert.deepEqual(reading.models[0], {
    id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', supportedEfforts: ['low', 'medium', 'high'], isDefault: true, defaultEffort: 'high',
  });
  assert.equal(reading.models.filter((model) => model.isDefault).length, 1);
  assert.deepEqual(withCurrentModel(listing, { id: 'retired-model' }), listing, 'an unlisted current model is not invented');
  assert.deepEqual(withCurrentModel(listing, null), listing);
});

test('stream-json events read in their nested and flat forms, and failures carry the CLI\'s own words', () => {
  assert.deepEqual(parseAntigravityLine('{"event":"step_update","conversation_id":"c","step_index":2,"state":"DONE","step_type":"TOOL","tool_name":"view_file","tool_info":{"parameters":"{\\"AbsolutePath\\":\\"/a\\"}","output":"text"}}'), {
    kind: 'step', conversationId: 'c', index: 2, state: 'done', type: 'tool', textDelta: '',
    tool: { name: 'view_file', parameters: { AbsolutePath: '/a' }, output: 'text', error: '' },
  });
  assert.deepEqual(parseAntigravityLine('{"event":"result","result":{"status":"error","error":{"message":"bad model"},"denied_actions":[{"action":"command","display_name":"Run rm"}]}}'), {
    kind: 'result', conversationId: '', status: 'ERROR', response: '', error: 'bad model', deniedActions: ['Run rm'],
  });
  assert.equal(parseAntigravityLine('jetski: no output produced'), null);
  // Recorded from agy 1.4.0: a refused tool ends in ERROR, not DONE.
  const failed = parseAntigravityLine(JSON.stringify({ event: 'step_update', step_update: {
    conversation_id: 'c', step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'call_mcp_tool',
    tool_info: { name: 'call_mcp_tool', parameters: { Arguments: {}, ServerName: 'stashbase', ToolName: 'list_projects' }, error: { type: 'TOOL_ERROR', message: 'permission check failed' } },
  } }));
  assert.equal(failed?.kind === 'step' && failed.state, 'done');
  assert.equal(failed?.kind === 'step' && failed.tool?.error, 'permission check failed');
  assert.equal(antigravityErrorFromStderr('noise\nAGY_ERROR: {"short_error":"429 rate limited","retryable":true}\n'), '429 rate limited');
  assert.equal(antigravityErrorFromStderr('error: unknown model "x"'), 'unknown model "x"');
});

test('Antigravity setup adds StashBase beside the reader\'s own MCP servers and hooks, and refuses a broken file', () => {
  const config = path.join(os.homedir(), '.gemini', 'config');
  fs.mkdirSync(config, { recursive: true });
  const mcp = path.join(config, 'mcp_config.json');
  const hooks = path.join(config, 'hooks.json');
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { linter: { command: 'lint-mcp' }, stashbase: { command: 'old' } } }));
  const ownHook = { PreToolUse: [{ matcher: 'run_command', hooks: [{ command: '/my/guard' }] }] };
  fs.writeFileSync(hooks, JSON.stringify({ guard: ownHook }));
  ensureAgentMcp('antigravity');
  const servers = JSON.parse(fs.readFileSync(mcp, 'utf8')).mcpServers;
  assert.deepEqual(servers.linter, { command: 'lint-mcp' });
  assert.match(servers.stashbase.command, /stashbase-mcp/);
  const written = JSON.parse(fs.readFileSync(hooks, 'utf8'));
  assert.deepEqual(written.guard, ownHook);
  const [entry] = written.stashbase.PreToolUse;
  assert.equal(entry.matcher, '*');
  assert.match(entry.hooks[0].command, /stashbase-antigravity-hook/);
  assert.ok(fs.existsSync(entry.hooks[0].command), 'the hook launcher exists');
  if (process.platform !== 'win32') {
    assert.ok(fs.statSync(entry.hooks[0].command).mode & 0o100, 'the hook launcher is executable');
  }

  fs.writeFileSync(hooks, '{ "guard": ');
  assert.throws(() => ensureAgentMcp('antigravity'), /leaving it untouched/);
  assert.equal(fs.readFileSync(hooks, 'utf8'), '{ "guard": ');

  // An empty file left by an earlier install holds nothing to keep; a BOM is not content.
  fs.writeFileSync(mcp, '');
  fs.writeFileSync(hooks, '\uFEFF{"guard":' + JSON.stringify(ownHook) + '}');
  ensureAgentMcp('antigravity');
  assert.match(JSON.parse(fs.readFileSync(mcp, 'utf8')).mcpServers.stashbase.command, /stashbase-mcp/);
  assert.deepEqual(JSON.parse(fs.readFileSync(hooks, 'utf8')).guard, ownHook);
  fs.rmSync(config, { recursive: true, force: true });
});

test('the hook launcher is neutral outside StashBase, asks the host inside, and denies when the host is gone', { skip: process.platform === 'win32' }, async (t) => {
  const received: Array<{ session: string | undefined; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ session: req.headers['x-stashbase-agent-session-id'] as string | undefined, body });
      res.setHeader('content-type', 'application/json');
      res.end('{"decision":"deny","reason":"declined"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-agy-hook-'));
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const launcher = path.join(root, 'hook');
  fs.writeFileSync(launcher, antigravityHookLauncher(port, process.platform), { mode: 0o755 });
  const payload = '{"conversationId":"c1","toolCall":{"name":"run_command","args":{}}}';
  const run = (env: NodeJS.ProcessEnv) => new Promise<string>((resolve, reject) => {
    const child = spawn(launcher, [], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.once('error', reject);
    // Outside StashBase the launcher exits without reading stdin. Its decision
    // is still asserted below, even when it closes the pipe before this write.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.once('close', () => resolve(out.trim()));
    child.stdin.end(payload);
  });
  const { STASHBASE_AGENT_SESSION_ID: _ignored, ...outside } = process.env;
  assert.equal(await run(outside), '{"decision":"allow"}');
  assert.equal(received.length, 0, 'a run outside StashBase never reaches the host');
  assert.equal(await run({ ...outside, STASHBASE_AGENT_SESSION_ID: 'session-1' }), '{"decision":"deny","reason":"declined"}');
  assert.deepEqual(received, [{ session: 'session-1', body: payload }]);
  server.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(await run({ ...outside, STASHBASE_AGENT_SESSION_ID: 'session-1' }), /"decision":"deny"/);
  assert.equal(spawnSync('sh', ['-n', launcher]).status, 0);
});
