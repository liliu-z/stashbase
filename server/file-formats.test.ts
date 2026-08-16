import assert from 'node:assert/strict';
import test from 'node:test';
import { DIRECT_TEXT_EXTENSIONS, NOTE_EXTENSIONS, STRUCTURED_DATA_EXTENSIONS, VIEWABLE_FILE_EXTENSIONS } from '../shared/file-formats.ts';
import { detectFormat, isConvertibleSource, isNoteName, matchNoteStem } from './format.ts';
import { hasCompatibleRenameExtension } from './routes/file-mutations.ts';

test('JSON is direct readable text without acquiring note or conversion behavior', () => {
  assert.ok(STRUCTURED_DATA_EXTENSIONS.includes('json'));
  assert.ok(DIRECT_TEXT_EXTENSIONS.includes('json'));
  assert.ok(VIEWABLE_FILE_EXTENSIONS.includes('json'));
  assert.equal((NOTE_EXTENSIONS as readonly string[]).includes('json'), false);
  assert.equal(detectFormat('nested/data.JSON'), 'json');
  assert.equal(detectFormat('C:\\Library\\nested\\data.JsOn'), 'json');
  assert.equal(isNoteName('data.json'), false);
  assert.equal(matchNoteStem('data.json'), null);
  assert.equal(isConvertibleSource('data.json'), false);
});

test('CSV is direct readable text without acquiring note or conversion behavior', () => {
  assert.ok(STRUCTURED_DATA_EXTENSIONS.includes('csv'));
  assert.ok(DIRECT_TEXT_EXTENSIONS.includes('csv'));
  assert.ok(VIEWABLE_FILE_EXTENSIONS.includes('csv'));
  assert.equal((NOTE_EXTENSIONS as readonly string[]).includes('csv'), false);
  assert.equal(detectFormat('nested/table.CSV'), 'csv');
  assert.equal(detectFormat('C:\\Library\\nested\\table.CsV'), 'csv');
  assert.equal(isNoteName('table.csv'), false);
  assert.equal(matchNoteStem('table.csv'), null);
  assert.equal(isConvertibleSource('table.csv'), false);
});

test('JSON and CSV keep their extensions without regressing Markdown and HTML cross-format renames', () => {
  assert.equal(hasCompatibleRenameExtension('json', 'json', 'renamed.JSON'), true);
  assert.equal(hasCompatibleRenameExtension('json', 'json', 'renamed.html'), false);
  assert.equal(hasCompatibleRenameExtension('csv', 'csv', 'renamed.CSV'), true);
  assert.equal(hasCompatibleRenameExtension('csv', 'csv', 'renamed.json'), false);
  assert.equal(hasCompatibleRenameExtension('md', 'md', 'renamed.html'), true);
  assert.equal(hasCompatibleRenameExtension('html', 'html', 'renamed.md'), true);
});
