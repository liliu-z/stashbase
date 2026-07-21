import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('multipart import stages on disk and accepts long-recording size budgets', async (t) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-upload-test-'));
  const previous = new Map(['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'STASHBASE_LOCAL_DATA_ROOT']
    .map((name) => [name, process.env[name]]));
  let server: HttpServer | undefined;
  let closeStateDb: (() => void) | undefined;
  t.after(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve()));
    closeStateDb?.();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  process.env.LOCALAPPDATA = path.join(testHome, 'LocalAppData');
  process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(testHome, 'data');

  const [{ default: express }, folder, upload, stateDb] = await Promise.all([
    import('express'),
    import('./folder.ts'),
    import('./routes/upload.ts'),
    import('./state-db.ts'),
  ]);
  closeStateDb = stateDb.closeStateDb;
  assert.ok(upload.MAX_UPLOAD_FILE_BYTES > 512 * 1024 * 1024);

  const library = path.join(testHome, 'Library');
  fs.mkdirSync(library, { recursive: true });
  folder.setCurrentFolder(library);
  const app = express();
  upload.mount(app);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server?.once('listening', resolve);
    server?.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const tempRoot = path.join(os.tmpdir(), 'stashbase-upload');
  const stagedBefore = new Set(fs.existsSync(tempRoot) ? fs.readdirSync(tempRoot) : []);
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x5a);
  const body = new FormData();
  body.append('files', new Blob([bytes]), 'recording.wav');
  body.append('paths', 'recording.wav');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/upload`, { method: 'POST', body });
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(fs.readFileSync(path.join(library, 'recording.wav')), bytes);

  const leftovers = fs.existsSync(tempRoot)
    ? fs.readdirSync(tempRoot).filter((name) => name.endsWith('.upload') && !stagedBefore.has(name))
    : [];
  assert.deepEqual(leftovers, []);
});

test('staged publication is asynchronous, cancellable, and removes its partial target', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-upload-copy-test-'));
  const staged = path.join(root, 'staged.upload');
  const library = path.join(root, 'Library');
  fs.mkdirSync(library);
  fs.closeSync(fs.openSync(staged, 'w'));
  fs.truncateSync(staged, 32 * 1024 * 1024);
  try {
    const { publishStagedImport } = await import('./import-publication.ts');
    const controller = new AbortController();
    const publication = publishStagedImport({
      folderRoot: library,
      relativePath: 'recording.wav',
      stagedPath: staged,
      signal: controller.signal,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error('test cancelled'));

    await assert.rejects(publication, /abort|cancel/i);
    assert.equal(fs.existsSync(path.join(library, 'recording.wav')), false);
    assert.deepEqual(fs.readdirSync(library), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('large imported text is published without being loaded into the Node heap', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-upload-text-test-'));
  const staged = path.join(root, 'staged.upload');
  const library = path.join(root, 'Library');
  fs.mkdirSync(library);
  fs.closeSync(fs.openSync(staged, 'w'));
  fs.truncateSync(staged, 9 * 1024 * 1024);
  try {
    const { publishStagedImport } = await import('./import-publication.ts');
    const result = await publishStagedImport({
      folderRoot: library,
      relativePath: 'large.md',
      stagedPath: staged,
      signal: new AbortController().signal,
      captureIndexText: true,
    });

    assert.equal(fs.statSync(result.path).size, 9 * 1024 * 1024);
    assert.equal(result.indexText, undefined);
    assert.match(result.indexSkipReason ?? '', /too large to index/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('staged publication never replaces a target created after collision planning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-upload-race-test-'));
  const staged = path.join(root, 'staged.upload');
  const library = path.join(root, 'Library');
  const target = path.join(library, 'recording.wav');
  fs.mkdirSync(library);
  fs.writeFileSync(staged, 'new recording');
  fs.writeFileSync(target, 'existing recording');
  try {
    const { publishStagedImport } = await import('./import-publication.ts');
    await assert.rejects(
      publishStagedImport({
        folderRoot: library,
        relativePath: 'recording.wav',
        stagedPath: staged,
        signal: new AbortController().signal,
      }),
      /exist|collision|target/i,
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'existing recording');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('staged publication falls back when the library filesystem rejects hard links', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-upload-no-link-test-'));
  const staged = path.join(root, 'staged.upload');
  const library = path.join(root, 'Library');
  fs.mkdirSync(library);
  fs.writeFileSync(staged, 'portable recording');
  const originalLink = fs.promises.link;
  const originalCopyFile = fs.promises.copyFile;
  fs.promises.link = async () => {
    const error = new Error('hard links unsupported') as NodeJS.ErrnoException;
    error.code = 'EOPNOTSUPP';
    throw error;
  };
  fs.promises.copyFile = async () => {
    throw new Error('fallback publication must not copy into the visible target');
  };
  try {
    const { publishStagedImport } = await import('./import-publication.ts');
    const result = await publishStagedImport({
      folderRoot: library,
      relativePath: 'recording.wav',
      stagedPath: staged,
      signal: new AbortController().signal,
    });
    assert.equal(fs.readFileSync(result.path, 'utf8'), 'portable recording');

    const occupied = path.join(library, 'occupied.wav');
    fs.writeFileSync(occupied, 'existing user recording');
    await assert.rejects(
      publishStagedImport({
        folderRoot: library,
        relativePath: 'occupied.wav',
        stagedPath: staged,
        signal: new AbortController().signal,
      }),
      /exist/i,
    );
    assert.equal(fs.readFileSync(occupied, 'utf8'), 'existing user recording');
  } finally {
    fs.promises.link = originalLink;
    fs.promises.copyFile = originalCopyFile;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startup recovery removes an abandoned fallback reservation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-upload-recovery-test-'));
  const library = path.join(root, 'Library');
  const stagingRoot = path.join(root, 'staging');
  const deadPid = 2147483647;
  const id = '00000000-0000-4000-8000-000000000000';
  const staged = path.join(stagingRoot, `${deadPid}-1-${id}.upload`);
  const target = path.join(library, 'recording.wav');
  const temporary = path.join(library, `.recording.wav.${deadPid}.${id}.tmp`);
  const recordPath = `${staged}.publication.json`;
  fs.mkdirSync(library, { recursive: true });
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.writeFileSync(staged, 'staged recording');
  fs.writeFileSync(temporary, 'complete hidden recording');
  fs.closeSync(fs.openSync(target, 'wx'));
  const reservation = fs.statSync(target);
  const record = {
    schemaVersion: 1,
    pid: deadPid,
    createdAt: Date.now(),
    stagedPath: staged,
    targetPath: target,
    temporaryPath: temporary,
    reservation: { device: String(reservation.dev), inode: String(reservation.ino) },
  };
  fs.writeFileSync(recordPath, `${JSON.stringify(record)}\n{"schemaVersion":1`);
  try {
    const { cleanupStaleUploads } = await import('./routes/upload.ts');
    cleanupStaleUploads(stagingRoot);

    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(temporary), false);
    assert.equal(fs.existsSync(recordPath), false);
    assert.equal(fs.existsSync(staged), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startup recovery preserves a completed fallback rename', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-upload-commit-recovery-test-'));
  const library = path.join(root, 'Library');
  const stagingRoot = path.join(root, 'staging');
  const deadPid = 2147483647;
  const id = '00000000-0000-4000-8000-000000000001';
  const staged = path.join(stagingRoot, `${deadPid}-1-${id}.upload`);
  const target = path.join(library, 'recording.wav');
  const temporary = path.join(library, `.recording.wav.${deadPid}.${id}.tmp`);
  const recordPath = `${staged}.publication.json`;
  fs.mkdirSync(library, { recursive: true });
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.writeFileSync(staged, 'staged recording');
  fs.writeFileSync(target, 'complete published recording');
  fs.writeFileSync(recordPath, `${JSON.stringify({
    schemaVersion: 1,
    pid: deadPid,
    createdAt: Date.now(),
    stagedPath: staged,
    targetPath: target,
    temporaryPath: temporary,
    reservation: { device: '-1', inode: '-1' },
  })}\n`);
  try {
    const { cleanupStaleUploads } = await import('./routes/upload.ts');
    cleanupStaleUploads(stagingRoot);

    assert.equal(fs.readFileSync(target, 'utf8'), 'complete published recording');
    assert.equal(fs.existsSync(recordPath), false);
    assert.equal(fs.existsSync(staged), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('upload route mount reclaims staged files left by a dead server', async () => {
  const tempRoot = path.join(os.tmpdir(), 'stashbase-upload');
  const stale = path.join(tempRoot, '2147483647-1-00000000-0000-4000-8000-000000000000.upload');
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.writeFileSync(stale, 'stale staged bytes');
  try {
    const [{ default: express }, upload] = await Promise.all([
      import('express'),
      import('./routes/upload.ts'),
    ]);
    upload.mount(express());
    assert.equal(fs.existsSync(stale), false);
  } finally {
    fs.rmSync(stale, { force: true });
  }
});
