import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { filesystemPath } from '../filesystem-path.ts';

const isolatedEnvNames = [
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'XDG_DATA_HOME',
  'STASHBASE_LOCAL_DATA_ROOT',
  'STASHBASE_FOLDER_HOME',
] as const;

test('project routes return authoritative membership and open the selected folder', async (t) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-project-route-'));
  const originalEnv = new Map(isolatedEnvNames.map((name) => [name, process.env[name]]));
  let closeIndexer: (() => Promise<void>) | undefined;
  let closeStateDb: (() => void) | undefined;
  let clearWindowFolder: (() => void) | undefined;
  let server: HttpServer | undefined;

  t.after(async () => {
    clearWindowFolder?.();
    await closeIndexer?.();
    // Removing a folder clears its semantic-indexing decision, which opens the
    // state database under the redirected app data root. better-sqlite3 keeps
    // that file plus its WAL and shared-memory sidecars open for the rest of
    // the process, and Windows refuses to delete a directory holding an open
    // mapped file. POSIX unlinks it regardless, so only Windows sees this.
    closeStateDb?.();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(testHome, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
  });

  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  process.env.LOCALAPPDATA = path.join(testHome, 'LocalAppData');
  process.env.XDG_DATA_HOME = path.join(testHome, 'xdg-data');
  process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(testHome, 'stashbase-data');
  process.env.STASHBASE_FOLDER_HOME = path.join(testHome, 'default-home');

  const [{ default: express }, folder, { withWindowContext }, projectRoutes, state, stateDb, appConfig] =
    await Promise.all([
      import('express'),
      import('../folder.ts'),
      import('../http.ts'),
      import('./project.ts'),
      import('../state.ts'),
      import('../state-db.ts'),
      import('../app-config.ts'),
    ]);
  closeIndexer = () => state.indexer.close();
  closeStateDb = stateDb.closeStateDb;
  clearWindowFolder = () =>
    folder.runWithWindowId('project-window', () => folder.clearCurrentFolder());

  // POSIX can hold both spellings as distinct directories; opening or
  // removing the selected one must not silently select its trimmed sibling.
  const selectedName = process.platform === 'win32' ? 'Research' : 'Research ';
  const selectedFolder = path.join(testHome, selectedName);
  if (process.platform !== 'win32') fs.mkdirSync(path.join(testHome, 'Research'));
  fs.mkdirSync(selectedFolder);
  // The project API answers in source spelling with POSIX separators, which is
  // not what path.join produces on Windows. Filesystem calls keep the native
  // spelling above.
  const selectedFolderPath = filesystemPath.absolute(selectedFolder);
  const app = express();
  app.use(express.json());
  app.use(withWindowContext);
  projectRoutes.mount(app);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server?.once('listening', resolve);
    server?.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = {
    'content-type': 'application/json',
    'x-stashbase-window-id': 'project-window',
  };

  const initial = await fetch(`${baseUrl}/api/projects`, { headers });
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), {
    current: null,
    homeDir: testHome,
    recent: [],
  });

  assert.equal((await fetch(`${baseUrl}/api/folder`, { headers })).status, 404);
  const folderHome = await fetch(`${baseUrl}/api/folder-home`, { headers });
  assert.equal(folderHome.status, 200);
  const { path: homePath } = await folderHome.json() as { path: string };
  assert.equal(homePath, filesystemPath.absolute(process.env.STASHBASE_FOLDER_HOME));
  assert.deepEqual(fs.readdirSync(homePath), [], 'picker setup must not seed the introduction');

  // A copy starts where the last one went while that directory remains,
  // and falls back to the folder home once it is gone.
  const copyLocation = async () => {
    const response = await fetch(`${baseUrl}/api/copy-location`, { headers });
    assert.equal(response.status, 200);
    return (await response.json() as { path: string }).path;
  };
  assert.equal(await copyLocation(), homePath);
  const elsewhere = path.join(testHome, 'Elsewhere');
  fs.mkdirSync(elsewhere);
  appConfig.rememberCopyLocation(elsewhere);
  assert.equal(await copyLocation(), elsewhere);
  fs.rmSync(elsewhere, { recursive: true });
  assert.equal(await copyLocation(), homePath);


  const malformed = await fetch(`${baseUrl}/api/projects/open`, {
    body: JSON.stringify({ create: true, path: selectedFolder }),
    headers,
    method: 'POST',
  });
  assert.equal(malformed.status, 400);

  const opened = await fetch(`${baseUrl}/api/projects/open`, {
    body: JSON.stringify({ path: selectedFolder }),
    headers,
    method: 'POST',
  });
  assert.equal(opened.status, 200);
  const payload = (await opened.json()) as {
    current: { name: string; path: string } | null;
    recent: Array<{ path: string }>;
  };
  assert.deepEqual(payload.current, { name: selectedName, path: selectedFolderPath });
  assert.equal(payload.recent[0]?.path, selectedFolderPath);

  const current = await fetch(`${baseUrl}/api/projects`, { headers });
  assert.equal(current.status, 200);
  const currentPayload = (await current.json()) as {
    current: { name: string; path: string } | null;
  };
  assert.deepEqual(currentPayload.current, {
    name: selectedName,
    path: selectedFolderPath,
  });

  const removed = await fetch(`${baseUrl}/api/projects/remove`, {
    body: JSON.stringify({ path: selectedFolder }),
    headers,
    method: 'POST',
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), {
    current: null,
    homeDir: testHome,
    recent: [],
  });
  assert.equal(fs.statSync(selectedFolder).isDirectory(), true);

  const missingFolder = path.join(testHome, 'Moved away');
  fs.mkdirSync(missingFolder);
  const openedMissing = await fetch(`${baseUrl}/api/projects/open`, {
    body: JSON.stringify({ path: missingFolder }),
    headers,
    method: 'POST',
  });
  assert.equal(openedMissing.status, 200);
  fs.rmSync(missingFolder, { recursive: true, maxRetries: 10, retryDelay: 100 });

  const lost = await fetch(`${baseUrl}/api/projects`, { headers });
  assert.equal(lost.status, 200);
  const lostSnapshot = await lost.json() as { current: unknown; homeDir: string; recent: { path: string }[] };
  assert.equal(lostSnapshot.current, null);
  assert.equal(lostSnapshot.homeDir, testHome);
  assert.equal(lostSnapshot.recent[0].path, filesystemPath.absolute(missingFolder));

  const forgotMissing = await fetch(`${baseUrl}/api/projects/remove`, {
    body: JSON.stringify({ path: missingFolder }),
    headers,
    method: 'POST',
  });
  assert.equal(forgotMissing.status, 200);
  const reopened = await fetch(`${baseUrl}/api/projects/open`, {
    body: JSON.stringify({ path: selectedFolder }), headers, method: 'POST',
  });
  assert.equal(reopened.status, 200);
  assert.equal((await reopened.json() as { current: { path: string } }).current.path, selectedFolderPath);
  const favorite = await fetch(`${baseUrl}/api/folders/favorite`, {
    body: JSON.stringify({ path: selectedFolder, favorite: true }), headers, method: 'POST',
  });
  assert.equal(favorite.status, 200);
  const removedAgain = await fetch(`${baseUrl}/api/projects/remove`, {
    body: JSON.stringify({ path: selectedFolder }), headers, method: 'POST',
  });
  assert.equal(removedAgain.status, 200);
  const afterRemoval = await fetch(`${baseUrl}/api/projects`, { headers });
  assert.equal((await afterRemoval.json() as { recent: unknown[] }).recent.length, 0);
});

test('import receipts join duplicate requests, isolate windows, and remember cancellation before POST', async () => {
  const { createProjectImportOperations } = await import('../project-import-operations.ts');
  const imports = createProjectImportOperations<string>();
  let finish!: (result: string) => void;
  let calls = 0;
  const acquire = async () => { calls++; return new Promise<string>((resolve) => { finish = resolve; }); };
  const first = imports.start('one', 'receipt', 'repo/name', acquire);
  const duplicate = imports.start('one', 'receipt', 'repo/name', acquire);
  assert.equal(first, duplicate);
  assert.equal(imports.result('two', 'receipt'), null);
  assert.throws(() => imports.start('one', 'receipt', 'changed request', acquire));
  await new Promise<void>((resolve) => setImmediate(resolve));
  finish('/projects/Copy');
  assert.equal(await imports.result('one', 'receipt'), '/projects/Copy');
  assert.equal(calls, 1);
  imports.cancel('one', 'cancelled-before-post', 'cancelled');
  assert.equal(await imports.start('one', 'cancelled-before-post', 'repo/name', acquire), 'cancelled');
  assert.equal(calls, 1);
});
