import assert from 'node:assert/strict';
import test from 'node:test';
import {
  folderRefsEqual,
  isAbsoluteFolderRef,
  isFolderStillInLibrary,
  rebindFolderIfStillInLibrary,
} from '../folderPath';

test('initial window folder references recognize POSIX, drive, and UNC roots', () => {
  assert.equal(isAbsoluteFolderRef('/Users/example/Notes'), true);
  assert.equal(isAbsoluteFolderRef('C:/Users/example/Notes'), true);
  assert.equal(isAbsoluteFolderRef('C:\\Users\\example\\Notes'), true);
  assert.equal(isAbsoluteFolderRef('//server/share/Notes'), true);
  assert.equal(isAbsoluteFolderRef('\\\\server\\share\\Notes'), true);
  assert.equal(isAbsoluteFolderRef('Notes'), false);
});

test('folder references compare with Windows separator and case semantics', () => {
  assert.equal(folderRefsEqual('C:\\Users\\Ada\\Notes', 'c:/users/ada/notes'), true);
  assert.equal(folderRefsEqual('\\\\Server\\Share\\Notes', '//server/share/notes'), true);
  assert.equal(folderRefsEqual('/Users/Ada/Notes', '/users/ada/notes'), false);
});

test('removed folders are not eligible for automatic server-restart rebind', () => {
  const library = {
    recent: [
      { path: 'C:/Users/Ada/Notes', openedAt: '2026-01-01T00:00:00.000Z' },
    ],
  };
  assert.equal(isFolderStillInLibrary('c:\\users\\ada\\notes', library), true);
  assert.equal(isFolderStillInLibrary('C:/Users/Ada/Removed', library), false);
});

test('context recovery never reopens a folder removed by another window', async () => {
  let opens = 0;
  const result = await rebindFolderIfStillInLibrary('C:/Users/Ada/Removed', {
    getLibrary: async () => ({
      recent: [{ path: 'C:/Users/Ada/Notes', openedAt: '2026-01-01T00:00:00.000Z' }],
    }),
    openFolder: async () => {
      opens += 1;
      return { current: { path: 'unexpected' } };
    },
  });
  assert.equal(opens, 0);
  assert.equal(result.opened, null);
});

test('context recovery does not issue an old folder open after navigation changes during its library read', async () => {
  let resolveLibrary!: (library: { recent: { path: string }[] }) => void;
  const library = new Promise<{ recent: { path: string }[] }>((resolve) => { resolveLibrary = resolve; });
  let opens = 0;
  const recovery = rebindFolderIfStillInLibrary('/notes', {
    getLibrary: async () => library,
    shouldContinue: () => false,
    openFolder: async () => {
      opens += 1;
      return { current: { path: '/notes' } };
    },
  });
  resolveLibrary({ recent: [{ path: '/notes' }] });
  const result = await recovery;
  assert.equal(opens, 0);
  assert.equal(result.opened, null);
});
