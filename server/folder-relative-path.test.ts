import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeFolderRelativePath } from './folder-relative-path.ts';

test('folder-relative paths share one separator and traversal policy', () => {
  assert.equal(normalizeFolderRelativePath('Folder\\nested//File.md'), 'Folder/nested/File.md');
  assert.throws(() => normalizeFolderRelativePath('/absolute/File.md'), /relative/);
  assert.throws(() => normalizeFolderRelativePath('C:\\absolute\\File.md'), /relative/);
  assert.throws(() => normalizeFolderRelativePath('Folder/../File.md'), /invalid segment/);
  assert.throws(() => normalizeFolderRelativePath('Folder/\u0000File.md'), /invalid characters/);
});

test('writable folder-relative paths share one protected-segment policy', () => {
  assert.equal(
    normalizeFolderRelativePath('Folder/File.md', { writable: true }),
    'Folder/File.md',
  );
  assert.throws(
    () => normalizeFolderRelativePath('.stashbase/state.db', { writable: true }),
    /cannot write into \.stashbase/,
  );
  assert.throws(
    () => normalizeFolderRelativePath('node_modules/file.md', { writable: true }),
    /excluded directory "node_modules"/,
  );
  assert.throws(
    () => normalizeFolderRelativePath('pending.icloud', { writable: true }),
    /iCloud placeholder/,
  );
  assert.equal(
    normalizeFolderRelativePath("Imported/John's Notes.pdf", { writable: true, allowQuotes: true }),
    "Imported/John's Notes.pdf",
  );
  assert.equal(
    normalizeFolderRelativePath("Imported/John's Notes.pdf", { allowQuotes: true }),
    "Imported/John's Notes.pdf",
  );
  assert.throws(() => normalizeFolderRelativePath("John's Notes.md"), /invalid characters/);
});

test('writable paths on Windows refuse names Windows cannot store, with the reason', () => {
  const win32 = { writable: true, allowQuotes: true, platform: 'win32' } as const;
  for (const [name, reason] of [
    ['What is this?.md', /cannot contain/],
    ['Drafts/My "final" draft.md', /cannot contain/],
    ['note.md:hidden.md', /cannot contain/],
    ['Chapter one./draft.md', /cannot end with a dot or a space/],
    ['draft.md ', /cannot end with a dot or a space/],
    ['CON.md', /CON is reserved for a device/],
    ['Notes/lpt1', /LPT1 is reserved for a device/],
  ] as const) {
    assert.throws(() => normalizeFolderRelativePath(name, win32), reason, name);
  }
  // Similar-looking names Windows accepts.
  for (const name of ['What is this.md', "John's Notes.md", 'console.md', 'COM10.md', 'Notes/.env']) {
    assert.equal(normalizeFolderRelativePath(name, win32), name);
  }
  // macOS and Linux store these names, so only Windows refuses them.
  assert.equal(
    normalizeFolderRelativePath('What is this?.md', { writable: true, platform: 'darwin' }),
    'What is this?.md',
  );
  // Reading an existing path is not a write and is not checked.
  assert.equal(normalizeFolderRelativePath('CON.md', { platform: 'win32' }), 'CON.md');
});
