import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFilesystemPath, filesystemPath } from './filesystem-path.ts';

test('POSIX paths preserve case and root joins', () => {
  const paths = createFilesystemPath({ platform: 'posix', cwd: '/workspace' });
  assert.equal(paths.absolute('./Notes/../File.md'), '/workspace/File.md');
  assert.equal(paths.join('/', 'Folder/File.md'), '/Folder/File.md');
  assert.equal(paths.equal('/Data/File.md', '/Data/file.md'), false);
  assert.equal(paths.relative('/Data', '/Data/Folder/File.md'), 'Folder/File.md');
  assert.equal(paths.relative('/Data', '/Database/File.md'), null);
});

test('a module for another platform than the host resolves without an explicit cwd', () => {
  const posix = createFilesystemPath({ platform: 'posix' });
  assert.equal(posix.absolute('/work/notes'), '/work/notes');
  assert.equal(posix.isAbsolute('/work/notes'), true);
  assert.match(posix.absolute('notes'), /^\/(?:.*\/)?notes$/u);

  const windows = createFilesystemPath({ platform: 'win32' });
  assert.equal(windows.absolute('C:\\Work\\Notes'), 'C:/Work/Notes');
  assert.match(windows.absolute('notes'), /^[A-Za-z]:\/(?:.*\/)?notes$/u);
});

test('macOS identity follows the mounted volume case behaviour', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('requires a native macOS filesystem');
    return;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-darwin-path-'));
  const root = path.join(temp, 'MixedCaseRoot');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const alias = path.join(temp, 'mixedcaseroot');
  let sameEntry = false;
  try {
    const actualStat = fs.statSync(root);
    const aliasStat = fs.statSync(alias);
    sameEntry = actualStat.dev === aliasStat.dev && actualStat.ino === aliasStat.ino;
  } catch {
    // A case-sensitive APFS volume correctly keeps the identities distinct.
  }

  const paths = createFilesystemPath({ platform: 'darwin', cwd: temp });
  assert.equal(paths.equal(root, alias), sameEntry);
  assert.equal(await paths.sameExistingPathAsync(root, alias), sameEntry);
  assert.equal(
    paths.equal(path.join(root, 'Future.docx'), path.join(alias, 'future.docx')),
    sameEntry,
  );
  assert.equal(paths.contains(root, path.join(alias, 'future.docx')), sameEntry);
  assert.equal(
    paths.relative(root, path.join(alias, 'future.docx')),
    sameEntry ? 'future.docx' : null,
  );

  const composed = path.join(temp, 'Caf\u00e9');
  const decomposed = path.join(temp, 'Cafe\u0301');
  fs.mkdirSync(composed);
  let sameUnicodeEntry = false;
  try {
    const composedStat = fs.statSync(composed);
    const decomposedStat = fs.statSync(decomposed);
    sameUnicodeEntry = composedStat.dev === decomposedStat.dev && composedStat.ino === decomposedStat.ino;
  } catch {
    // Preserve distinct normalization forms when the mounted volume does.
  }
  assert.equal(paths.equal(composed, decomposed), sameUnicodeEntry);
});

test('existing path aliases do not collapse distinct hard links', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-path-alias-'));
  const source = path.join(temp, 'source.md');
  const hardLink = path.join(temp, 'hard-link.md');
  fs.writeFileSync(source, 'content');
  fs.linkSync(source, hardLink);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  assert.equal(await filesystemPath.sameExistingPathAsync(source, source), true);
  assert.equal(await filesystemPath.sameExistingPathAsync(source, hardLink), false);
});

test('Windows drive paths share one identity across separator and case variants', () => {
  const paths = createFilesystemPath({ platform: 'win32', cwd: 'C:\\workspace' });
  assert.equal(paths.absolute('c:\\Users\\Alice\\..\\ALICE\\File.docx'), 'c:/Users/ALICE/File.docx');
  assert.equal(paths.identity('C:\\Users\\Alice\\File.docx'), 'c:/users/alice/file.docx');
  assert.equal(paths.equal('C:/Users/Alice/File.docx', 'c:\\users\\alice\\FILE.docx'), true);
  assert.equal(paths.contains('C:/Users/Alice', 'c:\\users\\alice\\Notes\\File.md'), true);
  assert.equal(paths.contains('C:/Users/Alice', 'C:/Users/Alicev2/File.md'), false);
  assert.equal(paths.relative('C:/Users/Alice', 'c:\\users\\ALICE\\Notes\\File.md'), 'Notes/File.md');
  assert.equal(paths.join('C:/', 'Users/Alice'), 'C:/Users/Alice');
  assert.equal(paths.resolveUnder('C:\\Users\\Alice', 'Notes\\File.md'), 'C:/Users/Alice/Notes/File.md');
});

test('Windows existing resolution restores actual component spelling', (t) => {
  const originalReaddir = fs.readdirSync;
  const originalRealpath = fs.realpathSync.native;
  (fs.readdirSync as unknown as (cursor: string) => string[]) = ((cursor: string) => {
    const normalized = cursor.replace(/\\/g, '/').toLowerCase();
    if (normalized === 'c:/users/alice') return ['Docs'];
    if (normalized === 'c:/users/alice/docs') return ['Report.docx'];
    return [];
  }) as typeof fs.readdirSync;
  fs.realpathSync.native = ((value: fs.PathLike) => String(value)) as typeof fs.realpathSync.native;
  t.after(() => {
    fs.readdirSync = originalReaddir;
    fs.realpathSync.native = originalRealpath;
  });

  const paths = createFilesystemPath({ platform: 'win32', cwd: 'C:\\workspace' });
  assert.equal(
    paths.resolveUnder('C:/Users/Alice', 'docs/report.docx', { access: 'existing' }),
    'C:/Users/Alice/Docs/Report.docx',
  );
});

test('Windows async existing resolution restores actual component spelling without sync I/O', async (t) => {
  const originalReaddir = fs.promises.readdir;
  const originalRealpath = fs.realpath.native;
  const originalReaddirSync = fs.readdirSync;
  const originalRealpathSync = fs.realpathSync.native;
  fs.promises.readdir = (async (cursor: fs.PathLike) => {
    const normalized = String(cursor).replace(/\\/g, '/').toLowerCase();
    if (normalized === 'c:/users/alice') return ['Docs'];
    if (normalized === 'c:/users/alice/docs') return ['Report.docx'];
    return [];
  }) as typeof fs.promises.readdir;
  fs.realpath.native = ((value: fs.PathLike, callback: (error: NodeJS.ErrnoException | null, path?: string) => void) => {
    callback(null, String(value));
  }) as typeof fs.realpath.native;
  fs.readdirSync = (() => {
    throw new Error('async resolution called readdirSync');
  }) as typeof fs.readdirSync;
  fs.realpathSync.native = (() => {
    throw new Error('async resolution called realpathSync');
  }) as typeof fs.realpathSync.native;
  t.after(() => {
    fs.promises.readdir = originalReaddir;
    fs.realpath.native = originalRealpath;
    fs.readdirSync = originalReaddirSync;
    fs.realpathSync.native = originalRealpathSync;
  });

  const paths = createFilesystemPath({ platform: 'win32', cwd: 'C:\\workspace' });
  assert.equal(
    await paths.resolveUnderAsync('C:/Users/Alice', 'docs/report.docx', { access: 'existing' }),
    'C:/Users/Alice/Docs/Report.docx',
  );
  assert.equal(await paths.equalAsync('C:/Users/Alice', 'c:/users/alice'), true);
  assert.equal(await paths.containsAsync('C:/Users/Alice', 'c:/users/alice/Docs/Report.docx'), true);
  assert.equal(await paths.relativeAsync('C:/Users/Alice', 'c:/users/alice/Docs/Report.docx'), 'Docs/Report.docx');
  assert.equal(await paths.canonicalRelativeAsync('C:/Users/Alice', 'docs/report.docx'), 'Docs/Report.docx');
});

test('Windows UNC and extended-length spellings normalize without losing share roots', () => {
  const paths = createFilesystemPath({ platform: 'win32', cwd: 'C:\\workspace' });
  assert.equal(paths.absolute('\\\\server\\share\\Folder'), '//server/share/Folder');
  assert.equal(paths.join('//server/share/', 'Folder/File.md'), '//server/share/Folder/File.md');
  assert.equal(paths.contains('//SERVER/SHARE', '\\\\server\\share\\folder\\file.md'), true);
  assert.equal(paths.relative('//server/share', '//SERVER/SHARE/Folder/File.md'), 'Folder/File.md');
  assert.equal(paths.absolute('\\\\?\\C:\\Users\\Alice'), 'C:/Users/Alice');
  assert.equal(paths.absolute('\\\\?\\UNC\\server\\share\\Folder'), '//server/share/Folder');
});

test('ambiguous Windows and escaping relative paths are rejected', () => {
  const paths = createFilesystemPath({ platform: 'win32', cwd: 'C:\\workspace' });
  assert.throws(() => paths.absolute('C:relative\\file.md'), /drive-relative/);
  assert.throws(() => paths.absolute('\\\\.\\PhysicalDrive0'), /device paths/);
  assert.throws(() => paths.absolute('\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1'), /namespace/);
  assert.throws(() => paths.absolute('\\\\?\\Volume{abc}\\Folder'), /namespace/);
  assert.throws(() => paths.join('C:/Root', '../escape.md'), /invalid path segment/);
  assert.throws(() => paths.join('C:/Root', 'D:/escape.md'), /relative/);
});

test('POSIX paths reject foreign Windows absolute drive syntax but keep valid colon names', () => {
  const paths = createFilesystemPath({ platform: 'posix', cwd: '/workspace' });
  assert.throws(() => paths.absolute('C:/Users/Alice/File.docx'), /Windows drive paths/);
  assert.throws(() => paths.absolute('C:\\Users\\Alice\\File.docx'), /Windows drive paths/);
  assert.equal(paths.absolute('A:notes.md'), '/workspace/A:notes.md');
});

test('resolveUnder blocks existing and creatable symlink or junction escapes', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-path-'));
  const root = path.join(temp, 'root');
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'inside.md'), 'inside');
  fs.writeFileSync(path.join(outside, 'outside.md'), 'outside');
  fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(outside, 'outside.md'), path.join(root, 'linked-file.md'));
  }
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  assert.equal(
    filesystemPath.resolveUnder(root, 'inside.md', { access: 'existing' }),
    filesystemPath.absolute(path.join(root, 'inside.md')),
  );
  assert.throws(
    () => filesystemPath.resolveUnder(root, 'link/outside.md', { access: 'existing' }),
    /escapes folder through symlink/,
  );
  assert.throws(
    () => filesystemPath.resolveUnder(root, 'link/new.md', { access: 'creatable' }),
    /escapes folder through symlink/,
  );
  if (process.platform !== 'win32') {
    assert.throws(
      () => filesystemPath.resolveUnder(root, 'linked-file.md', { access: 'creatable' }),
      /escapes folder through symlink/,
    );
  }
  assert.equal(
    filesystemPath.resolveUnder(root, 'new/child.md', { access: 'creatable' }),
    filesystemPath.absolute(path.join(root, 'new', 'child.md')),
  );
});

test('resolveUnderAsync matches resolveUnder for symlink or junction escapes', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-path-async-'));
  const root = path.join(temp, 'root');
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'inside.md'), 'inside');
  fs.writeFileSync(path.join(outside, 'outside.md'), 'outside');
  fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(outside, 'outside.md'), path.join(root, 'linked-file.md'));
  }
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  assert.equal(
    await filesystemPath.resolveUnderAsync(root, 'inside.md', { access: 'existing' }),
    filesystemPath.absolute(path.join(root, 'inside.md')),
  );
  await assert.rejects(
    () => filesystemPath.resolveUnderAsync(root, 'link/outside.md', { access: 'existing' }),
    /escapes folder through symlink/,
  );
  await assert.rejects(
    () => filesystemPath.resolveUnderAsync(root, 'link/new.md', { access: 'creatable' }),
    /escapes folder through symlink/,
  );
  if (process.platform !== 'win32') {
    await assert.rejects(
      () => filesystemPath.resolveUnderAsync(root, 'linked-file.md', { access: 'creatable' }),
      /escapes folder through symlink/,
    );
  }
  assert.equal(
    await filesystemPath.resolveUnderAsync(root, 'new/child.md', { access: 'creatable' }),
    filesystemPath.absolute(path.join(root, 'new', 'child.md')),
  );

  // resolveUnder and resolveUnderAsync must agree on every access mode, not
  // just the escape cases, since routes migrate to the async path one at a
  // time and both are expected to behave identically in the meantime.
  for (const access of ['lexical', 'existing', 'creatable'] as const) {
    assert.equal(
      await filesystemPath.resolveUnderAsync(root, 'inside.md', { access }),
      filesystemPath.resolveUnder(root, 'inside.md', { access }),
    );
  }
});

test('resolveUnderAsync never reaches synchronous filesystem primitives under macOS semantics', {
  skip: process.platform === 'win32',
}, async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-path-async-liveness-'));
  const root = path.join(temp, 'root');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'inside.md'), 'inside');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const paths = createFilesystemPath({ platform: 'darwin', cwd: temp });
  const originalStatSync = fs.statSync;
  const originalReaddirSync = fs.readdirSync;
  let syncCalls = 0;
  (fs as { statSync: typeof fs.statSync }).statSync = ((...args: Parameters<typeof fs.statSync>) => {
    syncCalls += 1;
    return originalStatSync(...args);
  }) as typeof fs.statSync;
  fs.readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => {
    syncCalls += 1;
    return originalReaddirSync(...args);
  }) as typeof fs.readdirSync;
  t.after(() => {
    (fs as { statSync: typeof fs.statSync }).statSync = originalStatSync;
    fs.readdirSync = originalReaddirSync;
  });

  assert.equal(
    await paths.resolveUnderAsync(root, 'inside.md', { access: 'existing' }),
    paths.absolute(path.join(root, 'inside.md')),
  );
  assert.equal(await paths.equalAsync(root, root), true);
  assert.equal(await paths.containsAsync(root, path.join(root, 'inside.md')), true);
  assert.equal(await paths.relativeAsync(root, path.join(root, 'inside.md')), 'inside.md');
  assert.equal(await paths.canonicalRelativeAsync(root, 'inside.md'), 'inside.md');
  assert.equal(syncCalls, 0, `async resolution reached ${syncCalls} synchronous filesystem calls`);
});

test('slow async realpath resolution leaves unrelated event-loop work live', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-path-async-concurrency-'));
  const root = path.join(temp, 'root');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'inside.md'), 'inside');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const originalRealpath = fs.realpath.native;
  fs.realpath.native = ((value: fs.PathLike, callback: (error: NodeJS.ErrnoException | null, path?: string) => void) => {
    setTimeout(() => originalRealpath(value, callback), 40);
  }) as typeof fs.realpath.native;
  t.after(() => { fs.realpath.native = originalRealpath; });

  let resolutionFinished = false;
  const resolution = filesystemPath.resolveUnderAsync(root, 'inside.md', { access: 'existing' })
    .then(() => { resolutionFinished = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resolutionFinished, false, 'artificially slow realpath should still be pending');
  await resolution;
});

test('a request waiting on async realpath does not delay an unrelated request', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-path-http-concurrency-'));
  const root = path.join(temp, 'root');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'inside.md'), 'inside');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const originalRealpath = fs.realpath.native;
  let releaseFirstRealpath: (() => void) | undefined;
  let firstRealpathReleased = false;
  fs.realpath.native = ((value: fs.PathLike, callback: (error: NodeJS.ErrnoException | null, path?: string) => void) => {
    if (!releaseFirstRealpath) {
      releaseFirstRealpath = () => {
        if (firstRealpathReleased) return;
        firstRealpathReleased = true;
        originalRealpath(value, callback);
      };
      return;
    }
    originalRealpath(value, callback);
  }) as typeof fs.realpath.native;
  t.after(() => {
    releaseFirstRealpath?.();
    fs.realpath.native = originalRealpath;
  });

  let markSlowStarted: (() => void) | undefined;
  const slowStarted = new Promise<void>((resolve) => { markSlowStarted = resolve; });
  const server = http.createServer(async (req, res) => {
    if (req.url === '/slow') {
      markSlowStarted?.();
      await filesystemPath.resolveUnderAsync(root, 'inside.md', { access: 'existing' });
      res.end('slow');
      return;
    }
    res.end('fast');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  const slowResponse = fetch(`${base}/slow`);
  await slowStarted;
  assert.equal(await (await fetch(`${base}/fast`)).text(), 'fast');
  assert.ok(releaseFirstRealpath, 'slow request reached the artificial filesystem gate');
  releaseFirstRealpath();
  assert.equal(await (await slowResponse).text(), 'slow');
});
