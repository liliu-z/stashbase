/** Read restricted write diagnostics without probing any captured filesystem path. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import {
  writeDiagnosticBundleSchema,
  type DiagnosticValue,
  type WriteDiagnosticBundle,
  type WriteOperationDiagnostic,
} from '../shared/protocols/write-diagnostics.ts';
import { createFilesystemPath, type FilesystemPlatform } from '../server/filesystem-path.ts';
import { appDataRoot } from '../server/local-data.ts';

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
type Evidence = Record<string, DiagnosticValue>;
type Assessment = 'supported_refusal' | 'observed_system_failure' | 'inconsistent_evidence' | 'insufficient_evidence' | 'success';
type FixtureKind = 'path_semantics' | 'project_outside' | 'session_mismatch' | 'symlink_escape' | 'missing_source' | 'edit_match' | 'requested_version' | 'commit_version' | 'system_failure' | 'path_validation' | 'unavailable';

export interface WriteReplayCase {
  operation_id: string;
  expected_code: string;
  failed_stage: string | null;
  failed_action: string | null;
  assessment: Assessment;
  kind: FixtureKind;
  platform: FilesystemPlatform;
  raw_path: string | null;
  evidence: WriteOperationDiagnostic['steps'];
  gaps: string[];
  contradictions: string[];
  synthetic_edit?: { source: string; old_text: string; new_text: string; replace_all: boolean; observed_match_count: number };
  system_failure?: { api: string; syscall: string; code: string; errno?: number | string; fail_at_call: number };
}

export interface WriteReplayEnvironment {
  schema_version: 1;
  diagnostic_ids: string[];
  purpose: 'branch_regression_from_captured_evidence';
  limitations: string[];
  cases: WriteReplayCase[];
}

function facts(operation: WriteOperationDiagnostic, action: string): Evidence[] {
  return operation.steps.filter((step) => step.action === action).map((step) => step.evidence);
}

function lastFact(operation: WriteOperationDiagnostic, action: string): Evidence | undefined {
  return facts(operation, action).at(-1);
}

function object(value: DiagnosticValue | undefined): Evidence | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function platformOf(operation: WriteOperationDiagnostic): FilesystemPlatform {
  const value = lastFact(operation, 'project_path.input')?.platform ?? lastFact(operation, 'path.resolve_under.inputs')?.platform ?? lastFact(operation, 'path.identity')?.platform ?? operation.os;
  return value === 'win32' ? 'win32' : value === 'darwin' ? 'darwin' : 'posix';
}

function contained(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** Compare captured decisions to their captured operands; never repeat a disk probe. */
function pathContradictions(operation: WriteOperationDiagnostic): string[] {
  const contradictions: string[] = [];
  for (const fact of facts(operation, 'path.contains')) {
    if (typeof fact.root_identity !== 'string' || typeof fact.candidate_identity !== 'string' || typeof fact.matches !== 'boolean') continue;
    if (contained(fact.root_identity, fact.candidate_identity) !== fact.matches) {
      contradictions.push('Captured containment result disagrees with its actual comparison identities.');
    }
  }
  // Windows and POSIX lexical identity are portable. macOS volume identity is
  // intentionally assessed from recorded probes, never this machine's volume.
  const platform = platformOf(operation);
  if (platform === 'darwin') return contradictions;
  const paths = createFilesystemPath({ platform, cwd: platform === 'win32' ? 'C:/' : '/' });
  for (const fact of facts(operation, 'path.identity')) {
    if (typeof fact.path !== 'string' || typeof fact.comparison_identity !== 'string') continue;
    try {
      if (paths.identity(fact.path) !== fact.comparison_identity) {
        contradictions.push('Captured path identity disagrees with the current platform path implementation.');
      }
    } catch {
      contradictions.push('A captured successful path identity is rejected by the current path implementation.');
    }
  }
  return [...new Set(contradictions)];
}

export function diagnoseWriteOperation(operation: WriteOperationDiagnostic): WriteReplayCase {
  const code = operation.error?.code ?? 'NONE';
  const gaps = [...operation.gaps];
  const contradictions = pathContradictions(operation);
  const result: WriteReplayCase = {
    operation_id: operation.operation_id,
    expected_code: code,
    failed_stage: operation.failed_stage ?? null,
    failed_action: operation.failed_action ?? null,
    assessment: operation.outcome === 'success' ? 'success' : 'insufficient_evidence',
    kind: 'unavailable', platform: platformOf(operation), raw_path: operation.raw_path,
    evidence: operation.steps, gaps, contradictions,
  };
  const support = (kind: FixtureKind, condition: boolean, missing: string): void => {
    result.kind = kind;
    if (condition) result.assessment = 'supported_refusal';
    else gaps.push(missing);
  };
  if (operation.outcome === 'success') {
    result.kind = 'path_semantics';
    if (contradictions.length) result.assessment = 'inconsistent_evidence';
    else if (gaps.length || !operation.steps.some((step) => step.action === 'path.contains' || step.action === 'path.identity')) {
      result.assessment = 'insufficient_evidence';
      gaps.push('Successful operation has no replayable path comparison evidence.');
    }
    return result;
  }
  if (!operation.failed_stage || !operation.failed_action) gaps.push('The failing stage/action was not captured.');
  if (code === 'PROJECT_PATH_OUTSIDE') {
    const matches = facts(operation, 'folder.match');
    const completed = lastFact(operation, 'folder.match_result');
    support('project_outside', completed?.selected_root === null && matches.every((item) => item.matched === false), 'No complete rejected project candidate decisions were captured.');
    if (matches.some((item) => item.matched === true)) contradictions.push('Project rejection followed a matching registered root.');
  } else if (code === 'PROJECT_SCOPE_MISMATCH') {
    const bound = lastFact(operation, 'session_scope.bound_project');
    const decision = lastFact(operation, 'session_scope.result');
    support('session_mismatch', typeof bound?.session_folder === 'string' && typeof bound.target === 'string' && decision?.allowed === false, 'The bound session project, checked target, or rejected scope decision is missing.');
  } else if (code === 'PATH_SYMLINK_ESCAPE') {
    const probes = facts(operation, 'path.realpath');
    support('symlink_escape', probes.some((item) => item.outcome === 'ok' && typeof item.result === 'string') && facts(operation, 'path.contains').some((item) => item.matches === false), 'Realpath results and their rejected containment comparison are required.');
  } else if (code === 'FILE_NOT_FOUND') {
    support('missing_source', facts(operation, 'text_snapshot').some((item) => item.present === false && item.system_code === 'ENOENT') && operation.operation === 'edit', 'The missing existing-source read (including ENOENT) is missing.');
  } else if (code === 'EDIT_MISMATCH' || code === 'EDIT_AMBIGUOUS') {
    const match = lastFact(operation, 'edit_match_result');
    const count = match?.match_count;
    const oldLength = object(match?.old_text)?.utf16_length;
    const supported = typeof count === 'number' && Number.isInteger(count) && count >= 0 && typeof oldLength === 'number' && match?.comparison === 'literal_utf16' && match.normalization_applied === 'none';
    support('edit_match', supported, 'Match count, old-text length, comparison mode, or normalization decision is missing.');
    if (supported) {
      const expected = code === 'EDIT_MISMATCH' ? count === 0 : count > 1 && match?.replace_all === false;
      if (!expected) contradictions.push('The edit refusal disagrees with its captured match count or replace_all flag.');
      if (count > 10_000) gaps.push('Synthetic matching is capped at 10,000 matches.');
      else result.synthetic_edit = {
        source: count === 0 ? 'synthetic source' : Array.from({ length: count }, () => 'needle').join('|'),
        old_text: oldLength === 0 ? '' : count === 0 ? 'missing needle' : 'needle',
        new_text: 'synthetic replacement', replace_all: match?.replace_all === true,
        observed_match_count: count,
      };
      const normalized = object(match?.diagnostic_normalized_match_counts);
      if (count === 0 && result.synthetic_edit && normalized) {
        const nfc = typeof normalized.nfc === 'number' ? normalized.nfc : 0;
        const endings = typeof normalized.line_endings === 'number' ? normalized.line_endings : 0;
        const combined = typeof normalized.nfc_and_line_endings === 'number' ? normalized.nfc_and_line_endings : 0;
        if (Math.max(nfc, endings, combined) > 10_000) gaps.push('Normalized synthetic matching is capped at 10,000 matches.');
        else if (combined < nfc + endings) gaps.push('Overlapping normalized matches require a more specific synthetic fixture.');
        else if (nfc > 0 || endings > 0 || combined > 0) {
          result.synthetic_edit.source = [
            ...Array.from({ length: nfc }, () => 'é\n'),
            ...Array.from({ length: endings }, () => 'e\u0301\r\n'),
            ...Array.from({ length: combined - nfc - endings }, () => 'é\r\n'),
          ].join('|');
          result.synthetic_edit.old_text = 'e\u0301\n';
        }
      }
    }
  } else if (code === 'FILE_CHANGED') {
    const commit = lastFact(operation, 'commit_version_result');
    const requested = lastFact(operation, 'check_requested_version');
    if (operation.failed_action === 'check_commit_version') {
      support('commit_version', commit !== undefined && 'expected_version' in commit && 'commit_version' in commit, 'Expected and commit versions are required.');
      if (commit && commit.expected_version === commit.commit_version) contradictions.push('Commit conflict recorded equal expected and commit versions.');
    } else {
      support('requested_version', requested !== undefined && 'request_version' in requested && 'read_version' in requested && requested.required === true, 'Requested/read versions and the required version check are missing.');
      if (requested && requested.request_version === requested.comparison_version) contradictions.push('Requested-version conflict recorded equal compared versions.');
    }
  } else if (code.startsWith('PATH_') && operation.raw_path !== null) {
    support('path_validation', ['PATH_REQUIRED', 'PATH_NOT_ABSOLUTE', 'PATH_INVALID_CHARACTERS', 'PATH_INVALID_SEGMENT', 'PATH_UNSUPPORTED_NAMESPACE', 'PATH_DRIVE_RELATIVE', 'PATH_PLATFORM_MISMATCH'].includes(code), 'This path refusal has no replay implementation yet.');
  } else {
    const failed = operation.steps.find((step) => step.result === 'failed' && step.action === operation.failed_action);
    const syscall = failed?.error?.syscall ?? failed?.evidence.syscall;
    if (failed && typeof syscall === 'string' && /^(?:E[A-Z0-9_]+)$/.test(code)) {
      const api = typeof failed.evidence.syscall === 'string' ? failed.evidence.syscall : syscall;
      result.kind = 'system_failure';
      result.assessment = 'observed_system_failure';
      const previousCalls = operation.steps.filter((step) => step.sequence < failed.sequence && step.result === 'success' && step.evidence.syscall === api).length;
      result.system_failure = { api, syscall, code, fail_at_call: previousCalls + 1, ...(failed.error?.errno !== undefined ? { errno: failed.error.errno } : {}) };
      if (!['realpath', 'open', 'read', 'writeFile', 'chmod', 'rename', 'mkdir'].includes(api)) gaps.push(`The recorded API ${api} has no controlled replay implementation.`);
    } else gaps.push(`No evidence-backed replay is implemented for ${code}; the exception and existing steps remain available.`);
  }
  if (contradictions.length) result.assessment = 'inconsistent_evidence';
  else if (gaps.length) result.assessment = 'insufficient_evidence';
  return result;
}

export function readWriteDiagnosticBundles(input: unknown): WriteDiagnosticBundle[] {
  const values = Array.isArray(input) ? input : [input];
  if (values.length === 0 || values.length > 100) throw new Error('Expected between 1 and 100 diagnostic bundles.');
  return values.map((value) => writeDiagnosticBundleSchema.parse(value));
}

export function writeDiagnosticTimeline(bundles: WriteDiagnosticBundle[]) {
  const operations = new Map<string, WriteOperationDiagnostic>();
  for (const bundle of bundles) for (const operation of bundle.operations) operations.set(operation.operation_id, operation);
  const ordered = [...operations.values()].sort((a, b) => a.started_at.localeCompare(b.started_at));
  return ordered.map((operation, index) => ({
    operation_id: operation.operation_id, diagnostic_id: operation.diagnostic_id,
    started_at: operation.started_at, duration_ms: operation.duration_ms,
    request_id: operation.request_id ?? null, turn_id: operation.turn_id ?? null,
    tool_call_id: operation.tool_call_id ?? null, correlation: operation.correlation,
    outcome: operation.outcome, changed: operation.changed ?? null,
    target_id: operation.target_id, target_relation: operation.target_relation,
    path_changed: operation.path_changed ?? null, raw_path: operation.raw_path,
    failed_stage: operation.failed_stage ?? null, failed_action: operation.failed_action ?? null,
    error_code: operation.error?.code ?? null,
    assessment: diagnoseWriteOperation(operation).assessment,
    follow_ups: operation.outcome !== 'failed' || !operation.turn_id ? [] : ordered.slice(index + 1)
      .filter((later) => later.turn_id === operation.turn_id)
      .map((later) => ({
        operation_id: later.operation_id, outcome: later.outcome, changed: later.changed ?? null,
        relation_to_failure: later.target_identity !== null && operation.target_identity !== null
          ? later.target_identity === operation.target_identity ? 'same_target' : 'changed_target'
          : later.target_id === operation.target_id ? 'same_target' : 'unavailable',
        path_changed: later.raw_path !== operation.raw_path,
      })),
  }));
}

export function buildWriteReplayEnvironment(bundles: WriteDiagnosticBundle[]): WriteReplayEnvironment {
  const operations = new Map<string, WriteOperationDiagnostic>();
  for (const bundle of bundles) for (const operation of bundle.operations) operations.set(operation.operation_id, operation);
  return {
    schema_version: 1, diagnostic_ids: bundles.map((bundle) => bundle.diagnostic_id),
    purpose: 'branch_regression_from_captured_evidence',
    limitations: [
      'Fixtures reproduce the captured failure branch, not original document bytes; all text is synthetic.',
      'System errors use the captured syscall and errno at a controlled boundary; original OS permissions and provider behavior require separate verification.',
      'Windows lexical comparisons execute the production Windows path module on any host. macOS volume checks use captured identities and do not probe the original filesystem.',
      ...bundles.flatMap((bundle) => [...bundle.gaps, ...(bundle.delivery.status === 'failed' || bundle.delivery.status === 'unavailable' ? [`Diagnostic delivery was ${bundle.delivery.status}.`] : [])]),
    ],
    cases: [...operations.values()].map(diagnoseWriteOperation),
  };
}

/** Only generated, opaque names reach fs APIs. Captured paths remain data. */
export async function materializeWriteReplayEnvironment(environment: WriteReplayEnvironment): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stashbase-write-replay-'));
  await fs.promises.chmod(directory, 0o700);
  await fs.promises.writeFile(path.join(directory, 'environment.json'), JSON.stringify(environment, null, 2), { mode: 0o600 });
  const moduleUrl = import.meta.url;
  await fs.promises.writeFile(path.join(directory, 'regression.test.ts'), [
    "import test from 'node:test';",
    "import fs from 'node:fs';",
    `import { executeWriteReplayCase } from ${JSON.stringify(moduleUrl)};`,
    "const environment = JSON.parse(fs.readFileSync(new URL('./environment.json', import.meta.url), 'utf8'));",
    "for (const fixture of environment.cases) test(fixture.operation_id, (t) => executeWriteReplayCase(fixture, t));",
    '',
  ].join('\n'), { mode: 0o600 });
  return directory;
}

/** Called only by the generated isolated Node regression test. */
export async function executeWriteReplayCase(fixture: WriteReplayCase, t: TestContext): Promise<void> {
  if (process.env.STASHBASE_ISOLATED_AGENTS !== '1' || process.env.STASHBASE_TELEMETRY_DISABLED !== '1') {
    throw new Error('Replay must run with server/__tests__/isolated-home.ts preloaded.');
  }
  assert.notEqual(fixture.assessment, 'insufficient_evidence', fixture.gaps.join('\n'));
  assert.notEqual(fixture.kind, 'unavailable', 'No captured evidence supports a replay.');
  const lexical = createFilesystemPath({ platform: fixture.platform, cwd: fixture.platform === 'win32' ? 'C:/' : '/' });
  for (const step of fixture.evidence) {
    if (step.action === 'path.identity' && fixture.platform !== 'darwin') {
      const { path: input, comparison_identity: identity } = step.evidence;
      if (typeof input === 'string' && typeof identity === 'string') assert.equal(lexical.identity(input), identity, 'Production identity differs from captured identity.');
    }
    if (step.action === 'project_path.absolute' && fixture.raw_path !== null) {
      assert.equal(lexical.absolute(fixture.raw_path), step.evidence.normalized_path, 'Production normalization differs from captured path.');
    }
    if (step.action !== 'path.contains') continue;
    const { root, candidate, root_identity, candidate_identity, matches } = step.evidence;
    if (typeof root_identity === 'string' && typeof candidate_identity === 'string' && typeof matches === 'boolean') {
      assert.equal(contained(root_identity, candidate_identity), matches, 'Captured path comparison contradicts its operands.');
    }
    if (fixture.platform !== 'darwin' && typeof root === 'string' && typeof candidate === 'string' && typeof matches === 'boolean') {
      assert.equal(lexical.contains(root, candidate), matches, 'Production path semantics differ from the captured decision.');
    }
  }
  if (fixture.kind === 'path_semantics') return;
  const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stashbase-write-fixture-'));
  t.after(() => fs.promises.rm(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, 'project');
  const other = path.join(scratch, 'other');
  const target = path.join(root, 'source.fixture');
  await fs.promises.mkdir(root);
  await fs.promises.mkdir(other);
  const [{ registerProjectFolderAsync, runWithFolderRoot }, { writeProjectFile, editProjectFile }, transaction] = await Promise.all([
    import('../server/folder.ts'), import('../server/project-file-mutations.ts'), import('../server/text-file-transaction.ts'),
  ]);
  await registerProjectFolderAsync(root);
  const write = () => writeProjectFile(target, 'synthetic replacement');
  const { traceWriteOperation } = await import('../server/write-diagnostic-context.ts');
  const expectFailure = async (work: () => Promise<unknown>, operation: 'write' | 'edit' = 'write'): Promise<WriteOperationDiagnostic> => {
    let captured: WriteOperationDiagnostic | undefined;
    await assert.rejects(traceWriteOperation({ operation, path: target, origin: 'mcp' }, work, (value) => { captured = value; }), { code: fixture.expected_code });
    assert.ok(captured);
    assert.equal(captured.failed_stage, fixture.failed_stage, 'Replay reached a different failure stage.');
    assert.equal(captured.failed_action, fixture.failed_action, 'Replay reached a different failure branch.');
    return captured;
  };
  if (fixture.kind === 'project_outside') {
    await expectFailure(() => writeProjectFile(path.join(other, 'source.fixture'), 'synthetic replacement'));
  } else if (fixture.kind === 'session_mismatch') {
    await registerProjectFolderAsync(other);
    const { registerAttributedAgentSession, unregisterAttributedAgentSession } = await import('../server/agent-session-registry.ts');
    const { withAgentProjectScope } = await import('../server/project-request-scope.ts');
    const id = `diagnostic-replay-${fixture.operation_id}`;
    registerAttributedAgentSession(id, { agentId: 'claude', windowId: id, boundFolder: () => other, turnInFlight: () => true });
    t.after(() => unregisterAttributedAgentSession(id));
    await expectFailure(() => withAgentProjectScope(id, write));
  } else if (fixture.kind === 'symlink_escape') {
    await fs.promises.symlink(other, path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await expectFailure(() => writeProjectFile(path.join(root, 'alias', 'source.fixture'), 'synthetic replacement'));
  } else if (fixture.kind === 'missing_source') {
    await expectFailure(() => editProjectFile(target, 'needle', 'replacement'), 'edit');
    assert.equal(fs.existsSync(target), false);
  } else if (fixture.kind === 'edit_match') {
    const edit = fixture.synthetic_edit;
    assert.ok(edit, 'Synthetic edit cannot be constructed from the supplied match evidence.');
    await fs.promises.writeFile(target, edit.source);
    const replay = await expectFailure(() => editProjectFile(target, edit.old_text, edit.new_text, { replaceAll: edit.replace_all }), 'edit');
    const normalized = fixture.evidence.find((step) => step.action === 'edit_match_result')?.evidence.diagnostic_normalized_match_counts;
    if (normalized && typeof normalized === 'object') assert.deepEqual(lastFact(replay, 'edit_match_result')?.diagnostic_normalized_match_counts, normalized, 'Synthetic normalization evidence differs from the received packet.');
    assert.equal(await fs.promises.readFile(target, 'utf8'), edit.source);
  } else if (fixture.kind === 'requested_version' || fixture.kind === 'commit_version') {
    await fs.promises.writeFile(target, 'current synthetic version');
    const oldVersion = transaction.textVersion('previous synthetic version');
    await expectFailure(() => fixture.kind === 'requested_version'
      ? writeProjectFile(target, 'next synthetic version', { baseVersion: oldVersion })
      : runWithFolderRoot(root, () => transaction.replaceTextSnapshotAsync('source.fixture', 'next synthetic version', oldVersion)));
    assert.equal(await fs.promises.readFile(target, 'utf8'), 'current synthetic version');
  } else if (fixture.kind === 'path_validation') {
    assert.ok(fixture.raw_path !== null);
    // Only the lexical path module sees captured paths; no filesystem operation
    // or project registration ever receives them.
    if (fixture.expected_code === 'PATH_INVALID_CHARACTERS') assert.match(fixture.raw_path, /[\x00-\x1f]/);
    else if (fixture.expected_code === 'PATH_INVALID_SEGMENT') assert.ok(fixture.raw_path.replace(/\\/g, '/').split('/').some((part) => part === '.' || part === '..'));
    else if (fixture.expected_code === 'PATH_REQUIRED') assert.equal(fixture.raw_path.trim(), '');
    else if (fixture.expected_code === 'PATH_NOT_ABSOLUTE') assert.equal(lexical.isAbsolute(fixture.raw_path), false);
    else assert.throws(() => lexical.absolute(fixture.raw_path!));
  } else if (fixture.kind === 'system_failure') {
    const system = fixture.system_failure;
    assert.ok(system);
    await fs.promises.writeFile(target, 'original synthetic text');
    const injected = Object.assign(new Error('Captured system failure replay'), { code: system.code, errno: system.errno, syscall: system.syscall });
    let calls = 0;
    const fail = (): never => { calls++; throw injected; };
    if (system.api === 'realpath' && fixture.failed_action !== 'write_identity_realpath') t.mock.method(fs.realpath, 'native', (_input: unknown, callback: (error: Error) => void) => { calls++; callback(injected); });
    else if (system.api === 'read') t.mock.method(fs.promises, 'open', async () => ({ stat: async () => ({ isFile: () => true, size: 1 }), read: fail, close: async () => undefined }));
    else if (['realpath', 'open', 'writeFile', 'chmod', 'rename', 'mkdir'].includes(system.api)) {
      const api = system.api as 'open';
      const original = fs.promises[api];
      t.mock.method(fs.promises, api, async (...args: Parameters<typeof original>) => {
        if (++calls === system.fail_at_call) throw injected;
        return original(...args);
      });
    } else assert.fail(`No safe syscall replay for ${system.api}.`);
    await expectFailure(write);
    assert.ok(calls > 0, 'The captured failing syscall was not reached.');
    t.mock.restoreAll();
    assert.equal(await fs.promises.readFile(target, 'utf8'), 'original synthetic text');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const usage = 'Usage: node --import tsx scripts/write-diagnostic-replay.ts BUNDLE.json|--id UUID [--materialize] [--verify]';
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(`${usage}\nReads restricted diagnostic evidence. --verify generates and runs isolated branch tests; test output goes to stderr. --id reads the local retained bundle; remote retrieval is unavailable.\n`);
    return;
  }
  const byId = args[0] === '--id';
  const id = byId ? writeDiagnosticBundleSchema.shape.diagnostic_id.parse(args[1]) : undefined;
  const input = byId ? path.join(appDataRoot(), 'write-diagnostics', `${id}.json`) : args[0];
  const options = args.slice(byId ? 2 : 1);
  if (!input || options.some((option) => !['--materialize', '--verify'].includes(option))) {
    throw new Error(usage);
  }
  const missing = (error: NodeJS.ErrnoException): never => {
    if (byId && error.code === 'ENOENT') throw new Error(`No local diagnostic ${id}; it may have expired or failed to persist. Remote attachment retrieval is unavailable in this build.`);
    throw error;
  };
  if (byId) {
    const directory = await fs.promises.lstat(path.dirname(input)).catch(missing);
    const file = await fs.promises.lstat(input).catch(missing);
    if (!directory.isDirectory() || directory.isSymbolicLink() || file.isSymbolicLink()) throw new Error('Local diagnostic retrieval cannot follow symbolic links.');
  }
  const handle = await fs.promises.open(input, fs.constants.O_RDONLY | (byId ? fs.constants.O_NOFOLLOW ?? 0 : 0)).catch(missing);
  let bundles: WriteDiagnosticBundle[];
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error('Diagnostic input must be a regular file no larger than 16 MiB.');
    bundles = readWriteDiagnosticBundles(JSON.parse(await handle.readFile('utf8')));
  } finally { await handle.close(); }
  if (byId && (bundles.length !== 1 || bundles[0].diagnostic_id !== id)) throw new Error('Local diagnostic identity does not match the requested ID.');
  if (byId && Date.parse(bundles[0].expires_at) <= Date.now()) throw new Error('The local diagnostic has expired.');
  const environment = buildWriteReplayEnvironment(bundles);
  const directory = options.length ? await materializeWriteReplayEnvironment(environment) : undefined;
  process.stdout.write(`${JSON.stringify({ timeline: writeDiagnosticTimeline(bundles), environment, ...(directory ? { fixture_directory: directory } : {}) }, null, 2)}\n`);
  if (options.includes('--verify')) {
    const repository = fileURLToPath(new URL('../', import.meta.url));
    const result = spawnSync(process.execPath, [
      '--import', pathToFileURL(path.join(repository, 'node_modules/tsx/dist/loader.mjs')).href,
      '--import', pathToFileURL(path.join(repository, 'server/__tests__/isolated-home.ts')).href,
      '--test', path.join(directory!, 'regression.test.ts'),
    ], { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
