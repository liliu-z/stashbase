import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { clearCurrentFolder, openProjectFolder } from './folder.ts';
import { decodeGenericText, readGenericFilePreview } from './generic-file-preview.ts';
import { MAX_TEXT_READ_BYTES } from './active-file-operations.ts';
import { fileSymlink } from './__tests__/filesystem-links.ts';

test('generic preview strictly distinguishes readable text from binary and oversized files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-generic-preview-'));
  try {
    fs.writeFileSync(path.join(root, 'script.ts'), 'const greeting = "你好";\r\n');
    fs.writeFileSync(path.join(root, 'payload.bin'), Buffer.from([0x61, 0x00, 0x62]));
    fs.writeFileSync(path.join(root, 'invalid.data'), Buffer.from([0xc3, 0x28]));
    fs.writeFileSync(path.join(root, 'looks-textual.zip'), 'plain-looking bytes');
    fs.writeFileSync(path.join(root, '.remote.txt.icloud'), '');
    fs.writeFileSync(path.join(root, 'known.md'), '# Known');
    fs.writeFileSync(path.join(root, 'huge.log'), '');
    fs.truncateSync(path.join(root, 'huge.log'), MAX_TEXT_READ_BYTES + 1);
    fs.writeFileSync(path.join(root, 'huge.zip'), '');
    fs.truncateSync(path.join(root, 'huge.zip'), MAX_TEXT_READ_BYTES + 1);
    await openProjectFolder(root);

    const text = await readGenericFilePreview('script.ts');
    assert.equal(text.kind, 'text');
    if (text.kind === 'text') {
      assert.equal(text.content, 'const greeting = "你好";\r\n');
      assert.ok(text.version);
    }
    assert.equal((await readGenericFilePreview('payload.bin')).kind, 'binary');
    assert.equal((await readGenericFilePreview('invalid.data')).kind, 'binary');
    assert.equal((await readGenericFilePreview('looks-textual.zip')).kind, 'binary');
    assert.equal((await readGenericFilePreview('huge.log')).kind, 'too-large');
    assert.equal((await readGenericFilePreview('huge.zip')).kind, 'binary', 'known binary type wins over the text-size ceiling');
    assert.equal((await readGenericFilePreview('.remote.txt.icloud')).kind, 'cloud-placeholder');
    await assert.rejects(readGenericFilePreview('known.md'), /known document formats/);
  } finally {
    clearCurrentFolder();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generic UTF-8 admission permits normal whitespace but rejects binary controls', () => {
  assert.equal(decodeGenericText(Buffer.from('line one\n\tline two')), 'line one\n\tline two');
  assert.equal(decodeGenericText(Buffer.from([0x61, 0x00, 0x62])), null);
  assert.equal(decodeGenericText(Buffer.from([0xff, 0xfe, 0x61])), null);
});

// Windows creates file symlinks only with Developer Mode or administrator
// rights; without them the case reports that it was not exercised.
test('generic preview reports symlinks without following them', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-generic-symlink-'));
  try {
    fs.writeFileSync(path.join(root, 'target.ts'), 'secret');
    if (!fileSymlink('target.ts', path.join(root, 'alias.ts'), t)) {
      t.skip('file symlinks need Windows Developer Mode');
      return;
    }
    await openProjectFolder(root);
    assert.equal((await readGenericFilePreview('alias.ts')).kind, 'symlink');
  } finally {
    clearCurrentFolder();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
