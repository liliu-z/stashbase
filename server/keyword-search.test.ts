import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { matchesSearchTypes, searchExtensionsForTypes } from './format.ts';
import {
  audioTimestampForTranscriptLine,
  hasWholeTokenBoundaries,
  normalizeRipgrepSubmatches,
  resolveSpawnableRipgrepPath,
  snippetForLine,
} from './keyword-search.ts';

test('ripgrep byte offsets map to UTF-16 ranges for multibyte text', () => {
  const line = '前缀 alpha 结果';
  const start = Buffer.byteLength('前缀 ', 'utf8');
  const end = start + Buffer.byteLength('alpha', 'utf8');

  assert.deepEqual(normalizeRipgrepSubmatches(line, [{ start, end }]), [[3, 8]]);
});

test('whole-token matching treats CJK letters and underscores as word chars', () => {
  assert.equal(hasWholeTokenBoundaries('alpha beta', 0, 5), true);
  assert.equal(hasWholeTokenBoundaries('prealpha beta', 3, 8), false);
  assert.equal(hasWholeTokenBoundaries('alpha_beta', 0, 5), false);
  assert.equal(hasWholeTokenBoundaries('中文结果', 0, 2), false);
});

test('keyword snippets keep highlighted ranges inside the visible window', () => {
  const line = `${'a'.repeat(260)}MATCH${'b'.repeat(260)}`;
  const snippet = snippetForLine(line, [[260, 265]]);

  assert.ok(snippet.text.startsWith('…'));
  assert.ok(snippet.text.endsWith('…'));
  assert.equal(snippet.text.slice(snippet.ranges[0][0], snippet.ranges[0][1]), 'MATCH');
});

test('audio keyword snippets retain their exact timestamp when the match is far into a long line', () => {
  const prefix = '- [00:01:35.250] ';
  const line = `${prefix}${'context '.repeat(50)}REPEATED PHRASE`;
  const start = line.indexOf('REPEATED PHRASE');
  const snippet = snippetForLine(line, [[start, start + 'REPEATED PHRASE'.length]]);

  assert.ok(snippet.text.startsWith(`${prefix.trimEnd()} … `));
  assert.equal(
    snippet.text.slice(snippet.ranges[0][0], snippet.ranges[0][1]),
    'REPEATED PHRASE',
  );
  assert.equal(audioTimestampForTranscriptLine(line), 95_250);
});

test('packaged ripgrep path prefers app.asar.unpacked when present', () => {
  const candidate = path.join('/tmp', 'App.app', 'Contents', 'Resources', 'app.asar', 'node_modules', 'rg');

  assert.equal(resolveSpawnableRipgrepPath(candidate), candidate);
});

test('search type categories map to source extensions', () => {
  assert.deepEqual(searchExtensionsForTypes(['pdf']), ['.pdf']);
  assert.deepEqual(searchExtensionsForTypes(['notes']), ['.md', '.markdown', '.html', '.htm']);
  assert.deepEqual(searchExtensionsForTypes(['docx', 'docx']), ['.docx']);
  assert.deepEqual(
    searchExtensionsForTypes(['audio']),
    ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.opus', '.aac', '.aiff', '.aif'],
  );
  assert.equal(searchExtensionsForTypes([]), null);
  assert.equal(searchExtensionsForTypes(['notes', 'pdf', 'image', 'docx', 'audio']), null);
});

test('type membership checks extensions case-insensitively', () => {
  assert.equal(matchesSearchTypes('a/Report.PDF', ['pdf']), true);
  assert.equal(matchesSearchTypes('a/report.pdf', ['notes']), false);
  assert.equal(matchesSearchTypes('shot.jpeg', ['image']), true);
  assert.equal(matchesSearchTypes('doc.docx', ['pdf', 'docx']), true);
  assert.equal(matchesSearchTypes('meeting.M4A', ['audio']), true);
  assert.equal(matchesSearchTypes('meeting.m4a', ['docx']), false);
  assert.equal(matchesSearchTypes('note.md', []), true);
});
