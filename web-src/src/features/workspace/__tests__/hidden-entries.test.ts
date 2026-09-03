/**
 * Hidden-directory presentation and the FILES_LOADED carrier of the
 * server-owned Show Hidden Files preference. The classification itself is
 * server-owned (`server/__tests__/file-listing.test.ts`); the renderer only
 * marks hidden rows and tracks the effective flag each listing reports.
 * See `code-review/renderer-workspace.md`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, reducer, type State } from '@/store/state/state';
import { isHiddenEntryPath } from '@/features/workspace/lib/fileTreeModel';
import { rankQuickOpen } from '@/common/lib/quickOpen';

test('isHiddenEntryPath marks dot-directory namespaces but never ordinary dotfiles', () => {
  // Ordinary dotfiles keep their current, unmarked presentation.
  assert.equal(isHiddenEntryPath('.env', 'file'), false);
  assert.equal(isHiddenEntryPath('docs/.gitignore', 'file'), false);
  // Hidden directories and everything beneath them are marked.
  assert.equal(isHiddenEntryPath('.github', 'folder'), true);
  assert.equal(isHiddenEntryPath('.github/workflows', 'folder'), true);
  assert.equal(isHiddenEntryPath('.github/workflows/ci.yml', 'file'), true);
  assert.equal(isHiddenEntryPath('project/.vscode/settings.json', 'file'), true);
  // Ordinary content stays unmarked.
  assert.equal(isHiddenEntryPath('docs', 'folder'), false);
  assert.equal(isHiddenEntryPath('docs/note.md', 'file'), false);
});

test('FILES_LOADED applies the listing-reported visibility and keeps it across local patches', () => {
  const base: State = initialState;
  assert.equal(base.workspace.showHiddenFiles, false);

  // A server listing that reports the preference applies it.
  let state = reducer(base, {
    type: 'FILES_LOADED',
    files: [],
    folders: [],
    folder: 'notes',
    folderPath: '/notes',
    showHiddenFiles: true,
  });
  assert.equal(state.workspace.showHiddenFiles, true);

  // An optimistic local FILES_LOADED patch (delete/rename flows) does not
  // carry the flag and must not reset it.
  state = reducer(state, {
    type: 'FILES_LOADED',
    files: [],
    folders: [],
    folder: 'notes',
    folderPath: '/notes',
  });
  assert.equal(state.workspace.showHiddenFiles, true);

  // The next authoritative listing can turn it back off.
  state = reducer(state, {
    type: 'FILES_LOADED',
    files: [],
    folders: [],
    folder: 'notes',
    folderPath: '/notes',
    showHiddenFiles: false,
  });
  assert.equal(state.workspace.showHiddenFiles, false);
});

test('turning hidden files off prunes tree-only state without closing retained tabs', () => {
  const hiddenFile = {
    name: '.github/README.md',
    content: '# CI',
    format: 'md' as const,
  };
  let state = reducer(initialState, {
    type: 'FILES_LOADED',
    files: [{ name: hiddenFile.name, format: 'md', size: 4, heading: 'CI', snippet: '', imported_at: '' }],
    folders: [{ path: '.github' }],
    folder: 'notes',
    folderPath: '/notes',
    showHiddenFiles: true,
  });
  state = reducer(state, { type: 'FILE_OPEN', body: hiddenFile });
  state = reducer(state, { type: 'EXPAND_FOLDER', path: '.github' });
  state = reducer(state, { type: 'SELECT_PATH', path: hiddenFile.name });

  const visibleQuickOpen = rankQuickOpen(
    state.workspace.files.map((file) => file.name),
    '',
    state.workspace.recentFilePaths,
  );
  assert.deepEqual(visibleQuickOpen.map((item) => item.path), [hiddenFile.name]);

  state = reducer(state, {
    type: 'FILES_LOADED',
    files: [],
    folders: [],
    folder: 'notes',
    folderPath: '/notes',
    showHiddenFiles: false,
  });

  assert.deepEqual(state.workspace.expanded, {});
  assert.equal(state.workspace.selectedPath, '');
  assert.equal(state.workspace.activeFolder, '');
  assert.equal(state.workspace.tabs.length, 1);
  assert.equal(state.workspace.tabs[0]?.file?.name, hiddenFile.name);
  const hiddenQuickOpen = rankQuickOpen(
    state.workspace.files.map((file) => file.name),
    '',
    state.workspace.recentFilePaths,
  );
  assert.deepEqual(hiddenQuickOpen, [], 'Quick Open consumes the pruned tree listing, not retained tabs');
});
