import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  importFolderAsSpace,
  previewFolderImport,
} from './import-folder.ts';

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `stashbase-${label}-`));
}

test('preview derives the destination name and requires confirmation for non-empty sources', () => {
  const kbRoot = tmpDir('kb');
  const source = tmpDir('source');
  fs.writeFileSync(path.join(source, 'note.md'), '# hello\n');

  const preview = previewFolderImport({ source, kbRoot });

  assert.equal(preview.name, path.basename(source));
  assert.equal(preview.destination, path.join(kbRoot, path.basename(source)));
  assert.equal(preview.exists, true);
  assert.equal(preview.requiresConfirmation, true);
  assert.equal(preview.entryCount, 1);
  assert.equal(preview.hasSnapshot, false);
});

test('copy imports into a new space, dereferences symlinks, and leaves the source intact', () => {
  const kbRoot = tmpDir('kb');
  const source = tmpDir('source');
  const external = tmpDir('external');
  fs.writeFileSync(path.join(external, 'outside.md'), '# outside\n');
  fs.symlinkSync(path.join(external, 'outside.md'), path.join(source, 'linked.md'));
  fs.mkdirSync(path.join(source, '.stashbase'), { recursive: true });
  fs.writeFileSync(path.join(source, '.stashbase', 'snapshot.parquet'), 'snapshot');
  fs.writeFileSync(path.join(source, '.stashbase', 'config.json'), '{}');

  const result = importFolderAsSpace({
    source,
    kbRoot,
    name: 'imported',
    mode: 'copy',
    confirmExisting: true,
  });

  assert.equal(result.name, 'imported');
  assert.equal(result.path, path.join(kbRoot, 'imported'));
  assert.equal(fs.readFileSync(path.join(result.path, 'linked.md'), 'utf8'), '# outside\n');
  assert.equal(fs.lstatSync(path.join(result.path, 'linked.md')).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(result.path, '.stashbase', 'snapshot.parquet')), true);
  assert.equal(fs.existsSync(path.join(result.path, '.stashbase', 'config.json')), false);
  assert.equal(fs.existsSync(source), true);
});

test('preview counts a symlinked directory once', () => {
  const kbRoot = tmpDir('kb');
  const source = tmpDir('source');
  const linkedDir = tmpDir('linked');
  fs.writeFileSync(path.join(linkedDir, 'linked.md'), '# linked\n');
  fs.symlinkSync(linkedDir, path.join(source, 'linked'));

  const preview = previewFolderImport({ source, kbRoot });

  assert.equal(preview.entryCount, 2);
  assert.equal(preview.totalBytes, Buffer.byteLength('# linked\n'));
});

test('move imports by copy-then-delete, preserving dereferenced content in the space', () => {
  const kbRoot = tmpDir('kb');
  const source = tmpDir('source');
  fs.writeFileSync(path.join(source, 'note.md'), '# moved\n');

  const result = importFolderAsSpace({
    source,
    kbRoot,
    name: 'moved-space',
    mode: 'move',
    confirmExisting: true,
  });

  assert.equal(fs.readFileSync(path.join(result.path, 'note.md'), 'utf8'), '# moved\n');
  assert.equal(fs.existsSync(source), false);
});

test('move keeps the imported space and warns when the original cannot be removed', () => {
  const kbRoot = tmpDir('kb');
  const parent = tmpDir('parent');
  const source = path.join(parent, 'src');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'note.md'), '# moved\n');
  // Strip write permission on the parent so the source entry cannot be
  // unlinked — simulates a copy-succeeds-but-delete-fails move (a lock or
  // permission issue). The copy is already committed at that point.
  fs.chmodSync(parent, 0o500);
  try {
    const result = importFolderAsSpace({
      source,
      kbRoot,
      name: 'kept',
      mode: 'move',
      confirmExisting: true,
    });
    // The new space must survive — tearing it down would lose data on
    // both sides, since the original is also partially gone.
    assert.equal(fs.readFileSync(path.join(result.path, 'note.md'), 'utf8'), '# moved\n');
    assert.equal(fs.existsSync(source), true);
    assert.match(result.warning ?? '', /could not be fully removed/);
  } finally {
    fs.chmodSync(parent, 0o700);
  }
});

test('import refuses to merge into an existing space', () => {
  const kbRoot = tmpDir('kb');
  const source = tmpDir('source');
  fs.writeFileSync(path.join(source, 'note.md'), '# hello\n');
  fs.mkdirSync(path.join(kbRoot, 'existing'));

  assert.throws(
    () => importFolderAsSpace({
      source,
      kbRoot,
      name: 'existing',
      mode: 'copy',
      confirmExisting: true,
    }),
    /already exists/,
  );
});

test('import refuses non-empty source without confirmation', () => {
  const kbRoot = tmpDir('kb');
  const source = tmpDir('source');
  fs.writeFileSync(path.join(source, 'note.md'), '# hello\n');

  assert.throws(
    () => importFolderAsSpace({ source, kbRoot, mode: 'copy', confirmExisting: false }),
    /confirmation required/,
  );
});

test('import refuses unknown modes', () => {
  const kbRoot = tmpDir('kb');
  const source = tmpDir('source');

  assert.throws(
    () => importFolderAsSpace({
      source,
      kbRoot,
      mode: 'link' as any,
      confirmExisting: true,
    }),
    /mode must be "copy" or "move"/,
  );
});

test('import refuses cyclic directory symlinks and rolls back the destination', () => {
  const kbRoot = tmpDir('kb');
  const source = tmpDir('source');
  fs.writeFileSync(path.join(source, 'note.md'), '# hello\n');
  fs.symlinkSync(source, path.join(source, 'cycle'));

  assert.throws(
    () => importFolderAsSpace({
      source,
      kbRoot,
      name: 'cyclic',
      mode: 'copy',
      confirmExisting: true,
    }),
    /cyclic symlink/,
  );
  assert.equal(fs.existsSync(path.join(kbRoot, 'cyclic')), false);
});

test('import refuses sources that contain the library root', () => {
  const parent = tmpDir('parent');
  const kbRoot = path.join(parent, 'StashBase');
  fs.mkdirSync(kbRoot);
  fs.writeFileSync(path.join(parent, 'note.md'), '# hello\n');

  assert.throws(
    () => previewFolderImport({ source: parent, kbRoot }),
    /contains the library root/,
  );
});

test('import refuses home, filesystem root, kb root, and sources already inside kb root', () => {
  const kbRoot = tmpDir('kb');
  const inside = path.join(kbRoot, 'space');
  fs.mkdirSync(inside);

  for (const source of [os.homedir(), path.parse(kbRoot).root, kbRoot, inside]) {
    assert.throws(
      () => previewFolderImport({ source, kbRoot }),
      /refusing|already inside the library/,
    );
  }
});
