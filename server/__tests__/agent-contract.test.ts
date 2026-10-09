import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILT_IN_AGENT_ADAPTERS } from '../agent-adapters.ts';
import {
  attachAgentRuntime,
  discoverAgentRuntimes,
  disposeSessionsBoundToFolder,
  parseAgentEffort,
  registerAgentAdapter,
  resolveAgentSessionFolder,
  resolveAgentSessionScope,
  resolveSessionBinding,
  runtimeDescriptorFor,
  type AgentClientEvent,
  type AgentServerEvent,
} from '../agent-contract.ts';
import { smokeNativeAgentCli } from '../agent-native-smoke.ts';

const REQUIRED_SHARED_CAPABILITIES = [
  'connection', 'prompts', 'interrupt', 'transcript', 'approvals', 'history',
] as const;

test('every built-in runtime declares the fundamental Shared Agent Contract behavior', () => {
  assert.deepEqual(BUILT_IN_AGENT_ADAPTERS.map((adapter) => [adapter.id, adapter.label]), [
    ['codex', 'Codex'],
    ['claude', 'Claude'],
    ['stashbase', 'Default'],
  ]);
  for (const adapter of BUILT_IN_AGENT_ADAPTERS) {
    for (const capability of REQUIRED_SHARED_CAPABILITIES) {
      assert.equal(adapter.capabilities[capability], true, `${adapter.id} must support ${capability}`);
    }
    assert.equal(typeof adapter.attach, 'function');
    assert.equal(typeof adapter.stop, 'function');
    assert.equal(typeof adapter.stopFolder, 'function');
    assert.equal(typeof adapter.history.list, 'function');
    assert.equal(typeof adapter.history.messages, 'function');
    assert.equal(typeof adapter.history.rename, 'function');
    assert.equal(typeof adapter.history.remove, 'function');
  }
});

test('runtime-only capabilities stay adapter-specific', () => {
  const capabilities = Object.fromEntries(BUILT_IN_AGENT_ADAPTERS.map((adapter) => [adapter.id, adapter.capabilities]));
  assert.equal(capabilities.claude!.steering, false);
  assert.equal(capabilities.claude!.titleHint, false);
  assert.equal(capabilities.codex!.steering, true);
  assert.equal(capabilities.codex!.titleHint, true);
  assert.deepEqual(capabilities.stashbase!.modes, ['default', 'acceptEdits', 'plan']);
  assert.deepEqual(capabilities.claude!.modes, ['default', 'acceptEdits', 'plan', 'auto']);
  assert.deepEqual(capabilities.codex!.modes, ['default', 'acceptEdits', 'plan', 'auto']);
  assert.equal(capabilities.stashbase!.models, false);
  assert.equal(capabilities.stashbase!.skills, false);
  assert.equal(capabilities.stashbase!.attachments, false);
  assert.equal(capabilities.claude!.attachments, true);
  assert.equal(capabilities.codex!.attachments, true);
});

test('Agent effort identifiers stay runtime-owned while the URL boundary remains bounded', () => {
  assert.equal(parseAgentEffort('ultra'), 'ultra');
  assert.equal(parseAgentEffort('provider_native-level'), 'provider_native-level');
  assert.equal(parseAgentEffort(''), undefined);
  assert.equal(parseAgentEffort(' ultra '), undefined);
  assert.equal(parseAgentEffort('x'.repeat(65)), undefined);
  assert.equal(parseAgentEffort('high\n'), undefined);
});

test('Shared Agent Contract retains lifecycle, streaming, approval, session, and queue event vocabulary', () => {
  const clientEvents: AgentClientEvent[] = [
    { t: 'prompt', text: 'first', titleHint: 'Title' }, { t: 'steer', id: 'queued', text: 'follow-up' },
    { t: 'permission-reply', id: 'approval', allow: true, always: true },
    { t: 'permission-reply', id: 'question', allow: true, answers: { 'Which format?': 'Summary' } },
    { t: 'interrupt' },
    { t: 'set-model', model: 'native-model' }, { t: 'set-mode', mode: 'plan' },
    { t: 'close' },
  ];
  const events: AgentServerEvent[] = [
    { t: 'ready' }, { t: 'session-id', id: 'session' }, { t: 'session-title', title: 'Title' },
    { t: 'models', models: [{ id: 'native-model', label: 'Native model' }], activeModel: 'native-model' },
    { t: 'turn-start' }, { t: 'text', delta: 'text' }, { t: 'thinking', delta: 'thinking' },
    { t: 'tool', id: 'tool', name: 'Read', input: {} }, { t: 'tool-delta', id: 'tool', delta: 'input' },
    { t: 'tool-result', id: 'tool', content: 'done', isError: false },
    { t: 'file-diff', id: 'diff', file: 'notes.md', before: 'old', after: 'new', additions: 1, deletions: 1 },
    { t: 'permission', id: 'approval', toolUseId: 'tool', name: 'Write', title: null, input: {} },
    { t: 'steer-result', id: 'queued', ok: true },
    { t: 'turn-end', isError: false },
    { t: 'error', message: 'runtime unavailable' }, { t: 'exit' },
    { t: 'exit', message: 'runtime stopped unexpectedly' },
    { t: 'exit', reason: 'scope-removed', folder: '/Users/me/Projects/Research' },
  ];
  assert.equal(clientEvents.length, 8);

});

test('capability discovery reports installed and unavailable native runtimes without changing adapter metadata', () => {
  const expectedInstallHints = {
    claude: process.platform === 'win32'
      ? 'irm https://claude.ai/install.ps1 | iex'
      : 'curl -fsSL https://claude.ai/install.sh | bash',
    codex: process.platform === 'win32'
      ? 'irm https://chatgpt.com/codex/install.ps1 | iex'
      : 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
  } as const;
  for (const adapter of BUILT_IN_AGENT_ADAPTERS) {
    if (adapter.id === 'stashbase') continue;
    const available = runtimeDescriptorFor(adapter, `/native/${adapter.id}`);
    assert.equal(available.state, 'available');
    assert.equal(available.source, 'system');
    assert.equal(available.bootstrap.phase, 'idle');
    assert.equal(available.version, null, 'an executable that cannot report a version is still discovered');
    assert.equal(available.updatable, true, 'both native runtimes support the official native installer');
    const unavailable = runtimeDescriptorFor(adapter, null);
    assert.equal(unavailable.state, 'unavailable');
    assert.equal(unavailable.source, null);
    assert.equal(unavailable.updatable, false);
    assert.equal(unavailable.installHint, expectedInstallHints[adapter.id]);
  }

});

test('capability discovery publishes the registered adapter catalog', async () => {
  for (const adapter of BUILT_IN_AGENT_ADAPTERS) registerAgentAdapter(adapter);
  const discovered = await discoverAgentRuntimes();
  assert.deepEqual(discovered.map((runtime) => runtime.id), ['codex', 'claude', 'stashbase']);
  for (const runtime of discovered) {
    const adapter = BUILT_IN_AGENT_ADAPTERS.find((candidate) => candidate.id === runtime.id)!;
    assert.equal(runtime.endpoint, '/ws/agent');
    assert.deepEqual(runtime.capabilities, adapter.capabilities);
  }
});

test('an explicit session folder is accepted only when it is a registered project folder', () => {
  const members = ['/Users/me/Documents/StashBase/Notes', '/Users/me/Projects/Research'];

  // Explicit member folder → accepted with the stored member spelling.
  const accepted = resolveAgentSessionFolder('/Users/me/Projects/Research', members);
  assert.deepEqual(accepted, { ok: true, folder: '/Users/me/Projects/Research' });

  // Absent/empty → fall back to the window's current folder (no explicit binding).
  assert.deepEqual(resolveAgentSessionFolder('/Users/me/Projects/Research ', ['/Users/me/Projects/Research ']), { ok: true, folder: '/Users/me/Projects/Research ' });
  assert.equal(resolveAgentSessionFolder('/Users/me/Projects/Research ', members).ok, false);
  assert.deepEqual(resolveAgentSessionFolder(undefined, members), { ok: true });
  assert.deepEqual(resolveAgentSessionFolder(null, members), { ok: true });
  assert.deepEqual(resolveAgentSessionFolder('   ', members), { ok: true });

  // Anything outside membership is rejected — never bound to an agent session.
  assert.equal(resolveAgentSessionFolder('/etc', members).ok, false);
  assert.equal(resolveAgentSessionFolder('/Users/me/Projects/Research/nested', members).ok, false);
  assert.equal(resolveAgentSessionFolder('relative/path', members).ok, false);
  assert.equal(resolveAgentSessionFolder(['/Users/me/Projects/Research'], members).ok, false);
  assert.equal(resolveAgentSessionFolder('/anything', []).ok, false);
});

test('folder-bound teardown ends only the sessions bound to the removed folder', () => {
  const makeSession = (bound: string | null) => {
    const session = {
      disposed: false,
      termination: null as null | { kind: 'scope-removed'; folder: string },
      boundFolder: () => bound,
      dispose(termination?: { kind: 'scope-removed'; folder: string }) {
        session.disposed = true;
        session.termination = termination ?? null;
      },
    };
    return session;
  };
  const removedA = makeSession('/Users/me/Projects/Research');
  // Equivalent spelling still matches — comparison is filesystem identity.
  const removedB = makeSession('/Users/me/Projects/Research/');
  const otherFolder = makeSession('/Users/me/Documents/StashBase/Notes');
  const unstarted = makeSession(null);
  const sessions = new Set([removedA, removedB, otherFolder, unstarted]);

  disposeSessionsBoundToFolder(sessions, '/Users/me/Projects/Research');

  assert.equal(removedA.disposed, true);
  assert.equal(removedB.disposed, true);
  assert.deepEqual(removedA.termination, {
    kind: 'scope-removed',
    folder: '/Users/me/Projects/Research',
  });
  assert.deepEqual(removedB.termination, removedA.termination);
  assert.equal(otherFolder.disposed, false);
  assert.equal(otherFolder.termination, null);
  assert.equal(unstarted.disposed, false);
  assert.deepEqual([...sessions], [otherFolder, unstarted]);
});

test('unsupported runtime connections return a contract error and close cleanly', () => {
  const sent: string[] = [];
  let closed = false;
  const ws = { send: (message: string) => sent.push(message), close: () => { closed = true; } };
  attachAgentRuntime('unsupported', ws as never, { windowId: 'test-window' });
  assert.deepEqual(sent, [JSON.stringify({ t: 'error', message: 'Unsupported agent runtime.' })]);
  assert.equal(closed, true);
});

test('native CLI smoke checks report protocol incompatibility with an actionable error', () => {
  const codex = smokeNativeAgentCli('codex', '/native/codex', () => ({ status: 0, stdout: 'usage: codex', stderr: '' }));
  assert.equal(codex.ok, false);
  assert.match(codex.message, /app-server/);

  const claude = smokeNativeAgentCli('claude', '/native/claude', () => ({ status: 1, stdout: '', stderr: 'bad flag' }));
  assert.equal(claude.ok, false);
  assert.match(claude.message, /exit code 1/);
});

test('session requests require an explicit registered project and reject unbound or aggregate scope', () => {
 const project = '/work/project';
 for (const scope of ['unbound', 'all', '', []]) assert.equal(resolveAgentSessionScope(scope, project, [project]).ok, false);
 for (const folder of [undefined, '', '/outside']) assert.equal(resolveAgentSessionScope(undefined, folder, [project]).ok, false);
 assert.deepEqual(resolveAgentSessionScope(undefined, project, [project]), { ok: true, scope: { kind: 'folder', path: project } });
 assert.throws(() => resolveSessionBinding({ currentFolder: null }), /Open a project/);
 assert.deepEqual(resolveSessionBinding({ folder: project, currentFolder: '/other' }), { cwd: project });
});
