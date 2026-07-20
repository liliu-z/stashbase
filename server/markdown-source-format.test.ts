import assert from 'node:assert/strict';
import test from 'node:test';
import { preserveMarkdownSourceFormat } from './markdown-source-format.ts';

test('preserves BOM and uniform CRLF while serializing an edited Markdown note', () => {
  assert.equal(
    preserveMarkdownSourceFormat('\uFEFF# Title\r\n\r\nBody\r\n', '# Title\n\nEdited\n'),
    '\uFEFF# Title\r\n\r\nEdited\r\n',
  );
});

test('preserves uniform LF and normalizes mixed endings only on a save', () => {
  assert.equal(
    preserveMarkdownSourceFormat('one\ntwo\n', 'one\ntwo\nthree\n'),
    'one\ntwo\nthree\n',
  );
  assert.equal(
    preserveMarkdownSourceFormat('one\r\ntwo\r\nthree\n', 'one\ntwo\nthree\nfour\n'),
    'one\r\ntwo\r\nthree\r\nfour\r\n',
  );
});

test('does not rewrite source text that has no line-ending convention', () => {
  assert.equal(preserveMarkdownSourceFormat('plain source', 'changed source'), 'changed source');
});
