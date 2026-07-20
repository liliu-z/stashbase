import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EditorState } from '@codemirror/state';
import { saveFileContent, validateEditableFileWrite } from './file-save.ts';
import { runWithFolderRoot } from './folder.ts';
import {
  createFolder,
  deleteFile,
  fileVersion,
  isSameExistingPath,
  listFiles,
  listFolders,
  listIndexableTextFilesUnder,
  readText,
  renameFolder,
  renameOnDisk,
  saveText,
  sanitizeFilename,
} from './files.ts';

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

test('edited Markdown saves preserve BOM and source line ending convention', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-markdown-source-format-'));
  const name = 'note.md';
  try {
    fs.writeFileSync(path.join(root, name), Buffer.from('\uFEFF# Title\r\n\r\nRaw <mark>HTML</mark>\r\n', 'utf8'));
    await runWithFolderRoot(root, async () => {
      const result = await saveFileContent(name, '# Title\n\nRaw <mark>HTML</mark>\nEdited\n');
      assert.equal(result.content, '\uFEFF# Title\r\n\r\nRaw <mark>HTML</mark>\r\nEdited\r\n');
    });
    assert.equal(
      fs.readFileSync(path.join(root, name), 'utf8'),
      '\uFEFF# Title\r\n\r\nRaw <mark>HTML</mark>\r\nEdited\r\n',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unchanged Markdown serialization does not replace the source file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-markdown-noop-save-'));
  const name = 'note.md';
  try {
    const source = '\uFEFF# Title\r\n';
    fs.writeFileSync(path.join(root, name), Buffer.from(source, 'utf8'));
    const before = fs.statSync(path.join(root, name));
    await runWithFolderRoot(root, async () => {
      await saveFileContent(name, '# Title\n');
    });
    const after = fs.statSync(path.join(root, name));
    assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), source);
    assert.equal(after.ino, before.ino);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stale Markdown save retry recognizes the already-serialized BOM/CRLF bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-markdown-idempotent-retry-'));
  const name = 'note.md';
  try {
    fs.writeFileSync(path.join(root, name), Buffer.from('\uFEFF# Title\r\n', 'utf8'));
    await runWithFolderRoot(root, async () => {
      const originalVersion = fileVersion(name);
      assert.ok(originalVersion);
      await saveFileContent(name, '# Title\nEdited\n', { baseVersion: originalVersion });
      const retry = await saveFileContent(name, '# Title\nEdited\n', { baseVersion: originalVersion });
      assert.equal(retry.content, '\uFEFF# Title\r\nEdited\r\n');
      assert.equal(retry.version, fileVersion(name));
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source-format fixture survives CodeMirror load, autosave, explicit save, and Reading View', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-markdown-lifecycle-'));
  const name = 'fixture.md';
  const source = '\uFEFF---\r\ntitle: raw\r\n---\r\n\r\n<div data-unsupported="yes">raw</div>\r\n[broken](\r\n';
  try {
    fs.writeFileSync(path.join(root, name), Buffer.from(source, 'utf8'));
    await runWithFolderRoot(root, async () => {
      // Loading into CodeMirror canonicalizes its document to LF, while a
      // reading transition only reads the saved source and does not write.
      const loaded = readText(name)!;
      let editor = EditorState.create({ doc: loaded });
      editor = editor.update({ changes: { from: editor.doc.length, insert: 'autosaved\n' } }).state;
      await saveFileContent(name, editor.doc.toString());
      const afterAutosave = readText(name)!;
      assert.equal(afterAutosave.includes('\r\n'), true);
      assert.equal(afterAutosave.startsWith('\uFEFF'), true);
      assert.equal(afterAutosave.includes('<div data-unsupported="yes">raw</div>'), true);
      assert.equal(afterAutosave.includes('[broken]('), true);

      const readingView = readText(name)!;
      assert.equal(readingView, afterAutosave);
      editor = editor.update({ changes: { from: editor.doc.length, insert: 'explicit save\n' } }).state;
      await saveFileContent(name, editor.doc.toString());
      const afterExplicitSave = readText(name)!;
      assert.equal(afterExplicitSave.endsWith('autosaved\r\nexplicit save\r\n'), true);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('editable file writes apply portable path, hidden-derived, and format policy', () => {
  assert.doesNotThrow(() => validateEditableFileWrite("John's Notes.md"));
  assert.throws(() => validateEditableFileWrite('../escape.md'), /invalid segment/);
  assert.throws(() => validateEditableFileWrite('.report.pdf.md'), /app-maintained derived notes/);
  assert.throws(() => validateEditableFileWrite('report.pdf'), /unsupported editable format/);
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

test('folder rename scan includes legacy derived notes for stale index cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-derived-scan-'));
  try {
    fs.mkdirSync(path.join(root, 'Research'));
    fs.writeFileSync(path.join(root, 'Research', 'paper.pdf'), 'pdf bytes');
    fs.writeFileSync(path.join(root, 'Research', '.paper.md'), 'legacy stem text');
    fs.writeFileSync(path.join(root, 'Research', '.paper.pdf.md'), 'legacy basename text');

    await runWithFolderRoot(root, () => {
      assert.deepEqual(
        listIndexableTextFilesUnder('Research').map((entry) => entry.name),
        ['Research/.paper.md', 'Research/.paper.pdf.md'],
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
