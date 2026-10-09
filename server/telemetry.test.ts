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
        'telemetry_disabled', 'project_entry_result',
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
  assert.deepEqual(f.sent[0].body.properties, { app_version: '2.7.0', os: 'linux', schema_version: 2,
    $process_person_profile: false, $geoip_disable: true, $ip: null });
  assert.equal(f.sent[0].body.distinct_id, f.config().telemetry?.installationId);
  assert.deepEqual(f.config().updates, { autoCheck: false });
  f.service.close();
});

test('opt-out persists first, discards pending events, sends one final signal, and rotates on re-enable', async () => {
  const f = fixture();
  f.service.capture({ event: 'app_opened' });
  await tick();
  const oldId = f.sent[0].body.distinct_id;
  f.service.capture({ event: 'agent_turn_started', runtime: 'codex' });
  assert.equal(f.service.update({ enabled: false }).enabled, false);
  assert.equal(f.config().telemetry?.installationId, undefined);
  f.service.capture({ event: 'agent_turn_started', runtime: 'codex' });
  await tick();
  assert.deepEqual(f.sent.map((entry) => entry.body.event), ['app_opened', 'telemetry_disabled']);
  assert.equal(f.sent[1].body.distinct_id, oldId);
  const restarted = createTelemetry(f.options);
  restarted.capture({ event: 'app_opened' });
  await tick();
  assert.equal(f.sent.length, 2);
  restarted.update({ enabled: true });
  restarted.capture({ event: 'app_opened' });
  await tick();
  assert.notEqual(f.sent[2].body.distinct_id, oldId);
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

test('document saves are coalesced across process restarts and reset on the next UTC day', async () => {
  const f = fixture();
  for (let i = 0; i < 50; i++) f.service.capture({ event: 'document_write_result', outcome: 'success' });
  f.service.capture({ event: 'document_write_result', outcome: 'conflict' });
  await tick();
  assert.equal(f.sent.length, 2);
  const restarted = createTelemetry(f.options);
  restarted.capture({ event: 'document_write_result', outcome: 'success' });
  await tick();
  assert.equal(f.sent.length, 2);
  f.nextDay();
  restarted.capture({ event: 'document_write_result', outcome: 'success' });
  await tick();
  assert.equal(f.sent.length, 3);
  restarted.close(); f.service.close();
});

test('offline final notifications are attempted once without blocking preferences or retrying', async () => {
  const f = fixture();
  let calls = 0;
  const service = createTelemetry({ ...f.options, fetch: (async () => { calls++; throw new Error('offline'); }) as typeof fetch });
  service.capture({ event: 'app_opened' });
  await tick();
  service.update({ enabled: false });
  await tick(); await tick();
  assert.equal(calls, 2);
  assert.equal(service.preferences().enabled, false);
  service.close();
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
  assert.deepEqual(f.sent.map((entry) => entry.body.event), ['application_error', 'telemetry_disabled']);
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
