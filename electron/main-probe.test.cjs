'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  probeServerHealth,
  createServerArguments,
  createServerSpawn,
  isCompatibleServerHealth,
  startServer,
  createServerChildEnvironment,
  readDevelopmentExternalFileToken,
  waitForStableServerProbe,
  serverStartupTimeoutMs,
} = require('./main-probe.cjs');

const identity = { protocolVersion: 1, appRoot: '/app', resourcesPath: '/resources' };
const health = (instanceId) => ({ app: 'stashbase', ok: true, ...identity, instanceId });

function startupFixture({ existing, afterSpawn, packaged = true } = {}) {
  let now = 0;
  let spawnedId;
  let probesAfterSpawn = 0;
  const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null });
  const options = {
    packaged,
    port: 8090,
    timeoutMs: 500,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    probeOptions: {
      timeoutMs: 500,
      retryMs: 100,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    },
    probe: async (instanceId) => {
      if (instanceId === undefined) return existing ?? { compatible: false, occupied: false };
      probesAfterSpawn += 1;
      const body = afterSpawn
        ? await afterSpawn({ instanceId, child, probe: probesAfterSpawn })
        : health(instanceId);
      return { compatible: isCompatibleServerHealth(body, { ...identity, instanceId }) };
    },
    spawn: (instanceId) => {
      spawnedId = instanceId;
      return child;
    },
  };
  return { options, child, spawnedId: () => spawnedId, elapsed: () => now, probes: () => probesAfterSpawn };
}

test('packaged relaunch waits for the previous server to release the port before spawning', async () => {
  const fixture = startupFixture({
    existing: { compatible: true, occupied: true },
    afterSpawn: ({ instanceId }) => health(instanceId),
  });
  let oldProbes = 0;
  fixture.options.probe = async (instanceId) => {
    if (instanceId === undefined) {
      oldProbes += 1;
      return oldProbes < 3
        ? { compatible: true, occupied: true }
        : { compatible: false, occupied: false };
    }
    assert.equal(oldProbes, 3, 'new server must not bind while the old one owns the port');
    return { compatible: isCompatibleServerHealth(health(instanceId), { ...identity, instanceId }) };
  };
  assert.equal(await startServer(fixture.options), fixture.child);
  assert.equal(oldProbes, 3);
  assert.ok(fixture.spawnedId());
});

test('a permanently unresponsive listener reaches child-side reclaim only after the bounded re-probe', async () => {
  const fixture = startupFixture({ existing: { compatible: false, occupied: true, transient: true } });
  assert.equal(await startServer(fixture.options), fixture.child);
  assert.equal(fixture.elapsed(), 500);
});

test('a responsive foreign listener is rejected without spawning', async () => {
  const fixture = startupFixture({ existing: { compatible: false, occupied: true, transient: false } });
  await assert.rejects(startServer(fixture.options), /another local service/);
  assert.equal(fixture.spawnedId(), undefined);
});

test('an incompatible legacy StashBase listener keeps the port guidance', async () => {
  const fixture = startupFixture({ existing: { compatible: false, occupied: true, legacyStashBase: true } });
  await assert.rejects(startServer(fixture.options), /an older StashBase server/);
  assert.equal(fixture.spawnedId(), undefined);
});

test('only source launches reuse a compatible server without launching a child', async () => {
  const fixture = startupFixture({ packaged: false, existing: { compatible: true, occupied: true } });
  assert.equal(await startServer(fixture.options), null);
  assert.equal(fixture.spawnedId(), undefined);
});

test('source readiness follows the instance ID even when a watch wrapper has a different PID', async () => {
  const fixture = startupFixture({
    packaged: false,
    afterSpawn: ({ instanceId, child }) => ({ ...health(instanceId), pid: child.pid + 1 }),
  });
  assert.equal(await startServer(fixture.options), fixture.child);
});

test('a previous live StashBase server cannot trigger a competing packaged bind', async () => {
  const fixture = startupFixture({
    existing: { compatible: true, occupied: true },
  });
  await assert.rejects(startServer({ ...fixture.options, handoffTimeoutMs: 300 }), /previous StashBase instance/);
  assert.equal(fixture.spawnedId(), undefined);
});

test('a child that exits during a health request never becomes ready', async () => {
  const fixture = startupFixture({
    afterSpawn: ({ child, instanceId }) => { child.signalCode = 'SIGTERM'; return health(instanceId); },
  });
  await assert.rejects(startServer(fixture.options), /exited with signal SIGTERM/);
});

test('spawn failures reject with the cause and release the readiness listener', async () => {
  const fixture = startupFixture({
    afterSpawn: ({ child }) => { child.emit('error', new Error('ENOENT')); return null; },
  });
  await assert.rejects(startServer(fixture.options), /server spawn failed: ENOENT/);
  assert.equal(fixture.child.listenerCount('error'), 0);
});

test('readiness times out when only a prior instance answers', async () => {
  const fixture = startupFixture({ afterSpawn: () => health('old-instance') });
  await assert.rejects(startServer(fixture.options), /did not come up/);
  assert.equal(fixture.elapsed(), 500);
  assert.equal(fixture.child.listenerCount('error'), 0);
});

test('readiness timeout retains the last probe, count and elapsed time without relaxing identity', async () => {
  const fixture = startupFixture();
  const probe = fixture.options.probe;
  fixture.options.probe = async (instanceId) => instanceId ? {
    compatible: false, occupied: true, probe_result: 'identity_mismatch', probe_mismatch: 'instanceId',
    probe_duration_ms: 12, probe_http_status: 200,
  } : probe();
  await assert.rejects(startServer(fixture.options), error => {
    assert.equal(error.startupContext.probe_count, 4);
    assert.equal(error.startupContext.probe_result, 'identity_mismatch');
    assert.equal(error.startupContext.probe_mismatch, 'instanceId');
    assert.equal(error.startupContext.probe_duration_ms, 12);
    assert.equal(error.startupContext.elapsed_ms, 500);
    assert.equal(error.startupContext.process_start_id, fixture.spawnedId());
    return true;
  });
});

test('real loopback probes distinguish refusal, stalled response, bad HTTP, bad JSON and wrong identity', async (t) => {
  const http = require('node:http');
  let mode = 'ready';
  const server = http.createServer((_req, res) => {
    if (mode === 'stall') return;
    if (mode === 'http') { res.writeHead(503); res.end('{}'); return; }
    if (mode === 'json') { res.end('not json'); return; }
    res.end(JSON.stringify(health(mode === 'identity' ? 'old-instance' : 'expected-instance')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (const [nextMode, expectedResult] of [
    ['ready', 'ready'], ['stall', 'response_timeout'], ['http', 'http_error'],
    ['json', 'invalid_json'], ['identity', 'identity_mismatch'],
  ]) {
    mode = nextMode;
    const result = await probeServerHealth(port, 1000, { ...identity, instanceId: 'expected-instance' });
    assert.equal(result.probe_result, expectedResult);
    assert.equal(result.compatible, nextMode === 'ready');
    assert.ok(result.probe_duration_ms >= 0);
    if (nextMode === 'stall') { assert.equal(result.occupied, true); assert.equal(result.transient, true); }
    if (nextMode === 'identity') assert.equal(result.probe_mismatch, 'instanceId');
    assert.equal('body' in result, false);
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  const refused = await probeServerHealth(port, 100, identity);
  assert.equal(refused.probe_result, 'connection_refused');
  assert.equal(refused.occupied, false);
});

test('child environment replaces inherited instance identity and health rejects missing ownership', () => {
  const environment = createServerChildEnvironment({
    baseEnv: { STASHBASE_SERVER_INSTANCE_ID: 'old-instance' },
    packaged: true,
    instanceId: 'new-instance',
  });
  assert.equal(environment.STASHBASE_SERVER_INSTANCE_ID, 'new-instance');
  assert.equal(isCompatibleServerHealth(health(), identity), true);
  assert.equal(isCompatibleServerHealth(health(), { ...identity, instanceId: 'new-instance' }), false);
});

test('Electron-owned source server does not enable the Vite proxy without an inherited Vite marker', () => {
  const environment = createServerChildEnvironment({
    baseEnv: { PATH: '/test/bin' },
    packaged: false,
    packagedEnv: { STASHBASE_APP_ROOT: '/repo' },
    shutdownToken: 'shutdown-token',
    oauthReturnToken: 'oauth-token',
  });

  assert.equal(environment.STASHBASE_DEV_RUNTIME, '1');
  assert.equal(environment.STASHBASE_DEV_VITE, undefined);
  assert.equal(environment.STASHBASE_APP_ROOT, '/repo');
  assert.equal(environment.STASHBASE_SHUTDOWN_TOKEN, 'shutdown-token');
  assert.equal(environment.STASHBASE_OAUTH_RETURN_TOKEN, 'oauth-token');
});

test('Electron-owned source server preserves an explicit Vite proxy marker', () => {
  const environment = createServerChildEnvironment({
    baseEnv: { STASHBASE_DEV_VITE: '1' },
    packaged: false,
    packagedEnv: { STASHBASE_APP_ROOT: '/repo' },
    shutdownToken: 'shutdown-token',
    oauthReturnToken: 'oauth-token',
  });

  assert.equal(environment.STASHBASE_DEV_RUNTIME, '1');
  assert.equal(environment.STASHBASE_DEV_VITE, '1');
});

test('packaged server environment cannot inherit development runtime flags', () => {
  const environment = createServerChildEnvironment({
    baseEnv: {
      STASHBASE_DEV_RUNTIME: '1',
      STASHBASE_DEV_VITE: '1',
    },
    packaged: true,
    packagedEnv: { ELECTRON_RUN_AS_NODE: '1' },
    shutdownToken: 'shutdown-token',
    oauthReturnToken: 'oauth-token',
  });

  assert.equal(environment.STASHBASE_DEV_RUNTIME, undefined);
  assert.equal(environment.STASHBASE_DEV_VITE, undefined);
  assert.equal(environment.ELECTRON_RUN_AS_NODE, '1');
});

test('Electron-owned server uses a single process unless Vite explicitly needs watch mode', () => {
  const direct = createServerArguments({
    entry: '/repo/server/index.ts',
    portArgs: ['--port=4200'],
    packaged: false,
    vite: false,
  });
  const vite = createServerArguments({
    entry: '/repo/server/index.ts',
    portArgs: ['--port=4200'],
    packaged: false,
    vite: true,
  });
  const packaged = createServerArguments({
    entry: '/app/dist/server/index.mjs',
    portArgs: [],
    packaged: true,
    vite: false,
  });

  assert.deepEqual(direct, ['/repo/server/index.ts', '--port=4200']);
  assert.deepEqual(vite, ['watch', '/repo/server/index.ts', '--port=4200']);
  assert.deepEqual(packaged, ['/app/dist/server/index.mjs']);
});

test('Windows source launch keeps a spaced checkout path intact through cmd.exe', async () => {
  const windows = createServerSpawn({
    command: 'C:\\My Projects\\stashbase\\node_modules\\.bin\\tsx.cmd',
    args: ['C:\\My Projects\\stashbase\\server\\index.ts', '--port=4200'],
    platform: 'win32',
  });
  assert.deepEqual(windows, {
    command: '"C:\\My Projects\\stashbase\\node_modules\\.bin\\tsx.cmd"',
    args: ['"C:\\My Projects\\stashbase\\server\\index.ts"', '"--port=4200"'],
    shell: true,
  });

  const posix = createServerSpawn({
    command: '/My Projects/stashbase/node_modules/.bin/tsx',
    args: ['/My Projects/stashbase/server/index.ts'],
    platform: 'darwin',
  });
  assert.deepEqual(posix, {
    command: '/My Projects/stashbase/node_modules/.bin/tsx',
    args: ['/My Projects/stashbase/server/index.ts'],
    shell: false,
  });

  if (process.platform !== 'win32') return;
  // Exercise the real cmd.exe path: a spaced directory with a .cmd shim must
  // receive its spaced argument as one value.
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase spawn '));
  try {
    const shim = path.join(root, 'echo args.cmd');
    fs.writeFileSync(shim, '@echo off\r\necho [%~1]\r\n');
    const real = createServerSpawn({ command: shim, args: [path.join(root, 'server index.ts')] });
    const result = spawnSync(real.command, real.args, { shell: real.shell, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `[${path.join(root, 'server index.ts')}]`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source server startup covers cold TypeScript loading without weakening packaged failure bounds', () => {
  assert.equal(serverStartupTimeoutMs({ packaged: false }), 30_000);
  assert.equal(serverStartupTimeoutMs({ packaged: true }), 10_000);
});

test('Electron waits through a temporarily unresponsive server instead of spawning a competitor', async () => {
  const probes = [
    { compatible: false, occupied: true, transient: true },
    { compatible: false, occupied: true, transient: true },
    { compatible: true, occupied: true, transient: false },
  ];
  let now = 0;
  let waits = 0;

  const result = await waitForStableServerProbe(
    async () => probes.shift(),
    {
      timeoutMs: 1_000,
      retryMs: 100,
      now: () => now,
      sleep: async (ms) => { now += ms; waits += 1; },
    },
  );

  assert.equal(result.compatible, true);
  assert.equal(waits, 2);
});

test('Electron stops waiting when the transient port holder exits', async () => {
  const probes = [
    { compatible: false, occupied: true, transient: true },
    { compatible: false, occupied: false, transient: false },
  ];
  let now = 0;

  const result = await waitForStableServerProbe(
    async () => probes.shift(),
    {
      timeoutMs: 1_000,
      retryMs: 100,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    },
  );

  assert.equal(result.occupied, false, 'Electron may now start the one owned server');
});

test('Electron does not delay a responsive incompatible service', async () => {
  let probes = 0;
  let waits = 0;
  const result = await waitForStableServerProbe(
    async () => {
      probes += 1;
      return { compatible: false, occupied: true, transient: false };
    },
    {
      timeoutMs: 1_000,
      retryMs: 100,
      sleep: async () => { waits += 1; },
    },
  );

  assert.equal(result.compatible, false);
  assert.equal(probes, 1);
  assert.equal(waits, 0);
});


test('host startup diagnostics retain a bounded log tail and tolerate unavailable logs', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { readServerLogTail } = require('./main-probe.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-host-log-'));
  const file = path.join(directory, 'server.log');
  try {
    fs.writeFileSync(file, 'x'.repeat(20000) + '\nError: missing startup module\n at bootstrap:10:4');
    const tail = readServerLogTail(file);
    assert.ok(Buffer.byteLength(tail) <= 8000);
    assert.match(tail, /missing startup module/);
    assert.match(tail, /bootstrap:10:4$/);
    assert.equal(readServerLogTail(path.join(directory, 'absent')), undefined);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


test('storage warning crosses a verified health probe without blocking source reuse or owned startup', async (t) => {
  const http = require('node:http');
  const warning = 'Preparation status is unavailable. Repair local storage and restart.';
  let currentInstance;
  let body = { ...health(), preparationStorage: {
    ok: false, code: 'PREPARATION_STORAGE_UNAVAILABLE', message: warning,
  } };
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ ...body, instanceId: currentInstance })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const ready = [];
  const shared = {
    port,
    probe: (instanceId) => probeServerHealth(port, 1000, { ...identity, instanceId }),
    onReady: (result) => ready.push(result.preparationStorageWarning),
  };
  assert.equal(await startServer({ ...shared, packaged: false, spawn: () => assert.fail('must reuse') }), null);
  assert.deepEqual(ready, [warning]);
  const fixture = startupFixture();
  let spawned = false;
  assert.equal(await startServer({ ...fixture.options, ...shared,
    probe: (instanceId) => spawned ? shared.probe(instanceId) : { compatible: false, occupied: false },
    spawn: (instanceId) => { spawned = true; currentInstance = instanceId; return fixture.child; },
  }), fixture.child);
  assert.deepEqual(ready, [warning, warning]);
  assert.equal((await shared.probe(currentInstance)).instanceId, currentInstance,
    'verified identity must reach window lifecycle correlation');

  body = { ...body, appRoot: '/foreign' };
  assert.equal((await shared.probe(currentInstance)).preparationStorageWarning, undefined);
  body = { ...body, appRoot: identity.appRoot, preparationStorage: { ok: true } };
  assert.equal((await shared.probe(currentInstance)).preparationStorageWarning, undefined);
  body.preparationStorage = { ok: false, code: 'UNRECOGNIZED', message: warning };
  assert.equal((await shared.probe(currentInstance)).preparationStorageWarning, undefined);
});

test('main reads a development server\'s registration token only when it is well formed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-dev-token-'));
  try {
    assert.equal(readDevelopmentExternalFileToken(home), null);
    fs.mkdirSync(path.join(home, '.stashbase'));
    const file = path.join(home, '.stashbase', 'dev-external-file-token');
    fs.writeFileSync(file, 'not-a-token');
    assert.equal(readDevelopmentExternalFileToken(home), null);
    const token = 'a'.repeat(64);
    fs.writeFileSync(file, `${token}\n`);
    assert.equal(readDevelopmentExternalFileToken(home), token);
  } finally {
    fs.rmSync(home, { force: true, recursive: true });
  }
});

test('owned startup accepts a healthy response slower than the short port probe', async (t) => {
  const http = require('node:http');
  let ownedInstance;
  let requests = 0;
  const timers = new Set();
  const server = http.createServer((_req, res) => {
    requests++;
    const timer = setTimeout(() => {
      timers.delete(timer);
      res.end(JSON.stringify(health(ownedInstance)));
    }, 450);
    timers.add(timer);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const result = await startServer({
    packaged: true, port, timeoutMs: 1600,
    spawn(instanceId) { ownedInstance = instanceId; return child; },
    probe: (instanceId, timeoutMs = 300) => instanceId
      ? probeServerHealth(port, timeoutMs, { ...identity, instanceId })
      : { compatible: false, occupied: false },
  });
  assert.equal(result, child);
  assert.equal(requests, 1, 'a healthy response should not be repeatedly abandoned');
});


test('owned readiness clamps a stalled probe to the remaining startup budget', async () => {
  const fixture = startupFixture();
  const budgets = [];
  fixture.options.probe = async (instanceId, timeoutMs) => {
    if (!instanceId) return { compatible: false, occupied: false };
    budgets.push(timeoutMs);
    await fixture.options.sleep(timeoutMs);
    return { compatible: false, occupied: true, probe_result: 'response_timeout' };
  };
  await assert.rejects(startServer(fixture.options), /did not come up/);
  assert.deepEqual(budgets, [500]);
  assert.equal(fixture.elapsed(), 500);
});
