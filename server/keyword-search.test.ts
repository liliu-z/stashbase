import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { matchesSearchTypes, searchExtensionsForTypes } from './format.ts';
import {
  audioTimestampForTranscriptLine,
  hasWholeTokenBoundaries,
  normalizeRipgrepSubmatches,
  normalizeRipgrepPath,
  resolveSpawnableRipgrepPath,
  runKeywordSearch,
  snippetForLine,
} from './keyword-search.ts';

test('ripgrep paths use one folder-relative identity on POSIX and Windows', () => {
  assert.equal(normalizeRipgrepPath('./data.JSON'), 'data.JSON');
  assert.equal(normalizeRipgrepPath('.\\data.JSON'), 'data.JSON');
  assert.equal(normalizeRipgrepPath('nested\\data.JSON'), 'nested/data.JSON');
});

test('keyword search includes malformed case-variant JSON and applies data before limits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-json-search-'));
  try {
    fs.writeFileSync(path.join(root, 'note.md'), 'needle in note');
    fs.writeFileSync(path.join(root, 'data.JSON'), '{"needle": broken');
    const all = await runKeywordSearch('needle', root, { caseStrict: false, wholeWord: false });
    assert.deepEqual(all.files.map((file) => file.path).sort(), ['data.JSON', 'note.md']);
    const data = await runKeywordSearch('needle', root, { caseStrict: false, wholeWord: false, types: ['data'] });
    assert.deepEqual(data.files.map((file) => file.path), ['data.JSON']);
    const notes = await runKeywordSearch('needle', root, { caseStrict: false, wholeWord: false, types: ['notes'] });
    assert.deepEqual(notes.files.map((file) => file.path), ['note.md']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('whole-word keyword search finds a match past the per-file substring cap', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-whole-word-cap-'));
  try {
    const lines = Array.from({ length: 60 }, (_, index) => `row ${index} mentions agents here`);
    lines.push('the final line names one agent alone');
    fs.writeFileSync(path.join(root, 'note.md'), `${lines.join('\n')}\n`);

    const result = await runKeywordSearch('agent', root, { caseStrict: false, wholeWord: true });

    assert.deepEqual(result.files.map((file) => file.path), ['note.md']);
    assert.deepEqual(result.files[0].matches.map((match) => match.line), [61]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('whole-word keyword search streams substring-heavy files before filtering', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-whole-word-stream-'));
  try {
    fs.writeFileSync(path.join(root, 'note.md'), `${'agents\n'.repeat(250_000)}agent\n`);

    const result = await runKeywordSearch('agent', root, { caseStrict: false, wholeWord: true });

    assert.deepEqual(result.files.map((file) => file.path), ['note.md']);
    assert.deepEqual(result.files[0].matches.map((match) => match.line), [250_001]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('whole-word keyword search caps matches per file and reports the truncation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-whole-word-truncated-'));
  try {
    const lines = Array.from({ length: 60 }, (_, index) => `row ${index} names one agent alone`);
    fs.writeFileSync(path.join(root, 'note.md'), `${lines.join('\n')}\n`);

    const result = await runKeywordSearch('agent', root, { caseStrict: false, wholeWord: true });

    assert.equal(result.files[0].matches.length, 50);
    assert.equal(result.truncated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('whole-word keyword search caps ranges within one matching line', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-whole-word-range-cap-'));
  try {
    fs.writeFileSync(path.join(root, 'note.md'), `${Array.from({ length: 60 }, () => 'agent').join(' ')}\n`);

    const result = await runKeywordSearch('agent', root, { caseStrict: false, wholeWord: true });

    assert.equal(result.files[0].totalMatches, 50);
    assert.equal(result.files[0].matches.length, 1);
    assert.equal(result.truncated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
  assert.deepEqual(searchExtensionsForTypes(['data']), ['.json', '.csv']);
  assert.deepEqual(searchExtensionsForTypes(['docx', 'docx']), ['.docx']);
  assert.deepEqual(
    searchExtensionsForTypes(['audio']),
    [
      '.mp3', '.wav', '.m4a', '.flac', '.ogg', '.opus', '.aac', '.aiff', '.aif',
      '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi',
    ],
  );
  assert.equal(searchExtensionsForTypes([]), null);
  assert.equal(searchExtensionsForTypes(['notes', 'data', 'pdf', 'image', 'docx', 'audio']), null);
});

test('type membership checks extensions case-insensitively', () => {
  assert.equal(matchesSearchTypes('a/Report.PDF', ['pdf']), true);
  assert.equal(matchesSearchTypes('a/report.pdf', ['notes']), false);
  assert.equal(matchesSearchTypes('shot.jpeg', ['image']), true);
  assert.equal(matchesSearchTypes('doc.docx', ['pdf', 'docx']), true);
  assert.equal(matchesSearchTypes('meeting.M4A', ['audio']), true);
  assert.equal(matchesSearchTypes('clip.MOV', ['audio']), true);
  assert.equal(matchesSearchTypes('meeting.m4a', ['docx']), false);
  assert.equal(matchesSearchTypes('note.md', []), true);
  assert.equal(matchesSearchTypes('nested/Data.JSON', ['data']), true);
  assert.equal(matchesSearchTypes('nested/Data.JSON', ['notes']), false);
});
