/** Authorized MCP project creation and live-session attribution. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DIRECTORY_LINK } from './filesystem-links.ts';

// Isolate application data before
// importing the modules under test (each test file runs in its own process).
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-agent-projects-'));
process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(scratch, 'app-data');

const { createProjectFolder, resolveCreateProjectTargetAsync } = await import('../agent-projects.ts');
type CreateProjectDeps = import('../agent-projects.ts').CreateProjectDeps;
const { filesystemPath } = await import('../filesystem-path.ts');
const {
  registerAttributedAgentSession,
  unregisterAttributedAgentSession,
  attributedAgentSession,
} = await import('../agent-session-registry.ts');
type AttributedAgentSession = import('../agent-session-registry.ts').AttributedAgentSession;


const HOME = path.join(scratch, 'folder-home');
const MEMBER = path.join(scratch, 'members', 'Research');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(MEMBER, { recursive: true });

/** create_project returns the filesystem seam's source spelling, which uses
 * forward slashes on Windows rather than Node's platform-native separator. */
const projectPath = (name: string, parent = HOME) => filesystemPath.join(parent, name);

interface DepsLog {
  registered: string[];
  treeChanges: number;
  synced: string[];
}

function fakeSession(): AttributedAgentSession {
 return { agentId: 'claude', windowId: 'w-test', turnInFlight: () => false, boundFolder: () => MEMBER };
}

function fakeDeps(): { deps: CreateProjectDeps; log: DepsLog } {
  const log: DepsLog = { registered: [], treeChanges: 0, synced: [] };
  const deps: CreateProjectDeps = {
    folderHome: () => HOME,
    memberRoots: () => [MEMBER],
    register: (abs) => { log.registered.push(abs); },
    noteTreeChanged: () => { log.treeChanges += 1; },
    syncFolder: async (abs) => { log.synced.push(abs); },
    assertAvailable: () => {},
  };
  return { deps, log };
}

test('create_project validates the name as one cross-platform-safe segment', async () => {
  const scope = { folderHome: HOME, memberRoots: [MEMBER] };
  assert.equal((await resolveCreateProjectTargetAsync('Thesis Notes', undefined, scope)).ok, true);
  for (const bad of ['', '   ', 'a/b', 'a\\b', '..', '.hidden', 'name.', 'na<me', 'x'.repeat(65)]) {
    assert.equal((await resolveCreateProjectTargetAsync(bad, undefined, scope)).ok, false, `name ${JSON.stringify(bad)} must be rejected`);
  }
  assert.equal((await resolveCreateProjectTargetAsync(42, undefined, scope)).ok, false);
});

test('create_project defaults to the folder home and accepts only owned locations', async () => {
  const scope = { folderHome: HOME, memberRoots: [MEMBER] };
  const defaulted = await resolveCreateProjectTargetAsync('Proj', undefined, scope);
  assert.deepEqual(defaulted, { ok: true, parent: HOME, target: projectPath('Proj'), name: 'Proj', owner: filesystemPath.absolute(HOME) });

  // The folder home itself, inside it, a member root, and inside a member
  // root are all valid explicit locations.
  for (const location of [HOME, path.join(HOME, 'nested'), MEMBER, path.join(MEMBER, 'sub')]) {
    const resolved = await resolveCreateProjectTargetAsync('Proj', location, scope);
    assert.equal(resolved.ok, true, `location ${location} must be accepted`);
    if (resolved.ok) assert.equal(resolved.target, projectPath('Proj', location));
  }

  // Arbitrary host paths and relative paths never become registered folders.
  for (const location of ['/etc', os.homedir(), 'relative/dir', path.dirname(HOME)]) {
    assert.equal((await resolveCreateProjectTargetAsync('Proj', location, scope)).ok, false, `location ${location} must be rejected`);
  }
});

test('create_project creates and registers an empty folder without writing Agent files', async () => {
  const { deps, log } = fakeDeps();
  const result = await createProjectFolder({ name: 'Unattributed' }, deps);
  const target = projectPath('Unattributed');
  assert.equal(result.path, target);
  assert.equal(result.registered, true);
  assert.equal(fs.statSync(target).isDirectory(), true);
  assert.deepEqual(log.registered, [target]);
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(log.treeChanges, 1);
  // Background bind/sync is queued for the new member.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log.synced, [target]);
});

test('create_project explicitly creates a missing default home after validating the target', async () => {
  const { deps, log } = fakeDeps();
  const missingHome = path.join(scratch, 'missing-home');
  deps.folderHome = () => missingHome;
  await assert.rejects(() => createProjectFolder({ name: '../invalid' }, deps), /invalid project name/);
  assert.equal(fs.existsSync(missingHome), false);
  const result = await createProjectFolder({ name: 'First Project' }, deps);
  assert.equal(result.path, projectPath('First Project', missingHome));
  assert.deepEqual(fs.readdirSync(missingHome), ['First Project']);
  assert.deepEqual(log.registered, [result.path]);
});

test('create_project still checks removal before creating the resolved target', async () => {
  const { deps, log } = fakeDeps();
  deps.assertAvailable = () => { throw new Error('folder removal is in progress'); };
  await assert.rejects(() => createProjectFolder({ name: 'Removing' }, deps), /removal is in progress/);
  assert.equal(fs.existsSync(projectPath('Removing')), false);
  assert.deepEqual(log.registered, []);
});

test('an existing directory is a conflict, not a silent reuse', async () => {
  const { deps } = fakeDeps();
  await createProjectFolder({ name: 'Duplicate' }, deps);
  await assert.rejects(
    () => createProjectFolder({ name: 'Duplicate' }, deps),
    (err: Error & { status?: number; code?: string }) => err.status === 409 && err.code === 'FOLDER_EXISTS',
  );
});

test('create_project removes its empty directory when membership cannot commit', async () => {
  const { deps } = fakeDeps();
  deps.register = () => { throw new Error('config unavailable'); };
  const target = projectPath('Uncommitted');
  await assert.rejects(() => createProjectFolder({ name: 'Uncommitted' }, deps), /config unavailable/);
  assert.equal(fs.existsSync(target), false);
});

test('creation preserves the exact location when a distinct trimmed sibling exists', {
  skip: process.platform === 'win32' && 'Win32 paths do not preserve trailing spaces',
}, async () => {
  const plain = path.join(HOME, 'Parent');
  const spaced = `${plain} `;
  fs.mkdirSync(plain);
  fs.mkdirSync(spaced);
  const { deps, log } = fakeDeps();
  const result = await createProjectFolder({ name: 'Child', location: spaced }, deps);
  assert.equal(result.path, projectPath('Child', spaced));
  assert.equal(fs.existsSync(path.join(spaced, 'Child')), true);
  assert.equal(fs.existsSync(path.join(plain, 'Child')), false);
  assert.deepEqual(log.registered, [result.path]);
});

test('registration rollback preserves a replacement directory and newly added files', async () => {
  for (const replacement of [false, true]) {
    const { deps, log } = fakeDeps();
    const name = replacement ? 'Replacement' : 'NewFiles';
    const target = projectPath(name);
    deps.register = async (abs) => {
      if (replacement) {
        await fs.promises.rename(abs, `${abs}-original`);
        await fs.promises.mkdir(abs);
      } else {
        await fs.promises.writeFile(path.join(abs, 'user.txt'), 'keep');
      }
      throw new Error('registration failed');
    };
    await assert.rejects(createProjectFolder({ name }, deps), /registration failed/);
    assert.equal(fs.statSync(target).isDirectory(), true);
    if (replacement) assert.equal(fs.statSync(`${target}-original`).isDirectory(), true);
    else assert.equal(fs.readFileSync(path.join(target, 'user.txt'), 'utf8'), 'keep');
    assert.equal(log.treeChanges, 0);
    assert.deepEqual(log.synced, []);
  }
});

test('invalid input surfaces a 400 without touching disk', async () => {
  const { deps, log } = fakeDeps();
  await assert.rejects(
    () => createProjectFolder({ name: 'nested/name' }, deps),
    (err: Error & { status?: number }) => err.status === 400,
  );
  await assert.rejects(
    () => createProjectFolder({ name: 'Fine', location: '/etc' }, deps),
    (err: Error & { status?: number }) => err.status === 400,
  );
  await assert.rejects(
    () => createProjectFolder({ name: 'Fine', location: path.join(HOME, 'does-not-exist') }, deps),
    (err: Error & { status?: number }) => err.status === 400,
  );
  assert.deepEqual(log.registered, []);
});

test('create_project rejects a location that escapes an owned root through a symlink', async (t) => {
  const outside = path.join(scratch, 'outside-owned-roots');
  const link = path.join(HOME, 'linked-outside');
  fs.mkdirSync(outside, { recursive: true });
  try {
    fs.symlinkSync(outside, link, DIRECTORY_LINK);
  } catch (error) {
    t.skip(`symlinks are unavailable in this environment: ${String(error)}`);
    return;
  }

  const { deps, log } = fakeDeps();
  await assert.rejects(
    () => createProjectFolder({ name: 'Escaped', location: link }, deps),
    (err: Error & { status?: number; code?: string }) => err.status === 400 && err.code === 'INVALID_PROJECT',
  );
  assert.equal(fs.existsSync(path.join(outside, 'Escaped')), false);
  assert.deepEqual(log.registered, []);
});

test('the attribution registry maps ids to live sessions and forgets them on unregister', () => {
  const session = fakeSession();
  registerAttributedAgentSession('attr-registry', session);
  assert.equal(attributedAgentSession('attr-registry'), session);
  assert.equal(attributedAgentSession('  attr-registry  '), session);
  assert.equal(attributedAgentSession('unknown'), null);
  assert.equal(attributedAgentSession(undefined), null);
  unregisterAttributedAgentSession('attr-registry');
  assert.equal(attributedAgentSession('attr-registry'), null);
});
