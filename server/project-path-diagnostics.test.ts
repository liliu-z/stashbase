import './__tests__/isolated-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { writeDiagnosticBundleSchema, type WriteOperationDiagnostic } from '../shared/protocols/write-diagnostics.ts';
import { readAppConfigStrict, writeAppConfigStrict } from './app-config.ts';
import { registerAttributedAgentSession, unregisterAttributedAgentSession } from './agent-session-registry.ts';
import { createFilesystemPath, filesystemPath } from './filesystem-path.ts';
import { registerProjectFolderAsync } from './folder.ts';
import { normalizeProjectFilePath } from './project-file-access.ts';
import { currentProjectDiagnosticScope, withAgentProjectScope } from './project-request-scope.ts';
import { traceWriteOperation } from './write-diagnostic-context.ts';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-path-evidence-'));
const samples: WriteOperationDiagnostic[] = [];
after(() => {
  const destination = process.env.STASHBASE_DIAGNOSTIC_FIXTURE_DIR;
  if (destination) {
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    samples.forEach((operation, index) => {
      const bundle = writeDiagnosticBundleSchema.parse({
        schema_version: 1, diagnostic_id: operation.diagnostic_id,
        first_seen: operation.started_at, last_seen: operation.finished_at, occurrences: 1,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(), operations: [operation],
        completeness: operation.completeness, gaps: operation.gaps,
        delivery: { status: 'local_only', attempts: 0 },
      });
      fs.writeFileSync(path.join(destination, `p${index + 1}.json`), JSON.stringify(bundle, null, 2), { mode: 0o600 });
    });
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function capture(target: string, work: () => Promise<unknown>) {
  let diagnostic: WriteOperationDiagnostic | undefined;
  let error: unknown;
  const scope = currentProjectDiagnosticScope();
  await traceWriteOperation({ operation: 'write', path: target, origin: scope.runtime ? 'agent' : 'mcp',
    runtime: scope.runtime, session_root: scope.folder, turn_id: scope.turn_id, runtime_version: scope.runtime_version },
  work, value => { diagnostic = value; }).catch(caught => { error = caught; });
  assert.ok(diagnostic);
  assert.equal(diagnostic.completeness, 'complete', JSON.stringify(diagnostic.gaps));
  samples.push(diagnostic);
  return { diagnostic, error };
}

function observations(operation: WriteOperationDiagnostic, action: string) {
  return operation.steps.filter(step => step.action === action).map(step => step.evidence);
}

test('Windows path evidence reproduces actual drive, case, separator and Unicode decisions', async (t) => {
  const windows = createFilesystemPath({ platform: 'win32', cwd: 'C:\\' });
  const originalConfig = readAppConfigStrict();
  const originalPlatform = filesystemPath.platform;
  t.after(() => {
    Object.defineProperty(filesystemPath, 'platform', { value: originalPlatform });
    writeAppConfigStrict(originalConfig);
  });
  for (const key of Object.keys(windows) as Array<keyof typeof windows>) {
    if (key !== 'platform') t.mock.method(filesystemPath, key, windows[key]);
  }
  Object.defineProperty(filesystemPath, 'platform', { value: 'win32' });
  const root = 'C:\\Work\\Caf\u00e9';
  writeAppConfigStrict({ ...originalConfig, recentFolders: [{ path: root, openedAt: new Date().toISOString() }] });
  t.mock.method(fs.promises, 'stat', async () => ({ isDirectory: () => true } as fs.Stats));
  t.mock.method(fs.promises, 'readdir', async () => []);

  const accepted = 'c:/wORK/Caf\u00e9/\u6587\u7a3f\u200b.ts';
  const same = await capture(accepted, () => normalizeProjectFilePath(accepted));
  assert.equal(same.error, undefined);
  const matched = observations(same.diagnostic, 'path.contains').find(value => value.candidate === windows.absolute(accepted));
  assert.equal(matched?.matches, true);
  assert.equal(matched?.root_identity, 'c:/work/café');
  assert.equal(matched?.candidate_identity, 'c:/work/café/文稿\u200b.ts');
  assert.equal(same.diagnostic.raw_path, accepted);

  for (const rejected of ['d:\\Work\\Caf\u00e9\\\u6587\u7a3f.ts', 'c:\\WORK\\Cafe\u0301\\\u6587\u7a3f.ts']) {
    const failed = await capture(rejected, () => normalizeProjectFilePath(rejected));
    assert.equal(failed.diagnostic.error?.code, 'PROJECT_PATH_OUTSIDE');
    assert.equal(failed.diagnostic.failed_stage, 'project_match');
    assert.equal(failed.diagnostic.stages.session_scope, 'not_reached');
    assert.equal(failed.diagnostic.raw_path, rejected);
    const compared = observations(failed.diagnostic, 'path.contains')[0];
    assert.equal(compared.platform, 'win32');
    assert.equal(compared.matches, false);
    const replay = createFilesystemPath({ platform: 'win32' });
    assert.equal(replay.contains(String(compared.root), String(compared.candidate)), compared.matches);
    assert.equal(replay.identity(String(compared.candidate)), compared.candidate_identity);
  }
});

test('registered-project refusal and live-session refusal retain different authoritative roots', async (t) => {
  const roots = [path.join(scratch, 'p0'), path.join(scratch, 'p1')];
  for (const root of roots) { fs.mkdirSync(root); await registerProjectFolderAsync(root); }
  const outside = path.join(scratch, 'p2', 'entry.ts');
  const rejected = await capture(outside, () => normalizeProjectFilePath(outside));
  assert.equal(rejected.diagnostic.error?.code, 'PROJECT_PATH_OUTSIDE');
  assert.ok(roots.every(root => observations(rejected.diagnostic, 'folder.match').some(value => value.root === root && value.matched === false)));
  registerAttributedAgentSession('path-diagnostic-session', {
    agentId: 'claude', windowId: 'path-diagnostic-window', boundFolder: () => roots[0], turnInFlight: () => true,
    diagnosticContext: () => ({ turn_id: 'path-diagnostic-turn', runtime_version: 'fixture-version' }),
  });
  t.after(() => unregisterAttributedAgentSession('path-diagnostic-session'));
  const target = path.join(roots[1], 'entry.ts');
  const denied = await withAgentProjectScope('path-diagnostic-session', () => capture(target, () => normalizeProjectFilePath(target)));
  assert.equal(denied.diagnostic.error?.code, 'PROJECT_SCOPE_MISMATCH');
  assert.equal(denied.diagnostic.failed_stage, 'session_scope');
  assert.equal(denied.diagnostic.session_root, roots[0]);
  assert.equal(denied.diagnostic.turn_id, 'path-diagnostic-turn');
  assert.equal(denied.diagnostic.runtime_version, 'fixture-version');
  assert.ok(observations(denied.diagnostic, 'folder.match').some(value => value.root === roots[1] && value.matched === true));
  assert.equal(observations(denied.diagnostic, 'session_scope.result')[0].allowed, false);
  assert.equal(denied.diagnostic.stages.read, 'not_reached');
});

test('realpath failure and symlink refusal record the original observed result without checking again', async (t) => {
  const root = path.join(scratch, 'p3');
  const other = path.join(scratch, 'p4');
  fs.mkdirSync(root); fs.mkdirSync(other);
  const alias = path.join(root, 'p5');
  fs.symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const target = path.join(alias, 'entry.ts');
  const paths = createFilesystemPath();
  const escaped = await capture(target, () => paths.resolveUnderAsync(root, 'p5/entry.ts', { access: 'creatable' }));
  assert.equal(escaped.diagnostic.error?.code, 'PATH_SYMLINK_ESCAPE');
  assert.ok(observations(escaped.diagnostic, 'path.realpath').some(value => value.path === alias && value.result === fs.realpathSync.native(other)));
  assert.equal(escaped.diagnostic.failed_action, 'path.resolve_under');
  fs.unlinkSync(alias);
  fs.mkdirSync(alias);
  assert.ok(observations(escaped.diagnostic, 'path.realpath').some(value => value.path === alias && value.result === fs.realpathSync.native(other)), 'the recorded decision must not change with the filesystem');

  const original = fs.realpath.native;
  let calls = 0;
  t.mock.method(fs.realpath, 'native', (input: fs.PathLike, callback: (error: NodeJS.ErrnoException | null, value?: string) => void) => {
    calls += 1;
    if (String(input) === root) return callback(Object.assign(new Error('private excerpt omitted'), { code: 'EACCES', errno: -13, syscall: 'realpath', path: root }));
    return original(input, callback);
  });
  const denied = await capture(path.join(root, 'entry.ts'), () => paths.resolveUnderAsync(root, 'entry.ts', { access: 'existing' }));
  assert.equal(denied.diagnostic.error?.code, 'EACCES');
  assert.equal(denied.diagnostic.failed_stage, 'path_resolution');
  assert.ok(observations(denied.diagnostic, 'path.realpath').some(value => value.path === root && value.code === 'EACCES' && value.errno === -13));
  assert.equal(calls, 1, 'diagnostics do not retry the failed syscall');
  assert.equal(JSON.stringify(denied.diagnostic).includes('private excerpt'), false);
});

test('successful diagnostic capture does not add filesystem probes', async (t) => {
  const root = path.join(scratch, 'p6'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'entry.ts'), 'fixture');
  const paths = createFilesystemPath({ platform: process.platform === 'win32' ? 'win32' : 'posix' });
  const original = fs.realpath.native;
  const calls: string[] = [];
  t.mock.method(fs.realpath, 'native', (input: fs.PathLike, callback: (error: NodeJS.ErrnoException | null, value?: string) => void) => {
    calls.push(String(input)); return original(input, callback);
  });
  await paths.resolveUnderAsync(root, 'entry.ts', { access: 'existing' });
  const plain = [...calls]; calls.length = 0;
  const traced = await capture(path.join(root, 'entry.ts'), () => paths.resolveUnderAsync(root, 'entry.ts', { access: 'existing' }));
  assert.equal(traced.error, undefined);
  assert.deepEqual(calls, plain);
});
