import './__tests__/isolated-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createServerStartTelemetry } from './server-start-telemetry.ts';
import { initialUsageIdentity, clearServerStartTelemetry } from './telemetry-bootstrap.ts';
import { createTelemetry } from './telemetry.ts';
import { QUEUE_TTL, usageIdentity } from './telemetry-state.ts';
import type { AppConfigFile } from './app-config.ts';
import { rendererTelemetryEventSchema } from '../shared/protocols/http/telemetry.ts';

const { startServer } = createRequire(import.meta.url)('../electron/main-probe.cjs');
function fixture(t: { after(fn: () => void): void }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-server-start-'));
  let config: AppConfigFile = {};
  let time = Date.now();
  const sent: any[] = [];
  const read = () => structuredClone(config);
  const write = (next: AppConfigFile) => { config = structuredClone(next); };
  const now = () => time;
  const transport: typeof fetch = async (_url, init) => {
    sent.push(...JSON.parse(String(init?.body)).batch);
    return new Response(null, { status: 200 });
  };
  const options = { directory, available: true, version: 'test-original', distribution: 'packaged' as const,
    read, now, monotonicNow: now, fetch: transport };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, sent, read, write, now, advance(ms: number) { time += ms; }, options,
    records: () => fs.existsSync(path.join(directory, 'events'))
      ? fs.readdirSync(path.join(directory, 'events')).map(file => JSON.parse(fs.readFileSync(path.join(directory, 'events', file), 'utf8'))) : [] };
}

test('first-launch timeout reaches transport without a host or renderer and joins a later signed-in host', async t => {
  const f = fixture(t);
  const reporter = createServerStartTelemetry(f.options);
  const appSessionId = randomUUID();
  const attempt = reporter.begin(appSessionId);
  await reporter.flush(); // The initiated fact must leave before any host exists.
  assert.equal(f.sent[0].event, 'server_start_initiated');
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  let processId: string | undefined;
  try {
    await startServer({ packaged: true, port: 8090, timeoutMs: 10_000,
      now: f.now, sleep: async (ms: number) => f.advance(ms),
      onStage: attempt.stage,
      spawn: (id: string) => { processId = id; return child; },
      probe: async () => ({ compatible: false, occupied: false, probe_result: 'connection_refused' }),
    });
    assert.fail('must fail readiness');
  } catch (error) {
    attempt.failed(error, (error as any).startupContext);
  }
  await reporter.settle();
  assert.deepEqual(f.sent.map(event => event.event), ['server_start_initiated', 'server_start_failed']);
  const failed = f.sent[1];
  assert.equal(failed.properties.elapsed_ms, 10_000);
  assert.equal(failed.properties.stage, 'waiting_ready');
  assert.equal(failed.properties.context.probe_result, 'connection_refused');
  assert.equal(failed.properties.context.process_start_id, processId);
  assert.match(failed.properties.diagnostic.message, /within 10s/);
  assert.equal(failed.properties.app_session_id, appSessionId);
  assert.equal(failed.properties.attempt_id, f.sent[0].properties.attempt_id);
  assert.equal(failed.distinct_id, f.sent[0].distinct_id);
  assert.deepEqual(f.read(), {}, 'main never writes host app-config');

  const host = createTelemetry({ ...f.options, os: process.platform, projectToken: 'fixture', host: 'https://example.invalid',
    write: f.write, initialIdentity: () => initialUsageIdentity(f.directory, f.now()),
    clearStartup: () => clearServerStartTelemetry(f.directory) });
  try {
    host.capture({ event: 'app_opened' });
    await host.flush();
    const opened = f.sent.find(event => event.event === 'app_opened');
    assert.equal(opened.distinct_id, failed.distinct_id);
    assert.equal(opened.properties.installation_id, failed.properties.installation_id);
    f.write({ ...f.read(), account: { session: { userId: 'signed-in-user' } } } as AppConfigFile);
    host.identityChanged();
    await host.flush();
    const identify = f.sent.find(event => event.event === '$identify');
    assert.equal(identify.distinct_id, 'user:signed-in-user');
    assert.equal(identify.properties.$anon_distinct_id, failed.distinct_id);
    host.update({ enabled: false });
    assert.equal(fs.existsSync(path.join(f.directory, 'identity.json')), false);
    host.update({ enabled: true });
    host.capture({ event: 'app_opened' });
    await host.flush();
    assert.notEqual(f.read().telemetry?.anonymousId, failed.distinct_id);
  } finally { host.close(); }
});

test('successful owned startup and source reuse each produce one terminal event; renderer cannot forge them', async t => {
  const f = fixture(t);
  const reporter = createServerStartTelemetry(f.options);
  for (const reused of [false, true]) {
    const attempt = reporter.begin(randomUUID());
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
    const result = await startServer({ packaged: !reused, port: 8090,
      onStage: attempt.stage,
      spawn: () => child,
      probe: async (id?: string) => ({ compatible: reused || !!id, occupied: reused || !!id }),
    });
    f.advance(425);
    attempt.success(!result);
    attempt.success(!result);
    attempt.failed(new Error('late failure'));
    await reporter.settle();
  }
  const successes = f.sent.filter(event => event.event === 'server_start_success');
  assert.equal(successes.length, 2);
  assert.deepEqual(successes.map(event => event.properties.reused), [false, true]);
  assert.ok(successes.every(event => event.properties.elapsed_ms === 425 && event.properties.stage === 'ready'));
  assert.equal(f.sent.some(event => event.event === 'server_start_failed'), false);
  assert.equal(rendererTelemetryEventSchema.safeParse({ event: 'server_start_success', app_session_id: randomUUID(),
    attempt_id: randomUUID(), stage: 'ready', elapsed_ms: 425, reused: false }).success, false);
});

test('offline failure retries with original identity, UUID, timestamp, version and redacted errors', async t => {
  const f = fixture(t);
  const offline = createServerStartTelemetry({ ...f.options, fetch: async () => { throw new Error('offline'); } });
  const attempt = offline.begin(randomUUID());
  f.advance(50);
  attempt.stage('spawn');
  attempt.failed(new Error('failed token=secret-value'));
  await offline.settle();
  const records = f.records();
  assert.equal(records.length, 2);
  assert.ok(!JSON.stringify(records).includes('secret-value'));
  f.advance(1000);
  // No sign-in or installation state has been persisted by a host yet.
  const next = createServerStartTelemetry({ ...f.options, version: 'test-upgraded' });
  await next.flush();
  for (const record of records) {
    const delivered = f.sent.find(event => event.uuid === record.uuid);
    assert.equal(delivered.timestamp, record.timestamp);
    assert.equal(delivered.properties.app_version, 'test-original');
    assert.equal(delivered.distinct_id, record.anonymousId);
  }
  assert.deepEqual(f.records(), []);
});

test('port conflicts and synchronous spawn errors retain their distinct stages and attempt IDs', async t => {
  const f = fixture(t);
  const reporter = createServerStartTelemetry(f.options);
  const appSession = randomUUID();
  for (const occupied of [true, false]) {
    const attempt = reporter.begin(appSession);
    try {
      await startServer({ packaged: true, port: 8090, onStage: attempt.stage,
        probe: async () => ({ occupied, compatible: false }),
        spawn: () => { throw new Error('spawn permission denied'); },
      });
      assert.fail('startup must fail');
    } catch (error) { attempt.failed(error); }
    await reporter.settle();
  }
  const failures = f.sent.filter(event => event.event === 'server_start_failed');
  assert.deepEqual(failures.map(event => event.properties.stage), ['arbitration', 'spawn']);
  assert.notEqual(failures[0].properties.attempt_id, failures[1].properties.attempt_id);
  assert.ok(failures.every(event => event.properties.app_session_id === appSession));
});

test('a permanently refused singleton cannot prevent delivery of the next startup event', async t => {
  const f = fixture(t);
  let requests = 0;
  const reporter = createServerStartTelemetry({ ...f.options, fetch: async (url, init) => {
    if (++requests === 1) return new Response(null, { status: 400 });
    return f.options.fetch(url, init);
  } });
  const attempt = reporter.begin(randomUUID());
  f.advance(1); // Keep the refused initiation first when the spool sorts by occurrence time.
  attempt.failed(new Error('original failure'));
  await reporter.settle();
  assert.equal(f.sent.at(-1).event, 'server_start_failed');
  assert.deepEqual(f.records(), []);
});

test('opt-out aborts an in-flight request, erases seed and events, and cannot send a terminal event', async t => {
  const f = fixture(t);
  let started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  const reporter = createServerStartTelemetry({ ...f.options, fetch: async (_url, init) => {
    started();
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    });
  } });
  const attempt = reporter.begin(randomUUID());
  await start;
  f.write({ telemetry: { enabled: false } });
  await reporter.flush();
  attempt.failed(new Error('after opt-out'));
  await reporter.settle();
  assert.equal(aborted, true);
  assert.equal(fs.existsSync(f.directory), false);
});

test('concurrent opt-out cannot recreate a previously admitted spool when saving preferences fails', async t => {
  for (const initialized of [false, true]) {
    const f = fixture(t);
    if (initialized) f.write({ telemetry: { enabled: true, ...usageIdentity({ enabled: true }, f.now()) } });
    let revoke = false;
    let reads = 0;
    const reporter = createServerStartTelemetry({ ...f.options, read: () => {
      const snapshot = f.read();
      // The host removes startup data but cannot persist the disabled setting.
      // Main's second read has already captured the previous enabled snapshot.
      if (revoke && ++reads === 2) clearServerStartTelemetry(f.directory);
      return snapshot;
    } });
    const attempt = reporter.begin(randomUUID());
    await reporter.flush();
    revoke = true;
    attempt.failed(new Error('after concurrent opt-out'));
    revoke = false;
    await reporter.settle();
    assert.deepEqual(f.sent.map(event => event.event), ['server_start_initiated']);
    assert.equal(fs.existsSync(f.directory), false);

    // A new collector or a later opt-in cannot revive this retired collector.
    fs.mkdirSync(path.join(f.directory, 'events'), { recursive: true });
    reporter.begin(randomUUID()).success(true);
    await reporter.settle();
    assert.deepEqual(f.sent.map(event => event.event), ['server_start_initiated']);
    assert.deepEqual(f.records(), []);
  }
});

test('resuming an offline spool observes revocation during its first preference read', async t => {
  const f = fixture(t);
  f.write({ telemetry: { enabled: true, ...usageIdentity({ enabled: true }, f.now()) } });
  const offline = createServerStartTelemetry({ ...f.options, fetch: async () => { throw new Error('offline'); } });
  offline.begin(randomUUID());
  await offline.settle();
  let revoked = false;
  const resumed = createServerStartTelemetry({ ...f.options, read: () => {
    const snapshot = f.read();
    if (!revoked) { revoked = true; clearServerStartTelemetry(f.directory); }
    return snapshot;
  } });
  resumed.begin(randomUUID()).failed(new Error('after revocation'));
  await resumed.settle();
  assert.deepEqual(f.sent, []);
  assert.equal(fs.existsSync(f.directory), false);
});

test('revocation at event publication cannot recreate the parent or reactivate the collector', async t => {
  const f = fixture(t);
  const reporter = createServerStartTelemetry(f.options);
  const attempt = reporter.begin(randomUUID());
  await reporter.flush();
  const write = fs.writeFileSync;
  let revoke = true;
  t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    if (revoke && path.dirname(String(args[0])) === path.join(f.directory, 'events')) {
      revoke = false;
      clearServerStartTelemetry(f.directory);
    }
    return write(...args);
  });
  attempt.failed(new Error('revoked at publication'));
  await reporter.settle();
  assert.equal(revoke, false);
  assert.equal(fs.existsSync(f.directory), false);
  fs.mkdirSync(path.join(f.directory, 'events'), { recursive: true });
  reporter.begin(randomUUID()).success(true);
  await reporter.settle();
  assert.deepEqual(f.sent.map(event => event.event), ['server_start_initiated']);
  assert.deepEqual(f.records(), []);
});

test('suppressed, unreadable and malformed preferences produce no identity, spool or requests', async t => {
  const f = fixture(t);
  for (const override of [
    { available: false },
    { read: () => { throw new Error('unreadable'); } },
    { read: () => ({ telemetry: { enabled: 'invalid' } }) as unknown as AppConfigFile },
  ]) {
    const reporter = createServerStartTelemetry({ ...f.options, ...override });
    const attempt = reporter.begin(randomUUID());
    attempt.failed(new Error('startup failed'));
    await reporter.settle();
    assert.deepEqual(f.records(), []);
    assert.equal(fs.existsSync(path.join(f.directory, 'identity.json')), false);
  }
  assert.deepEqual(f.sent, []);
});

test('slow delivery is bounded and expired records free capacity while offline', async t => {
  const f = fixture(t);
  const reporter = createServerStartTelemetry({ ...f.options, timeoutMs: 20, fetch: async (_url, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true })) });
  reporter.begin(randomUUID());
  await reporter.settle();
  assert.equal(f.records().length, 1);
  f.advance(QUEUE_TTL + 1);
  const next = reporter.begin(randomUUID());
  next.failed(new Error('new failure'));
  await reporter.settle();
  assert.equal(f.records().length, 2);
  assert.ok(f.records().every(record => record.timestamp === new Date(f.now()).toISOString()));
});
