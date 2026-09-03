import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runWithFolderRoot } from '../folder.ts';
import { listFilesAndFolders, listFilesAndFoldersAsync } from '../file-listing.ts';

test('file-listing reports the truthful workbench tree without traversing excluded infrastructure', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-listing-test-'));
  const originalReadFileSync = fs.readFileSync;

  try {
    // Set up test folder structure
    // 1. Root supported file
    fs.writeFileSync(path.join(tempDir, 'note1.md'), 'Heading 1\nSome content');

    // 2. Folder containing supported files (should keep folder + files)
    const folderSupported = path.join(tempDir, 'docs');
    fs.mkdirSync(folderSupported);
    fs.writeFileSync(path.join(folderSupported, 'note2.html'), '<h1>HTML Note</h1>');

    // 3. A code-only folder remains visible with generic files.
    const folderCodeOnly = path.join(tempDir, 'src');
    fs.mkdirSync(folderCodeOnly);
    fs.writeFileSync(path.join(folderCodeOnly, 'main.ts'), 'console.log("hello")');
    fs.writeFileSync(path.join(folderCodeOnly, 'utils.py'), 'def add(a, b): return a + b');

    // 4. Mixed known and generic files.
    const folderMixed = path.join(tempDir, 'mixed');
    fs.mkdirSync(folderMixed);
    fs.writeFileSync(path.join(folderMixed, 'note3.md'), '# Markdown');
    fs.writeFileSync(path.join(folderMixed, 'data.csv'), '1,2,3');
    fs.writeFileSync(path.join(folderMixed, 'archive.zip'), '');
    fs.writeFileSync(path.join(folderMixed, 'config.JSON'), '{ invalid json');
    fs.writeFileSync(path.join(folderMixed, 'plain.TxT'), '# literal heading\n<strong>literal</strong>');
    fs.writeFileSync(path.join(folderMixed, 'broken.txt'), Buffer.from([0x62, 0x61, 0x80, 0x64]));
    const largeText = path.join(folderMixed, 'large.txt');
    fs.writeFileSync(largeText, Buffer.concat([
      Buffer.from('# bounded preview\n'),
      Buffer.alloc((8 * 1024 * 1024) + 1, 0x61),
    ]));
    fs.readFileSync = ((file, options) => {
      if (String(file) === largeText) throw new Error('listing must not read a whole TXT source');
      return originalReadFileSync(file, options as never);
    }) as typeof fs.readFileSync;
    fs.writeFileSync(path.join(folderMixed, 'readme.txt'), 'searchable plain text');
    fs.writeFileSync(path.join(folderMixed, 'unfinished.tmp'), 'a user-owned temp file');
    fs.mkdirSync(path.join(folderMixed, 'config.json_files'));
    fs.writeFileSync(path.join(folderMixed, 'config.json_files', 'asset.md'), '# visible child');

    // 5. Excluded directory is represented but never traversed.
    const folderExcluded = path.join(tempDir, 'node_modules');
    fs.mkdirSync(folderExcluded);
    fs.writeFileSync(path.join(folderExcluded, 'index.js'), 'module.exports = {}');

    // 6. Physically empty folder (should keep folder)
    const folderEmpty = path.join(tempDir, 'empty-dir');
    fs.mkdirSync(folderEmpty);

    // 7. Junk/derived dot-files remain hidden, ordinary user dot-files do not.
    fs.writeFileSync(path.join(tempDir, '.DS_Store'), '');
    fs.writeFileSync(path.join(tempDir, '.env'), 'TOKEN=local');
    fs.writeFileSync(path.join(tempDir, '.private.md'), '# Hidden dot-note');
    fs.writeFileSync(path.join(tempDir, '.note.pdf.md'), 'derived');
    const folderDotOnly = path.join(tempDir, 'dot-only');
    fs.mkdirSync(folderDotOnly);
    fs.writeFileSync(path.join(folderDotOnly, '.DS_Store'), '');

    // Run listing scan
    const { result, asyncResult } = await runWithFolderRoot(tempDir, async () => {
      const result = listFilesAndFolders();
      const originalReaddirSync = fs.readdirSync;
      fs.readdirSync = (() => {
        throw new Error('async HTTP listing used synchronous directory I/O');
      }) as typeof fs.readdirSync;
      try {
        return { result, asyncResult: await listFilesAndFoldersAsync() };
      } finally {
        fs.readdirSync = originalReaddirSync;
      }
    });
    assert.deepEqual(asyncResult, result, 'async HTTP listing must preserve sidebar classification');

    // Every ordinary folder survives even when it contains only generic files.
    const folderPaths = result.folders.map((f) => f.path);
    assert.ok(folderPaths.includes('docs'));
    assert.ok(folderPaths.includes('mixed'));
    assert.ok(folderPaths.includes('empty-dir'));
    assert.ok(folderPaths.includes('src'), 'code-only directories stay visible');
    assert.ok(folderPaths.includes('node_modules'), 'excluded directories get an explanatory placeholder');
    assert.equal(result.folders.find((f) => f.path === 'node_modules')?.kind, 'excluded');
    assert.ok(folderPaths.includes('dot-only'), 'a folder holding only dot-files stays visible as empty');

    // Verify files list
    const fileNames = result.files.map((f) => f.name);
    assert.ok(fileNames.includes('note1.md'));
    assert.ok(fileNames.includes('docs/note2.html'));
    assert.ok(fileNames.includes('mixed/note3.md'));
    assert.ok(fileNames.includes('mixed/config.JSON'));
    assert.ok(fileNames.includes('mixed/plain.TxT'));
    assert.ok(fileNames.includes('mixed/broken.txt'));
    assert.ok(fileNames.includes('mixed/large.txt'));
    assert.ok(fileNames.includes('mixed/config.json_files/asset.md'), 'JSON must not claim a note bundle');
    assert.equal(result.files.find((file) => file.name === 'mixed/plain.TxT')?.heading, '');
    assert.equal(
      result.files.find((file) => file.name === 'mixed/plain.TxT')?.snippet,
      '# literal heading <strong>literal</strong>',
      'TXT preview remains literal rather than using Markdown or HTML semantics',
    );
    assert.equal(result.files.find((file) => file.name === 'mixed/broken.txt')?.snippet, '');
    assert.match(result.files.find((file) => file.name === 'mixed/large.txt')?.snippet ?? '', /^# bounded preview/);

    // The unchanged counts below double as the dot-file regression: the
    // two .DS_Store files must not appear in `other`/`otherExtensions`
    // (they used to surface as "N files (no extension)").

    assert.equal(result.files.find((f) => f.name === 'mixed/readme.txt')?.format, 'txt');
    assert.equal(result.files.find((f) => f.name === 'src/main.ts')?.format, 'generic');
    assert.equal(result.files.find((f) => f.name === 'src/utils.py')?.format, 'generic');
    assert.equal(result.files.find((f) => f.name === 'mixed/data.csv')?.format, 'generic');
    assert.equal(result.files.find((f) => f.name === 'mixed/archive.zip')?.format, 'generic');
    assert.equal(result.files.find((f) => f.name === 'mixed/unfinished.tmp')?.format, 'generic');
    assert.ok(fileNames.includes('mixed/config.json_files/asset.md'), 'JSON must not claim a note bundle');
    assert.ok(fileNames.includes('.env'), 'ordinary user dot-files stay visible');
    assert.ok(!fileNames.includes('.DS_Store'), 'junk dot-files stay hidden');
    assert.ok(!fileNames.includes('.private.md'), 'the established hidden dot-note namespace stays hidden');
    assert.ok(!fileNames.includes('.note.pdf.md'), 'hidden derived notes never surface');
    assert.ok(!fileNames.includes('node_modules/index.js'), 'excluded directory contents are never traversed');

  } finally {
    fs.readFileSync = originalReadFileSync;
    // Recursively clean up the temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('show-hidden listings surface eligible dot-directories while protecting VCS, excluded, and derived state', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-listing-hidden-dirs-'));
  try {
    fs.writeFileSync(path.join(tempDir, 'note.md'), '# Visible note');
    fs.writeFileSync(path.join(tempDir, '.env'), 'TOKEN=local');

    // Eligible user-owned hidden directory with nested content.
    fs.mkdirSync(path.join(tempDir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.github', 'README.md'), '# CI docs');
    fs.writeFileSync(path.join(tempDir, '.github', 'workflows', 'ci.yml'), 'on: push');
    // Junk metadata and the hidden dot-note namespace stay hidden even
    // inside a surfaced hidden directory.
    fs.writeFileSync(path.join(tempDir, '.github', '.DS_Store'), '');
    fs.writeFileSync(path.join(tempDir, '.github', '.private.md'), '# hidden dot-note');

    // VCS databases must never surface or be traversed in either mode.
    fs.mkdirSync(path.join(tempDir, '.git'));
    fs.writeFileSync(path.join(tempDir, '.git', 'HEAD'), 'ref: refs/heads/main');
    fs.mkdirSync(path.join(tempDir, '.hg'));
    fs.writeFileSync(path.join(tempDir, '.hg', 'requires'), 'store');
    fs.mkdirSync(path.join(tempDir, '.stashbase'));
    fs.writeFileSync(path.join(tempDir, '.stashbase', 'state.json'), '{}');
    fs.mkdirSync(path.join(tempDir, '.stashbase-cache'));
    fs.writeFileSync(path.join(tempDir, '.stashbase-cache', 'index.bin'), 'internal');

    // A hidden excluded cache stays a bounded, non-expandable row.
    fs.mkdirSync(path.join(tempDir, '.cache'));
    fs.writeFileSync(path.join(tempDir, '.cache', 'blob.bin'), 'cache bytes');

    const { hiddenOff, hiddenOn, hiddenOnAsync } = await runWithFolderRoot(tempDir, async () => ({
      hiddenOff: listFilesAndFolders(),
      hiddenOn: listFilesAndFolders({ showHidden: true }),
      hiddenOnAsync: await listFilesAndFoldersAsync({ showHidden: true }),
    }));
    assert.deepEqual(hiddenOnAsync, hiddenOn, 'async HTTP listing must preserve hidden-visibility classification');

    // Default view: current behavior exactly — dotfiles visible, every
    // dot-directory absent.
    const offFolders = hiddenOff.folders.map((f) => f.path);
    const offFiles = hiddenOff.files.map((f) => f.name);
    assert.deepEqual(offFolders, []);
    assert.deepEqual(offFiles, ['.env', 'note.md']);

    // Opted in: eligible hidden directories and their descendants join the
    // tree with normal classification.
    const onFolders = hiddenOn.folders;
    const onFolderPaths = onFolders.map((f) => f.path);
    const onFiles = hiddenOn.files.map((f) => f.name);
    assert.ok(onFolderPaths.includes('.github'));
    assert.ok(onFolderPaths.includes('.github/workflows'));
    assert.equal(onFolders.find((f) => f.path === '.github')?.kind, undefined);
    assert.ok(onFiles.includes('.github/README.md'));
    assert.ok(onFiles.includes('.github/workflows/ci.yml'));
    assert.ok(onFiles.includes('.env'), 'ordinary dotfiles keep their current behavior');
    assert.equal(hiddenOn.files.find((f) => f.name === '.github/workflows/ci.yml')?.format, 'generic');

    // Protected internals stay invisible and untraversed.
    assert.ok(!onFolderPaths.includes('.git'), 'VCS databases never surface');
    assert.ok(!onFolderPaths.includes('.hg'), 'VCS databases never surface');
    assert.ok(!onFolderPaths.includes('.stashbase'), 'product state never surfaces');
    assert.ok(!onFolderPaths.includes('.stashbase-cache'), 'product state variants never surface');
    assert.ok(!onFiles.some((name) =>
      name.startsWith('.git/')
      || name.startsWith('.hg/')
      || name.startsWith('.stashbase/')
      || name.startsWith('.stashbase-')
    ));
    assert.ok(!onFiles.includes('.github/.DS_Store'), 'junk dot-files stay hidden');
    assert.ok(!onFiles.includes('.github/.private.md'), 'the hidden dot-note namespace stays hidden');

    // Hidden excluded caches remain bounded excluded rows, not traversals.
    assert.equal(onFolders.find((f) => f.path === '.cache')?.kind, 'excluded');
    assert.ok(!onFiles.includes('.cache/blob.bin'), 'excluded directory contents are never traversed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('show-hidden async traversal yields while scanning a large eligible dot-directory', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-listing-hidden-yield-'));
  try {
    const hiddenDir = path.join(tempDir, '.github');
    fs.mkdirSync(hiddenDir);
    for (let i = 0; i < 2_050; i += 1) {
      fs.writeFileSync(path.join(hiddenDir, `file-${String(i).padStart(4, '0')}.md`), '# note');
    }
    const originalSetImmediate = setImmediate;
    let explicitYieldCount = 0;
    const instrumentedSetImmediate = ((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
      explicitYieldCount += 1;
      return originalSetImmediate(callback, ...args);
    }) as unknown as typeof setImmediate;
    t.mock.method(globalThis, 'setImmediate', instrumentedSetImmediate);

    const listing = await runWithFolderRoot(tempDir, () => listFilesAndFoldersAsync({ showHidden: true }));
    assert.ok(explicitYieldCount >= 1, 'large hidden traversal must invoke the shared event-loop yield');
    assert.equal(listing.files.length, 2_050);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
