import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  WRITE_STAGES,
  type WriteDiagnosticBundle,
  type WriteOperationDiagnostic,
} from '../shared/protocols/write-diagnostics.ts';
import {
  buildWriteReplayEnvironment,
  diagnoseWriteOperation,
  executeWriteReplayCase,
  materializeWriteReplayEnvironment,
  readWriteDiagnosticBundles,
  writeDiagnosticTimeline,
} from './write-diagnostic-replay.ts';

function operation(): WriteOperationDiagnostic {
  const raw = 'D:\\文档\\Cafe\u0301\\草稿.md';
  const root = 'C:\\文档\\Café';
  const rootKey = 'c:/文档/café';
  const targetKey = 'd:/文档/cafe\u0301/草稿.md';
  return {
    operation_id: randomUUID(), diagnostic_id: randomUUID(), turn_id: randomUUID(),
    correlation: { request: 'unavailable', turn: 'linked', tool: 'unavailable' },
    operation: 'write', origin: 'agent', runtime: 'claude', runtime_version: null,
    app_version: '1.0.0', node_version: 'v24.11.0', os: 'win32', arch: 'x64',
    started_at: '2026-11-04T00:00:00.000Z', finished_at: '2026-11-04T00:00:00.010Z', duration_ms: 10,
    raw_path: raw, escaped_path: JSON.stringify(raw), raw_path_type: 'string',
    session_root: root, session_scope: 'bound',
    target_id: randomUUID(), target_identity: targetKey, target_relation: 'first',
    outcome: 'failed', error: { name: 'ProjectOperationError', code: 'PROJECT_PATH_OUTSIDE', stack: [] },
    failed_stage: 'project_match', failed_action: 'project_path.require_registered_root',
    stages: Object.fromEntries(WRITE_STAGES.map((stage) => [stage, stage === 'project_match' ? 'failed' : 'not_reached'])) as WriteOperationDiagnostic['stages'],
    steps: ([
      { action: 'project_path.input', evidence: { raw_path: raw, escaped_path: JSON.stringify(raw), platform: 'win32', input_type: 'string' } },
      { action: 'path.identity', evidence: { path: raw, comparison_identity: targetKey, platform: 'win32', case_rule: 'lowercase', unicode_rule: 'preserve', separator_rule: 'backslash_to_slash' } },
      { action: 'path.contains', evidence: { root, candidate: raw, root_identity: rootKey, candidate_identity: targetKey, matches: false, platform: 'win32' } },
      { action: 'folder.match', evidence: { root, target: raw, matched: false, selected: false } },
      { action: 'folder.match_result', evidence: { target: raw, selected_root: null } },
    ] as Array<Pick<WriteOperationDiagnostic['steps'][number], 'action' | 'evidence'>>).map((step, sequence) => ({ ...step, sequence: sequence + 1, stage: 'project_match', started_ms: sequence, duration_ms: 0, result: 'observed' })),
    completeness: 'complete', gaps: [],
  };
}

function bundle(operations: WriteOperationDiagnostic[]): WriteDiagnosticBundle {
  return {
    schema_version: 1, diagnostic_id: operations[0].diagnostic_id,
    first_seen: operations[0].started_at, last_seen: operations.at(-1)!.finished_at,
    occurrences: 1, expires_at: '2026-11-11T00:00:00.000Z', operations,
    completeness: 'complete', gaps: [], delivery: { status: 'local_only', attempts: 0 },
  };
}

test('received Windows evidence preserves drive, separators, Unicode and exposes incorrect identities', async (t) => {
  const captured = operation();
  const received = readWriteDiagnosticBundles(JSON.parse(JSON.stringify(bundle([captured]))));
  assert.equal(received[0].operations[0].raw_path, 'D:\\文档\\Cafe\u0301\\草稿.md');
  const fixture = buildWriteReplayEnvironment(received).cases[0];
  assert.equal(fixture.assessment, 'supported_refusal');
  await executeWriteReplayCase(fixture, t);

  const inconsistent = structuredClone(captured);
  const identity = inconsistent.steps.find((step) => step.action === 'path.identity')!;
  identity.evidence.comparison_identity = 'd:/文档/café/草稿.md';
  assert.equal(diagnoseWriteOperation(inconsistent).assessment, 'inconsistent_evidence');
  assert.match(diagnoseWriteOperation(inconsistent).contradictions.join(' '), /path identity/);

  const erroneousCaseRejection = structuredClone(captured);
  const containment = erroneousCaseRejection.steps.find((step) => step.action === 'path.contains')!.evidence;
  containment.root = 'D:/文档/Cafe\u0301';
  containment.root_identity = 'd:/文档/cafe\u0301';
  assert.equal(diagnoseWriteOperation(erroneousCaseRejection).assessment, 'inconsistent_evidence');
  assert.match(diagnoseWriteOperation(erroneousCaseRejection).contradictions.join(' '), /containment/);
});

test('timeline joins duplicate packets once and separates target correction from a different target success', () => {
  const failed = operation();
  const same = structuredClone(failed);
  same.operation_id = randomUUID();
  same.started_at = '2026-11-04T00:01:00.000Z';
  same.finished_at = same.started_at;
  same.outcome = 'success'; same.changed = false;
  delete same.error; delete same.failed_stage; delete same.failed_action;
  same.target_relation = 'same_target'; same.path_changed = true;
  same.raw_path = 'd:/文档/Cafe\u0301/草稿.md';
  const other = structuredClone(same);
  other.operation_id = randomUUID(); other.target_id = randomUUID();
  other.target_identity = 'c:/different/target.md'; other.raw_path = 'C:/different/target.md';
  other.started_at = '2026-11-04T00:02:00.000Z'; other.finished_at = other.started_at;
  other.target_relation = 'changed_target'; other.changed = true;
  const rows = writeDiagnosticTimeline([bundle([failed, same, other]), bundle([failed])]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].follow_ups.map((follow) => [follow.relation_to_failure, follow.changed, follow.path_changed]), [
    ['same_target', false, true], ['changed_target', true, true],
  ]);
  assert.equal('recovered' in rows[0], false, 'A later success alone never declares recovery.');
  delete failed.turn_id;
  assert.deepEqual(writeDiagnosticTimeline([bundle([failed, same])])[0].follow_ups, []);
});

test('missing and truncated evidence stays visible and cannot produce a passing replay', async (t) => {
  const partial = operation();
  partial.steps = [];
  partial.completeness = 'partial'; partial.gaps = ['evidence_limit'];
  const diagnostic = bundle([partial]);
  diagnostic.completeness = 'partial'; diagnostic.gaps = ['bundle_limit'];
  diagnostic.delivery = { status: 'failed', attempts: 2, last_error: 'transport_failure' };
  const environment = buildWriteReplayEnvironment([diagnostic]);
  assert.equal(environment.cases[0].assessment, 'insufficient_evidence');
  assert.ok(environment.cases[0].gaps.includes('evidence_limit'));
  assert.ok(environment.limitations.includes('bundle_limit'));
  assert.ok(environment.limitations.includes('Diagnostic delivery was failed.'));
  await assert.rejects(executeWriteReplayCase(environment.cases[0], t), /evidence_limit/);
  assert.throws(() => readWriteDiagnosticBundles({ ...diagnostic, schema_version: 2 }));
  assert.throws(() => readWriteDiagnosticBundles([]));
});

test('materialization only writes opaque files in a fresh restricted temporary directory', async (t) => {
  const captured = operation();
  captured.raw_path = '/this-original-path-must-never-be-created/private/source.txt';
  const fixtureDirectory = await materializeWriteReplayEnvironment(buildWriteReplayEnvironment([bundle([captured])]));
  t.after(() => fs.promises.rm(fixtureDirectory, { recursive: true, force: true }));
  assert.deepEqual((await fs.promises.readdir(fixtureDirectory)).sort(), ['environment.json', 'regression.test.ts']);
  assert.match(fixtureDirectory, /stashbase-write-replay-/);
  assert.equal(fs.existsSync('/this-original-path-must-never-be-created'), false);
  assert.equal((await fs.promises.stat(fixtureDirectory)).mode & 0o777, 0o700);
  assert.equal((await fs.promises.stat(path.join(fixtureDirectory, 'environment.json'))).mode & 0o777, 0o600);
  assert.match(await fs.promises.readFile(path.join(fixtureDirectory, 'regression.test.ts'), 'utf8'), /executeWriteReplayCase/);
});

test('local ID retrieval enforces expiry and refuses linked diagnostic files', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-diagnostic-reader-'));
  t.after(() => fs.promises.rm(scratch, { recursive: true, force: true }));
  const directory = path.join(scratch, 'write-diagnostics');
  fs.mkdirSync(directory);
  const packet = bundle([operation()]);
  packet.expires_at = new Date(Date.now() + 60_000).toISOString();
  const file = path.join(directory, `${packet.diagnostic_id}.json`);
  const read = () => spawnSync(process.execPath, [
    '--import', new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href,
    fileURLToPath(new URL('./write-diagnostic-replay.ts', import.meta.url)), '--id', packet.diagnostic_id,
  ], { env: { ...process.env, STASHBASE_LOCAL_DATA_ROOT: scratch }, encoding: 'utf8', timeout: 10_000 });
  fs.writeFileSync(file, JSON.stringify(packet));
  assert.equal(read().status, 0);
  packet.expires_at = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify(packet));
  const expired = read();
  assert.equal(expired.status, 1);
  assert.match(expired.stderr, /has expired/);
  const external = path.join(scratch, 'external.json');
  fs.renameSync(file, external);
  try { fs.symlinkSync(external, file); }
  catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return;
    throw error;
  }
  const linked = read();
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /cannot follow symbolic links/);
});

test('an early edit failure and later writes through an alias retain one physical target', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-replay-target-'));
  const root = path.join(scratch, 'project');
  fs.mkdirSync(path.join(root, 'real'), { recursive: true });
  t.after(() => fs.promises.rm(scratch, { recursive: true, force: true }));
  try { fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows directory-symlink privilege unavailable.'); return; }
    throw error;
  }
  const direct = path.join(root, 'real', 'source.fixture');
  const alias = path.join(root, 'alias', 'source.fixture');
  fs.writeFileSync(direct, 'synthetic original');
  const [{ registerProjectFolderAsync }, { editProjectFile, writeProjectFile }, { traceWriteOperation }, { createWriteDiagnosticStore }] = await Promise.all([
    import('../server/folder.ts'), import('../server/project-file-mutations.ts'),
    import('../server/write-diagnostic-context.ts'), import('../server/write-diagnostics.ts'),
  ]);
  await registerProjectFolderAsync(root);
  const store = createWriteDiagnosticStore({ directory: path.join(scratch, 'diagnostics') });
  t.after(() => store.clear());
  const captured: WriteOperationDiagnostic[] = [];
  const turn = randomUUID();
  const record = (operation: WriteOperationDiagnostic) => { store.record(operation, () => true); captured.push(operation); };
  await assert.rejects(traceWriteOperation({ operation: 'edit', path: alias, origin: 'mcp', turn_id: turn },
    () => editProjectFile(alias, 'missing needle', 'replacement'), record), { code: 'EDIT_MISMATCH' });
  await traceWriteOperation({ operation: 'write', path: alias, origin: 'mcp', turn_id: turn },
    () => writeProjectFile(alias, 'synthetic replacement'), record);
  await traceWriteOperation({ operation: 'write', path: direct, origin: 'mcp', turn_id: turn },
    () => writeProjectFile(direct, 'synthetic replacement'), record);
  assert.deepEqual(captured.map((operation) => operation.target_relation), ['first', 'same_target', 'same_target']);
  assert.equal(new Set(captured.map((operation) => operation.target_identity)).size, 1);
  assert.deepEqual(captured.slice(1).map((operation) => [operation.path_changed, operation.changed]), [[false, true], [true, false]]);
  await store.flush();
  const received = await store.read(captured[0].diagnostic_id);
  assert.ok(received);
  assert.deepEqual(writeDiagnosticTimeline([received])[0].follow_ups.map((follow) => follow.relation_to_failure), ['same_target', 'same_target']);
});
