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
import { friendlyIndexError, saveFileContent, validateEditableFileWrite } from './file-save.ts';
import { detectViewerFormat, isConvertibleSource } from './format.ts';
import { runWithFolderRoot } from './folder.ts';
import {
  createFolder,
  deleteFile,
  fileVersion,
  isSameExistingPath,
  listFiles,
  listFolders,
  listIndexableTextFilesUnder,
  listImmediateDirectory,
  MAX_TEXT_READ_BYTES,
  readText,
  renameFolder,
  renameOnDisk,
  saveText,
  sanitizeFilename,
} from './files.ts';

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
  assert.throws(() => validateEditableFileWrite('../escape.md'), /invalid segment/);
  assert.throws(() => validateEditableFileWrite('.report.pdf.md'), /app-maintained derived notes/);
  assert.throws(() => validateEditableFileWrite('report.pdf'), /unsupported editable format/);
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

test('friendlyIndexError translates raw embedding API errors correctly', () => {
  // Test HTTP 401/403 status codes
  const err401 = { status: 401, message: 'Unauthorized access' };
  assert.match(friendlyIndexError(err401), /API key is invalid or expired/i);

  const err403 = { statusCode: 403, message: 'Forbidden access' };
  assert.match(friendlyIndexError(err403), /API key is invalid or expired/i);

  // Test HTTP 429 status code
  const err429 = { status: 429, message: 'Too many requests' };
  assert.match(friendlyIndexError(err429), /Rate limit reached/i);

  // Test OpenAI-style Error code wrapper parsing
  const errRawOai = new Error("Error code: 400 - {'error': {'message': 'Invalid model selection.', 'code': 400}}");
  assert.equal(friendlyIndexError(errRawOai), 'Invalid model selection.');

  // Test standard fallback
  const errFallback = new Error('Some random network error');
  assert.equal(friendlyIndexError(errFallback), 'Some random network error');
});
