import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createCapturePreferencesStore,
  createUpdatePreferencesStore,
  normalizeCapturePreferences,
  normalizeUpdatePreferences,
  normalizeWorkspacePreferences,
  type AppConfigFile,
} from './app-config.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('clipboard image capture is default-off and persists only an explicit opt-in', () => {
  let config: AppConfigFile = { appearance: { theme: 'dark' } };
  const store = createCapturePreferencesStore({
    read: () => structuredClone(config),
    write: (next) => { config = structuredClone(next); },
  });

  assert.deepEqual(store.get(), { clipboardImageImport: false });
  assert.deepEqual(store.set({ clipboardImageImport: true }), { clipboardImageImport: true });
  assert.equal(config.appearance?.theme, 'dark');
  assert.deepEqual(store.get(), { clipboardImageImport: true });
  assert.deepEqual(normalizeCapturePreferences({ clipboardImageImport: 'yes' }), {
    clipboardImageImport: false,
  });
});

test('hidden-files visibility is default-off and invalid stored state recovers to the safe view', () => {
  assert.deepEqual(normalizeWorkspacePreferences(undefined), { showHiddenFiles: false });
  assert.deepEqual(normalizeWorkspacePreferences(null), { showHiddenFiles: false });
  assert.deepEqual(normalizeWorkspacePreferences('yes'), { showHiddenFiles: false });
  assert.deepEqual(normalizeWorkspacePreferences({ showHiddenFiles: 'yes' }), { showHiddenFiles: false });
  assert.deepEqual(normalizeWorkspacePreferences({ showHiddenFiles: 1 }), { showHiddenFiles: false });
  assert.deepEqual(normalizeWorkspacePreferences({ showHiddenFiles: true }), { showHiddenFiles: true });
  assert.deepEqual(normalizeWorkspacePreferences({ showHiddenFiles: false }), { showHiddenFiles: false });
});

test('hidden-files visibility persists across fresh app-config processes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-workspace-preferences-'));
  const configDir = path.join(home, '.stashbase');
  const configPath = path.join(configDir, 'config.json');
  fs.mkdirSync(configDir);
  fs.writeFileSync(configPath, JSON.stringify({ appearance: { theme: 'dark' } }));
  try {
    const write = runConfigMutation(home, `
      config.setWorkspacePreferences({ showHiddenFiles: true });
    `);
    assert.equal(write.status, 0, write.stderr);
    const read = runConfigMutation(home, `
      process.stdout.write(JSON.stringify(config.getWorkspacePreferences()));
    `);
    assert.equal(read.status, 0, read.stderr);
    assert.deepEqual(JSON.parse(read.stdout), { showHiddenFiles: true });
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).appearance.theme, 'dark');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('desktop update checks are default-on and preserve unrelated config', () => {
  let config: AppConfigFile = { appearance: { theme: 'dark' } };
  const store = createUpdatePreferencesStore({
    read: () => structuredClone(config),
    write: (next) => { config = structuredClone(next); },
  });

  assert.deepEqual(store.get(), { autoCheck: true });
  assert.deepEqual(store.set({ autoCheck: false }), { autoCheck: false });
  assert.equal(config.appearance?.theme, 'dark');
  assert.deepEqual(store.get(), { autoCheck: false });
  assert.deepEqual(normalizeUpdatePreferences({ autoCheck: 'yes' }), {
    autoCheck: true,
  });
});

function runConfigWrite(home: string) {
  return spawnSync(
    process.execPath,
    [
      '--no-warnings',
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `
        try {
          const { writeAppConfigStrict } = await import('./server/app-config.ts');
          writeAppConfigStrict({ embedder: { provider: 'openai', apiKey: 'test-key' } });
        } catch (error) {
          process.stderr.write(JSON.stringify({
            message: error instanceof Error ? error.message : String(error),
            code: error?.code,
            status: error?.status,
          }));
          process.exitCode = 17;
        }
      `,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    },
  );
}

function runConfigMutation(home: string, statement: string) {
  return spawnSync(
    process.execPath,
    [
      '--no-warnings',
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `
        try {
          const config = await import('./server/app-config.ts');
          ${statement}
        } catch (error) {
          process.stderr.write(error instanceof Error ? error.message : String(error));
          process.exitCode = 17;
        }
      `,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    },
  );
}

test('removing library membership clears only its StashBase-owned Agent Instructions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-agent-instructions-remove-'));
  const configDir = path.join(home, '.stashbase');
  const configPath = path.join(configDir, 'config.json');
  const removed = path.join(home, 'removed');
  const retained = path.join(home, 'retained');
  fs.mkdirSync(configDir);
  fs.mkdirSync(removed);
  fs.mkdirSync(retained);
  fs.writeFileSync(configPath, JSON.stringify({
    recentFolders: [removed, retained].map((folder, index) => ({
      path: folder,
      openedAt: `2026-08-0${index + 1}T00:00:00.000Z`,
    })),
    agentInstructions: {
      folders: [
        { path: removed, text: 'Removed guidance' },
        { path: retained, text: 'Retained guidance' },
      ],
    },
  }));
  try {
    const result = runConfigMutation(home, `
      const folder = await import('./server/folder.ts');
      await folder.removeRecentAsync(${JSON.stringify(removed)});
    `);
    assert.equal(result.status, 0, result.stderr);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(saved.recentFolders.map((entry: { path: string }) => entry.path), [retained]);
    assert.deepEqual(saved.agentInstructions.folders, [{ path: retained, text: 'Retained guidance' }]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('retired folder metadata does not escape library APIs or survive a membership write', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-folder-metadata-test-'));
  const configDir = path.join(home, '.stashbase');
  const configPath = path.join(configDir, 'config.json');
  const member = path.join(home, 'member');
  const openedAt = '2026-08-17T00:00:00.000Z';
  fs.mkdirSync(configDir);
  fs.mkdirSync(member);
  fs.writeFileSync(configPath, JSON.stringify({
    recentFolders: [{
      path: member,
      openedAt,
      favorite: false,
      description: 'retired summary',
      descriptionSource: 'ai',
      descriptionUpdatedAt: openedAt,
    }],
  }));
  try {
    const result = runConfigMutation(home, `
      const assert = (await import('node:assert/strict')).default;
      const fs = (await import('node:fs')).default;
      const folder = await import('./server/folder.ts');
      const library = await import('./server/library-info.ts');
      assert.deepEqual(folder.getRecentFolders(), [{
        path: ${JSON.stringify(member)},
        openedAt: ${JSON.stringify(openedAt)},
      }]);
      assert.deepEqual(await folder.getRecentFoldersAsync(), [{
        path: ${JSON.stringify(member)},
        openedAt: ${JSON.stringify(openedAt)},
      }]);
      assert.deepEqual(Object.keys(library.getLibraryInfo().folders[0]).sort(), ['name', 'path', 'provider']);
      assert.equal(folder.setRecentFavorite(${JSON.stringify(member)}, true), true);
      assert.deepEqual(JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, 'utf8')).recentFolders, [{
        path: ${JSON.stringify(member)},
        openedAt: ${JSON.stringify(openedAt)},
        favorite: true,
      }]);
    `);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('credential and source mutations never overwrite malformed config through a fallback read', () => {
  const statements = [
    `config.setHostedAccountSession({ accessToken: 'access', refreshToken: 'refresh', expiresAt: 4102444800, userId: 'user', email: 'person@example.com' });`,
    `config.setEmbedderConfig({ provider: 'openai', apiKey: 'sk-test' });`,
    `config.setEmbeddingSource('openai');`,
    `config.setWorkspacePreferences({ showHiddenFiles: true });`,
  ];
  for (const statement of statements) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-config-corrupt-test-'));
    const configDir = path.join(home, '.stashbase');
    const configPath = path.join(configDir, 'config.json');
    fs.mkdirSync(configDir);
    fs.writeFileSync(configPath, '{ malformed but user-owned config');
    try {
      const result = runConfigMutation(home, statement);
      assert.equal(result.status, 17);
      assert.match(result.stderr, /Could not read .*config\.json: invalid JSON/);
      assert.equal(fs.readFileSync(configPath, 'utf8'), '{ malformed but user-owned config');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('retired local embedding source cannot be selected again', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-local-embedding-config-test-'));
  try {
    const result = runConfigMutation(home, `
      const assert = (await import('node:assert/strict')).default;
      assert.throws(() => config.setEmbeddingSource('local'), /no longer available/);
    `);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('retired local embedding source migrates to account, BYOK, or unconfigured state', () => {
  const session = {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: 4_102_444_800,
    userId: 'user',
    email: 'person@example.com',
  };
  const cases = [
    {
      name: 'account takes priority when both credentials exist',
      config: {
        embeddingSource: 'local',
        embedder: { provider: 'openrouter', apiKey: 'sk-or-test' },
        account: { session },
        appearance: { theme: 'dark' },
      },
      expectedSource: 'stashbase-account',
      expectedResolved: 'stashbase-account',
      expectedConfigured: true,
    },
    {
      name: 'stored provider key becomes active without an account',
      config: {
        embeddingSource: 'local',
        embedder: { provider: 'openrouter', apiKey: 'sk-or-test' },
        appearance: { theme: 'dark' },
      },
      expectedSource: 'openrouter',
      expectedResolved: 'openrouter',
      expectedConfigured: true,
    },
    {
      name: 'no credentials returns to setup',
      config: {
        embeddingSource: 'local',
        appearance: { theme: 'dark' },
      },
      expectedSource: undefined,
      expectedResolved: 'openai',
      expectedConfigured: false,
    },
  ] as const;

  for (const scenario of cases) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-local-embedding-migration-test-'));
    const configDir = path.join(home, '.stashbase');
    const configPath = path.join(configDir, 'config.json');
    fs.mkdirSync(configDir);
    fs.writeFileSync(configPath, JSON.stringify(scenario.config, null, 2));
    try {
      const result = runConfigMutation(home, `
        const assert = (await import('node:assert/strict')).default;
        config.migrateRetiredLocalEmbeddingSource();
        config.migrateRetiredLocalEmbeddingSource();
        assert.equal(config.getEmbeddingSource(), ${JSON.stringify(scenario.expectedResolved)});
        assert.equal(config.isEmbeddingConfigured(), ${scenario.expectedConfigured});
      `);
      assert.equal(result.status, 0, `${scenario.name}: ${result.stderr}`);
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(persisted.embeddingSource, scenario.expectedSource, scenario.name);
      assert.equal(persisted.appearance.theme, 'dark', scenario.name);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('retired local migration leaves current account and BYOK sources unchanged', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-current-embedding-migration-test-'));
  const configDir = path.join(home, '.stashbase');
  const configPath = path.join(configDir, 'config.json');
  const serialized = JSON.stringify({
    embeddingSource: 'openai',
    embedder: { provider: 'openai', apiKey: 'sk-test' },
    appearance: { theme: 'dark' },
  }, null, 2);
  fs.mkdirSync(configDir);
  fs.writeFileSync(configPath, serialized);
  try {
    const result = runConfigMutation(home, 'config.migrateRetiredLocalEmbeddingSource();');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(configPath, 'utf8'), serialized);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('embedding source activation persists only after reset and bind succeed', async () => {
  const { activateEmbeddingSource } = await import('./routes/embedder.ts');
  const runtime = {
    provider: 'openai' as const,
    apiKey: 'sk-test',
    model: 'text-embedding-3-small',
    dimension: 1536,
  };
  const events: string[] = [];

  await activateEmbeddingSource('stashbase-account', 'openai', runtime, {
    resetRuntime: async () => { events.push('reset'); },
    bindFolders: async (nextRuntime) => { events.push(`bind:${nextRuntime?.provider ?? 'previous'}`); },
    persistSource: (source) => { events.push(`persist:${source}`); },
  });
  assert.deepEqual(events, ['reset', 'bind:openai', 'persist:openai']);

  events.length = 0;
  await assert.rejects(
    activateEmbeddingSource('stashbase-account', 'openai', runtime, {
      resetRuntime: async () => {
        events.push('reset');
        throw new Error('reset failed');
      },
      bindFolders: async () => { events.push('bind'); },
      persistSource: (source) => { events.push(`persist:${source}`); },
    }),
    /reset failed/,
  );
  assert.deepEqual(events, ['reset']);

  events.length = 0;
  let firstBind = true;
  await assert.rejects(
    activateEmbeddingSource('stashbase-account', 'openai', runtime, {
      resetRuntime: async () => { events.push('reset'); },
      bindFolders: async (nextRuntime) => {
        events.push(`bind:${nextRuntime?.provider ?? 'previous'}`);
        if (firstBind) {
          firstBind = false;
          throw new Error('bind failed');
        }
      },
      persistSource: (source) => { events.push(`persist:${source}`); },
    }),
    /bind failed/,
  );
  assert.deepEqual(events, [
    'reset',
    'bind:openai',
    'reset',
    'bind:previous',
  ]);
});

test('library membership mutations never overwrite malformed config through a fallback read', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-folder-config-corrupt-test-'));
  const configDir = path.join(home, '.stashbase');
  const configPath = path.join(configDir, 'config.json');
  const member = path.join(home, 'member');
  fs.mkdirSync(configDir);
  fs.mkdirSync(member);
  fs.writeFileSync(configPath, '{ malformed but user-owned config');
  try {
    const result = runConfigMutation(home, `
      const folder = await import('./server/folder.ts');
      folder.setCurrentFolder(${JSON.stringify(member)});
    `);
    assert.equal(result.status, 17);
    assert.match(result.stderr, /Could not read .*config\.json: invalid JSON/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), '{ malformed but user-owned config');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an in-progress library removal blocks reopen and descendant registration', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-folder-removal-gate-'));
  const member = path.join(home, 'member');
  fs.mkdirSync(member);
  try {
    const result = runConfigMutation(home, `
      const assert = (await import('node:assert/strict')).default;
      const path = await import('node:path');
      const folder = await import('./server/folder.ts');
      await folder.registerLibraryFolderAsync(${JSON.stringify(member)});
      const finish = await folder.beginLibraryFolderRemovalAsync(${JSON.stringify(member)});
      try {
        assert.throws(() => folder.setCurrentFolder(${JSON.stringify(member)}), (error) => error.code === 'FOLDER_REMOVING');
        assert.throws(() => folder.registerLibraryFolder(path.join(${JSON.stringify(member)}, 'child')), (error) => error.code === 'FOLDER_REMOVING');
        await assert.rejects(
          folder.registerLibraryFolderAsync(path.join(${JSON.stringify(member)}, 'async-child')),
          (error) => error.code === 'FOLDER_REMOVING',
        );
      } finally {
        finish();
      }
      folder.setCurrentFolder(${JSON.stringify(member)});
    `);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('concurrent async registrations preserve membership and unrelated settings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-folder-registration-race-'));
  const first = path.join(home, 'first');
  const second = path.join(home, 'second');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  try {
    const result = runConfigMutation(home, `
      const assert = (await import('node:assert/strict')).default;
      const folder = await import('./server/folder.ts');
      const { filesystemPath } = await import('./server/filesystem-path.ts');
      const registrations = Promise.all([
        folder.registerLibraryFolderAsync(${JSON.stringify(first)}),
        folder.registerLibraryFolderAsync(${JSON.stringify(second)}),
      ]);
      queueMicrotask(() => config.setCapturePreferences({ clipboardImageImport: true }));
      await registrations;
      const saved = config.readAppConfigStrict();
      assert.equal(saved.capture?.clipboardImageImport, true);
      assert.deepEqual(
        new Set(saved.recentFolders?.map((entry) => entry.path)),
        new Set([
          filesystemPath.absolute(${JSON.stringify(first)}),
          filesystemPath.absolute(${JSON.stringify(second)}),
        ]),
      );
    `);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('macOS config writes do not alter an ACL that blocks atomic temp files', {
  skip: process.platform !== 'darwin',
}, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-config-acl-test-'));
  const configDir = path.join(home, '.stashbase');
  const deniedProbe = path.join(configDir, 'denied-probe');
  fs.mkdirSync(configDir);

  try {
    execFileSync('/bin/chmod', ['+a', `${os.userInfo().username} deny add_file,delete_child`, configDir]);
    assert.throws(
      () => fs.writeFileSync(deniedProbe, 'blocked'),
      (error: NodeJS.ErrnoException) => error.code === 'EACCES' || error.code === 'EPERM',
      'test ACL did not block file creation',
    );

    const result = runConfigWrite(home);
    assert.equal(result.status, 17);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.code, 'CONFIG_NOT_WRITABLE');
    assert.equal(failure.status, 500);
    assert.match(failure.message, /cannot save settings/i);
    assert.match(failure.message, /~\/\.stashbase/);
    assert.doesNotMatch(failure.message, /config\.json\..*\.tmp/);
    assert.throws(
      () => fs.writeFileSync(deniedProbe, 'still blocked'),
      (error: NodeJS.ErrnoException) => error.code === 'EACCES' || error.code === 'EPERM',
      'StashBase must leave the user-managed ACL unchanged',
    );
  } finally {
    execFileSync('/bin/chmod', ['-RN', configDir]);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('macOS config writes replace raw EPERM temp-file errors with an actionable diagnostic', {
  skip: process.platform !== 'darwin',
}, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-config-flags-test-'));
  const configDir = path.join(home, '.stashbase');
  fs.mkdirSync(configDir);

  try {
    execFileSync('/usr/bin/chflags', ['uchg', configDir]);
    const result = runConfigWrite(home);
    assert.equal(result.status, 17);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.code, 'CONFIG_NOT_WRITABLE');
    assert.equal(failure.status, 500);
    assert.match(failure.message, /cannot save settings/i);
    assert.match(failure.message, /~\/\.stashbase/);
    assert.doesNotMatch(failure.message, /config\.json\..*\.tmp/);
  } finally {
    execFileSync('/usr/bin/chflags', ['nouchg', configDir]);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
