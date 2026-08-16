import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCsvSource,
  deleteCsvRow,
  detectDelimiter,
  detectLineEnding,
  formatCellValue,
  insertCsvRow,
  matchingCsvCells,
  pasteCsvMatrix,
  replaceCsvCell,
  toColumnHeader,
} from '../components/csv/sourceModel';

test('detectDelimiter correctly identifies delimiters', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a|b|c\n1|2|3'), '|');
  // Handles delimiters inside quotes
  assert.equal(detectDelimiter('"a,b,c";"d,e,f"\n1;2'), ';');
});

test('detectLineEnding identifies line endings', () => {
  assert.equal(detectLineEnding('a,b\r\n1,2'), '\r\n');
  assert.equal(detectLineEnding('a,b\n1,2'), '\n');
  assert.equal(detectLineEnding('a,b\r1,2'), '\r');
});

test('toColumnHeader formats spreadsheet columns correctly', () => {
  assert.equal(toColumnHeader(0), 'A');
  assert.equal(toColumnHeader(25), 'Z');
  assert.equal(toColumnHeader(26), 'AA');
  assert.equal(toColumnHeader(27), 'AB');
  assert.equal(toColumnHeader(51), 'AZ');
  assert.equal(toColumnHeader(52), 'BA');
});

test('analyzeCsvSource parses standard and ragged CSV', () => {
  const source = 'name,age,city\nAlice,30,Paris\nBob,25';
  const analysis = analyzeCsvSource(source);
  assert.equal(analysis.ok, true);
  assert.equal(analysis.delimiter, ',');
  assert.equal(analysis.maxColumns, 3);
  assert.equal(analysis.rows.length, 3);
  assert.equal(analysis.rows[0].cells[0].value, 'name');
  assert.equal(analysis.rows[1].cells[2].value, 'Paris');
  assert.equal(analysis.rows[2].cells.length, 2);
});

test('analyzeCsvSource handles quoted fields with commas, newlines, and escaped quotes', () => {
  const source = 'id,summary\n1,"Hello, ""World""\nNew line"';
  const analysis = analyzeCsvSource(source);
  assert.equal(analysis.ok, true);
  assert.equal(analysis.rows.length, 2);
  assert.equal(analysis.rows[1].cells[1].value, 'Hello, "World"\nNew line');
  assert.equal(analysis.rows[1].cells[1].isQuoted, true);
});

test('analyzeCsvSource detects unclosed quotes', () => {
  const source = 'id,summary\n1,"Unclosed quote here';
  const analysis = analyzeCsvSource(source);
  assert.equal(analysis.ok, false);
  assert.match(analysis.error ?? '', /Unclosed quote/);
});

test('formatCellValue quotes when containing delimiters, newlines or quotes', () => {
  assert.equal(formatCellValue('hello', ','), 'hello');
  assert.equal(formatCellValue('hello,world', ','), '"hello,world"');
  assert.equal(formatCellValue('hello"world', ','), '"hello""world"');
  assert.equal(formatCellValue('hello\nworld', ','), '"hello\nworld"');
});

test('replaceCsvCell preserves source and BOM', () => {
  const source = '\uFEFFname,score\nAlice,100\nBob,95';
  const analysis = analyzeCsvSource(source);
  assert.equal(analysis.hasBom, true);

  const updated = replaceCsvCell(source, analysis, 1, 1, '105');
  assert.equal(updated, '\uFEFFname,score\nAlice,105\nBob,95');
  assert.equal(updated.startsWith('\uFEFF'), true);
});

test('replaceCsvCell extends columns when editing beyond ragged row length', () => {
  const source = 'a,b\n1';
  const analysis = analyzeCsvSource(source);
  const updated = replaceCsvCell(source, analysis, 1, 1, '2');
  assert.equal(updated, 'a,b\n1,2');
});

test('insertCsvRow inserts rows cleanly', () => {
  const source = 'name,age\nAlice,30';
  const analysis = analyzeCsvSource(source);

  const insertedMiddle = insertCsvRow(source, analysis, 1, ['Bob', '25']);
  assert.equal(insertedMiddle, 'name,age\nBob,25\nAlice,30');

  const insertedEnd = insertCsvRow(source, analysis, 2, ['Charlie', '35']);
  assert.equal(insertedEnd, 'name,age\nAlice,30\nCharlie,35\n');
});

test('deleteCsvRow removes rows cleanly', () => {
  const source = 'name,age\nAlice,30\nBob,25';
  const analysis = analyzeCsvSource(source);

  const deleted = deleteCsvRow(source, analysis, 1);
  assert.equal(deleted, 'name,age\nBob,25');
});

test('pasteCsvMatrix patches rectangular matrices', () => {
  const source = 'a,b,c\n1,2,3\n4,5,6';
  const analysis = analyzeCsvSource(source);

  const patched = pasteCsvMatrix(source, analysis, 1, 1, [
    ['20', '30'],
    ['50', '60'],
  ]);
  assert.equal(patched, 'a,b,c\n1,20,30\n4,50,60');
});

test('matchingCsvCells finds search matches with options', () => {
  const source = 'name,notes\nAlice,Likes cats\nBob,Likes dogs';
  const analysis = analyzeCsvSource(source);

  const matches = matchingCsvCells(analysis, 'Likes', { caseSensitive: true, wholeWord: false });
  assert.equal(matches.length, 2);
  assert.equal(matches[0].row, 1);
  assert.equal(matches[0].col, 1);
  assert.equal(matches[1].row, 2);
  assert.equal(matches[1].col, 1);
});
