import assert from 'node:assert/strict';
import test from 'node:test';
import { preparationWaitCopy } from '../preparation-copy.ts';

test('wait copy keeps output-specific wording when work can start immediately', () => {
  assert.equal(preparationWaitCopy('transcript', 0), 'Waiting to transcribe…');
  assert.equal(
    preparationWaitCopy('audio-preview', 0),
    'Waiting to prepare a compatible preview…',
  );
  assert.equal(
    preparationWaitCopy('searchable-text', 0),
    'Waiting to prepare searchable text…',
  );
});

test('wait copy explains the wait without exposing scheduler lanes or position', () => {
  assert.equal(
    preparationWaitCopy('transcript', 1),
    'Waiting for other file preparation to finish…',
  );
});

test('wait copy stays stable when the number of files ahead changes', () => {
  assert.equal(
    preparationWaitCopy('searchable-text', 2),
    'Waiting for other file preparation to finish…',
  );
  assert.equal(
    preparationWaitCopy('audio-preview', 8),
    'Waiting for other file preparation to finish…',
  );
});
