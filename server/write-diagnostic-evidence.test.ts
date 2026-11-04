import './__tests__/isolated-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { writeDiagnosticBundleSchema, type WriteOperationDiagnostic } from '../shared/protocols/write-diagnostics.ts';
import { openProjectFolder } from './folder.ts';
import { editProjectFile, writeProjectFile } from './project-file-mutations.ts';
import { textVersion } from './text-file-transaction.ts';
import { traceWriteOperation } from './write-diagnostic-context.ts';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-write-evidence-'));
const blindSamples: WriteOperationDiagnostic[] = [];
after(() => {
  // An opt-in handoff contains evidence only, without the scenario/test names.
  const exportDirectory = process.env.STASHBASE_DIAGNOSTIC_FIXTURE_DIR;
  if (exportDirectory) {
    fs.mkdirSync(exportDirectory, { recursive: true, mode: 0o700 });
    blindSamples.forEach((operation, index) => {
      const bundle = writeDiagnosticBundleSchema.parse({
        schema_version: 1, diagnostic_id: operation.diagnostic_id,
        first_seen: operation.started_at, last_seen: operation.finished_at, occurrences: 1,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(), operations: [operation],
        completeness: operation.completeness, gaps: operation.gaps,
        delivery: { status: 'local_only', attempts: 0 },
      });
      fs.writeFileSync(path.join(exportDirectory, `${index + 1}.json`), JSON.stringify(bundle, null, 2), { mode: 0o600 });
    });
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function project() {
  const root = fs.mkdtempSync(path.join(scratch, 'project-'));
  await openProjectFolder(root);
  return root;
}
async function capture(operation: 'write' | 'edit', target: string, work: () => Promise<unknown>) {
  let diagnostic: WriteOperationDiagnostic | undefined;
  let error: unknown;
  await traceWriteOperation({ operation, path: target, origin: 'mcp' }, work, (value) => { diagnostic = value; }).catch((caught) => { error = caught; });
  assert.ok(diagnostic);
  assert.equal(diagnostic.completeness, 'complete', JSON.stringify({ gaps: diagnostic.gaps, steps: diagnostic.steps.length, failure: diagnostic.error }));
  if (diagnostic.outcome === 'failed') blindSamples.push(diagnostic);
  return { diagnostic, error };
}
function evidence(operation: WriteOperationDiagnostic, action: string) {
  const step = operation.steps.find((item) => item.action === action);
  assert.ok(step, `missing ${action}`);
  return step.evidence;
}

// These cases prove that diagnostic inputs alone identify the exercised branch;
// existing source transaction tests remain the primary byte-preservation proof.
test('literal edit refusal records match counts and text structure without text', async () => {
  const root = await project();
  const target = path.join(root, 'note.ts');
  const source = '\uFEFFprivate source: café\r\nold old\r\n';
  fs.writeFileSync(target, source);
  const mismatch = await capture('edit', target, () => editProjectFile(target, 'cafe\u0301', 'private replacement'));
  assert.equal(mismatch.diagnostic.error?.code, 'EDIT_MISMATCH');
  assert.equal(mismatch.diagnostic.failed_action, 'match_edit_text');
  assert.equal(evidence(mismatch.diagnostic, 'edit_match_result').match_count, 0);
  assert.deepEqual(evidence(mismatch.diagnostic, 'edit_match_result').diagnostic_normalized_match_counts, {
    nfc: 1, line_endings: 0, nfc_and_line_endings: 1,
  });
  assert.deepEqual(evidence(mismatch.diagnostic, 'edit_match_result').old_text, {
    utf16_length: 5, utf8_bytes: 6, crlf_count: 0, lone_lf_count: 0, lone_cr_count: 0,
    has_bom: false, is_nfc: false, is_nfd: true,
  });
  const ambiguous = await capture('edit', target, () => editProjectFile(target, 'old', 'private replacement'));
  assert.equal(ambiguous.diagnostic.error?.code, 'EDIT_AMBIGUOUS');
  assert.equal(evidence(ambiguous.diagnostic, 'edit_match_result').match_count, 2);
  assert.equal(ambiguous.diagnostic.stages.persist, 'not_reached');
  const serialized = JSON.stringify([mismatch.diagnostic, ambiguous.diagnostic]);
  for (const secret of ['private source', 'private replacement', source]) assert.equal(serialized.includes(secret), false);
  assert.equal(fs.readFileSync(target, 'utf8'), source);
});

test('missing old source is distinguished from an absent file accepted for creation', async () => {
  const root = await project();
  const target = path.join(root, 'missing.ts');
  const missing = await capture('edit', target, () => editProjectFile(target, 'old', 'new'));
  assert.equal(missing.diagnostic.error?.code, 'FILE_NOT_FOUND');
  assert.equal(missing.diagnostic.failed_stage, 'read');
  assert.equal(evidence(missing.diagnostic, 'text_snapshot').present, false);
  assert.ok(missing.diagnostic.steps.some((step) => step.action === 'open_source' && step.error?.code === 'ENOENT'));
  assert.equal(missing.diagnostic.stages.edit_match, 'not_reached');
  const created = await capture('write', target, () => writeProjectFile(target, 'new'));
  assert.equal(created.error, undefined);
  assert.equal(created.diagnostic.outcome, 'success');
  assert.equal(evidence(created.diagnostic, 'text_snapshot').purpose, 'write_previous');
  assert.equal(evidence(created.diagnostic, 'atomic_write_published').published, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
});

test('requested and commit-time conflicts retain distinct versions and the operation order', async (t) => {
  const root = await project();
  const target = path.join(root, 'version.ts');
  fs.writeFileSync(target, 'original');
  const request = await capture('write', target, () => writeProjectFile(target, 'my edit', { baseVersion: textVersion('stale') }));
  assert.equal(request.diagnostic.failed_action, 'check_requested_version');
  assert.deepEqual(evidence(request.diagnostic, 'check_requested_version'), {
    request_version: textVersion('stale'), read_version: textVersion('original'),
    comparison_version: textVersion('original'), required: true,
  });
  const writeFile = fs.promises.writeFile;
  t.mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof writeFile>) => {
    await writeFile(...args);
    if (String(args[0]).endsWith('.tmp')) await writeFile(target, 'external edit');
  });
  const commit = await capture('write', target, () => writeProjectFile(target, 'my edit', { baseVersion: textVersion('original') }));
  assert.equal(commit.diagnostic.failed_action, 'check_commit_version');
  assert.deepEqual(evidence(commit.diagnostic, 'commit_version_result'), {
    expected_version: textVersion('original'), commit_version: textVersion('external edit'),
  });
  const actions = commit.diagnostic.steps.map((step) => step.action);
  assert.ok(actions.indexOf('write_staging_file') < actions.indexOf('check_commit_version'));
  assert.ok(actions.indexOf('check_commit_version') < actions.indexOf('cleanup_staging_file'));
  assert.equal(evidence(commit.diagnostic, 'atomic_write_cleanup').cleanup_complete, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'external edit');
});

test('system publication refusal retains syscall and partial-write facts without uploading its message', async (t) => {
  const root = await project();
  const target = path.join(root, 'denied.ts');
  fs.writeFileSync(target, 'original');
  const rename = fs.promises.rename;
  t.mock.method(fs.promises, 'rename', async (...[from, to]: Parameters<typeof rename>) => {
    if (String(to) === target) throw Object.assign(new Error('document excerpt must stay private'), { code: 'EACCES', errno: -13, syscall: 'rename', path: String(from), dest: String(to) });
    return rename(from, to);
  });
  const denied = await capture('write', target, () => writeProjectFile(target, 'private new content'));
  assert.equal(denied.diagnostic.failed_action, 'publish_staging_file');
  assert.equal(denied.diagnostic.error?.syscall, 'rename');
  assert.equal(denied.diagnostic.error?.errno, -13);
  assert.equal(denied.diagnostic.error?.dest, target);
  assert.equal(evidence(denied.diagnostic, 'atomic_write_plan').target_partial_write_possible, false);
  assert.equal(evidence(denied.diagnostic, 'atomic_write_cleanup').cleanup_complete, true);
  assert.equal(JSON.stringify(denied.diagnostic).includes('document excerpt'), false);
  assert.equal(JSON.stringify(denied.diagnostic).includes('private new content'), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(root), ['denied.ts']);
});

test('an actual read-only parent records the failed staging system call', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('POSIX permission denial requires a non-root process'); return; }
  const root = await project();
  const target = path.join(root, 'readonly.ts');
  fs.writeFileSync(target, 'original');
  fs.chmodSync(root, 0o555);
  t.after(() => fs.chmodSync(root, 0o755));
  const denied = await capture('write', target, () => writeProjectFile(target, 'replacement'));
  assert.ok(['EACCES', 'EPERM'].includes(denied.diagnostic.error?.code ?? ''));
  assert.equal(denied.diagnostic.failed_action, 'write_staging_file');
  assert.equal(denied.diagnostic.stages.persist, 'failed');
  assert.equal(evidence(denied.diagnostic, 'write_staging_file').syscall, 'writeFile');
  assert.equal(typeof denied.diagnostic.error?.syscall, 'string');
  assert.equal(evidence(denied.diagnostic, 'write_staging_file').target_partial_write_possible, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
});

test('received diagnostic packets alone generate production regressions for every captured failure', async (t) => {
  const { readWriteDiagnosticBundles, buildWriteReplayEnvironment, executeWriteReplayCase } = await import('../scripts/write-diagnostic-replay.ts');
  assert.ok(blindSamples.length >= 6, 'The capture scenarios must run before packet replay.');
  // Serialization removes object identity and live execution state. The replay
  // receives only the same restricted packet an investigator would receive.
  const received = JSON.parse(JSON.stringify(blindSamples.map((operation) => ({
    schema_version: 1, diagnostic_id: operation.diagnostic_id,
    first_seen: operation.started_at, last_seen: operation.finished_at, occurrences: 1,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(), operations: [operation],
    completeness: operation.completeness, gaps: operation.gaps,
    delivery: { status: 'local_only', attempts: 0 },
  }))));
  const environment = buildWriteReplayEnvironment(readWriteDiagnosticBundles(received));
  assert.equal(environment.cases.length, blindSamples.length);
  for (const fixture of environment.cases) {
    await t.test(fixture.operation_id, (scenario) => executeWriteReplayCase(fixture, scenario));
  }
});

test('received timelines distinguish recovery on the same target from a successful write elsewhere', async (t) => {
  const { createWriteDiagnosticStore } = await import('./write-diagnostics.ts');
  const { readWriteDiagnosticBundles, writeDiagnosticTimeline, buildWriteReplayEnvironment, executeWriteReplayCase } = await import('../scripts/write-diagnostic-replay.ts');
  for (const sameTarget of [true, false]) await t.test(sameTarget ? 'same target' : 'changed target', async (scenario) => {
    const root = await project();
    const target = path.join(root, 'timeline.ts');
    fs.writeFileSync(target, 'initial synthetic source');
    const store = createWriteDiagnosticStore({ directory: path.join(root, '.fixture-diagnostics') });
    scenario.after(() => store.clear());
    let failure: WriteOperationDiagnostic | undefined;
    await traceWriteOperation({ operation: 'edit', path: target, origin: 'agent', turn_id: 'fixture-turn' },
      () => editProjectFile(target, 'missing needle', 'replacement'),
      (operation) => { failure = operation; store.record(operation, () => true); }).catch(() => undefined);
    assert.ok(failure);
    const destination = sameTarget ? target : path.join(root, 'different.ts');
    await traceWriteOperation({ operation: 'write', path: destination, origin: 'agent', turn_id: 'fixture-turn' },
      () => writeProjectFile(destination, 'new synthetic source'),
      (operation) => { store.record(operation, () => true); });
    await store.flush();
    const saved = await store.read(failure.diagnostic_id); assert.ok(saved);
    const received = readWriteDiagnosticBundles(JSON.parse(JSON.stringify(saved)));
    const timeline = writeDiagnosticTimeline(received);
    assert.equal(timeline.length, 2);
    assert.equal(timeline[0].outcome, 'failed');
    assert.equal(timeline[1].outcome, 'success');
    assert.equal(timeline[1].changed, true);
    assert.equal(timeline[0].follow_ups[0].relation_to_failure, sameTarget ? 'same_target' : 'changed_target');
    assert.equal(timeline[0].follow_ups[0].path_changed, !sameTarget);
    const environment = buildWriteReplayEnvironment(received);
    assert.equal(environment.cases.length, 2);
    for (const fixture of environment.cases) await executeWriteReplayCase(fixture, scenario);
  });
});
