import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { EditorState } from '@codemirror/state';
import {
  AUDIO_SOURCE_EXTENSIONS,
  DOCX_EXTENSIONS,
  IMAGE_SOURCE_EXTENSIONS,
  PDF_EXTENSIONS,
} from '../shared/file-formats.ts';
import { saveFileContent, validateEditableFileWrite } from './file-save.ts';
import { detectViewerFormat, isConvertibleSource } from './format.ts';
import { runWithFolderRoot } from './folder.ts';
import { getDaemon } from './mfs-daemon.ts';
import { indexer } from './state.ts';
import {
  createFolder,
  createTextExclusiveAsync,
  deleteFileAsync,
  deleteFile,
  fileVersion,
  fileVersionAsync,
  isSameExistingPath,
  listFiles,
  listFilesAndFoldersAsync,
  listFolders,
  listIndexableTextFilesUnder,
  listIndexableTextFilesUnderAsync,
  listImmediateDirectory,
  MAX_TEXT_READ_BYTES,
  readText,
  readTextAsync,
  renameFolder,
  renameOnDisk,
  renameOnDiskAsync,
  saveText,
  sanitizeFilename,
} from './files.ts';

const originalUpsertFile = indexer.upsertFile.bind(indexer);
const originalDeleteFile = indexer.deleteFile.bind(indexer);

before(() => {
  indexer.upsertFile = async () => ({ outcome: 'unchanged' });
  indexer.deleteFile = async () => undefined;
});

after(async () => {
  indexer.upsertFile = originalUpsertFile;
  indexer.deleteFile = originalDeleteFile;
  await getDaemon().close();
});

test('async request-path file operations preserve create, read, list, rename, and delete behavior', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-async-files-'));
  try {
    await runWithFolderRoot(root, async () => {
      assert.equal(await createTextExclusiveAsync('note.md', 'hello'), true);
      assert.equal(await createTextExclusiveAsync('note.md', 'duplicate'), false);
      assert.equal(await readTextAsync('note.md'), 'hello');
      assert.match((await fileVersionAsync('note.md')) ?? '', /^sha256:/);
      assert.deepEqual((await listFilesAndFoldersAsync()).files.map((entry) => entry.name), ['note.md']);
      await renameOnDiskAsync('note.md', 'renamed.md');
      assert.equal(await readTextAsync('renamed.md'), 'hello');
      assert.equal(await deleteFileAsync('renamed.md'), true);
      assert.equal(await readTextAsync('renamed.md'), null);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalid UTF-8 TXT is rejected explicitly and never rewritten through the save path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-invalid-txt-'));
  const sourcePath = path.join(root, 'broken.txt');
  const invalid = Buffer.from([0x66, 0x6f, 0x80, 0x6f]);
  fs.writeFileSync(sourcePath, invalid);
  try {
    await runWithFolderRoot(root, async () => {
      await assert.rejects(
        () => readTextAsync('broken.txt'),
        (err: Error & { code?: string; status?: number }) =>
          err.code === 'UNSUPPORTED_ENCODING' && err.status === 415,
      );
      const version = await fileVersionAsync('broken.txt');
      await assert.rejects(
        () => saveFileContent('broken.txt', 'replacement text', { baseVersion: version ?? undefined }),
        (err: Error & { code?: string }) => err.code === 'UNSUPPORTED_ENCODING',
      );
    });
    assert.deepEqual(fs.readFileSync(sourcePath), invalid);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('TXT saves preserve UTF-8 BOM, line endings, and trailing-newline state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-txt-format-'));
  try {
    fs.writeFileSync(path.join(root, 'bom-crlf.txt'), '\uFEFFone\r\ntwo\r\n', 'utf8');
    fs.writeFileSync(path.join(root, 'lf-no-final.txt'), 'one\ntwo', 'utf8');
    await runWithFolderRoot(root, async () => {
      await saveFileContent(
        'bom-crlf.txt',
        '\uFEFFone\ntwo edited\n',
        { baseVersion: (await fileVersionAsync('bom-crlf.txt')) ?? undefined },
      );
      assert.equal(await readTextAsync('bom-crlf.txt'), '\uFEFFone\r\ntwo edited\r\n');

      await saveFileContent(
        'lf-no-final.txt',
        'one\ntwo edited',
        { baseVersion: (await fileVersionAsync('lf-no-final.txt')) ?? undefined },
      );
      assert.equal(await readTextAsync('lf-no-final.txt'), 'one\ntwo edited');

      const staleVersion = await fileVersionAsync('bom-crlf.txt');
      fs.writeFileSync(path.join(root, 'bom-crlf.txt'), '\uFEFFexternal\r\nchange\r\n', 'utf8');
      await assert.rejects(
        () => saveFileContent('bom-crlf.txt', 'stale editor\nchange\n', { baseVersion: staleVersion ?? undefined }),
        (err: Error & { code?: string }) => err.code === 'FILE_CHANGED',
      );
      assert.equal(fs.readFileSync(path.join(root, 'bom-crlf.txt'), 'utf8'), '\uFEFFexternal\r\nchange\r\n');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('byte-identical and already-reconciled saves retain the authoritative version', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-no-op-save-'));
  try {
    fs.writeFileSync(path.join(root, 'notes.txt'), 'one\r\n', 'utf8');
    await runWithFolderRoot(root, async () => {
      const firstVersion = await fileVersionAsync('notes.txt');
      const unchanged = await saveFileContent('notes.txt', 'one\n', {
        baseVersion: firstVersion ?? undefined,
      });
      assert.equal(unchanged.version, firstVersion);
      assert.equal(unchanged.changed, false);
      assert.equal(await readTextAsync('notes.txt'), 'one\r\n');

      fs.writeFileSync(path.join(root, 'notes.txt'), 'external\r\n', 'utf8');
      const externalVersion = await fileVersionAsync('notes.txt');
      const reconciled = await saveFileContent('notes.txt', 'external\n', {
        baseVersion: firstVersion ?? undefined,
      });
      assert.equal(reconciled.version, externalVersion);
      assert.equal(reconciled.changed, false);
      assert.equal(await readTextAsync('notes.txt'), 'external\r\n');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('text reads reject files above the bounded response limit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-bounded-read-'));
  try {
    fs.writeFileSync(path.join(root, 'large.md'), Buffer.alloc(MAX_TEXT_READ_BYTES + 1, 0x61));
    await runWithFolderRoot(root, () => {
      assert.throws(
        () => readText('large.md'),
        (err: Error & { code?: string; status?: number }) => err.code === 'FILE_TOO_LARGE' && err.status === 413,
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('immediate directory listing reports large files without reading their content', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-immediate-list-'));
  try {
    fs.mkdirSync(path.join(root, 'target'));
    fs.writeFileSync(path.join(root, 'target', 'large.md'), Buffer.alloc(MAX_TEXT_READ_BYTES + 1, 0x61));
    await runWithFolderRoot(root, () => {
      assert.deepEqual(listImmediateDirectory('target'), [{
        name: 'large.md',
        path: 'target/large.md',
        type: 'file',
        format: 'md',
        size: MAX_TEXT_READ_BYTES + 1,
      }]);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('renameOnDisk supports case-only file renames', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-case-rename-'));
  try {
    fs.writeFileSync(path.join(root, 'note.md'), 'hello');

    await runWithFolderRoot(root, async () => {
      const targetExistsBeforeRename = fs.existsSync(path.join(root, 'Note.md'));
      if (targetExistsBeforeRename) {
        assert.equal(isSameExistingPath('note.md', 'Note.md'), true);
      }

      renameOnDisk('note.md', 'Note.md');
    });

    assert.deepEqual(fs.readdirSync(root), ['Note.md']);
    assert.equal(fs.readFileSync(path.join(root, 'Note.md'), 'utf8'), 'hello');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('renameFolder supports case-only folder renames', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-case-folder-'));
  try {
    fs.mkdirSync(path.join(root, 'folder'));
    fs.writeFileSync(path.join(root, 'folder', 'note.md'), 'hello');

    await runWithFolderRoot(root, () => renameFolder('folder', 'Folder'));

    assert.deepEqual(fs.readdirSync(root), ['Folder']);
    assert.equal(fs.readFileSync(path.join(root, 'Folder', 'note.md'), 'utf8'), 'hello');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('quoted imported filenames remain readable, writable, and deletable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-quoted-file-'));
  try {
    const name = "John's Notes.md";
    fs.writeFileSync(path.join(root, name), 'hello');

    await runWithFolderRoot(root, () => {
      assert.equal(readText(name), 'hello');
      saveText(name, 'updated');
      assert.equal(readText(name), 'updated');
      assert.equal(deleteFile(name), true);
      assert.equal(readText(name), null);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('editable file writes apply portable path, hidden-derived, and format policy', () => {
  assert.doesNotThrow(() => validateEditableFileWrite("John's Notes.md"));
  assert.doesNotThrow(() => validateEditableFileWrite('notes.txt'));
  assert.throws(() => validateEditableFileWrite('../escape.md'), /invalid segment/);
  assert.throws(() => validateEditableFileWrite('.report.pdf.md'), /app-maintained derived notes/);
  assert.throws(() => validateEditableFileWrite('report.pdf'), /unsupported editable format/);
});

test('TXT save boundary preserves BOM and CRLF like other source text', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-txt-save-'));
  try {
    fs.writeFileSync(path.join(root, 'notes.txt'), '\uFEFFone\r\ntwo\r\n', 'utf8');
    await runWithFolderRoot(root, async () => {
      const version = fileVersion('notes.txt')!;
      await saveFileContent('notes.txt', '\uFEFFone\nchanged\n', { baseVersion: version });
      assert.equal(readText('notes.txt'), '\uFEFFone\r\nchanged\r\n');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('JSON save boundary preserves BOM/CRLF and rejects a stale renderer version', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-json-save-'));
  try {
    const source = '\uFEFF{\r\n  "value": 1\r\n}\r\n';
    fs.writeFileSync(path.join(root, 'data.json'), source, 'utf8');
    await runWithFolderRoot(root, async () => {
      const version = fileVersion('data.json')!;
      await saveFileContent('data.json', '\uFEFF{\n  "value": 2\n}\n', { baseVersion: version });
      assert.equal(readText('data.json'), '\uFEFF{\r\n  "value": 2\r\n}\r\n');

      saveText('data.json', '\uFEFF{\r\n  "value": "external"\r\n}\r\n');
      await assert.rejects(
        saveFileContent('data.json', '\uFEFF{\n  "value": 3\n}\n', { baseVersion: version }),
        (err: Error & { code?: string }) => err.code === 'FILE_CHANGED',
      );
      assert.equal(readText('data.json'), '\uFEFF{\r\n  "value": "external"\r\n}\r\n');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server convertible membership follows the shared extension catalog', () => {
  for (const extension of PDF_EXTENSIONS) {
    assert.equal(isConvertibleSource(`document.${extension}`), true);
    assert.equal(detectViewerFormat(`document.${extension}`), 'pdf');
  }
  for (const extension of IMAGE_SOURCE_EXTENSIONS) {
    assert.equal(isConvertibleSource(`image.${extension}`), true);
    assert.equal(detectViewerFormat(`image.${extension}`), 'image');
  }
  for (const extension of DOCX_EXTENSIONS) {
    assert.equal(isConvertibleSource(`document.${extension}`), true);
    assert.equal(detectViewerFormat(`document.${extension}`), 'docx');
    assert.equal(isConvertibleSource(`~$document.${extension}`), false);
  }
  for (const extension of AUDIO_SOURCE_EXTENSIONS) {
    assert.equal(isConvertibleSource(`recording.${extension}`), false);
    assert.equal(detectViewerFormat(`recording.${extension}`), 'audio');
  }
});

test('createFolder applies writable protected-segment policy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-create-folder-'));
  try {
    await runWithFolderRoot(root, () => {
      assert.equal(createFolder('Projects'), true);
      assert.equal(fs.statSync(path.join(root, 'Projects')).isDirectory(), true);
      assert.throws(() => createFolder('.stashbase/state'), /cannot write into \.stashbase/);
      assert.throws(() => createFolder('node_modules/pkg'), /excluded directory "node_modules"/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sanitizeFilename keeps folder creation names portable', () => {
  assert.equal(sanitizeFilename('Research:2026/Question?A'), 'Research-2026/Question-A');
});

test('folder listing hides note bundles and legacy derived artifacts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-listing-hidden-'));
  try {
    fs.writeFileSync(path.join(root, 'note.md'), '# Note\n\nVisible');
    fs.mkdirSync(path.join(root, 'note_files'));
    fs.writeFileSync(path.join(root, 'note_files', 'image.png'), 'asset');
    fs.writeFileSync(path.join(root, 'paper.pdf'), 'pdf bytes');
    fs.writeFileSync(path.join(root, '.paper.md'), 'legacy stem text');
    fs.writeFileSync(path.join(root, '.paper.pdf.md'), 'legacy basename text');
    fs.mkdirSync(path.join(root, '.stashbase'));

    await runWithFolderRoot(root, () => {
      assert.deepEqual(listFiles().map((entry) => entry.name), ['note.md', 'paper.pdf']);
      assert.deepEqual(listFolders().map((entry) => entry.path), []);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('audio same-stem dot Markdown stays user-owned while hidden from listing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-audio-hidden-note-'));
  try {
    fs.writeFileSync(path.join(root, 'meeting.mp3'), 'audio bytes');
    fs.writeFileSync(path.join(root, '.meeting.md'), '# Private meeting note');
    fs.writeFileSync(path.join(root, '.meeting.mp3.md'), '# Explicitly named note');

    await runWithFolderRoot(root, () => {
      assert.deepEqual(listFiles().map((entry) => entry.name), ['meeting.mp3']);
      assert.doesNotThrow(() => validateEditableFileWrite('.meeting.mp3.md'));
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('folder rename scan includes legacy derived notes for stale index cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-derived-scan-'));
  try {
    fs.mkdirSync(path.join(root, 'Research'));
    fs.writeFileSync(path.join(root, 'Research', 'paper.pdf'), 'pdf bytes');
    fs.writeFileSync(path.join(root, 'Research', '.paper.md'), 'legacy stem text');
    fs.writeFileSync(path.join(root, 'Research', '.paper.pdf.md'), 'legacy basename text');
    fs.writeFileSync(path.join(root, 'Research', 'plain.TXT'), 'literal text');
    fs.writeFileSync(path.join(root, 'Research', 'broken.txt'), Buffer.from([0x62, 0x61, 0x80, 0x64]));

    await runWithFolderRoot(root, async () => {
      assert.deepEqual(
        listIndexableTextFilesUnder('Research').map((entry) => entry.name),
        ['Research/.paper.md', 'Research/.paper.pdf.md', 'Research/plain.TXT'],
      );
      assert.deepEqual(
        (await listIndexableTextFilesUnderAsync('Research')).map((entry) => entry.name),
        ['Research/.paper.md', 'Research/.paper.pdf.md', 'Research/plain.TXT'],
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PDF rename and delete preserve neighboring files that match retired extraction names', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-source-neighbors-'));
  try {
    for (const asyncMode of [false, true]) {
      const source = asyncMode ? 'async.pdf' : 'sync.pdf';
      const target = asyncMode ? 'async-new.pdf' : 'sync-new.pdf';
      fs.writeFileSync(path.join(root, source), 'source');
      const siblings = ['.' + source + '.md', '.' + source.replace('.pdf', '') + '.md', '.' + target + '.md'];
      for (const sibling of siblings) fs.writeFileSync(path.join(root, sibling), 'user note');
      const bundle = path.join(root, '.' + source + '_files.tmp-user');
      fs.mkdirSync(bundle); fs.writeFileSync(path.join(bundle, 'keep.txt'), 'user asset');
      await runWithFolderRoot(root, async () => {
        if (asyncMode) { await renameOnDiskAsync(source, target); await deleteFileAsync(target); }
        else { renameOnDisk(source, target); deleteFile(target); }
      });
      for (const sibling of siblings) assert.equal(fs.readFileSync(path.join(root, sibling), 'utf8'), 'user note');
      assert.equal(fs.readFileSync(path.join(bundle, 'keep.txt'), 'utf8'), 'user asset');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
