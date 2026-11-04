import './__tests__/isolated-home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import express from 'express';
import type { AppConfigFile } from './app-config.ts';
import { createTelemetry } from './telemetry.ts';
import { mount } from './routes/telemetry.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('process shutdown evidence survives delivery without recounting its caught timeout', async () => {
  const { markDiagnosticReported } = await import('./error-diagnostics.ts');
  const { errorDiagnostic } = await import('./error-diagnostics.ts');
  const f = fixture();
  const error = Object.assign(new Error('Agent process did not finish closing after termination.'), { code: 'AGENT_PROCESS_CLOSE_TIMEOUT' });
  const event = {
    event: 'agent_runtime_stop_result' as const, runtime: 'stashbase' as const, purpose: 'prewarm' as const,
    reason: 'spare_expired' as const, attempt_id: '11111111-1111-4111-8111-111111111111',
    outcome: 'timeout' as const, elapsed_ms: 4001, deadline_ms: 4000,
    exit_observed: true, pipes_closed: false,
    context: { process_start_id: '22222222-2222-4222-8222-222222222222' },
    termination: { method: 'taskkill' as const, taskkill_state: 'finished' as const, taskkill_exit_code: 1,
      taskkill_stderr: 'denied token=private-secret', fallback_attempted: true, fallback_sent: false,
      fallback_error: { message: 'failed password=other-secret', code: 'EPERM' } },
    diagnostic: errorDiagnostic(error),
  };
  f.service.capture(event);
  markDiagnosticReported(error);
  f.service.captureWarning(error, { source: 'server', operation: 'background.opencode-runtime' });
  f.service.captureError(error, { source: 'server', operation: 'background.server' });
  f.service.capture({ ...event, outcome: 'closed_after_timeout', elapsed_ms: 4500, pipes_closed: true, diagnostic: undefined });
  await tick();
  assert.deepEqual(f.sent.map(({ body }) => [body.event, body.properties.outcome]), [
    ['agent_runtime_stop_result', 'timeout'], ['agent_runtime_stop_result', 'closed_after_timeout'],
  ]);
  assert.equal(f.sent[0].body.properties.termination.taskkill_exit_code, 1);
  assert.equal(f.sent[0].body.properties.context.process_start_id, event.context.process_start_id);
  assert.doesNotMatch(JSON.stringify(f.sent), /private-secret|other-secret/);
  f.service.update({ enabled: false });
  f.service.capture(event);
  await tick();
  assert.equal(f.sent.length, 2);
  f.service.close();
});

test('source and packaged launches collect while tests and explicit suppression preserve saved preferences', () => {
  const cases = ['0', '1'].flatMap(packaged => [
    { packaged, disabled: '1', available: false },
    { packaged, disabled: '0', available: true },
    { packaged, disabled: '0', available: true, marker: { STASHBASE_DEV_VITE: '1', NODE_ENV: 'development' } },
    { packaged, disabled: '0', available: false, marker: { NODE_TEST_CONTEXT: 'child-v8' } },
    { packaged, disabled: '0', available: false, marker: { NODE_ENV: 'test' } },
    { packaged, disabled: '0', available: false, marker: { VITEST: 'true' } },
    { packaged, disabled: '0', available: false, marker: { JEST_WORKER_ID: '1' } },
  ]);
  for (const { packaged, disabled, available, marker } of cases) {
    const environment = { ...process.env };
    for (const key of ['NODE_TEST_CONTEXT', 'NODE_ENV', 'VITEST', 'JEST_WORKER_ID', 'STASHBASE_DEV_VITE']) delete environment[key];
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import './server/__tests__/isolated-home.ts';
      import assert from 'node:assert/strict';
      import { createServerChildEnvironment } from './electron/main-probe.cjs';

      // This controlled subprocess has a replaced transport; emulate a real
      // launch even though the shared test fixture suppresses normal tests.
      process.env.STASHBASE_TELEMETRY_DISABLED = process.env.EXPECT_TELEMETRY_DISABLED;
      const packaged = process.env.STASHBASE_PACKAGED === '1';
      const available = process.env.EXPECT_TELEMETRY_AVAILABLE === '1';
      const sent = [];
      const distributions = [];
      // Replace the outbound transport before importing the production owner.
      // Even the positive control must never contact the production destination,
      // and desktop delivery must use the proxy-aware native relay, not Node fetch.
      globalThis.fetch = async () => { throw new Error('direct usage delivery bypassed the native relay'); };
      const { createAuthNetworkBridge } = await import('./electron/account/auth-network.ts');
      const bridge = await createAuthNetworkBridge({ usageUrl: 'https://ingest.test/batch/', fetch: async (url, init) => {
        assert.equal(String(url), 'https://ingest.test/batch/');
        for (const payload of JSON.parse(init.body).batch) {
          sent.push(payload.event);
          distributions.push(payload.properties.app_distribution);
        }
        return new Response('{}', { status: 200 });
      } });
      Object.assign(process.env, createServerChildEnvironment({
        baseEnv: process.env, packaged,
        packagedEnv: { STASHBASE_PACKAGED: packaged ? '1' : '0' },
        shutdownToken: 'test-shutdown', oauthReturnToken: 'test-oauth', instanceId: 'test', authNetwork: bridge,
      }));
      const { telemetry } = await import('./server/telemetry.ts');
      const { readAppConfigStrict, writeAppConfigStrict } = await import('./server/app-config.ts');
      const tick = () => new Promise(resolve => setImmediate(resolve));
      if (!available) {
        writeAppConfigStrict({});
        telemetry.capture({ event: 'app_opened' });
        await tick();
        assert.deepEqual(sent, []);
        assert.deepEqual(readAppConfigStrict(), {});
      }
      const saved = { telemetry: {
        enabled: true, installationId: '11111111-1111-4111-8111-111111111111',
      } };
      writeAppConfigStrict(saved);
      telemetry.capture({ event: 'app_opened' });
      telemetry.capture({ event: 'agent_turn_started', runtime: 'codex' });
      telemetry.capture({ event: 'document_write_result', outcome: 'success' });
      telemetry.captureError(new Error('skills unavailable'), { source: 'server', operation: 'runtime', runtime: 'codex' });
      telemetry.captureWarning(new Error('sandbox service unavailable'), { source: 'server', operation: 'runtime', runtime: 'codex' });
      await telemetry.flush();
      assert.deepEqual(sent, available ? ['app_opened', 'agent_turn_started', 'document_write_result', 'application_error', 'application_warning'] : []);
      assert.deepEqual(telemetry.preferences(), { enabled: true, available });
      assert.deepEqual(distributions, sent.map(() => packaged ? 'packaged' : 'source'));
      if (!available) assert.deepEqual(readAppConfigStrict(), saved);

      telemetry.update({ enabled: false });
      const beforeOptOut = sent.length;
      telemetry.capture({ event: 'document_engaged', activity: 'read', format: 'md' });
      await telemetry.flush();
      assert.equal(sent.length, beforeOptOut);
      assert.deepEqual(readAppConfigStrict().telemetry, { enabled: false });
      telemetry.update({ enabled: true });
      telemetry.capture({ event: 'project_entry_result', outcome: 'success' });
      await telemetry.flush();
      assert.deepEqual(sent, available ? [
        'app_opened', 'agent_turn_started', 'document_write_result', 'application_error', 'application_warning',
        'project_entry_result',
      ] : []);
      if (!available) assert.deepEqual(readAppConfigStrict(), { telemetry: { enabled: true } });
      telemetry.close();
      // Electron and MCP use this same native boundary: a suppressed launch
      // must not leave diagnostics that a later real launch could upload.
      const { createNativeDiagnostics, telemetryAvailable } = await import('./server/native-diagnostics.ts');
      const fs = await import('node:fs');
      const path = await import('node:path');
      const directory = path.join(process.env.STASHBASE_LOCAL_DATA_ROOT, 'native-admission');
      const native = createNativeDiagnostics({ available: telemetryAvailable(), distribution: packaged ? 'packaged' : 'source', version: 'test', directory });
      native.record(new Error('test native failure'), 'startup');
      assert.equal(fs.existsSync(directory), available);
      bridge.close();
    `], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...environment, ...marker, STASHBASE_PACKAGED: packaged, STASHBASE_TELEMETRY_DISABLED: disabled, EXPECT_TELEMETRY_AVAILABLE: available ? '1' : '0', EXPECT_TELEMETRY_DISABLED: disabled },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 0, `packaged=${packaged}, disabled=${disabled}, marker=${JSON.stringify(marker)}\n${result.stderr}`);
  }
});

function fixture(available = true) {
  let config: AppConfigFile = { updates: { autoCheck: false } };
  let readFails = false;
  let writeFails = false;
  let now = Date.UTC(2026, 8, 15);
  const sent: Array<{ body: Record<string, any>; signal: AbortSignal }> = [];
  const options = {
    available, distribution: 'source' as const, projectToken: 'phc_test', host: 'https://example.test', version: '2.7.0', os: 'linux',
    read() { if (readFails) throw new Error('private config path'); return structuredClone(config); },
    write(next: AppConfigFile) { if (writeFails) throw new Error('private config path'); config = structuredClone(next); },
    now: () => now,
    fetch: (async (_url, init) => {
      for (const body of JSON.parse(String(init?.body)).batch) sent.push({ body, signal: init?.signal as AbortSignal });
      return new Response(null, { status: 200 });
    }) as typeof fetch,
  };
  return { service: createTelemetry(options), options, sent,
    config: () => config,
    setConfig: (next: AppConfigFile) => { config = next; },
    readFails: (fails = true) => { readFails = fails; },
    writeFails: (fails = true) => { writeFails = fails; },
    nextDay: () => { now += 86400000; },
    advance: (ms: number) => { now += ms; },
  };
}

test('default-on manual collection has only allowed fields and no source or account data', async () => {
  const f = fixture();
  assert.equal(f.service.preferences().enabled, true);
  f.service.capture({ event: 'app_opened' });
  f.service.capture({ event: 'app_opened' });
  f.service.capture({ event: 'project_entry_result', outcome: 'success', path: '/private' } as any);
  await tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].body.properties.schema_version, 9);
  assert.equal(f.sent[0].body.properties.$process_person_profile, false);
  assert.equal(f.sent[0].body.properties.$geoip_disable, true);
  assert.equal(f.sent[0].body.properties.$ip, null);
  assert.equal(f.sent[0].body.distinct_id, f.config().telemetry?.anonymousId);
  assert.equal(f.sent[0].body.properties.installation_id, f.config().telemetry?.installationId);
  assert.deepEqual(f.config().updates, { autoCheck: false });
  f.service.close();
});

test('opt-out discards pending events without a final request and rotates on re-enable', async () => {
  const f = fixture();
  f.service.capture({ event: 'app_opened' });
  await tick();
  const oldId = f.sent[0].body.distinct_id;
  f.service.capture({ event: 'agent_turn_started', runtime: 'codex' });
  assert.equal(f.service.update({ enabled: false }).enabled, false);
  assert.equal(f.config().telemetry?.installationId, undefined);
  f.service.capture({ event: 'agent_turn_started', runtime: 'codex' });
  await tick();
  assert.deepEqual(f.sent.map((entry) => entry.body.event), ['app_opened']);
  const restarted = createTelemetry(f.options);
  restarted.capture({ event: 'app_opened' });
  await tick();
  assert.equal(f.sent.length, 1);
  restarted.update({ enabled: true });
  restarted.capture({ event: 'app_opened' });
  await tick();
  assert.notEqual(f.sent[1].body.distinct_id, oldId);
  f.service.close(); restarted.close();
});

test('read errors, malformed preferences, unavailable collection, and failed disable persistence do not send', async () => {
  for (const kind of ['read', 'malformed', 'unavailable', 'write'] as const) {
    const f = fixture(kind !== 'unavailable');
    if (kind === 'read') f.readFails();
    if (kind === 'malformed') f.setConfig({ telemetry: { enabled: 'yes' } as any });
    if (kind === 'write') {
      f.writeFails();
      assert.throws(() => f.service.update({ enabled: false }));
    }
    f.service.capture({ event: 'app_opened' });
    await tick();
    assert.equal(f.sent.length, 0, kind);
    f.service.close();
  }
});

test('saves preserve outcomes and actual-change evidence instead of suppressing the day', async () => {
  const f = fixture();
  f.service.capture({ event: 'document_write_result', outcome: 'success', changed: false });
  f.service.capture({ event: 'document_write_result', outcome: 'success', changed: true });
  f.service.capture({ event: 'document_write_result', outcome: 'conflict' });
  await f.service.flush();
  assert.deepEqual(f.sent.map(({ body }) => [body.properties.outcome, body.properties.changed]),
    [['success', false], ['success', true], ['conflict', undefined]]);
  f.service.close();
});

test('renderer intake acknowledges durable admission, retries storage failures, and deduplicates lost receipts', async () => {
  const f = fixture();
  const app = express(); app.use(express.json()); mount(app, f.service);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/api/telemetry`;
  try {
    const post = (path: string, body: unknown, method = 'POST') => fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const envelope = (event: unknown) => ({ id: crypto.randomUUID(), timestamp: new Date(f.options.now()).toISOString(), event });
    assert.equal((await post('/events', envelope({ event: 'agent_turn_started', runtime: 'codex', prompt: 'private' }))).status, 400);
    assert.equal((await post('/events', envelope({ event: 'agent_turn_started', runtime: 'codex', source: 'host' }))).status, 400);
    assert.equal((await post('/events', { ...envelope({ event: 'app_opened' }), userId: 'injected' })).status, 400);
    assert.equal((await post('', { enabled: false, installationId: 'injected' }, 'PUT')).status, 400);
    const request = envelope({ event: 'app_opened' });
    f.writeFails();
    const refused = await post('/events', request);
    assert.equal(refused.status, 503);
    assert.deepEqual(await refused.json(), { status: 'retry' });
    assert.equal(f.config().telemetry, undefined);
    f.writeFails(false);
    f.advance(500);
    assert.deepEqual(await (await post('/events', request)).json(), { status: 'accepted' });
    await f.service.flush();
    assert.deepEqual(await (await post('/events', request)).json(), { status: 'duplicate' });
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].body.uuid, request.id);
    assert.equal(f.sent[0].body.timestamp, request.timestamp);
    assert.deepEqual(await (await fetch(url)).json(), { enabled: true, available: true });
    assert.equal((await post('', { enabled: false }, 'PUT')).status, 200);
    assert.equal(f.config().telemetry?.enabled, false);
    assert.deepEqual(await (await post('/events', request)).json(), { status: 'disabled' });
  } finally { f.service.close(); server.closeAllConnections(); server.close(); }
});

test('short renderer retries cannot cross account changes, opt-out, or host restart', async () => {
  const f = fixture();
  const request = () => ({ id: crypto.randomUUID(), timestamp: new Date(f.options.now()).toISOString(),
    event: { event: 'document_engaged' as const, activity: 'edit' as const, format: 'md' as const } });
  account(f, 'A');
  f.advance(1);
  const oldAccount = request(); // The first request never reached the host.
  f.advance(1);
  account(f, 'B');
  assert.equal(f.service.captureRenderer(oldAccount), 'discarded');
  f.advance(1);
  const disabled = request();
  f.service.update({ enabled: false });
  assert.equal(f.service.captureRenderer(disabled), 'disabled');
  f.advance(1);
  f.service.update({ enabled: true });
  assert.equal(f.service.captureRenderer(disabled), 'discarded');
  f.advance(1);
  const fresh = request();
  assert.equal(f.service.captureRenderer(fresh), 'accepted');
  await f.service.flush();
  assert.equal(f.sent.filter(({ body }) => body.event === 'document_engaged').length, 1);
  assert.equal(f.sent.at(-1)!.body.distinct_id, 'user:B');
  f.service.close();
  f.advance(1);
  const restarted = createTelemetry(f.options);
  assert.equal(restarted.captureRenderer(fresh), 'discarded');
  restarted.close();
});

test('error diagnostics share opt-out, redact causes, and suppress repeated failures', async () => {
  const f = fixture();
  const cause = Object.assign(new Error('connect ECONNREFUSED https://private.example/path?token=hidden-token'), { code: 'ECONNREFUSED' });
  const error = Object.assign(new Error('Installer failed for "private project" at C:\\Users\\Jane Doe\\secret.txt\nBearer secret-token-value-123456789\nuser@example.com', { cause }), { exitCode: 13 });
  error.stack = 'Error: private message\n    at install (C:\\Users\\Jane Doe\\project\\installer.ts:10:4)';
  f.service.captureError(error, { source: 'agent', operation: 'install', runtime: 'codex' });
  f.service.captureError(error, { source: 'agent', operation: 'install', runtime: 'codex' });
  await tick();
  assert.equal(f.sent.length, 1);
  const diagnostic = f.sent[0].body.properties.diagnostic;
  assert.equal(diagnostic.causes[0].code, 'ECONNREFUSED');
  assert.equal(diagnostic.exit_code, 13);
  assert.match(diagnostic.message, /Installer failed/);
  assert.match(diagnostic.stack, /installer\.ts:10:4/);
  const payload = JSON.stringify(f.sent[0].body);
  for (const value of ['hidden-token', 'secret-token-value']) assert.equal(payload.includes(value), false, value);
  f.service.update({ enabled: false });
  f.service.captureError(new Error('another failure'), { source: 'server', operation: 'sync' });
  await tick();
  assert.deepEqual(f.sent.map((entry) => entry.body.event), ['application_error']);
  f.service.close();
});

test('warnings report apart from errors and count repeats per window', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture();
  const context = { source: 'server', operation: 'background.sync' } as const;
  const failure = Object.assign(new Error('index rejected'), { code: 'EIO' });
  f.service.captureWarning(failure, context);
  f.service.captureError(failure, context);
  await tick();
  assert.deepEqual(f.sent.map((entry) => [entry.body.event, entry.body.properties.occurrences]),
    [['application_warning', 1], ['application_error', 1]]);

  // Persistent: repeats are counted locally and reported once when the window closes.
  for (let i = 0; i < 5; i++) { f.advance(60_000); f.service.captureWarning(failure, context); }
  await tick();
  assert.equal(f.sent.length, 2);
  f.advance(5 * 60_000);
  t.mock.timers.tick(60_000);
  await tick();
  assert.deepEqual(f.sent.slice(2).map((entry) => [entry.body.event, entry.body.properties.occurrences]),
    [['application_warning', 5]]);
  assert.equal(f.sent[2].body.properties.diagnostic.code, 'EIO');

  // Sporadic: a lone occurrence reports once, with no later rollup.
  f.advance(60 * 60_000);
  f.service.captureWarning(failure, context);
  f.advance(20 * 60_000);
  t.mock.timers.tick(60_000);
  await tick();
  assert.deepEqual(f.sent.slice(3).map((entry) => entry.body.properties.occurrences), [1]);

  // Shutdown queues uncounted repeats durably instead of dropping them.
  f.service.captureWarning(failure, context);
  f.service.captureWarning(failure, context);
  f.service.captureWarning(failure, context);
  await tick();
  f.service.close();
  assert.deepEqual(f.config().telemetry?.queue?.map((entry) => [entry.event.event, 'occurrences' in entry.event && entry.event.occurrences]),
    [['application_warning', 2]]);
});

test('diagnostic repeats retain their account across a switch', async () => {
  const f = fixture();
  const context = { source: 'server', operation: 'background.sync' } as const;
  const failure = new Error('sync failed');
  account(f, 'A');
  f.service.captureWarning(failure, context);
  f.service.captureWarning(failure, context);
  await tick();
  account(f, 'B');
  f.service.captureWarning(failure, context);
  f.service.captureWarning(failure, context);
  await tick();
  f.service.close();
  const queued = f.config().telemetry?.queue?.filter((item) => item.event.event === 'application_warning') ?? [];
  assert.deepEqual(queued.map((item) => [item.userId, 'occurrences' in item.event && item.event.occurrences]),
    [['A', 1], ['B', 1]]);
});

test('setup diagnostics are redacted at collection even when the caller supplies raw text', async () => {
  const f = fixture();
  f.service.capture({ event: 'agent_setup_result', runtime: 'claude', stage: 'update', outcome: 'failed',
    failure_stage: 'installation', diagnostic: { message: 'EACCES token=must-not-leak /Users/private/project', exit_code: 7 } });
  await tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].body.properties.failure_stage, 'installation');
  assert.equal(f.sent[0].body.properties.diagnostic.exit_code, 7);
  assert.equal(JSON.stringify(f.sent).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(f.sent).includes('/Users/private'), true);
  f.service.close();
});

test('HTTP failures retain route, method, request ID and original cause without request bodies or duplicate events', async () => {
  const { httpErrorReporting } = await import('./error-reporting.ts');
  const { sendError } = await import('./http.ts');
  const f = fixture();
  const app = express(); app.use(express.json()); app.use(httpErrorReporting(f.service));
  app.post('/api/files/*', (_req, res) => sendError(res, Object.assign(new Error('Cannot write /private/customer.md'), { code: 'EACCES' })));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    const requestId = crypto.randomUUID();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/files/customer.md?folder=private-project`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-stashbase-request-id': requestId }, body: JSON.stringify({ content: 'private document content' }),
    });
    assert.equal(response.status, 500);
    await tick();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].body.properties.operation, 'http.files');
    assert.equal(f.sent[0].body.properties.diagnostic.http_status, 500);
    assert.equal(f.sent[0].body.properties.diagnostic.code, 'EACCES');
    assert.deepEqual(f.sent[0].body.properties.context, { method: 'POST', route: '/api/files/*' });
    assert.equal(f.sent[0].body.properties.request_id, requestId);
    assert.equal(response.headers.get('x-request-id'), f.sent[0].body.properties.request_id);
    assert.match(f.sent[0].body.properties.diagnostic.causes[0].stack, /telemetry.test.ts/);
    for (const value of ['private-project', 'private document content']) assert.equal(JSON.stringify(f.sent).includes(value), false);
  } finally { f.service.close(); server.closeAllConnections(); server.close(); }
});

test('slow JSON requests and early closure retain bounded lifecycle evidence without classifying cancellation or streams as failure', async () => {
  const { httpErrorReporting } = await import('./error-reporting.ts');
  const f = fixture();
  const app = express(); app.use(httpErrorReporting(f.service, { slowRequestMs: 20 }));
  let finishSlow!: () => void;
  let closeRead!: () => void;
  let enteredRead!: () => void;
  const readEntered = new Promise<void>(resolve => { enteredRead = resolve; });
  const readClosed = new Promise<void>(resolve => { closeRead = resolve; });
  app.get('/api/scheduled-tasks/projects', (_req, res) => { finishSlow = () => res.json({ projects: [] }); });
  app.get('/api/files/*', (_req, res) => { res.once('close', closeRead); enteredRead(); });
  app.get('/api/projects', (_req, res) => res.json({ projects: [] }));
  app.get('/api/agent/events', (_req, res) => { res.type('text/event-stream'); res.write(': connected\n\n'); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = (id: string) => ({ accept: 'application/json', 'x-stashbase-request-id': id });
  try {
    const slowId = crypto.randomUUID();
    const slow = fetch(`${base}/api/scheduled-tasks/projects?folder=private-project`, { headers: headers(slowId) });
    const until = Date.now() + 2000;
    while (!f.sent.some(row => row.body.properties.request_id === slowId) && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].body.properties.state, 'pending');
    finishSlow();
    assert.equal((await slow).headers.get('x-request-id'), slowId);
    await tick();
    assert.deepEqual(f.sent.map(row => row.body.properties.state), ['pending', 'finished']);
    assert.equal(f.sent[0].body.properties.headers_sent, false);
    assert.equal(f.sent[0].body.properties.http_status, undefined);
    assert.equal(f.sent[1].body.properties.http_status, 200);
    assert.ok(f.sent[1].body.properties.elapsed_ms >= f.sent[0].body.properties.elapsed_ms);

    const closedId = crypto.randomUUID();
    const abort = new AbortController();
    const cancelled = fetch(`${base}/api/files/private-document.md?folder=private-project`, {
      headers: headers(closedId), signal: abort.signal,
    });
    await readEntered;
    abort.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    await readClosed; await tick();
    const closed = f.sent.filter(row => row.body.properties.request_id === closedId);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].body.properties.state, 'closed');
    assert.equal(closed[0].body.properties.context.route, '/api/files/*');
    assert.ok(f.sent.every(row => row.body.event === 'http_request_lifecycle'));
    assert.doesNotMatch(JSON.stringify(f.sent), /private-document|private-project/);

    const before = f.sent.length;
    const invalid = await fetch(`${base}/api/projects`, { headers: headers('private-invalid-id') });
    assert.match(invalid.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
    await fetch(`${base}/api/projects`, { headers: headers(crypto.randomUUID()) });
    const streaming = new AbortController();
    const stream = await fetch(`${base}/api/agent/events`, { headers: headers(crypto.randomUUID()), signal: streaming.signal });
    assert.equal(stream.status, 200);
    await new Promise(resolve => setTimeout(resolve, 35));
    streaming.abort();
    await tick(); await tick();
    assert.equal(f.sent.length, before);
  } finally { f.service.close(); server.closeAllConnections(); server.close(); }
});


test('host logs report warnings and errors apart, classified by the caught error alone', async () => {
  const { installHostErrorReporting } = await import('./error-reporting.ts');
  const { logger, setLogErrorReporter } = await import('./log.ts');
  const f = fixture();
  installHostErrorReporting(f.service);
  try {
    const log = logger('file-save');
    log.warn('save: index update failed for Acme Plan.md:', Object.assign(new Error('disk is full'), { code: 'ENOSPC' }));
    log.error('save: write failed for Acme Plan.md:', Object.assign(new Error('read-only'), { code: 'EROFS' }));
    await tick();
    assert.deepEqual(f.sent.map((entry) => [entry.body.event, entry.body.properties.operation, entry.body.properties.diagnostic.code]),
      [['application_warning', 'background.file-save', 'ENOSPC'], ['application_error', 'background.file-save', 'EROFS']]);
    // The template's "update" must not decide the cause.
    assert.equal(f.sent[0].body.properties.diagnostic.message, 'disk is full');
    assert.match(f.sent[0].body.properties.context.action, /Acme Plan.md/);
  } finally { setLogErrorReporter(() => {}); f.service.close(); }
});

test('refused HTTP requests are warnings while server failures are errors', async () => {
  const { httpErrorReporting } = await import('./error-reporting.ts');
  const f = fixture();
  const app = express(); app.use(httpErrorReporting(f.service));
  app.put('/api/files/conflict', (_req, res) => res.status(412).json({ error: 'File changed on disk' }));
  app.put('/api/files/broken', (_req, res) => res.status(500).json({ error: 'Operation failed' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    for (const path of ['conflict', 'broken']) await fetch(`http://127.0.0.1:${address.port}/api/files/${path}`, { method: 'PUT' });
    await tick();
    assert.deepEqual(f.sent.map((entry) => [entry.body.event, entry.body.properties.diagnostic.http_status]),
      [['application_warning', 412], ['application_error', 500]]);
  } finally { f.service.close(); server.closeAllConnections(); server.close(); }
});

test('distinct error explanations, unknown codes and paths survive without being merged', async () => {
  const f = fixture();
  for (const message of [
    'rename_folder: conversion rediscovery failed for Acquisition Target Orion: database is locked',
    'failed to update links in Acquisition Plan.md',
    'save: index update failed for Acme Merger Plan.md: provider failed',
    'attach: write Private Acquisition.odt failed: EACCES',
    'SecretProject/subdir',
  ]) f.service.captureError({ message, code: 'CustomerSecret', name: 'CustomerSecret' }, { source: 'server', operation: 'AcquisitionSecret' });
  await tick();
  assert.equal(f.sent.length, 5);
  const payload = JSON.stringify(f.sent);
  for (const value of ['Acquisition', 'Orion', 'Acme', 'Merger', 'Private', 'SecretProject', 'CustomerSecret']) assert.equal(payload.includes(value), true, value);
  assert.match(payload, /database is locked/);
  assert.match(payload, /EACCES/);
  f.service.close();
});


test('non-JSON asset failures report status without reading private response content', async () => {
  const { httpErrorReporting } = await import('./error-reporting.ts');
  const f = fixture();
  const app = express(); app.use(httpErrorReporting(f.service));
  app.get('/asset/private-document.pdf', (_req, res) => res.status(404).end('Private Document.pdf'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/asset/private-document.pdf`);
    assert.equal(await response.text(), 'Private Document.pdf');
    await tick();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].body.properties.diagnostic.http_status, 404);
    assert.equal(JSON.stringify(f.sent).includes('Private'), false);
  } finally { f.service.close(); server.closeAllConnections(); server.close(); }
});

function account(f: ReturnType<typeof fixture>, userId?: string) {
  const config = f.config();
  config.account = userId ? { session: { userId, email: 'private@example.com', accessToken: 'secret-access',
    sessionToken: 'secret-refresh', expiresAt: 9999999999 } } : {};
  f.setConfig(config);
  f.service.identityChanged();
}

test('login links the preceding anonymous history and restores the same account across restarts', async () => {
  const f = fixture();
  f.service.capture({ event: 'app_active', mode: 'welcome' });
  await f.service.flush();
  const anonymous = f.sent[0].body.distinct_id;
  account(f, 'user-A');
  f.service.capture({ event: 'account_login_result', outcome: 'success' });
  await f.service.flush();
  const link = f.sent.find(({ body }) => body.event === '$identify')!.body;
  assert.equal(link.distinct_id, 'user:user-A');
  assert.equal(link.properties.$anon_distinct_id, anonymous);
  assert.equal(link.properties.$process_person_profile, true);
  f.service.close();
  const restarted = createTelemetry(f.options);
  restarted.capture({ event: 'app_opened' });
  await restarted.flush();
  assert.equal(f.sent.at(-1)!.body.distinct_id, 'user:user-A');
  assert.equal(f.sent.filter(({ body }) => body.event === '$identify').length, 1);
  for (const value of ['private@example.com', 'secret-access', 'secret-refresh']) assert.equal(JSON.stringify(f.sent).includes(value), false);
  restarted.close();
});

test('logout and direct account switches never merge two accounts on the same installation', async () => {
  const f = fixture();
  account(f, 'A');
  f.service.capture({ event: 'app_active', mode: 'documents' });
  await f.service.flush();
  const installation = f.config().telemetry!.installationId;
  const firstAnonymous = f.config().telemetry!.anonymousId;
  account(f);
  f.service.capture({ event: 'app_active', mode: 'documents' });
  const secondAnonymous = f.config().telemetry!.anonymousId;
  assert.notEqual(secondAnonymous, firstAnonymous);
  account(f, 'B');
  await f.service.flush();
  const links = f.sent.filter(({ body }) => body.event === '$identify').map(({ body }) => body);
  assert.deepEqual(links.map((body) => [body.distinct_id, body.properties.$anon_distinct_id]),
    [['user:A', firstAnonymous], ['user:B', secondAnonymous]]);
  assert.equal(f.config().telemetry!.installationId, installation);
  account(f, 'C');
  await f.service.flush();
  assert.notEqual(f.sent.at(-1)!.body.properties.$anon_distinct_id, secondAnonymous);
  f.service.close();
});

test('offline queue survives a distribution change and keeps occurrence identity, time, version and UUID', async () => {
  const f = fixture();
  const offline = createTelemetry({ ...f.options, distribution: 'packaged', fetch: async () => { throw new Error('offline'); } });
  offline.capture({ event: 'document_engaged', activity: 'edit', format: 'md' });
  await offline.flush();
  const queued = structuredClone(f.config().telemetry!.queue![0]);
  offline.close();
  f.nextDay();
  account(f, 'A');
  await f.service.flush();
  const delivered = f.sent.find(({ body }) => body.event === 'document_engaged')!.body;
  assert.equal(delivered.timestamp, queued.timestamp);
  assert.equal(delivered.uuid, queued.uuid);
  assert.equal(delivered.distinct_id, queued.anonymousId);
  assert.equal(delivered.properties.app_version, queued.version);
  assert.equal(delivered.properties.app_distribution, 'packaged');
  assert.equal(f.config().telemetry!.queue!.length, 0);
  f.service.close();
});

test('queued events leave in batches and a refused batch cannot discard its valid members', async () => {
  const f = fixture();
  const requests: string[][] = [];
  const service = createTelemetry({ ...f.options, fetch: async (_url, init) => {
    const batch = JSON.parse(String(init?.body)).batch as Array<{ event: string }>;
    requests.push(batch.map(({ event }) => event));
    // The provider refuses any request that contains the invalid envelope.
    return new Response(null, { status: batch.some(({ event }) => event === 'document_write_result') ? 400 : 200 });
  } });
  service.capture({ event: 'app_opened' });
  service.capture({ event: 'document_write_result', outcome: 'success', changed: true });
  service.capture({ event: 'project_entry_result', outcome: 'success' });
  await service.flush();
  assert.deepEqual(requests, [
    ['app_opened', 'document_write_result', 'project_entry_result'],
    ['app_opened'], ['document_write_result'], ['project_entry_result'],
  ]);
  assert.equal(f.config().telemetry!.queue!.length, 0);
  service.capture({ event: 'app_active', mode: 'chat' });
  service.capture({ event: 'project_entry_result', outcome: 'failed' });
  await service.flush();
  assert.deepEqual(requests.at(-1), ['app_active', 'project_entry_result']);
  service.close(); f.service.close();
});

test('undelivered events survive a three-week absence and leave on the next launch', async () => {
  const f = fixture();
  const offline = createTelemetry({ ...f.options, fetch: async () => { throw new Error('offline'); } });
  offline.capture({ event: 'document_engaged', activity: 'edit', format: 'md' });
  offline.close('app_shutdown');
  for (let day = 0; day < 21; day++) f.nextDay();
  f.service.capture({ event: 'app_opened' });
  await f.service.flush();
  assert.deepEqual(f.sent.map(({ body }) => body.event), ['document_engaged', 'app_opened']);
  f.service.close();
});

test('diagnostic bursts cannot crowd out core activity, turn starts or operation results', async () => {
  const f = fixture();
  for (let index = 0; index < 130; index++) {
    if (index % 2 === 0) f.service.captureWarning(new Error('refused request'), { source: 'server', operation: 'http', request_id: crypto.randomUUID() });
    else f.service.capture({ event: 'http_request_lifecycle', request_id: crypto.randomUUID(), state: 'closed',
      elapsed_ms: 10, headers_sent: false, context: { method: 'GET', route: '/api/projects' } });
  }
  const turn_id = crypto.randomUUID();
  f.service.capture({ event: 'agent_turn_started', runtime: 'stashbase', turn_id });
  f.service.capture({ event: 'document_engaged', activity: 'edit', format: 'md' });
  f.service.capture({ event: 'app_active', mode: 'chat' });
  f.service.capture({ event: 'document_write_result', outcome: 'success', changed: true });
  f.service.capture({ event: 'agent_turn_finished', runtime: 'stashbase', turn_id, outcome: 'success' });
  for (let index = 0; index < 130; index++) f.service.capture({ event: 'project_entry_result', outcome: 'failed', request_id: crypto.randomUUID() });
  await f.service.flush();
  const events = f.sent.map(({ body }) => body.event);
  assert.equal(events.filter(event => event === 'application_warning').length, 60);
  assert.equal(events.filter(event => event === 'http_request_lifecycle').length, 60);
  assert.equal(events.filter(event => event === 'project_entry_result').length, 119);
  for (const event of ['agent_turn_started', 'document_engaged', 'app_active', 'document_write_result', 'agent_turn_finished']) assert.ok(events.includes(event), event);
  f.service.close();
});

test('HTTP observation scopes do no eager storage work and retire across account or consent changes', async (t) => {
  const f = fixture();
  const read = t.mock.method(f.options, 'read');
  const write = t.mock.method(f.options, 'write');
  const observe = f.service.httpRequestObserver();
  assert.equal(read.mock.callCount(), 0);
  assert.equal(write.mock.callCount(), 0);
  const event = { event: 'http_request_lifecycle' as const, request_id: crypto.randomUUID(), state: 'closed' as const,
    elapsed_ms: 10, headers_sent: false, context: { method: 'GET', route: '/api/projects' } };
  observe(event);
  await tick();
  assert.equal(f.sent.filter(row => row.body.event === 'http_request_lifecycle').length, 1);
  const previousAccount = f.service.httpRequestObserver();
  account(f, 'A');
  account(f); // Even a same-clock switch back cannot revive an old scope.
  previousAccount(event);
  const previousConsent = f.service.httpRequestObserver();
  f.service.update({ enabled: false });
  const disabled = f.service.httpRequestObserver();
  disabled(event);
  f.service.update({ enabled: true });
  disabled(event);
  previousConsent(event);
  const receipt = f.service.captureRenderer({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), event } as never);
  assert.equal(receipt, 'discarded');
  await tick();
  assert.equal(f.sent.filter(row => row.body.event === 'http_request_lifecycle').length, 1);
  f.service.close();
});

test('rate limiting retains failed deliveries while permanent refusals do not block the queue', async () => {
  const f = fixture();
  let status = 429;
  const service = createTelemetry({ ...f.options, fetch: async () => new Response(null, { status }) });
  service.capture({ event: 'app_opened' });
  await service.flush();
  assert.equal(f.config().telemetry!.queue!.length, 1);
  status = 503;
  await service.flush();
  assert.equal(f.config().telemetry!.queue!.length, 1);
  status = 400;
  await service.flush();
  assert.equal(f.config().telemetry!.queue!.length, 0);
  assert.deepEqual(service.delivery()?.counters, { attempted: 1, accepted: 1, transport_failed: 2, rejected: 1 });
  service.capture({ event: 'document_write_result', outcome: 'success', changed: true });
  const checkpoint = structuredClone(f.config().telemetry!.queue![0].delivery);
  assert.equal(checkpoint?.counters.rejected, 1);
  service.close();
  const restarted = createTelemetry(f.options);
  await restarted.flush();
  assert.deepEqual(f.sent[0].body.properties.delivery, checkpoint);
  assert.equal(restarted.delivery()?.counters.delivered, 1);
  restarted.close();
  service.close(); f.service.close();
});

test('delivery checkpoints distinguish failed storage and admission loss without carrying counters across opt-out', async () => {
  const f = fixture();
  f.writeFails();
  f.service.capture({ event: 'app_opened' });
  assert.equal(f.service.delivery()?.counters.storage_failed, 1);
  f.writeFails(false);
  f.service.capture({ event: 'app_opened' });
  await f.service.flush();
  assert.equal(f.sent[0].body.properties.delivery.counters.storage_failed, 1);
  assert.equal(f.sent[0].body.properties.delivery.counters.attempted, 2);
  assert.equal(f.sent[0].body.properties.delivery.counters.accepted, 1);
  const first = f.service.delivery()!.series_id;
  f.service.update({ enabled: false });
  assert.equal(f.service.delivery(), null);
  f.service.capture({ event: 'app_active', mode: 'documents' });
  f.service.update({ enabled: true });
  f.service.capture({ event: 'app_active', mode: 'documents' });
  await f.service.flush();
  assert.notEqual(f.service.delivery()!.series_id, first);
  assert.equal(f.service.delivery()!.counters.storage_failed, undefined);
  f.service.close();
});

test('renderer checkpoints cannot backfill a prior account or disabled collection period', async () => {
  const f = fixture();
  f.advance(1);
  const delivery = { series_id: crypto.randomUUID(), started_at: new Date(f.options.now()).toISOString(), counters: { generated: 10 } };
  f.service.update({ enabled: false });
  f.advance(1);
  f.service.update({ enabled: true });
  f.advance(1);
  const request = { id: crypto.randomUUID(), timestamp: new Date(f.options.now()).toISOString(), event: { event: 'app_opened' as const }, delivery };
  assert.equal(f.service.captureRenderer(request), 'accepted');
  assert.equal(f.service.rendererDeliveryCurrent(request), false);
  await f.service.flush();
  assert.equal(f.sent[0].body.properties.renderer_delivery, undefined);
  f.advance(1);
  const current = { ...request, id: crypto.randomUUID(), timestamp: new Date(f.options.now()).toISOString(),
    event: { event: 'document_engaged' as const, activity: 'read' as const, format: 'html' as const },
    delivery: { ...delivery, started_at: new Date(f.options.now()).toISOString(), counters: { generated: 1 } } };
  assert.equal(f.service.captureRenderer(current), 'accepted');
  await f.service.flush();
  assert.deepEqual(f.sent.at(-1)!.body.properties.renderer_delivery, current.delivery);
  f.service.close();
});

test('a failed delivery checkpoint retains the acknowledged UUID and records storage loss on recovery', async () => {
  const f = fixture();
  f.service.capture({ event: 'app_opened' });
  f.writeFails();
  await f.service.flush();
  assert.equal(f.config().telemetry!.queue!.length, 1);
  assert.equal(f.service.delivery()?.counters.storage_failed, 1);
  f.writeFails(false);
  await f.service.flush();
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent[1].body, f.sent[0].body);
  assert.equal(f.service.delivery()?.counters.storage_failed, 1);
  assert.equal(f.config().telemetry!.queue!.length, 0);
  f.service.close();
});

test('queued events expire, queue capacity is bounded, and malformed disk payloads never leave', async () => {
  const f = fixture();
  const offline = createTelemetry({ ...f.options, fetch: async () => { throw new Error('offline'); } });
  for (let minute = 0; minute < 8; minute++) {
    for (let index = 0; index < 120; index++) offline.capture({ event: 'agent_turn_started', runtime: 'codex' });
    f.advance(60_000);
  }
  await offline.flush();
  assert.ok(f.config().telemetry!.queue!.length <= 500);
  assert.ok((offline.delivery()?.counters.queue_full ?? 0) > 0);
  const valid = f.config().telemetry!.queue![0];
  f.config().telemetry!.queue!.push({ ...valid, event: { event: 'app_opened', secret: 'private-content' } } as any);
  offline.close();
  for (let day = 0; day < 31; day++) f.nextDay();
  await f.service.flush();
  assert.equal(f.sent.length, 0);
  assert.equal(f.config().telemetry!.queue!.length, 0);
  assert.ok((f.service.delivery()?.counters.expired ?? 0) > 0);
  assert.equal(f.service.delivery()?.counters.invalid_queued, 1);
  f.service.close();
});

test('opt-out cancels an in-flight delivery, erases the queue and cannot replay it on re-enable', async () => {
  const f = fixture();
  let complete!: (value: Response) => void;
  let signal: AbortSignal | undefined;
  const service = createTelemetry({ ...f.options, fetch: async (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve) => { complete = resolve; });
  } });
  service.capture({ event: 'app_opened' });
  await tick();
  const old = f.config().telemetry!.installationId;
  const late = service.scoped();
  service.update({ enabled: false });
  assert.equal(signal?.aborted, true);
  assert.deepEqual(f.config().telemetry, { enabled: false });
  service.update({ enabled: true });
  late({ event: 'document_write_result', outcome: 'success', changed: true });
  complete(new Response(null, { status: 200 }));
  await tick();
  assert.equal(f.config().telemetry!.queue?.length ?? 0, 0);
  service.close();
  f.service.capture({ event: 'app_active', mode: 'documents' });
  await f.service.flush();
  assert.notEqual(f.config().telemetry!.installationId, old);
  assert.deepEqual(f.sent.map(({ body }) => body.event), ['app_active']);
  f.service.close();
});

test('host work finishes against its captured account without reverting a newer account or settings', async () => {
  const f = fixture();
  account(f, 'A');
  const finish = f.service.scoped();
  account(f, 'B');
  finish({ event: 'document_write_result', outcome: 'success', changed: true });
  await f.service.flush();
  assert.equal(f.sent.at(-1)!.body.distinct_id, 'user:A');
  assert.equal(f.config().telemetry!.userId, 'B');
  assert.equal(f.config().account!.session!.userId, 'B');
  assert.deepEqual(f.config().updates, { autoCheck: false });
  f.service.close();
});

test('active days continue without restarting; background diagnostics do not extend sessions', async () => {
  const f = fixture();
  const active = () => f.service.capture({ event: 'app_active', mode: 'documents' });
  active(); active();
  await f.service.flush();
  assert.equal(f.sent.length, 1);
  const firstSession = f.sent[0].body.properties.$session_id;
  f.advance(20 * 60_000);
  f.service.captureError(new Error('offline'), { source: 'server', operation: 'sync' });
  f.advance(11 * 60_000);
  active();
  await f.service.flush();
  assert.notEqual(f.sent.at(-1)!.body.properties.$session_id, firstSession);
  f.nextDay(); active();
  await f.service.flush();
  assert.equal(f.sent.filter(({ body }) => body.event === 'app_active').length, 3);
  f.service.close();
});

test('subscription polling reports state transitions, not repeated purchases', async () => {
  const f = fixture();
  account(f, 'A');
  const paid = { event: 'subscription_observed', plan: 'plus', paid: true, cancel_at_period_end: false } as const;
  f.service.capture(paid); f.service.capture(paid);
  await f.service.flush();
  assert.equal(f.sent.filter(({ body }) => body.event === 'subscription_observed').length, 1);
  f.service.capture({ ...paid, cancel_at_period_end: true });
  await f.service.flush();
  assert.equal(f.sent.filter(({ body }) => body.event === 'subscription_observed').length, 2);
  f.service.close();
});

test('a long Agent turn retains its initiating identity and session across account changes', async () => {
  const f = fixture();
  account(f, 'A');
  const turn_id = '11111111-1111-4111-8111-111111111111';
  f.service.capture({ event: 'agent_turn_started', runtime: 'codex', turn_id });
  account(f, 'B');
  f.service.capture({ event: 'agent_turn_finished', runtime: 'codex', turn_id, outcome: 'success', duration: '1m_to_5m' });
  await f.service.flush();
  const events = f.sent.filter(({ body }) => body.properties.turn_id === turn_id).map(({ body }) => body);
  assert.equal(events.length, 2);
  assert.equal(events[0].distinct_id, 'user:A');
  assert.equal(events[1].distinct_id, 'user:A');
  assert.equal(events[0].properties.$session_id, events[1].properties.$session_id);
  f.service.close();
});

test('Agent diagnostics join the initiating turn and account with the original provider cause', async (t) => {
  const { telemetry } = await import('./telemetry.ts');
  const { beginAgentDiagnosticTurn, reportAgentRuntimeError } = await import('./error-reporting.ts');
  const f = fixture();
  t.mock.method(telemetry, 'scoped', () => f.service.scoped());
  const connection = {};
  const turnId = 'd40d1b38-b5d1-4cf1-b82c-19370bbdbfa5';
  account(f, 'A');
  beginAgentDiagnosticTurn(connection, turnId, { model: 'fixture-model', native_session_id: 'native-session' });
  account(f, 'B');
  reportAgentRuntimeError('claude', { t: 'error', message: 'Usage limit reached', failure: { kind: 'allowance-exhausted' } }, connection,
    Object.assign(new Error('Provider daily limit resets tomorrow'), { status: 429, requestId: 'provider-request-42' }));
  await tick();
  const failure = f.sent.find((item) => item.body.event === 'application_error')!.body;
  assert.equal(failure.distinct_id, 'user:A');
  assert.equal(failure.properties.turn_id, turnId);
  assert.equal(failure.properties.context.native_session_id, 'native-session');
  assert.equal(failure.properties.diagnostic.code, 'allowance-exhausted');
  assert.equal(failure.properties.diagnostic.causes[0].request_id, 'provider-request-42');
  assert.equal(failure.properties.diagnostic.causes[0].http_status, 429);
  f.service.close();
});

test('oversized operation context cannot discard an otherwise actionable diagnostic', async () => {
  const f = fixture();
  f.service.captureError(Object.assign(new Error('Asset read denied'), { code: 'EACCES' }), {
    source: 'server', operation: 'http.asset', context: { method: 'GET', route: `/asset/${'nested/'.repeat(200)}image.png` },
  });
  await tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].body.properties.diagnostic.code, 'EACCES');
  assert.ok(f.sent[0].body.properties.context.route.length <= 500);
  assert.match(f.sent[0].body.properties.context.route, /image.png$/);
  f.service.close();
});


test('turn recovery retains the originating identity/version/distribution and never invents a completion time', async () => {
  const f = fixture();
  const turn_id = crypto.randomUUID();
  account(f, 'A');
  f.service.observeTurn(turn_id, { stage: 'host_accepted', runtime: 'stashbase' });
  f.advance(5000);
  f.service.observeTurn(turn_id, { stage: 'runtime_dispatched' });
  await f.service.flush();
  const pending = f.config().telemetry!.turns![0];
  f.service.close(); // No observed shutdown: simulate losing the host.
  account(f, 'B');
  f.advance(60_000);
  const recovered = createTelemetry({ ...f.options, version: 'next-version', distribution: 'packaged' });
  await recovered.flush();
  const result = f.sent.find(({ body }) => body.event === 'agent_turn_finished')!.body;
  assert.equal(result.distinct_id, 'user:A');
  assert.equal(result.properties.app_version, '2.7.0');
  assert.equal(result.properties.app_distribution, 'source');
  assert.equal(result.properties.last_observed_at, pending.observedAt);
  assert.equal(result.properties.outcome, 'interrupted');
  assert.equal(result.properties.reason, 'host_restarted');
  assert.ok(result.properties.recovered_at);
  assert.equal(result.properties.finished_at, undefined);
  assert.equal(result.properties.duration, undefined);
  recovered.capture({ event: 'agent_turn_finished', turn_id, runtime: 'stashbase', outcome: 'success' });
  recovered.capture({ event: 'agent_turn_started', turn_id, runtime: 'stashbase' });
  await recovered.flush();
  assert.equal(f.sent.filter(({ body }) => body.event === 'agent_turn_finished').length, 1);
  recovered.close();
});

test('host completion wins once even when its facts race ahead of the start request', async () => {
  const f = fixture();
  const turn_id = crypto.randomUUID();
  const connection_id = crypto.randomUUID();
  f.service.observeTurn(turn_id, { stage: 'host_accepted', context: { connection_id } });
  f.service.observeTurn(turn_id, { stage: 'runtime_dispatched' });
  f.service.observeTurn(turn_id, { outcome: 'success', reason: 'completed' });
  f.service.capture({ event: 'agent_turn_started', runtime: 'codex', turn_id });
  f.service.capture({ event: 'agent_turn_finished', runtime: 'codex', turn_id, outcome: 'failed' });
  await f.service.flush();
  const results = f.sent.filter(({ body }) => body.event === 'agent_turn_finished');
  assert.equal(results.length, 1);
  assert.equal(results[0].body.properties.outcome, 'success');
  assert.equal(results[0].body.properties.source, 'host');
  assert.equal(results[0].body.properties.context.connection_id, connection_id);
  assert.equal(f.config().telemetry!.turns!.length, 0);
  f.service.close();
});

test('all runtime acceptance paths persist turns without renderer intake and late starts cannot recount them', async (t) => {
  const { EventEmitter } = await import('node:events');
  const { telemetry } = await import('./telemetry.ts');
  const { attachAgentDiagnostics, beginAgentDiagnosticTurn, reportAgentRuntimeError } = await import('./error-reporting.ts');
  const f = fixture();
  t.after(() => f.service.close());
  t.mock.method(telemetry, 'scoped', () => f.service.scoped());
  t.mock.method(telemetry, 'observeTurn', f.service.observeTurn);
  for (const runtime of ['stashbase', 'claude', 'codex', 'antigravity'] as const) {
    account(f, 'A');
    const socket = new EventEmitter() as unknown as import('ws').WebSocket;
    const turn_id = crypto.randomUUID();
    attachAgentDiagnostics(socket, runtime);
    beginAgentDiagnosticTurn(socket, turn_id);
    const pending = f.config().telemetry!.turns!.find(turn => turn.turnId === turn_id)!;
    assert.equal(pending.stage, 'host_accepted');
    f.advance(1000);
    account(f, 'B');
    reportAgentRuntimeError(runtime, { t: 'turn-end', isError: false }, socket);
    f.advance(1);
    const late = { id: crypto.randomUUID(), timestamp: new Date(f.options.now()).toISOString(),
      event: { event: 'agent_turn_started' as const, runtime, turn_id } };
    assert.equal(f.service.captureRenderer(late), 'duplicate');
    f.service.capture({ event: 'agent_turn_finished', runtime, turn_id, outcome: 'failed' });
    await f.service.flush();
    const events = f.sent.filter(({ body }) => body.properties.turn_id === turn_id).map(({ body }) => body);
    const starts = events.filter(body => body.event === 'agent_turn_started');
    const finishes = events.filter(body => body.event === 'agent_turn_finished');
    assert.equal(starts.length, 1, runtime);
    assert.equal(starts[0].properties.source, 'host');
    assert.equal(starts[0].timestamp, pending.startedAt);
    assert.equal(finishes.length, 1, runtime);
    assert.equal(finishes[0].properties.outcome, 'success');
    assert.equal(finishes[0].distinct_id, 'user:A');
  }
  f.service.observeTurn(crypto.randomUUID(), { outcome: 'success', reason: 'completed' });
  assert.equal(f.config().telemetry!.turns!.length, 0);
});

test('an admitted turn reserves its terminal through queue saturation and diagnostic rate limiting', async () => {
  const f = fixture();
  const offline = createTelemetry({ ...f.options, fetch: async () => { throw new Error('offline'); } });
  const turn_id = crypto.randomUUID();
  offline.capture({ event: 'agent_turn_started', runtime: 'stashbase', turn_id });
  for (let minute = 0; minute < 6; minute++) {
    f.advance(60_000);
    for (let i = 0; i < 125; i++) offline.capture({ event: 'project_entry_result', outcome: 'success' });
  }
  offline.observeTurn(turn_id, { stage: 'tool_running' });
  offline.observeTurn(turn_id, { outcome: 'failed', reason: 'runtime_error' });
  offline.capture({ event: 'agent_turn_finished', runtime: 'stashbase', turn_id, outcome: 'success' });
  const queued = f.config().telemetry!.queue!;
  assert.ok(queued.length <= 500);
  const terminal = queued.filter(({ event }) => event.event === 'agent_turn_finished');
  assert.equal(terminal.length, 1);
  assert.equal((terminal[0].event as any).last_stage, 'tool_running');
  assert.equal(terminal[0].uuid, turn_id);
  offline.close();
  f.service.close();
});

test('opt-out clears pending and early turn facts and re-enable cannot backfill them', async () => {
  const f = fixture();
  const turn_id = crypto.randomUUID();
  f.service.capture({ event: 'agent_turn_started', runtime: 'claude', turn_id });
  f.service.observeTurn(crypto.randomUUID(), { outcome: 'success', reason: 'completed' });
  f.service.update({ enabled: false });
  assert.deepEqual(f.config().telemetry, { enabled: false });
  f.service.update({ enabled: true });
  f.service.observeTurn(turn_id, { outcome: 'success', reason: 'completed' });
  f.service.close('app_shutdown');
  const recovered = createTelemetry(f.options);
  await recovered.flush();
  assert.equal(f.sent.some(({ body }) => body.event === 'agent_turn_finished'), false);
  recovered.close();
});

test('an observed update shutdown is distinct from crash recovery and survives offline restart', async () => {
  const f = fixture();
  const offline = createTelemetry({ ...f.options, fetch: async () => { throw new Error('offline'); } });
  offline.capture({ event: 'agent_turn_started', runtime: 'stashbase', turn_id: crypto.randomUUID() });
  offline.close('app_update');
  const queued = structuredClone(f.config().telemetry!.queue!.at(-1)!);
  const recovered = createTelemetry(f.options);
  await recovered.flush();
  const terminal = f.sent.find(({ body }) => body.event === 'agent_turn_finished')!.body;
  assert.equal(terminal.properties.reason, 'app_update');
  assert.equal(terminal.properties.source, 'host');
  assert.equal(terminal.properties.recovered_at, undefined);
  assert.equal(terminal.uuid, queued.uuid);
  assert.equal(terminal.timestamp, queued.timestamp);
  recovered.close(); f.service.close();
});


test('runtime exit and socket loss settle independently of the renderer with bounded process evidence', async (t) => {
  const { EventEmitter } = await import('node:events');
  const { spawn } = await import('node:child_process');
  const { agentProcessExitDiagnostic } = await import('./agent-process.ts');
  const { telemetry } = await import('./telemetry.ts');
  const { attachAgentDiagnostics, beginAgentDiagnosticTurn, reportAgentRuntimeError } = await import('./error-reporting.ts');
  const f = fixture();
  t.mock.method(telemetry, 'scoped', () => f.service.scoped());
  t.mock.method(telemetry, 'observeTurn', f.service.observeTurn);
  const connection = new EventEmitter();
  const turn_id = crypto.randomUUID();
  f.service.capture({ event: 'agent_turn_started', runtime: 'stashbase', turn_id });
  attachAgentDiagnostics(connection as any, 'stashbase', crypto.randomUUID());
  beginAgentDiagnosticTurn(connection, turn_id);
  const child = spawn(process.execPath, ['-e', "process.stderr.write('native failure token=secret-value'); process.exitCode = 7"]);
  const diagnostic = agentProcessExitDiagnostic(child);
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.once('close', (code, signal) => resolve([code, signal])));
  reportAgentRuntimeError('stashbase', { t: 'error', message: 'Runtime exited' }, connection, diagnostic('Runtime exited', code, signal));
  connection.emit('close', 1006);
  await f.service.flush();
  const terminal = f.sent.filter(({ body }) => body.event === 'agent_turn_finished');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].body.properties.outcome, 'failed');
  const failure = f.sent.find(({ body }) => body.event === 'application_error')!.body;
  assert.equal(failure.properties.turn_id, turn_id);
  assert.equal(failure.properties.diagnostic.causes[0].exit_code, 7);
  assert.match(failure.properties.diagnostic.causes[0].stderr, /native failure/);
  assert.doesNotMatch(JSON.stringify(f.sent), /secret-value/);
  const second = new EventEmitter();
  const secondId = crypto.randomUUID();
  f.service.capture({ event: 'agent_turn_started', runtime: 'stashbase', turn_id: secondId });
  attachAgentDiagnostics(second as any, 'stashbase');
  beginAgentDiagnosticTurn(second, secondId);
  second.emit('close', 1006);
  await f.service.flush();
  assert.equal(f.sent.find(({ body }) => body.event === 'agent_turn_finished' && body.properties.turn_id === secondId)!.body.properties.outcome, 'interrupted');
  f.service.close();
});

test('window retirement cancels each runtime turn while an unexpected socket loss stays an error', async (t) => {
  const { AGENT_SESSION_CLOSE } = await import('../shared/agent-protocol.ts');
  const { EventEmitter } = await import('node:events');
  const { AgentSession } = await import('./agent.ts');
  const { CodexSession } = await import('./codex-session-runtime.ts');
  const { AntigravitySession } = await import('./antigravity-session-runtime.ts');
  const { OpenCodePanelSession } = await import('./opencode-agent.ts');
  const { liveSessionSet } = await import('./agent-session-registry.ts');
  const { telemetry } = await import('./telemetry.ts');
  const { attachAgentDiagnostics, beginAgentDiagnosticTurn } = await import('./error-reporting.ts');
  const f = fixture();
  t.after(() => f.service.close());
  t.mock.method(telemetry, 'scoped', () => f.service.scoped());
  t.mock.method(telemetry, 'observeTurn', f.service.observeTurn);
  class Socket extends EventEmitter {
    OPEN = 1;
    readyState = 1;
    send() {}
    closeReason = '';
    close(code = 1000, reason = '') {
      if (this.readyState === 3) return;
      this.closeReason = reason;
      this.readyState = 3;
      this.emit('close', code);
    }
  }
  for (const runtime of ['stashbase', 'claude', 'codex', 'antigravity'] as const) {
    for (const reason of ['window', 'client', 'unexpected', 'socket-error'] as const) {
      const socket = new Socket();
      const ws = socket as unknown as import('ws').WebSocket;
      const windowId = crypto.randomUUID();
      attachAgentDiagnostics(ws, runtime, undefined, windowId);
      const session = runtime === 'claude' ? new AgentSession(ws, windowId)
        : runtime === 'codex' ? new CodexSession(ws, windowId)
        : runtime === 'antigravity' ? new AntigravitySession(ws, windowId, undefined, undefined, undefined, undefined, undefined)
        : new OpenCodePanelSession(ws, { windowId, folder: '/workspace' }, {
          models: async () => [], client: async () => new Promise<never>(() => {}),
          beginTurn() {}, endTurn() {}, tools: () => [], complete: async () => '',
          runTool: async () => ({ text: '', tool: '', model: '' }), onExit: () => () => {}, close: async () => {},
        });
      const turn_id = crypto.randomUUID();
      f.service.capture({ event: 'agent_turn_started', runtime, turn_id });
      beginAgentDiagnosticTurn(ws, turn_id);
      if (reason === 'window') {
        const sessions = liveSessionSet<typeof session>();
        sessions.add(session);
        sessions.killWindow(windowId);
      } else if (reason === 'client') socket.emit('message', Buffer.from('{"t":"close"}'));
      else if (reason === 'socket-error') {
        socket.emit('error', Object.assign(new Error('socket failed'), { code: 'ECONNRESET' }));
        socket.close(1006);
      }
      else socket.close(1001); // The close code alone does not prove user intent.
      await f.service.flush();
      const events = f.sent.filter(({ body }) => body.properties.turn_id === turn_id).map(({ body }) => body);
      const terminal = events.find(event => event.event === 'agent_turn_finished')!;
      const lost = reason === 'unexpected' || reason === 'socket-error';
      if (!lost) assert.equal(socket.closeReason, AGENT_SESSION_CLOSE.reason, `${runtime}: ${reason}`);
      assert.equal(terminal.properties.outcome, lost ? 'interrupted' : 'cancelled', `${runtime}: ${reason}`);
      assert.equal(events.some(event => event.event === 'application_error'), lost, `${runtime}: ${reason}`);
      const closed = events.find(event => event.event === 'agent_connection_closed')!;
      assert.equal(closed.properties.context.close_reason,
        reason === 'window' ? 'session_disposed' : reason === 'client' ? 'client_close'
          : reason === 'socket-error' ? 'socket_error' : 'socket_closed');
    }
  }
});

test('tool results count distinct per-turn workload without changing recovered and cancelled outcomes', async (t) => {
  const { EventEmitter } = await import('node:events');
  const { telemetry } = await import('./telemetry.ts');
  const { attachAgentDiagnostics, beginAgentDiagnosticTurn, reportAgentRuntimeError } = await import('./error-reporting.ts');
  const f = fixture();
  t.mock.method(telemetry, 'scoped', () => f.service.scoped());
  t.mock.method(telemetry, 'observeTurn', f.service.observeTurn);
  const connection = new EventEmitter();
  attachAgentDiagnostics(connection as any, 'claude');
  const start = () => {
    const id = crypto.randomUUID();
    f.service.capture({ event: 'agent_turn_started', runtime: 'claude', turn_id: id });
    beginAgentDiagnosticTurn(connection, id);
    return id;
  };
  const first = start();
  reportAgentRuntimeError('claude', { t: 'tool', id: 'tool-1', name: 'mcp__stashbase__search_project', input: { private: 'PRIVATE INPUT' } }, connection);
  reportAgentRuntimeError('claude', { t: 'tool-result', id: 'tool-1', content: 'PRIVATE OUTPUT', isError: true }, connection);
  reportAgentRuntimeError('claude', { t: 'tool', id: 'tool-1', name: 'mcp__stashbase__search_project', input: {} }, connection);
  reportAgentRuntimeError('claude', { t: 'tool-result', id: 'tool-1', content: 'PRIVATE DUPLICATE', isError: true }, connection);
  for (const [index, name] of ['stashbase:read_file', 'File change', 'MultiEdit', 'Web search', 'Bash', 'Task'].entries()) {
    const id = `successful-${index}`;
    reportAgentRuntimeError('claude', { t: 'tool', id, name, input: { private: 'PRIVATE INPUT' } }, connection);
    reportAgentRuntimeError('claude', { t: 'tool-result', id, content: 'PRIVATE OUTPUT', isError: false }, connection);
    reportAgentRuntimeError('claude', { t: 'tool-result', id, content: 'PRIVATE DUPLICATE', isError: false }, connection);
  }
  reportAgentRuntimeError('claude', { t: 'turn-end', isError: false }, connection);
  const second = start();
  reportAgentRuntimeError('claude', { t: 'tool', id: 'tool-1', name: 'read', input: {} }, connection);
  reportAgentRuntimeError('claude', { t: 'tool-result', id: 'tool-1', content: 'PRIVATE OUTPUT', isError: false }, connection);
  connection.emit('message', Buffer.from('{"t":"interrupt"}'));
  reportAgentRuntimeError('claude', { t: 'turn-end', isError: false }, connection);
  await f.service.flush();
  const outcomes = f.sent.filter(({ body }) => body.event === 'agent_turn_finished');
  assert.deepEqual(outcomes.map(({ body }) => [body.properties.turn_id, body.properties.outcome]), [[first, 'success'], [second, 'cancelled']]);
  assert.deepEqual(outcomes[0].body.properties.tool_summary, {
    success: 6, failed: 1, limited: false, by_category: {
      search: { success: 1, failed: 1 }, read: { success: 1, failed: 0 }, write: { success: 2, failed: 0 },
      shell: { success: 1, failed: 0 }, agent: { success: 1, failed: 0 },
    },
  });
  assert.deepEqual(outcomes[1].body.properties.tool_summary, {
    success: 1, failed: 0, limited: false, by_category: { read: { success: 1, failed: 0 } },
  });
  assert.equal(f.sent.filter(({ body }) => body.properties.operation === 'tool').length, 1);
  assert.equal(f.sent.find(({ body }) => body.properties.operation === 'tool')!.body.properties.context.tool_category, 'search');
  assert.doesNotMatch(JSON.stringify(f.sent), /PRIVATE/);
  f.service.close();
});

test('bounded tool counts survive crash recovery without filling the queue or trusting renderer totals', async () => {
  const { AGENT_TOOL_RESULT_LIMIT, rendererTelemetryEventSchema } = await import('../shared/protocols/http/telemetry.ts');
  const f = fixture();
  const turn_id = crypto.randomUUID();
  f.service.observeTurn(turn_id, { stage: 'host_accepted', runtime: 'codex' });
  const before = f.config().telemetry!.queue!.length;
  for (let index = 0; index <= AGENT_TOOL_RESULT_LIMIT; index++) {
    f.service.observeTurn(turn_id, { tool_result: { call_id: `tool-${index}`, category: 'read', outcome: 'success' } });
  }
  f.service.observeTurn(turn_id, { tool_result: { call_id: 'tool-0', category: 'write', outcome: 'failed' } });
  assert.equal(f.config().telemetry!.queue!.length, before, 'successful tool results consume no queue slots');
  const pending = f.config().telemetry!.turns![0];
  assert.equal(pending.toolCallIds!.length, AGENT_TOOL_RESULT_LIMIT);
  assert.deepEqual(pending.toolSummary, { success: AGENT_TOOL_RESULT_LIMIT, failed: 0,
    by_category: { read: { success: AGENT_TOOL_RESULT_LIMIT, failed: 0 } }, limited: true });
  assert.equal(rendererTelemetryEventSchema.safeParse({ event: 'agent_turn_finished', runtime: 'codex',
    turn_id, outcome: 'success', tool_summary: pending.toolSummary }).success, false);
  f.service.close();
  const restarted = createTelemetry(f.options);
  await restarted.flush();
  const terminal = f.sent.find(({ body }) => body.event === 'agent_turn_finished')!.body;
  assert.equal(terminal.properties.outcome, 'interrupted');
  assert.deepEqual(terminal.properties.tool_summary, pending.toolSummary);
  assert.doesNotMatch(JSON.stringify(f.sent), /tool-\d/);
  restarted.close();
});

test('tool failure diagnostics retain only a bounded failure category, never tool output', async (t) => {
  const { EventEmitter } = await import('node:events');
  const { telemetry } = await import('./telemetry.ts');
  const { attachAgentDiagnostics, reportAgentRuntimeError } = await import('./error-reporting.ts');
  const { toolResultFromItem } = await import('./codex-protocol.ts');
  const f = fixture();
  t.mock.method(telemetry, 'scoped', () => f.service.scoped());
  const connection = new EventEmitter();
  attachAgentDiagnostics(connection as any, 'stashbase');
  const failures = [
    ['Error: File not found: C:/PRIVATE/document.txt', 'not_found'],
    ['ENOENT: no such file or directory, open PRIVATE', 'not_found'],
    ['Error: EACCES: permission denied, open PRIVATE', 'permission_denied'],
    ['Error: Permission denied for PRIVATE', 'permission_denied'],
    ['Error: Invalid arguments: PRIVATE', 'invalid_arguments'],
    ['Error: Operation timed out: PRIVATE', 'timeout'],
    [toolResultFromItem({ type: 'mcpToolCall', id: 'native-error', status: 'failed',
      error: { code: 'ENOENT', message: 'PRIVATE source could not be opened' } })!.content, 'not_found'],
    [toolResultFromItem({ type: 'mcpToolCall', id: 'native-error', status: 'failed',
      error: { message: 'Error: EACCES: permission denied, open PRIVATE' } })!.content, 'permission_denied'],
    [JSON.stringify({ error: { message: 'Request timed out: PRIVATE' } }), 'timeout'],
    ['PRIVATE source text mentions file not found', 'unknown'],
    [JSON.stringify({ message: 'PRIVATE source text mentions file not found', content: 'ENOENT PRIVATE' }), 'unknown'],
    [JSON.stringify({ content: [{ text: 'File not found: PRIVATE' }] }), 'unknown'],
  ];
  for (const [index, [content]] of failures.entries()) {
    const id = `call-${index}`;
    reportAgentRuntimeError('stashbase', { t: 'tool', id, name: 'read', input: { path: 'PRIVATE' } }, connection);
    reportAgentRuntimeError('stashbase', { t: 'tool-result', id, content, isError: true }, connection);
  }
  await f.service.flush();
  const events = f.sent.filter(({ body }) => body.properties.operation === 'tool');
  assert.deepEqual(events.map(({ body }) => body.properties.context.tool_failure_kind), failures.map(([, kind]) => kind));
  assert.ok(events.every(({ body }) => body.properties.context.tool_category === 'read'));
  assert.doesNotMatch(JSON.stringify(f.sent), /PRIVATE|document\.txt|ENOENT|EACCES/);
  f.service.close();
});

test('startup attempts retain initiating scope, successful latency and retry linkage through delivery', async () => {
  const { diagnosticScope } = await import('./diagnostic-context.ts');
  const { rendererTelemetryEventSchema } = await import('../shared/protocols/http/telemetry.ts');
  const f = fixture();
  const request_id = crypto.randomUUID();
  const attempt_id = crypto.randomUUID();
  const turn_id = crypto.randomUUID();
  const capture = diagnosticScope.run({ request_id, turn_id, context: { method: 'GET', route: '/api/agents/:agent/sessions' } }, () => f.service.scoped());
  capture({ event: 'agent_runtime_start_result', runtime: 'stashbase', purpose: 'history', outcome: 'failed',
    stage: 'waiting_ready', attempt_id, elapsed_ms: 15_050,
    timings: { prepare_ms: 10, spawn_ms: 20, ready_wait_ms: 15_000, cleanup_ms: 20 },
    diagnostic: { message: 'timeout', stderr: 'database busy token=PRIVATE_SECRET' } });
  const success = { event: 'agent_runtime_start_result', runtime: 'stashbase', purpose: 'history', outcome: 'success',
    stage: 'ready', attempt_id: crypto.randomUUID(), retry_of: attempt_id, elapsed_ms: 2100, first_output_ms: 2099 } as const;
  capture(success);
  assert.equal(rendererTelemetryEventSchema.safeParse(success).success, false, 'native startup is a host fact');
  await f.service.flush();
  const starts = f.sent.filter(({ body }) => body.event === 'agent_runtime_start_result');
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0].body.properties.timings,
    { prepare_ms: 10, spawn_ms: 20, ready_wait_ms: 15_000, cleanup_ms: 20 });
  assert.ok(starts.every(({ body }) => body.properties.request_id === request_id && body.properties.turn_id === turn_id));
  assert.equal(starts[1].body.properties.retry_of, attempt_id);
  assert.equal(starts[1].body.properties.elapsed_ms, 2100);
  assert.doesNotMatch(JSON.stringify(starts), /PRIVATE_SECRET/);
  f.service.update({ enabled: false });
  capture(success);
  await f.service.flush();
  assert.equal(f.sent.filter(({ body }) => body.event === 'agent_runtime_start_result').length, 2);
  f.service.close();
});


test('a refused context request carries only its explicitly supplied turn ID', async () => {
  const { httpErrorReporting } = await import('./error-reporting.ts');
  const f = fixture();
  const app = express(); app.use(httpErrorReporting(f.service));
  app.get('/api/project/agent-context-file', (_req, res) => res.status(415).json({ error: 'unsupported format' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const id = crypto.randomUUID();
  try {
    const url = `http://127.0.0.1:${address.port}/api/project/agent-context-file`;
    await fetch(url, { headers: { 'x-stashbase-agent-turn-id': id } });
    await fetch(url);
    await f.service.flush();
    const failures = f.sent.filter(({ body }) => body.event === 'application_warning');
    assert.equal(failures.length, 2);
    assert.equal(failures[0].body.properties.turn_id, id);
    assert.equal(failures[1].body.properties.turn_id, undefined);
    assert.equal(failures[0].body.properties.diagnostic.http_status, 415);
  } finally { f.service.close(); server.closeAllConnections(); server.close(); }
});
