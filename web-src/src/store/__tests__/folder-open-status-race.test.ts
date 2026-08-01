import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { api, ApiError } from '../../api.ts';
import { createFolderMutationQueue } from '../../folderTransition.ts';
import { useFolderActions } from '../useFolderActions.ts';
import { isCurrentIndexStatusPoll, useSearchActions } from '../useSearchActions.ts';
import { initialState, reducer, type Action, type State } from '../state.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function freshState(overrides: Partial<State> = {}): State {
  return {
    ...initialState,
    tabs: [],
    chatTabs: [],
    chatTabRecencyByAgent: {},
    expanded: new Set(),
    pendingSemanticNames: new Set(),
    fileOrder: {},
    ...overrides,
  };
}

function createActionHarness(initial: State) {
  let current = initial;
  const stateRef = { current };
  const pollTimer = { current: null as ReturnType<typeof setTimeout> | null };
  const openGeneration = { current: 0 };
  const folderMutations = { current: createFolderMutationQueue() };
  const dispatch = (action: Action) => {
    current = reducer(current, action);
    stateRef.current = current;
  };
  let searchActions!: ReturnType<typeof useSearchActions>;
  let folderActions!: ReturnType<typeof useFolderActions>;

  function Harness() {
    searchActions = useSearchActions({
      stateRef,
      pollTimer,
      searchGeneration: { current: 0 },
      syncGeneration: { current: 0 },
      openGeneration,
      lastTreeVersion: { current: -1 },
      importConversionGrace: { current: new Map() },
      importIndexGrace: { current: new Map() },
      keyBackfillGrace: { current: new Map() },
      folderMutations,
    }, {
      loadFiles: async () => [],
      loadFilesFromServer: async () => [],
      refreshActiveTabFromDisk: async () => {},
      toast: () => '',
    }, dispatch);
    folderActions = useFolderActions({
      state: stateRef,
      editor: { current: null },
      openGeneration,
      syncGeneration: { current: 0 },
      searchGeneration: { current: 0 },
      lastTreeVersion: { current: -1 },
      importConversionGrace: { current: new Map() },
      importIndexGrace: { current: new Map() },
      keyBackfillGrace: { current: new Map() },
      // The real provider shares this queue across both hooks. The harness
      // does too so it exercises the same recovery/open ordering.
      folderMutations,
    }, {
      flushSave: async () => true,
      loadFiles: async () => [],
      loadFileOrder: async () => {},
      markVisibleFilesPendingForSearch: async () => {},
      refreshIndexState: (...args) => searchActions.refreshIndexState(...args),
      toast: () => '',
    }, dispatch);
    return null;
  }

  renderToStaticMarkup(createElement(Harness));
  return {
    get state() { return current; },
    searchActions,
    folderActions,
    clearTimer: () => { if (pollTimer.current) clearTimeout(pollTimer.current); },
  };
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

test('the real status and folder-open actions ignore a stale 412 and commit the selected folder', async () => {
  const originalIndexStatus = api.indexStatus;
  const originalOpenFolder = api.openFolder;
  const originalGetFolder = api.getFolder;
  const originalSetTimeout = global.setTimeout;
  const staleStatus = deferred<never>();
  const selectedFolder = deferred<{ current: { path: string; name: string }; recent: [] }>();
  let indexStatusCalls = 0;
  try {
    // The tested open schedules a later status refresh. Keep that unrelated
    // timer out of this deterministic interleaving.
    global.setTimeout = (() => ({}) as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout;
    api.indexStatus = (() => {
      indexStatusCalls += 1;
      return staleStatus.promise;
    }) as typeof api.indexStatus;
    api.openFolder = (() => selectedFolder.promise) as typeof api.openFolder;
    api.getFolder = (async () => ({ current: null, recent: [] })) as typeof api.getFolder;

    const welcome = createActionHarness(freshState());
    await welcome.searchActions.refreshIndexState();
    assert.equal(indexStatusCalls, 0, 'Welcome must not start active-folder polling');

    const harness = createActionHarness(freshState({
      folder: 'Previous',
      folderPath: '/previous',
      welcomeVisible: false,
    }));
    const poll = harness.searchActions.refreshIndexState();
    await Promise.resolve();
    assert.equal(indexStatusCalls, 1);

    const open = harness.folderActions.openFolder('/selected');
    await Promise.resolve();
    staleStatus.reject(new ApiError('no folder', 412, 'NO_FOLDER'));
    await poll;
    selectedFolder.resolve({ current: { path: '/selected', name: 'Selected' }, recent: [] });
    await open;

    assert.equal(harness.state.folderPath, '/selected');
    assert.equal(harness.state.welcomeVisible, false);
  } finally {
    api.indexStatus = originalIndexStatus;
    api.openFolder = originalOpenFolder;
    api.getFolder = originalGetFolder;
    global.setTimeout = originalSetTimeout;
  }
});

test('a recovery that becomes stale during its library read cannot rebind over a newer open', async () => {
  const originalIndexStatus = api.indexStatus;
  const originalOpenFolder = api.openFolder;
  const originalGetFolder = api.getFolder;
  const originalSetTimeout = global.setTimeout;
  const library = deferred<{ current: null; recent: { path: string; openedAt: string }[] }>();
  const selectedFolder = deferred<{ current: { path: string; name: string }; recent: [] }>();
  const opens: string[] = [];
  let libraryCalls = 0;
  try {
    global.setTimeout = (() => ({}) as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout;
    api.indexStatus = (async () => {
      throw new ApiError('no folder', 412, 'NO_FOLDER');
    }) as typeof api.indexStatus;
    api.getFolder = (() => {
      libraryCalls += 1;
      return libraryCalls === 1
        ? library.promise
        : Promise.resolve({ current: null, recent: [] });
    }) as typeof api.getFolder;
    api.openFolder = ((path: string) => {
      opens.push(path);
      if (path === '/selected') return selectedFolder.promise;
      throw new Error(`unexpected stale recovery open: ${path}`);
    }) as typeof api.openFolder;

    const harness = createActionHarness(freshState({
      folder: 'Previous',
      folderPath: '/previous',
      welcomeVisible: false,
    }));
    const recovery = harness.searchActions.refreshIndexState();
    await Promise.resolve();
    assert.equal(libraryCalls, 1);

    const open = harness.folderActions.openFolder('/selected');
    await Promise.resolve();
    selectedFolder.resolve({ current: { path: '/selected', name: 'Selected' }, recent: [] });
    await open;
    library.resolve({
      current: null,
      recent: [{ path: '/previous', openedAt: '2026-08-01T00:00:00.000Z' }],
    });
    await recovery;

    assert.deepEqual(opens, ['/selected']);
    assert.equal(harness.state.folderPath, '/selected');
    assert.equal(harness.state.welcomeVisible, false);
  } finally {
    api.indexStatus = originalIndexStatus;
    api.openFolder = originalOpenFolder;
    api.getFolder = originalGetFolder;
    global.setTimeout = originalSetTimeout;
  }
});
