import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createUpdatePreferencesStore,
  normalizeUpdatePreferences,
  normalizeWorkspacePreferences,
  shouldBackfillAfterKeyChange,
  type AppConfigFile,
} from './app-config.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

test('retired folder metadata does not escape project APIs or survive a membership write', () => {
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
      const project = await import('./server/project-info.ts');
      assert.deepEqual(folder.getRecentFolders(), [{
        path: ${JSON.stringify(member)},
        openedAt: ${JSON.stringify(openedAt)},
      }]);
      assert.deepEqual(await folder.getRecentFoldersAsync(), [{
        path: ${JSON.stringify(member)},
        openedAt: ${JSON.stringify(openedAt)},
      }]);
      assert.deepEqual(Object.keys(project.getProjectInfo().folders[0]).sort(), ['name', 'path', 'provider']);
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

test('credential and preference mutations never overwrite malformed config through a fallback read', () => {
  const statements = [
    `config.setHostedAccountSession({ accessToken: 'access', refreshToken: 'refresh', expiresAt: 4102444800, userId: 'user', email: 'person@example.com' });`,
    `config.setEmbedderConfig({ provider: 'openai', apiKey: 'sk-test' });`,
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

test('embedding source follows the key provider and has no separate selection endpoint', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-embedding-key-route-'));
  try {
    const result = runConfigMutation(home, `
      const assert = (await import('node:assert/strict')).default;
      const express = (await import('express')).default;
      const { mount } = await import('./server/routes/embedder.ts');
      config.setEmbedderConfig({ provider: 'openrouter', apiKey: 'test-key' });
      const app = express();
      app.use(express.json());
      mount(app);
      const server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      const origin = 'http://127.0.0.1:' + server.address().port;
      try {
        const response = await fetch(origin + '/api/embedder');
        const state = await response.json();
        assert.equal(state.provider, 'openrouter');
        assert.equal(state.hasKey, true);
        assert.equal('apiKey' in state, false);
        const removed = await fetch(origin + '/api/embedder/source', {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: 'openai' }),
        });
        assert.equal(removed.status, 404);
        assert.equal(config.getEmbedderProvider(), 'openrouter');
        assert.equal(config.isEmbeddingConfigured(), true);
        const deleted = await fetch(origin + '/api/embedder/key', { method: 'DELETE' });
        assert.equal(deleted.status, 200);
        assert.equal((await deleted.json()).hasKey, false);
        assert.equal(config.isEmbeddingConfigured(), false);
      } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    `);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('project membership mutations never overwrite malformed config through a fallback read', () => {
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
      await folder.openProjectFolder(${JSON.stringify(member)});
    `);
    assert.equal(result.status, 17);
    assert.match(result.stderr, /Could not read .*config\.json: invalid JSON/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), '{ malformed but user-owned config');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an in-progress project removal blocks reopen and descendant registration', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-folder-removal-gate-'));
  const member = path.join(home, 'member');
  fs.mkdirSync(member);
  try {
    const result = runConfigMutation(home, `
      const assert = (await import('node:assert/strict')).default;
      const path = await import('node:path');
      const folder = await import('./server/folder.ts');
      await folder.registerProjectFolderAsync(${JSON.stringify(member)});
      const finish = await folder.beginProjectFolderRemovalAsync(${JSON.stringify(member)});
      try {
        await assert.rejects(() => folder.openProjectFolder(${JSON.stringify(member)}), (error) => error.code === 'FOLDER_REMOVING');
        await assert.rejects(
          folder.registerProjectFolderAsync(path.join(${JSON.stringify(member)}, 'async-child')),
          (error) => error.code === 'FOLDER_REMOVING',
        );
      } finally {
        finish();
      }
      await folder.openProjectFolder(${JSON.stringify(member)});
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
        folder.registerProjectFolderAsync(${JSON.stringify(first)}),
        folder.registerProjectFolderAsync(${JSON.stringify(second)}),
      ]);
      queueMicrotask(() => config.setAppearancePreferences({ theme: 'dark' }));
      await registrations;
      const saved = config.readAppConfigStrict();
      assert.equal(saved.appearance?.theme, 'dark');
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

test('changing or adding a BYOK key reconciles pending files', () => {
  assert.equal(
    shouldBackfillAfterKeyChange('openrouter', 'openai', true),
    true,
  );
  assert.equal(
    shouldBackfillAfterKeyChange('openai', 'openai', false),
    true,
  );
  assert.equal(
    shouldBackfillAfterKeyChange('openai', 'openai', true),
    false,
  );
});

test('index-status compatibility flags follow key configuration without probing the provider', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-key-status-'));
  const folder = path.join(home, 'project');
  fs.mkdirSync(folder);
  try {
    const result = runConfigMutation(home, `
      const assert = (await import('node:assert/strict')).default;
      const { indexer, resolveEmbedderRuntime } = await import('./server/state.ts');
      const { buildIndexStatus } = await import('./server/index-status.ts');
      const { indexStatusResponseSchema } = await import('./shared/protocols/http/index-status.ts');
      globalThis.fetch = async () => { throw new Error('configuration must not probe the provider'); };
      indexer.status = async () => ({
        total: 0, indexed: 0, pendingCount: 0, pending: [], orphanedCount: 0,
        orphaned: [], upToDate: true, indexReady: true,
      });
      for (const apiKey of [undefined, 'unvalidated-test-key', undefined]) {
        config.setEmbedderConfig({ provider: 'openai', apiKey });
        const status = indexStatusResponseSchema.parse(await buildIndexStatus(${JSON.stringify(folder)}));
        assert.equal(status.semanticEnabled, !!apiKey);
        assert.equal(status.semanticAvailable, !!apiKey);
        assert.equal(status.semanticDisabledReason, apiKey ? undefined : 'Embedding provider key required');
        assert.equal(resolveEmbedderRuntime()?.apiKey, apiKey);
      }
    `);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
