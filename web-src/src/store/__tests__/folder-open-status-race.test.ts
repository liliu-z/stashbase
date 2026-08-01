import assert from 'node:assert/strict';
import test from 'node:test';
import { isCurrentIndexStatusPoll } from '../useSearchActions.ts';
import { initialState, reducer } from '../state.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('a stale Welcome index-status 412 cannot discard a successful folder open', async () => {
  // The initial active-folder poll starts on Welcome, before there is a
  // renderer folder. Hold that response while a newer open starts.
  const staleStatus = deferred<void>();
  const poll = { folderPathAtStart: '', openGenerationAtStart: 0 };
  let openGeneration = 0;
  let stale412Handled = false;
  const staleHandler = staleStatus.promise.then(() => {
    if (isCurrentIndexStatusPoll({
      ...poll,
      currentFolderPath: '',
      currentOpenGeneration: openGeneration,
    })) {
      stale412Handled = true;
      openGeneration += 1;
    }
  });

  // POST /api/folder has begun and received a successful response. Its
  // continuation is still entitled to commit the selected renderer folder.
  const openGenerationForSelectedFolder = ++openGeneration;
  staleStatus.resolve();
  await staleHandler;

  assert.equal(stale412Handled, false);
  assert.equal(openGeneration, openGenerationForSelectedFolder);

  let state = reducer(initialState, {
    type: 'FILES_LOADED',
    files: [],
    folders: [],
    folder: 'Selected',
    folderPath: '/selected',
  });
  state = reducer(state, { type: 'WELCOME_HIDE' });
  assert.equal(state.folderPath, '/selected');
  assert.equal(state.welcomeVisible, false);
});

test('index-status polling only accepts a committed folder from the same navigation generation', () => {
  assert.equal(isCurrentIndexStatusPoll({
    folderPathAtStart: '/notes',
    currentFolderPath: '/notes',
    openGenerationAtStart: 4,
    currentOpenGeneration: 4,
  }), true);
  assert.equal(isCurrentIndexStatusPoll({
    folderPathAtStart: '/notes',
    currentFolderPath: '/notes',
    openGenerationAtStart: 4,
    currentOpenGeneration: 5,
  }), false);
  assert.equal(isCurrentIndexStatusPoll({
    folderPathAtStart: '',
    currentFolderPath: '',
    openGenerationAtStart: 4,
    currentOpenGeneration: 4,
  }), false);
});
