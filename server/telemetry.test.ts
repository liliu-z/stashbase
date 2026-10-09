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

test('test launches suppress every event without changing saved preferences, including through Electron', () => {
  for (const [packaged, disabled] of [['1', '1'], ['1', '0'], ['0', '0']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import './server/__tests__/isolated-home.ts';
      import assert from 'node:assert/strict';
      import { createServerChildEnvironment } from './electron/main-probe.cjs';

      const packaged = process.env.STASHBASE_PACKAGED === '1';
      const available = packaged && process.env.STASHBASE_TELEMETRY_DISABLED !== '1';
      Object.assign(process.env, createServerChildEnvironment({
        baseEnv: process.env, packaged,
        packagedEnv: { STASHBASE_PACKAGED: packaged ? '1' : '0' },
        shutdownToken: 'test-shutdown', oauthReturnToken: 'test-oauth', instanceId: 'test',
      }));
      const sent = [];
      // Replace the outbound transport before importing the production owner.
      // Even the positive control must never contact the production destination.
      globalThis.fetch = async (_url, init) => {
        sent.push(JSON.parse(init.body).event);
        return new Response(null, { status: 200 });
      };
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
      await tick();
      assert.deepEqual(sent, available ? ['app_opened', 'agent_turn_started', 'document_write_result'] : []);
      assert.deepEqual(telemetry.preferences(), { enabled: true, available });
      if (!available) assert.deepEqual(readAppConfigStrict(), saved);

      telemetry.update({ enabled: false });
      telemetry.update({ enabled: true });
      telemetry.capture({ event: 'project_entry_result', outcome: 'success' });
      await tick();
      assert.deepEqual(sent, available ? [
        'app_opened', 'agent_turn_started', 'document_write_result',
        'project_entry_result',
      ] : []);
      if (!available) assert.deepEqual(readAppConfigStrict(), { telemetry: { enabled: true } });
      telemetry.close();
    `], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, STASHBASE_PACKAGED: packaged, STASHBASE_TELEMETRY_DISABLED: disabled },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 0, `packaged=${packaged}, disabled=${disabled}\n${result.stderr}`);
  }
});

function fixture(available = true) {
  let config: AppConfigFile = { updates: { autoCheck: false } };
  let readFails = false;
  let writeFails = false;
  let now = Date.UTC(2026, 8, 15);
  const sent: Array<{ body: Record<string, any>; signal: AbortSignal }> = [];
  const options = {
    available, projectToken: 'phc_test', host: 'https://example.test', version: '2.7.0', os: 'linux',
    read() { if (readFails) throw new Error('private config path'); return structuredClone(config); },
    write(next: AppConfigFile) { if (writeFails) throw new Error('private config path'); config = structuredClone(next); },
    now: () => now,
    fetch: (async (_url, init) => {
      sent.push({ body: JSON.parse(String(init?.body)), signal: init?.signal as AbortSignal });
      return new Response(null, { status: 200 });
    }) as typeof fetch,
  };
  return { service: createTelemetry(options), options, sent,
    config: () => config,
    setConfig: (next: AppConfigFile) => { config = next; },
    readFails: () => { readFails = true; },
    writeFails: () => { writeFails = true; },
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
  assert.equal(f.sent[0].body.properties.schema_version, 3);
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

test('read errors, malformed preferences, development builds, and failed disable persistence do not send', async () => {
  for (const kind of ['read', 'malformed', 'dev', 'write'] as const) {
    const f = fixture(kind !== 'dev');
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

test('HTTP boundary refuses arbitrary fields and never exposes the installation ID', async () => {
  const f = fixture();
  const app = express(); app.use(express.json()); mount(app, f.service);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/api/telemetry`;
  try {
    const post = (path: string, body: unknown, method = 'POST') => fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('/events', { event: 'agent_turn_started', runtime: 'codex', prompt: 'private' })).status, 400);
    assert.equal((await post('', { enabled: false, installationId: 'injected' }, 'PUT')).status, 400);
    assert.equal((await post('/events', { event: 'app_opened' })).status, 204);
    assert.deepEqual(await (await fetch(url)).json(), { enabled: true, available: true });
    assert.equal((await post('', { enabled: false }, 'PUT')).status, 200);
    assert.equal(f.config().telemetry?.enabled, false);
  } finally { f.service.close(); server.closeAllConnections(); server.close(); }
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
  assert.equal(diagnostic.code, 'ECONNREFUSED');
  assert.equal(diagnostic.exit_code, 13);
  assert.match(diagnostic.message, /Installer failed/);
  assert.match(diagnostic.stack, /\[frame\]:10:4/);
  const payload = JSON.stringify(f.sent[0].body);
  for (const value of ['Jane Doe', 'secret.txt', 'private project', 'private.example', 'hidden-token', 'secret-token-value', 'user@example.com']) assert.equal(payload.includes(value), false, value);
  f.service.update({ enabled: false });
  f.service.captureError(new Error('another failure'), { source: 'server', operation: 'sync' });
  await tick();
  assert.deepEqual(f.sent.map((entry) => entry.body.event), ['application_error']);
  f.service.close();
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
  assert.equal(JSON.stringify(f.sent).includes('/Users/private'), false);
  f.service.close();
});

test('HTTP failures report their operation without request bodies, paths, or a second event', async () => {
  const { httpErrorReporting } = await import('./error-reporting.ts');
  const { sendError } = await import('./http.ts');
  const f = fixture();
  const app = express(); app.use(express.json()); app.use(httpErrorReporting(f.service));
  app.post('/api/files/*', (_req, res) => sendError(res, Object.assign(new Error('Cannot write /private/customer.md'), { code: 'EACCES' })));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/files/customer.md?folder=private-project`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'private document content' }),
    });
    assert.equal(response.status, 500);
    await tick();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].body.properties.operation, 'http.files');
    assert.equal(f.sent[0].body.properties.diagnostic.http_status, 500);
    assert.equal(f.sent[0].body.properties.diagnostic.code, 'EACCES');
    for (const value of ['customer.md', 'private-project', 'private document content']) assert.equal(JSON.stringify(f.sent).includes(value), false);
  } finally { f.service.close(); server.closeAllConnections(); server.close(); }
});


test('automatic diagnostics never retain unquoted names or relative paths', async () => {
  const f = fixture();
  for (const message of [
    'rename_folder: conversion rediscovery failed for Acquisition Target Orion: database is locked',
    'failed to update links in Acquisition Plan.md',
    'save: index update failed for Acme Merger Plan.md: provider failed',
    'attach: write Private Acquisition.odt failed: EACCES',
    'SecretProject/subdir',
  ]) f.service.captureError({ message, code: 'CustomerSecret', name: 'CustomerSecret' }, { source: 'server', operation: 'AcquisitionSecret' });
  await tick();
  assert.ok(f.sent.length > 0);
  const payload = JSON.stringify(f.sent);
  for (const value of ['Acquisition', 'Orion', 'Acme', 'Merger', 'Private', 'SecretProject', 'CustomerSecret']) assert.equal(payload.includes(value), false, value);
  assert.match(payload, /Database is locked/);
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
    refreshToken: 'secret-refresh', expiresAt: 9999999999 } } : {};
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

test('offline queue survives restart and keeps occurrence identity, time, version and UUID', async () => {
  const f = fixture();
  const offline = createTelemetry({ ...f.options, fetch: async () => { throw new Error('offline'); } });
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
  assert.equal(f.config().telemetry!.queue!.length, 0);
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
  service.close(); f.service.close();
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
  const valid = f.config().telemetry!.queue![0];
  f.config().telemetry!.queue!.push({ ...valid, event: { event: 'app_opened', secret: 'private-content' } } as any);
  offline.close();
  for (let day = 0; day < 8; day++) f.nextDay();
  await f.service.flush();
  assert.equal(f.sent.length, 0);
  assert.equal(f.config().telemetry!.queue!.length, 0);
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
