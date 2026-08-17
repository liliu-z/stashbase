import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConflictMarkerDraft, computeLineDiff } from '../conflictDiff';

test('conflict comparison keeps common context and aligns the changed middle', () => {
  const rows = computeLineDiff(
    'shared\neditor one\neditor two\ntail',
    'shared\ndisk one\ntail',
  );

  assert.deepEqual(rows, [
    { editorLineNumber: 1, editorText: 'shared', diskLineNumber: 1, diskText: 'shared', type: 'equal' },
    { editorLineNumber: 2, editorText: 'editor one', diskLineNumber: 2, diskText: 'disk one', type: 'modify' },
    { editorLineNumber: 3, editorText: 'editor two', diskLineNumber: undefined, diskText: undefined, type: 'delete' },
    { editorLineNumber: 4, editorText: 'tail', diskLineNumber: 3, diskText: 'tail', type: 'equal' },
  ]);
});

test('merge draft preserves both changed blocks between conflict markers', () => {
  assert.equal(
    buildConflictMarkerDraft('shared\neditor\ntail', 'shared\ndisk\ntail'),
    [
      'shared',
      '<<<<<<< Editor Version',
      'editor',
      '=======',
      'disk',
      '>>>>>>> Disk Version',
      'tail',
    ].join('\n'),
  );
});

test('conflict comparison remains linear-sized for large documents', () => {
  const editor = Array.from({ length: 10_000 }, (_, index) => `editor ${index}`).join('\n');
  const disk = Array.from({ length: 10_000 }, (_, index) => `disk ${index}`).join('\n');
  const rows = computeLineDiff(editor, disk);

  assert.equal(rows.length, 10_000);
  assert.equal(rows.every((row) => row.type === 'modify'), true);
});
