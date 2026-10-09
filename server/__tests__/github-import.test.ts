/**
 * Contract tests for GitHub repository import: URL parsing & normalization,
 * folder name validation, anonymous snapshot download and extraction,
 * rejection of submodules and Git LFS, no-clobber publication, cancellation,
 * and pristine ordinary folder entry.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import * as tar from 'tar';
import { filesystemPath } from '../filesystem-path.ts';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-github-import-'));
const originalHomedir = os.homedir;
os.homedir = () => scratch;
test.after(() => { os.homedir = originalHomedir; });
process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(scratch, 'app-data');

const {
  cancelAllGitHubImports,
  detectGitLfs,
  GitHubImportError,
  importPublicGitHubRepository,
  parseAndValidateGitHubUrl,
  publishStagedRepository,
  productionGitHubImportDeps,
} = await import('../github-import.ts');
type GitHubImportDeps = import('../github-import.ts').GitHubImportDeps;
const express = (await import('express')).default;
const { mount: mountProjectRoutes } = await import('../routes/project.ts');
const { clearCurrentFolder, openProjectFolder } = await import('../folder.ts');

interface FakeDepsLog {
  requests: Array<{ url: string; options: RequestInit | undefined }>;
  registered: string[];
}

function fakeDeps(options: {
  folderHome?: string;
  onSnapshot?: (source: string) => void;
  status?: number;
  fetch?: typeof fetch;
  publish?: GitHubImportDeps['publish'];
}): { deps: GitHubImportDeps; log: FakeDepsLog; home: string } {
  const home = options.folderHome ?? fs.mkdtempSync(path.join(scratch, 'home-'));
  const log: FakeDepsLog = { requests: [], registered: [] };
  const deps: GitHubImportDeps = {
    folderHome: () => home,
    register: async (target) => { log.registered.push(target); },
    fetch: options.fetch ?? (async (url, init) => {
      log.requests.push({ url: String(url), options: init });
      if (options.status) return new Response('', { status: options.status });
      const fixture = fs.mkdtempSync(path.join(scratch, 'snapshot-'));
      const source = path.join(fixture, 'repo-commit');
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, 'README.md'), '# Test Repo\n', 'utf8');
      options.onSnapshot?.(source);
      const chunks = [];
      for await (const chunk of tar.c({ cwd: fixture, gzip: true }, ['repo-commit'])) chunks.push(chunk);
      fs.rmSync(fixture, { recursive: true });
      return new Response(Buffer.concat(chunks));
    }),
    publish: options.publish ?? publishStagedRepository,
  };
  return { deps, log, home };
}

test('parseAndValidateGitHubUrl accepts canonical public GitHub URLs', () => {
  const valid = [
    'https://github.com/owner/repo',
    'https://github.com/owner/repo.git',
    'https://github.com/owner/repo/',
    'https://github.com/owner/repo.git/',
    '  https://github.com/Priyansh19077/CP-Templates  ',
  ];

  for (const url of valid) {
    const res = parseAndValidateGitHubUrl(url);
    assert.equal(res.ok, true, `URL ${url} must be accepted`);
    if (res.ok) {
      assert.match(res.parsed.canonicalUrl, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
      assert.equal(res.parsed.canonicalUrl.endsWith('.git'), false);
      assert.ok(res.parsed.defaultFolderName);
    }
  }
});

test('parseAndValidateGitHubUrl rejects non-GitHub, insecure, query-bearing, and invalid URLs', () => {
  const invalid = [
    '',
    '   ',
    'http://github.com/owner/repo',
    'https://gitlab.com/owner/repo',
    'https://notgithub.com/owner/repo',
    'https://user:pass@github.com/owner/repo',
    'https://github.com:8080/owner/repo',
    'https://github.com/owner/repo?ref=main',
    'https://github.com/owner/repo#readme',
    'https://github.com/owner/repo%2Ftree',
    'https://github.com/owner/repo//',
    'https://github.com/-owner/repo',
    'https://github.com/owner/repo/tree/main',
    'https://github.com/owner/repo/blob/main/README.md',
    'https://github.com/owner',
    'https://github.com/',
    'git@github.com:owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    null,
    undefined,
    123,
  ];

  for (const bad of invalid) {
    const res = parseAndValidateGitHubUrl(bad);
    assert.equal(res.ok, false, `URL ${JSON.stringify(bad)} must be rejected`);
    if (!res.ok) {
      assert.equal(res.error.code, 'INVALID_GITHUB_URL');
      assert.equal(res.error.status, 400);
    }
  }
});

test('detectGitLfs identifies Git LFS declarations in .gitattributes', () => {
  assert.equal(detectGitLfs('*.psd filter=lfs diff=lfs merge=lfs -text'), true);
  assert.equal(detectGitLfs('*.zip filter=lfs'), true);
  assert.equal(detectGitLfs('*.png merge=lfs'), true);
  assert.equal(detectGitLfs('# *.psd filter=lfs\n*.txt text'), false);
  assert.equal(detectGitLfs('*.md text eol=lf'), false);
  assert.equal(detectGitLfs(''), false);
});

test('importPublicGitHubRepository rejects invalid folder names before download', async () => {
  const { deps, log } = fakeDeps({});
  for (const bad of ['', '   ', 'a/b', 'a\\b', '..', '.hidden', 'name.', 'na<me', 'x'.repeat(65)]) {
    await assert.rejects(
      () => importPublicGitHubRepository({ url: 'https://github.com/owner/repo', folderName: bad }, deps),
      (err: Error & { status?: number; code?: string }) => err.status === 400 && err.code === 'INVALID_FOLDER_NAME',
    );
  }
  assert.equal(log.requests.length, 0, 'No request should be sent for invalid folder names');
});

test('importPublicGitHubRepository rejects a destination already in the folder home', async () => {
  const { deps, log, home } = fakeDeps({});
  const existingFolder = path.join(home, 'ExistingChild');
  fs.mkdirSync(existingFolder, { recursive: true });

  await assert.rejects(
    () => importPublicGitHubRepository({ url: 'https://github.com/owner/ExistingChild' }, deps),
    (err: Error & { status?: number; code?: string }) => err.status === 409 && err.code === 'DESTINATION_EXISTS',
  );

  assert.equal(log.requests.length, 0, 'No request should be sent when destination exists');
});

test('importPublicGitHubRepository classifies private or not-found responses', async () => {
  const { deps, home } = fakeDeps({ status: 404 });
  await assert.rejects(
    importPublicGitHubRepository({ url: 'https://github.com/owner/private-repo' }, deps),
    { status: 404, code: 'PRIVATE_OR_NOT_FOUND' },
  );
  assert.deepEqual(fs.readdirSync(home), []);
});

test('importPublicGitHubRepository classifies rate limits and service failures as download failures', async () => {
  for (const status of [403, 429, 500]) {
    const { deps, home } = fakeDeps({ status });
    await assert.rejects(
      importPublicGitHubRepository({ url: 'https://github.com/owner/repo' }, deps),
      { status: 502, code: 'DOWNLOAD_FAILED' },
    );
    assert.deepEqual(fs.readdirSync(home), []);
  }
});

test('importPublicGitHubRepository rejects repositories with submodules and cleans staging', async () => {
  let observedStagingDir = '';
  const { deps, home } = fakeDeps({
    onSnapshot: (stagingPath) => {
      observedStagingDir = stagingPath;
      fs.writeFileSync(path.join(stagingPath, '.gitmodules'), '[submodule "dep"]\npath = dep\n', 'utf8');
    },
  });

  await assert.rejects(
    () => importPublicGitHubRepository({ url: 'https://github.com/owner/submod-repo' }, deps),
    (err: Error & { status?: number; code?: string }) => err.status === 400 && err.code === 'UNSUPPORTED_SUBMODULES',
  );

  assert.ok(observedStagingDir);
  assert.equal(fs.existsSync(observedStagingDir), false, 'Staging directory must be cleaned up');
  assert.equal(fs.existsSync(path.join(home, 'submod-repo')), false);
});

test('importPublicGitHubRepository rejects repositories with Git LFS and cleans staging', async () => {
  let observedStagingDir = '';
  const { deps, home } = fakeDeps({
    onSnapshot: (stagingPath) => {
      observedStagingDir = stagingPath;
      fs.mkdirSync(path.join(stagingPath, 'assets'));
      fs.writeFileSync(path.join(stagingPath, 'assets', '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'utf8');
    },
  });

  await assert.rejects(
    () => importPublicGitHubRepository({ url: 'https://github.com/owner/lfs-repo' }, deps),
    (err: Error & { status?: number; code?: string }) => err.status === 400 && err.code === 'UNSUPPORTED_LFS',
  );

  assert.ok(observedStagingDir);
  assert.equal(fs.existsSync(observedStagingDir), false, 'Staging directory must be cleaned up');
  assert.equal(fs.existsSync(path.join(home, 'lfs-repo')), false);
});

test('importPublicGitHubRepository supports cancellation before download and cleans staging', async () => {
  const ac = new AbortController();
  ac.abort();

  const { deps, home } = fakeDeps({});

  await assert.rejects(
    () => importPublicGitHubRepository({ url: 'https://github.com/owner/cancel-repo', signal: ac.signal }, deps),
    (err: Error & { status?: number; code?: string }) => err.status === 499 && err.code === 'IMPORT_CANCELLED',
  );

  assert.equal(fs.existsSync(path.join(home, 'cancel-repo')), false);
});

test('cancellation and shutdown abort pending HTTP work and clean staging', async () => {
  for (const shutdown of [false, true]) {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const { deps, home } = fakeDeps({
      fetch: async (_url, options) => {
        started();
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        });
      },
    });
    const importing = importPublicGitHubRepository({ url: 'https://github.com/owner/cancel', signal: controller.signal }, deps);
    const refused = assert.rejects(importing, { code: 'IMPORT_CANCELLED' });
    await ready;
    if (shutdown) assert.equal(await cancelAllGitHubImports(), 1);
    else controller.abort();
    await refused;
    assert.deepEqual(fs.readdirSync(home), []);
  }
});

test('concurrently created destinations remain untouched at publication', async () => {
  const { deps, home } = fakeDeps({
    publish: async (staged, target, signal) => {
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'owner.txt'), 'external', 'utf8');
      await publishStagedRepository(staged, target, signal);
    },
  });

  await assert.rejects(
    () => importPublicGitHubRepository({ url: 'https://github.com/owner/raced' }, deps),
    (err: Error & { code?: string }) => err.code === 'DESTINATION_EXISTS',
  );
  assert.equal(fs.readFileSync(path.join(home, 'raced', 'owner.txt'), 'utf8'), 'external');
  assert.equal(fs.existsSync(path.join(home, 'raced', 'README.md')), false);
});

test('snapshot import publishes ordinary files without invoking Git or retaining metadata', async (t) => {
  const mock = t.mock.method(childProcess, 'spawn', () => { throw new Error('Git is not installed'); });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const { deps, log, home } = fakeDeps({});
  const result = await importPublicGitHubRepository({
    url: 'https://github.com/Priyansh19077/CP-Templates.git',
    folderName: 'CP-Templates-Imported',
  }, deps);
  const target = path.join(home, 'CP-Templates-Imported');
  assert.equal(result.path, target);
  assert.equal(fs.readFileSync(path.join(target, 'README.md'), 'utf8'), '# Test Repo\n');
  assert.equal(fs.existsSync(path.join(target, '.git')), false);
  assert.equal(fs.existsSync(path.join(target, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(target, 'CLAUDE.md')), false);
  assert.equal(mock.mock.callCount(), 0);
  assert.equal(log.requests.length, 1);
  assert.equal(log.requests[0].url, 'https://api.github.com/repos/Priyansh19077/CP-Templates/tarball');
  assert.equal(log.requests[0].options?.credentials, 'omit');
  assert.deepEqual(log.registered, [target]);
  assert.deepEqual(fs.readdirSync(home), ['CP-Templates-Imported']);
});

test('ordinary folder entry does not seed instructions into a foreign working tree', async (t) => {
  const foreignFolder = fs.mkdtempSync(path.join(scratch, 'foreign-repository-'));
  fs.mkdirSync(path.join(foreignFolder, '.git'));
  fs.writeFileSync(path.join(foreignFolder, 'README.md'), '# Foreign repository\n', 'utf8');
  await openProjectFolder(foreignFolder);
  t.after(() => { clearCurrentFolder(); });

  const app = express();
  app.use(express.json());
  mountProjectRoutes(app);
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => { server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: foreignFolder }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(fs.existsSync(path.join(foreignFolder, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(foreignFolder, 'CLAUDE.md')), false);
});

function publicationFixture() {
  const home = fs.mkdtempSync(path.join(scratch, 'publication-'));
  const staged = path.join(home, 'staged');
  const target = path.join(home, 'published');
  fs.mkdirSync(staged);
  fs.writeFileSync(path.join(staged, 'notes.txt'), 'repository bytes');
  return { staged, target };
}

test('publication refuses a file arriving after the final directory reservation', async (t) => {
  const { staged, target } = publicationFixture();
  const link = fs.promises.link;
  t.mock.method(fs.promises, 'link', async (source: fs.PathLike, destination: fs.PathLike) => {
    await fs.promises.writeFile(destination, 'user bytes');
    return link(source, destination);
  });
  await assert.rejects(publishStagedRepository(staged, target, new AbortController().signal), { code: 'IMPORT_INCOMPLETE' });
  assert.equal(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8'), 'user bytes');
});

test('failed publication preserves unrelated content and removes only its own files', async (t) => {
  const { staged, target } = publicationFixture();
  fs.writeFileSync(path.join(staged, 'z-last.txt'), 'last');
  const link = fs.promises.link;
  t.mock.method(fs.promises, 'link', async (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination).endsWith('z-last.txt')) {
      await fs.promises.writeFile(path.join(target, 'user.txt'), 'keep');
      throw new Error('controlled publication failure');
    }
    return link(source, destination);
  });
  await assert.rejects(publishStagedRepository(staged, target, new AbortController().signal), { code: 'IMPORT_INCOMPLETE', retainedPath: target });
  assert.equal(fs.readFileSync(path.join(target, 'user.txt'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(target, 'notes.txt')), false);
});

test('rollback preserves a replaced final directory', async (t) => {
  const { staged, target } = publicationFixture();
  t.mock.method(fs.promises, 'link', async () => {
    await fs.promises.rename(target, `${target}-moved`);
    await fs.promises.mkdir(target);
    await fs.promises.writeFile(path.join(target, 'user.txt'), 'replacement');
    throw new Error('controlled publication failure');
  });
  await assert.rejects(publishStagedRepository(staged, target, new AbortController().signal), { code: 'IMPORT_INCOMPLETE', retainedPath: target });
  assert.equal(fs.readFileSync(path.join(target, 'user.txt'), 'utf8'), 'replacement');
  assert.equal(fs.existsSync(`${target}-moved`), true);
});

test('rollback preserves edits to an already published file', async (t) => {
  const { staged, target } = publicationFixture();
  const controller = new AbortController();
  const link = fs.promises.link;
  t.mock.method(fs.promises, 'link', async (source: fs.PathLike, destination: fs.PathLike) => {
    await link(source, destination);
    await fs.promises.writeFile(destination, 'edited by the user');
    controller.abort();
  });
  await assert.rejects(publishStagedRepository(staged, target, controller.signal), { code: 'IMPORT_INCOMPLETE', retainedPath: target });
  assert.equal(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8'), 'edited by the user');
});

test('cancellation during the final publication operation cleans the final folder and staging', async (t) => {
  const controller = new AbortController();
  const link = fs.promises.link;
  t.mock.method(fs.promises, 'link', async (source: fs.PathLike, destination: fs.PathLike) => {
    controller.abort();
    await link(source, destination);
  });
  const { deps, home } = fakeDeps({});
  await assert.rejects(importPublicGitHubRepository({
    url: 'https://github.com/owner/cancel-last', signal: controller.signal,
  }, deps), { code: 'IMPORT_CANCELLED' });
  assert.deepEqual(fs.readdirSync(home), []);
});

test('publication uses exclusive copies on filesystems without hard links', async (t) => {
  const { staged, target } = publicationFixture();
  t.mock.method(fs.promises, 'link', async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); });
  await publishStagedRepository(staged, target, new AbortController().signal);
  assert.equal(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8'), 'repository bytes');
  const copyFile = fs.promises.copyFile;
  t.mock.method(fs.promises, 'copyFile', async (source: fs.PathLike, destination: fs.PathLike, flags?: number) => {
    await fs.promises.writeFile(destination, 'concurrent');
    return copyFile(source, destination, flags);
  });
  const second = `${target}-second`;
  await assert.rejects(publishStagedRepository(staged, second, new AbortController().signal), { code: 'IMPORT_INCOMPLETE' });
  assert.equal(fs.readFileSync(path.join(second, 'notes.txt'), 'utf8'), 'concurrent');
});

test('publication retains nested files, executable modes, and symbolic links', async (t) => {
  const { staged, target } = publicationFixture();
  fs.mkdirSync(path.join(staged, 'scripts'));
  const script = path.join(staged, 'scripts', 'run.sh');
  fs.writeFileSync(script, '#!/bin/sh\necho hello\n', { mode: 0o755 });
  let hasLink = false;
  try {
    fs.symlinkSync('scripts/run.sh', path.join(staged, 'run'));
    hasLink = true;
  } catch {
    t.diagnostic('Symbolic link creation is unavailable on this host.');
  }
  await publishStagedRepository(staged, target, new AbortController().signal);
  assert.equal(fs.readFileSync(path.join(target, 'scripts', 'run.sh'), 'utf8'), fs.readFileSync(script, 'utf8'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(target, 'scripts', 'run.sh')).mode & 0o777, 0o755);
  if (hasLink) assert.equal(fs.readlinkSync(path.join(target, 'run')), fs.readlinkSync(path.join(staged, 'run')));
});

test('import commits project membership without changing the active window', async () => {
  const { getCurrentFolder, getRecentFolders } = await import('../folder.ts');
  const { deps, home } = fakeDeps({});
  deps.register = productionGitHubImportDeps.register;
  const result = await importPublicGitHubRepository({ url: 'https://github.com/owner/registered-copy' }, deps);
  assert.equal(result.path, path.join(home, 'registered-copy'));
  assert.ok(getRecentFolders().some((folder) => folder.path === filesystemPath.absolute(result.path)));
  assert.equal(getCurrentFolder(), null);
});

test('registration failure rolls publication back and permits a clean retry', async () => {
  const { deps, home, log } = fakeDeps({});
  const register = deps.register;
  deps.register = async () => { throw new Error('config write refused'); };
  await assert.rejects(importPublicGitHubRepository({ url: 'https://github.com/owner/register-failure' }, deps), { code: 'LOCAL_IMPORT_FAILED' });
  assert.deepEqual(log.registered, []);
  assert.deepEqual(fs.readdirSync(home), []);
  deps.register = register;
  const result = await importPublicGitHubRepository({ url: 'https://github.com/owner/register-failure' }, deps);
  assert.deepEqual(log.registered, [result.path]);
});

test('cancellation before membership commit removes the published copy without registering it', async () => {
  const { getRecentFolders } = await import('../folder.ts');
  const { deps, home } = fakeDeps({});
  const controller = new AbortController();
  deps.register = async (target, signal) => {
    controller.abort();
    await productionGitHubImportDeps.register(target, signal);
  };
  await assert.rejects(importPublicGitHubRepository({ url: 'https://github.com/owner/cancel-commit', signal: controller.signal }, deps), { code: 'IMPORT_CANCELLED' });
  assert.deepEqual(fs.readdirSync(home), []);
  assert.equal(getRecentFolders().some((folder) => folder.path === filesystemPath.absolute(path.join(home, 'cancel-commit'))), false);
});
