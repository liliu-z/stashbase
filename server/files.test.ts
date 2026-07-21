import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
import {
  createFolder,
  deleteFile,
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

test('editable file writes apply portable path, hidden-derived, and format policy', () => {
  assert.doesNotThrow(() => validateEditableFileWrite("John's Notes.md"));
  assert.throws(() => validateEditableFileWrite('../escape.md'), /invalid segment/);
  assert.throws(() => validateEditableFileWrite('.report.pdf.md'), /app-maintained derived notes/);
  assert.throws(() => validateEditableFileWrite('report.pdf'), /unsupported editable format/);
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
    assert.equal(isConvertibleSource(`recording.${extension}`), true);
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

test('audio sources do not hide same-stem user Markdown as legacy derived output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-audio-hidden-note-'));
  try {
    fs.writeFileSync(path.join(root, 'meeting.mp3'), 'audio bytes');
    fs.writeFileSync(path.join(root, '.meeting.md'), '# Private meeting note');
    fs.writeFileSync(path.join(root, '.meeting.mp3.md'), '# Explicitly named note');

    await runWithFolderRoot(root, () => {
      assert.deepEqual(listFiles().map((entry) => entry.name), [
        '.meeting.md',
        '.meeting.mp3.md',
        'meeting.mp3',
      ]);
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
