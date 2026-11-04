import './__tests__/isolated-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { diagnosticScope } from './diagnostic-context.ts';
import { createTelemetry, telemetry } from './telemetry.ts';
import type { AppConfigFile } from './app-config.ts';
import {
  attachWriteDiagnosticErrorIds, copyWriteDiagnosticErrorIds, isWriteDiagnosticActive,
  setWriteDiagnosticTarget, traceWriteOperation, writeDiagnosticErrorIds, writeDiagnosticEvidence, writeDiagnosticStep,
} from './write-diagnostic-context.ts';
import { createWriteDiagnosticStore, diagnoseFileWrite, writeDiagnostics, WRITE_DIAGNOSTIC_TTL } from './write-diagnostics.ts';
import type { WriteOperationDiagnostic } from '../shared/protocols/write-diagnostics.ts';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-diagnostic-store-'));
after(async () => { await writeDiagnostics.clear(); fs.rmSync(scratch, { recursive: true, force: true }); });
const directory = () => path.join(scratch, randomUUID());
const valid = () => true;

async function sample(options: {
  raw?: string; identity?: string; turn?: string; success?: boolean; changed?: boolean;
  temporary?: string; wait?: number; mode?: number; tool?: string;
} = {}): Promise<WriteOperationDiagnostic> {
  const raw = options.raw ?? 'C:\\Work\\Résumé\\draft.ts';
  let captured: WriteOperationDiagnostic | undefined;
  const temporary = options.temporary ?? 'C:\\Work\\Résumé\\.draft.ts.42.first.tmp';
  await traceWriteOperation({
    operation: 'write', path: raw, origin: 'agent', runtime: 'claude', runtime_version: '1.0.test',
    request_id: 'fixture-request', turn_id: options.turn, tool_call_id: options.tool,
    session_root: 'C:\\Work\\Résumé',
  }, async () => {
    setWriteDiagnosticTarget(options.identity ?? raw.toLowerCase());
    writeDiagnosticEvidence('write_queue_acquired', { comparison_identity: options.identity ?? raw.toLowerCase(), wait_duration_ms: options.wait ?? 1 });
    if (options.success) return { changed: options.changed ?? true };
    writeDiagnosticEvidence('atomic_write_plan', { path: raw, temporary_path: temporary, mode: options.mode ?? 0o600 });
    return writeDiagnosticStep('persist', 'write_staging_file', () => {
      const error = Object.assign(new Error('PRIVATE DOCUMENT BODY MUST NEVER LEAVE'), { code: 'EACCES', errno: -13, syscall: 'open', path: temporary });
      error.stack = 'Error: PRIVATE DOCUMENT BODY MUST NEVER LEAVE\n    at write (/app/server/atomic-write.ts:1:1)';
      throw error;
    }, { path: temporary, target_path: raw, syscall: 'writeFile' });
  }, (value) => { captured = value; }).catch(() => undefined);
  assert.ok(captured);
  return captured;
}

test('consent gates trace admission; ordinary telemetry receives IDs without paths or document text', async (t) => {
  const admission = t.mock.method(telemetry, 'diagnosticAdmission', () => null);
  let completed = false;
  await diagnoseFileWrite({ operation: 'write', path: '/private/project/document.md', origin: 'http' }, async () => {
    assert.equal(isWriteDiagnosticActive(), false);
    return { changed: false };
  }, () => { completed = true; });
  assert.equal(completed, false);
  admission.mock.restore();

  t.mock.method(telemetry, 'diagnosticAdmission', () => valid);
  const events: unknown[] = [];
  t.mock.method(telemetry, 'capture', (event: unknown) => { events.push(event); });
  let recorded: WriteOperationDiagnostic | undefined;
  await diagnosticScope.run({ request_id: 'request-1', turn_id: 'turn-1', context: { tool_call_id: 'tool-1', runtime_version: 'native-1' } }, () =>
    diagnoseFileWrite({ operation: 'write', path: '/private/project/document.md', origin: 'http' }, async () => {
      writeDiagnosticStep('validation', 'refuse_fixture', () => { throw Object.assign(new Error('PRIVATE DOCUMENT BODY MUST NEVER LEAVE'), { code: 'INVALID_FILE_WRITE' }); });
    }, (operation) => { recorded = operation; }).catch(() => undefined));
  assert.ok(recorded);
  assert.equal(recorded.request_id, 'request-1');
  assert.equal(recorded.turn_id, 'turn-1');
  assert.equal(recorded.tool_call_id, 'tool-1');
  assert.equal(recorded.runtime_version, 'native-1');
  assert.equal(JSON.stringify(recorded).includes('PRIVATE DOCUMENT BODY'), false);
  await writeDiagnostics.flush();
  assert.ok(events.some((event) => (event as { event?: string }).event === 'write_diagnostic_delivery'));
  assert.equal(JSON.stringify(events).includes('/private/project'), false);
  assert.equal(JSON.stringify(events).includes('PRIVATE DOCUMENT BODY'), false);
  await writeDiagnostics.clear();
});

test('revoked admission and clear prevent queued or in-flight paths from surviving', async () => {
  const location = directory();
  let enabled = true;
  let started!: () => void;
  const uploadStarted = new Promise<void>((resolve) => { started = resolve; });
  let aborted = false;
  const store = createWriteDiagnosticStore({ directory: location, upload: async (_bundle, signal) => {
    started();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); }, { once: true }));
  } });
  const first = await sample();
  store.record(first, () => enabled);
  enabled = false;
  await store.flush();
  assert.equal(await store.read(first.diagnostic_id), null);
  assert.equal(fs.existsSync(location), false);

  enabled = true;
  const second = await sample({ raw: 'C:\\Work\\Résumé\\second.ts' });
  store.record(second, () => enabled);
  const flushing = store.flush();
  await uploadStarted;
  enabled = false;
  await store.clear();
  await flushing;
  assert.equal(aborted, true);
  assert.equal(await store.read(second.diagnostic_id), null);
  assert.deepEqual(fs.readdirSync(location), []);
});

test('same context groups repeats despite temporary filenames and timing; changed context keeps a new sample', async () => {
  const location = directory();
  let now = Date.now();
  const store = createWriteDiagnosticStore({ directory: location, now: () => now });
  const first = await sample({ turn: 'repeats', temporary: 'C:\\Work\\Résumé\\.draft.ts.42.a.tmp', wait: 1 });
  const second = await sample({ turn: 'repeats', temporary: 'C:\\Work\\Résumé\\.draft.ts.42.b.tmp', wait: 12.5 });
  second.started_at = second.finished_at = new Date(now + 1000).toISOString();
  store.record(first, valid);
  now += 1000;
  store.record(second, valid);
  await store.flush();
  assert.equal(second.diagnostic_id, first.diagnostic_id);
  const bundle = await store.read(first.diagnostic_id);
  assert.ok(bundle);
  assert.equal(bundle.occurrences, 2);
  assert.equal(bundle.first_seen, first.started_at);
  assert.equal(bundle.last_seen, second.finished_at);
  const changed = await sample({ turn: 'repeats', mode: 0o400 });
  store.record(changed, valid);
  await store.flush();
  assert.notEqual(changed.diagnostic_id, first.diagnostic_id);
  assert.equal(fs.readdirSync(location).filter((name) => name.endsWith('.json')).length, 2);
  await store.clear();
});

test('follow-ups preserve target identity, spelling changes, changed=false and exact tool linkage', async () => {
  const location = directory();
  const store = createWriteDiagnosticStore({ directory: location });
  const first = await sample({ turn: 'follow-ups', identity: 'c:/work/resume/draft.ts' });
  const same = await sample({ turn: 'follow-ups', identity: 'c:/work/resume/draft.ts', raw: 'c:/WORK/resume/draft.ts', success: true, changed: false });
  const other = await sample({ turn: 'follow-ups', identity: 'c:/work/resume/other.ts', raw: 'C:/Work/resume/other.ts', success: true });
  for (const operation of [first, same, other]) store.record(operation, valid);
  assert.equal(same.target_id, first.target_id);
  assert.equal(same.target_relation, 'same_target');
  assert.equal(same.path_changed, true);
  assert.equal(same.changed, false);
  assert.notEqual(other.target_id, first.target_id);
  assert.equal(other.target_relation, 'changed_target');
  const expected = { turn_id: 'follow-ups', runtime: 'claude' };
  assert.equal(store.linkTool({ diagnostic_id: first.diagnostic_id, operation_id: randomUUID() }, 'wrong-operation', expected), false);
  assert.equal(store.linkTool({ diagnostic_id: first.diagnostic_id, operation_id: first.operation_id }, 'exact-tool', expected), true);
  assert.equal(store.linkTool({ diagnostic_id: first.diagnostic_id, operation_id: first.operation_id }, 'conflicting-tool', expected), false);
  await store.flush();
  const bundle = await store.read(first.diagnostic_id);
  assert.ok(bundle);
  assert.equal(bundle.operations.length, 3);
  assert.equal(bundle.operations[0].tool_call_id, 'exact-tool');
  assert.equal(bundle.operations[0].correlation.tool, 'linked');
  assert.equal(bundle.operations[0].outcome, 'failed');
  assert.equal(bundle.operations[1].changed, false);
  assert.equal(bundle.operations[2].target_relation, 'changed_target');
  assert.equal(bundle.delivery.status, 'unavailable');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(location).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(location, `${first.diagnostic_id}.json`)).mode & 0o777, 0o600);
  }
  await store.clear();
});

test('upload and storage failures remain visible, bounded and free of third-party error text', async () => {
  const location = directory();
  let attempts = 0;
  const store = createWriteDiagnosticStore({ directory: location, upload: async () => { attempts++; throw new Error('PRIVATE remote response body'); } });
  const operation = await sample();
  store.record(operation, valid);
  await store.flush();
  const bundle = await store.read(operation.diagnostic_id);
  assert.ok(bundle);
  assert.equal(attempts, 3);
  assert.equal(bundle.delivery.status, 'failed');
  assert.equal(bundle.delivery.attempts, 3);
  assert.equal(bundle.delivery.last_error, 'upload_failed');
  assert.equal(store.health().upload_failed, 3);
  assert.equal(JSON.stringify(bundle).includes('PRIVATE'), false);
  await store.clear();

  const blocked = directory();
  fs.writeFileSync(blocked, 'not a directory');
  const failedReports: string[] = [];
  const unavailable = createWriteDiagnosticStore({ directory: blocked, report: (_bundle, status) => { failedReports.push(status); } });
  unavailable.record(await sample(), valid);
  await unavailable.flush();
  assert.equal(unavailable.health().storage_failed, 1);
  assert.deepEqual(failedReports, ['failed']);
});

test('trace truncation, bounded pending queue and expiration are observable', async () => {
  let traced: WriteOperationDiagnostic | undefined;
  await traceWriteOperation({ operation: 'write', path: '/fixture', origin: 'http' }, async () => {
    for (let index = 0; index < 3000; index++) writeDiagnosticEvidence('fixture_probe', { index });
    writeDiagnosticStep('persist', 'fixture_failure', () => { throw Object.assign(new Error('secret'), { code: 'EIO' }); });
  }, (operation) => { traced = operation; }).catch(() => undefined);
  assert.ok(traced);
  assert.equal(traced.completeness, 'partial');
  assert.ok(traced.gaps.includes('evidence_limit'));
  assert.equal(traced.failed_action, 'fixture_failure');

  let now = Date.now();
  const store = createWriteDiagnosticStore({ directory: directory(), now: () => now });
  const base = await sample();
  for (let index = 0; index < 101; index++) {
    const distinct = structuredClone(base);
    distinct.operation_id = randomUUID(); distinct.diagnostic_id = randomUUID(); distinct.raw_path = `/fixture/${index}`;
    store.record(distinct, valid);
  }
  assert.ok(store.health().pending > 0 && store.health().pending < 101);
  assert.equal(store.health().pending + store.health().queue_refused, 101);
  await store.flush();
  const live = await sample({ raw: '/fixture/current' });
  store.record(live, valid);
  await store.flush();
  assert.ok(await store.read(live.diagnostic_id));
  now += WRITE_DIAGNOSTIC_TTL + 1;
  assert.equal(await store.read(live.diagnostic_id), null);
  await store.clear();
});

test('correlation survives safe error wrapping and rejects malformed external identifiers', async () => {
  const first = new Error('private');
  const ids = { operation_id: randomUUID(), diagnostic_id: randomUUID() };
  attachWriteDiagnosticErrorIds(first, ids);
  const wrapped = new Error('public');
  copyWriteDiagnosticErrorIds(first, wrapped);
  assert.deepEqual(writeDiagnosticErrorIds(wrapped), ids);
  const invalid = new Error('private');
  attachWriteDiagnosticErrorIds(invalid, { operation_id: '/private/path', diagnostic_id: ids.diagnostic_id });
  assert.equal(writeDiagnosticErrorIds(invalid), undefined);
});

test('restricted retrieval and clearing refuse symlink directories and never follow bundle symlinks', async (t) => {
  if (process.platform === 'win32') { t.skip('symbolic-link creation depends on Windows privileges'); return; }
  const location = directory();
  const store = createWriteDiagnosticStore({ directory: location });
  const operation = await sample();
  store.record(operation, valid);
  await store.flush();
  const source = path.join(location, `${operation.diagnostic_id}.json`);
  const kept = path.join(location, 'kept.json');
  fs.renameSync(source, kept);
  fs.symlinkSync(kept, source);
  assert.equal(await store.read(operation.diagnostic_id), null);
  await store.clear();
  assert.equal(fs.existsSync(kept), true);

  const moved = directory();
  fs.renameSync(location, moved);
  fs.symlinkSync(moved, location, 'dir');
  assert.equal(await store.read(operation.diagnostic_id), null);
  await store.clear();
  assert.equal(fs.existsSync(path.join(moved, 'kept.json')), true);
});

test('attachment size truncation is explicit and reporting failures stay inside diagnostics', async () => {
  const store = createWriteDiagnosticStore({ directory: directory() });
  const failure = await sample({ turn: 'large-timeline' });
  failure.steps.push({ sequence: 100, stage: 'path_resolution', action: 'large_fixture_path', result: 'observed', started_ms: 0, duration_ms: 0,
    evidence: { path: `/fixture/${'x'.repeat(600_000)}` } });
  const success = await sample({ turn: 'large-timeline', success: true });
  success.steps.push(structuredClone(failure.steps.at(-1)!));
  store.record(failure, valid);
  store.record(success, valid);
  await store.flush();
  const bundle = await store.read(failure.diagnostic_id);
  assert.ok(bundle);
  assert.equal(bundle.completeness, 'partial');
  assert.ok(bundle.gaps.includes('timeline_size_limit'));
  assert.equal(bundle.operations[0].outcome, 'failed');
  assert.equal(bundle.operations.length, 1);
  assert.ok(store.health().truncated > 0);
  await store.clear();

  const throwingReporter = createWriteDiagnosticStore({ directory: directory(), report: () => { throw new Error('report unavailable'); } });
  throwingReporter.record(await sample(), valid);
  await assert.doesNotReject(throwingReporter.flush());
  assert.ok(throwingReporter.health().storage_failed > 0);
  await throwingReporter.clear();
});

test('HTTP and MCP correlate restricted writes while routine events contain no source paths', async (t) => {
  const [{ default: express }, { mount: mountProjects }, { mount: mountMcp }, reporting, { registerProjectFolderAsync }, { HTTP_REQUEST_ID_HEADER }] = await Promise.all([
    import('express'), import('./routes/project-files.ts'), import('./routes/mcp-http.ts'), import('./error-reporting.ts'),
    import('./folder.ts'), import('../shared/protocols/http/request-diagnostics.ts'),
  ]);
  const root = directory(); fs.mkdirSync(root); await registerProjectFolderAsync(root);
  const target = path.join(root, 'private-target.ts');
  const events: unknown[] = [];
  t.mock.method(telemetry, 'diagnosticAdmission', () => valid);
  t.mock.method(telemetry, 'scoped', () => (event: unknown) => { events.push(event); });
  t.mock.method(telemetry, 'capture', (event: unknown) => { events.push(event); });
  t.mock.method(telemetry, 'captureWarning', (error: unknown, context: unknown) => { events.push({ event: 'warning', error, context }); });
  t.mock.method(telemetry, 'captureError', (error: unknown, context: unknown) => { events.push({ event: 'error', error, context }); });
  const app = express(); app.use(express.json()); app.use(reporting.httpErrorReporting()); mountProjects(app);
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await writeDiagnostics.clear(); });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const token = '7'.repeat(64); mountMcp(app, { webBase: base, getToken: () => token });
  const requestId = randomUUID();
  const response = await fetch(`${base}/api/project/file`, {
    method: 'PUT', headers: { 'content-type': 'application/json', [HTTP_REQUEST_ID_HEADER]: requestId },
    body: JSON.stringify({ path: target, content: '\u0000PRIVATE SOURCE CONTENT' }),
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { code?: string }; assert.equal(body.code, 'INVALID_TEXT_CONTENT');
  const operationId = response.headers.get('x-stashbase-operation-id');
  const diagnosticId = response.headers.get('x-stashbase-diagnostic-id');
  assert.ok(operationId && diagnosticId);
  await writeDiagnostics.flush();
  const bundle = await writeDiagnostics.read(diagnosticId); assert.ok(bundle);
  assert.equal(bundle.operations[0].request_id, requestId);
  assert.equal(bundle.operations[0].operation_id, operationId);
  assert.equal(bundle.operations[0].raw_path, target);
  assert.ok(events.some((event) => (event as { event?: string; operation_id?: string }).event === 'project_file_operation'
    && (event as { operation_id?: string }).operation_id === operationId));

  const mcpResponse = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'fixture-tool', method: 'tools/call', params: { name: 'write_file', arguments: { path: target, content: '\u0000PRIVATE SOURCE CONTENT' } } }),
  });
  const mcpBody = await mcpResponse.json() as { error?: { message?: string }; result?: { isError?: boolean; structuredContent?: unknown; content?: { type?: string; text?: string }[] } };
  assert.equal(mcpBody.error, undefined);
  assert.equal(mcpBody.result?.isError, true);
  const failureText = mcpBody.result?.content?.find((item) => item.type === 'text')?.text;
  assert.ok(typeof failureText === 'string');
  const structured = JSON.parse(failureText.replace(/^Error:\s*/, ''));
  assert.deepEqual(mcpBody.result?.structuredContent, structured);
  assert.equal(structured.stashbase_write_error, 1);
  reporting.reportAgentRuntimeError('claude', { t: 'tool-result', id: 'native-tool-42', content: failureText, isError: true });
  await writeDiagnostics.flush();
  const mcpBundle = await writeDiagnostics.read(structured.error.diagnostic_id); assert.ok(mcpBundle);
  const linked = mcpBundle.operations.find((operation) => operation.operation_id === structured.error.operation_id); assert.ok(linked);
  // An external MCP caller has no trusted live turn. Its structured IDs are
  // returned to the caller, but a runtime event cannot claim its operation.
  assert.equal(linked.tool_call_id, undefined);
  assert.equal(linked.correlation.tool, 'unavailable');
  assert.equal(linked.origin, 'mcp');
  assert.equal(JSON.stringify(events).includes(target), false);
  assert.equal(JSON.stringify(events).includes('PRIVATE SOURCE CONTENT'), false);
});

test('a new account admission cannot authorize an old same-turn failure or merge its repeated fingerprint', async () => {
  let firstAccountValid = true;
  const reports: string[] = [];
  const uploads: string[] = [];
  const store = createWriteDiagnosticStore({ directory: directory(), report: (bundle) => { reports.push(bundle.diagnostic_id); },
    upload: async (bundle) => { uploads.push(bundle.diagnostic_id); } });
  const first = await sample({ turn: 'shared-turn' });
  store.record(first, () => firstAccountValid);
  firstAccountValid = false;
  const secondAccountSuccess = await sample({ turn: 'shared-turn', success: true });
  store.record(secondAccountSuccess, valid);
  await store.flush();
  assert.equal(await store.read(first.diagnostic_id), null);
  assert.equal(reports.length, 0);
  assert.equal(uploads.length, 0);
  assert.equal(secondAccountSuccess.target_relation, 'first');
  assert.equal(secondAccountSuccess.previous_operation_id, undefined);

  const secondAccountFailure = await sample({ turn: 'shared-turn' });
  store.record(secondAccountFailure, valid);
  await store.flush();
  assert.notEqual(secondAccountFailure.diagnostic_id, first.diagnostic_id);
  const bundle = await store.read(secondAccountFailure.diagnostic_id); assert.ok(bundle);
  assert.equal(bundle.occurrences, 1);
  assert.deepEqual(bundle.operations.map((operation) => operation.operation_id), [secondAccountFailure.operation_id]);
  assert.deepEqual(uploads, [secondAccountFailure.diagnostic_id]);
  assert.equal(reports.includes(first.diagnostic_id), false);
  await store.clear();
});

test('account A to B to A never reactivates a diagnostic admission captured before the switch', () => {
  let config: AppConfigFile = { telemetry: { enabled: true } };
  const setAccount = (userId: string) => {
    config.account = { session: { userId, email: 'private@example.test', accessToken: 'fixture-access', sessionToken: 'fixture-session', expiresAt: 9999999999 } };
  };
  setAccount('A');
  const service = createTelemetry({
    available: true, distribution: 'source', projectToken: 'fixture-token', host: 'https://example.test', version: 'fixture', os: 'linux',
    read: () => structuredClone(config), write: (next) => { config = structuredClone(next); },
    fetch: (async () => new Response(null, { status: 200 })) as typeof fetch,
  });
  try {
    const first = service.diagnosticAdmission(); assert.ok(first); assert.equal(first(), true);
    setAccount('B'); service.identityChanged();
    assert.equal(first(), false);
    const second = service.diagnosticAdmission(); assert.ok(second); assert.equal(second(), true);
    setAccount('A'); service.identityChanged();
    assert.equal(first(), false);
    assert.equal(second(), false);
    const latest = service.diagnosticAdmission(); assert.ok(latest); assert.equal(latest(), true);
  } finally { service.close(); }
});

test('structured tool correlation requires a known operation in the trusted current turn and runtime', async () => {
  const store = createWriteDiagnosticStore({ directory: directory() });
  const operation = await sample({ turn: 'trusted-turn' });
  store.record(operation, valid);
  const ids = { diagnostic_id: operation.diagnostic_id, operation_id: operation.operation_id };
  assert.equal(store.linkTool({ ...ids, diagnostic_id: randomUUID() }, 'tool', { turn_id: 'trusted-turn', runtime: 'claude' }), false);
  assert.equal(store.linkTool(ids, 'tool', {}), false);
  assert.equal(store.linkTool(ids, 'tool', { turn_id: 'different-turn', runtime: 'claude' }), false);
  assert.equal(store.linkTool(ids, 'tool', { turn_id: 'trusted-turn', runtime: 'codex' }), false);
  await store.flush();
  let bundle = await store.read(operation.diagnostic_id); assert.ok(bundle);
  assert.equal(bundle.operations[0].tool_call_id, undefined);
  assert.equal(store.linkTool(ids, 'tool', { turn_id: 'trusted-turn', runtime: 'claude' }), true);
  await store.flush();
  bundle = await store.read(operation.diagnostic_id); assert.ok(bundle);
  assert.equal(bundle.operations[0].tool_call_id, 'tool');
  assert.equal(bundle.operations[0].correlation.tool, 'linked');
  const external = await sample(); store.record(external, valid);
  assert.equal(store.linkTool({ diagnostic_id: external.diagnostic_id, operation_id: external.operation_id }, 'tool', { runtime: 'claude' }), false);
  await store.clear();
});

test('orphaned restricted staging files are removed by both maintenance and opt-out clearing', async () => {
  const location = directory(); fs.mkdirSync(location);
  const store = createWriteDiagnosticStore({ directory: location });
  const orphan = path.join(location, `${randomUUID()}.tmp`);
  fs.writeFileSync(orphan, 'restricted incomplete attachment', { mode: 0o600 });
  await store.maintain();
  assert.equal(fs.existsSync(orphan), false);
  assert.ok(store.health().expired > 0);
  const later = path.join(location, `${randomUUID()}.tmp`);
  fs.writeFileSync(later, 'restricted incomplete attachment', { mode: 0o600 });
  await store.clear();
  assert.equal(fs.existsSync(later), false);
  assert.deepEqual(fs.readdirSync(location), []);
});

test('new admissions wait behind overlapping clears and survive cleanup of an older drain', async (t) => {
  for (const repeatClear of [false, true]) await t.test(repeatClear ? 'overlapping clears' : 'single clear', async () => {
    const location = directory();
    let oldAdmission = true;
    let started!: () => void;
    const oldStarted = new Promise<void>((resolve) => { started = resolve; });
    let settleOld!: () => void;
    const oldSettled = new Promise<void>((resolve) => { settleOld = resolve; });
    const uploaded: string[] = [];
    const reported: string[] = [];
    let oldSignal: AbortSignal | undefined;
    const old = await sample({ raw: '/fixture/old-generation' });
    const store = createWriteDiagnosticStore({ directory: location,
      upload: async (bundle, signal) => {
        uploaded.push(bundle.diagnostic_id);
        if (bundle.diagnostic_id === old.diagnostic_id) { oldSignal = signal; started(); await oldSettled; }
      }, report: (bundle) => { reported.push(bundle.diagnostic_id); },
    });
    store.record(old, () => oldAdmission);
    const initialFlush = store.flush();
    await oldStarted;
    oldAdmission = false;
    const cleanups = [store.clear()];
    const intervening = await sample({ raw: '/fixture/new-generation' });
    store.record(intervening, valid);
    const waitingFlush = store.flush();
    let newest = intervening;
    if (repeatClear) {
      cleanups.push(store.clear());
      newest = await sample({ raw: '/fixture/newest-generation' });
      store.record(newest, valid);
    }
    assert.equal(oldSignal?.aborted, true);
    assert.equal(store.health().pending, 1);
    assert.deepEqual(uploaded, [old.diagnostic_id]);
    assert.equal(fs.existsSync(path.join(location, `${newest.diagnostic_id}.json`)), false);
    settleOld();
    await Promise.all([...cleanups, initialFlush, waitingFlush]);
    await store.flush();
    assert.equal(await store.read(old.diagnostic_id), null);
    if (repeatClear) assert.equal(await store.read(intervening.diagnostic_id), null);
    const bundle = await store.read(newest.diagnostic_id); assert.ok(bundle);
    assert.equal(bundle.delivery.status, 'uploaded');
    assert.deepEqual(uploaded, [old.diagnostic_id, newest.diagnostic_id]);
    assert.deepEqual(reported, [newest.diagnostic_id]);
    assert.deepEqual(fs.readdirSync(location), [`${newest.diagnostic_id}.json`]);
    await store.clear();
  });
});
