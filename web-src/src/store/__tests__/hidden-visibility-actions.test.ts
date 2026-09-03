import assert from 'node:assert/strict';
import test from 'node:test';
import React, { useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { api, type IndexStatus } from '@/common/api/api';
import { useFileActions } from '@/store/hooks/useFileActions';
import { useSearchActions } from '@/store/hooks/useSearchActions';
import { initialState, type Action, type State, type WorkspaceSlice } from '@/store/state/state';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  assert.fail('condition did not settle');
}

function HiddenVisibilityHarness({
  onRender,
  loadFiles,
  toast,
}: {
  onRender: (actions: ReturnType<typeof useFileActions>) => void;
  loadFiles: (folder?: string) => Promise<WorkspaceSlice['files']>;
  toast: (message: string) => string;
}) {
  const stateRef = useRef<State>({
    ...initialState,
    workspace: { ...initialState.workspace, folder: 'notes', folderPath: '/notes' },
  });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const importConversionGrace = useRef(new Map<string, number>());
  const importIndexGrace = useRef(new Map<string, number>());
  const actions = useFileActions(
    { stateRef, saveTimer, importConversionGrace, importIndexGrace },
    {
      askCascadeForRename: async () => false,
      askConfirm: async () => false,
      flushSave: async () => true,
      loadFiles,
      openInNewTab: async () => undefined,
      refreshIndexState: async () => undefined,
      toast,
    },
    (_action: Action) => undefined,
  );
  onRender(actions);
  return React.createElement('span');
}

function CrossWindowRefreshHarness({
  lastTreeVersion,
  onRender,
  onListingRefresh,
  pollTimer,
}: {
  lastTreeVersion: React.MutableRefObject<number>;
  onRender: (actions: ReturnType<typeof useSearchActions>) => void;
  onListingRefresh: (folder: string | undefined) => void;
  pollTimer: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
}) {
  const stateRef = useRef<State>({
    ...initialState,
    workspace: { ...initialState.workspace, folder: 'notes', folderPath: '/notes' },
  });
  const folderContextPath = useRef('/notes');
  const syncGeneration = useRef(0);
  const openGeneration = useRef(0);
  const openingFolderGeneration = useRef<number | null>(null);
  const importConversionGrace = useRef(new Map<string, number>());
  const importIndexGrace = useRef(new Map<string, number>());
  const keyBackfillGrace = useRef(new Map<string, number>());
  const actions = useSearchActions(
    {
      stateRef,
      folderContextPath,
      pollTimer,
      syncGeneration,
      openGeneration,
      openingFolderGeneration,
      lastTreeVersion,
      importConversionGrace,
      importIndexGrace,
      keyBackfillGrace,
    },
    {
      loadFiles: async () => [],
      loadFilesFromServer: async (folder) => {
        onListingRefresh(folder);
        return { files: [], isCurrent: () => true };
      },
      refreshActiveTabFromDisk: async () => undefined,
      toast: () => 'toast',
    },
    (_action: Action) => undefined,
  );
  onRender(actions);
  return React.createElement('span');
}

const settledIndexStatus = (treeVersion: number): IndexStatus => ({
  folder: '/notes',
  total: 0,
  indexed: 0,
  pending: [],
  pendingCount: 0,
  orphaned: [],
  orphanedCount: 0,
  upToDate: true,
  semanticEnabled: false,
  semanticAvailable: false,
  visibleIndexingSettled: true,
  semanticIndexing: { state: 'disabled' },
  indexReady: true,
  pendingConversions: [],
  blockedConversions: [],
  conversionProgress: {},
  conversionRevision: 0,
  conversionVersions: {},
  preparationFailures: [],
  treeVersion,
  indexWarning: null,
});

test('rapid hidden-file toggles serialize opposite durable intents and reload only the final state', async () => {
  const originalFetch = globalThis.fetch;
  const responses = [deferred<Response>(), deferred<Response>()];
  const writes: boolean[] = [];
  let calls = 0;
  let reloads = 0;
  let actions!: ReturnType<typeof useFileActions>;
  let renderer: ReactTestRenderer | undefined;
  try {
    globalThis.fetch = (async (_input, init) => {
      writes.push(JSON.parse(String(init?.body)).showHiddenFiles);
      return responses[calls++]!.promise;
    }) as typeof fetch;
    await act(async () => {
      renderer = create(React.createElement(HiddenVisibilityHarness, {
        onRender: (next) => { actions = next; },
        loadFiles: async () => { reloads += 1; return []; },
        toast: () => 'toast',
      }));
    });

    const first = actions.toggleShowHiddenFiles();
    const second = actions.toggleShowHiddenFiles();
    await Promise.resolve();
    assert.deepEqual(writes, [true], 'the second write waits for the first');
    responses[0]!.resolve(new Response(JSON.stringify({ showHiddenFiles: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    await waitFor(() => writes.length === 2);
    assert.deepEqual(writes, [true, false], 'the second click reverses the pending intent');
    responses[1]!.resolve(new Response(JSON.stringify({ showHiddenFiles: false }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    await Promise.all([first, second]);
    assert.equal(reloads, 1, 'only the final successful intent reloads server truth');
  } finally {
    globalThis.fetch = originalFetch;
    const mounted = renderer;
    if (mounted) await act(async () => mounted.unmount());
  }
});

test('a failed hidden-file write reports the error and reloads authoritative server state', async () => {
  const originalFetch = globalThis.fetch;
  const toasts: string[] = [];
  let reloads = 0;
  let actions!: ReturnType<typeof useFileActions>;
  let renderer: ReactTestRenderer | undefined;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'config is read-only' }), {
      status: 500, headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    await act(async () => {
      renderer = create(React.createElement(HiddenVisibilityHarness, {
        onRender: (next) => { actions = next; },
        loadFiles: async () => { reloads += 1; return []; },
        toast: (message) => { toasts.push(message); return 'toast'; },
      }));
    });
    await actions.toggleShowHiddenFiles();
    assert.equal(reloads, 1);
    assert.match(toasts[0] ?? '', /Failed to update hidden files preference/);
  } finally {
    globalThis.fetch = originalFetch;
    const mounted = renderer;
    if (mounted) await act(async () => mounted.unmount());
  }
});

test('a tree-version bump from another window refreshes this window visible listing', async (t) => {
  t.mock.method(api, 'indexStatus', async () => settledIndexStatus(42));
  const lastTreeVersion = { current: 41 };
  const pollTimer = { current: null as ReturnType<typeof setTimeout> | null };
  const refreshedFolders: Array<string | undefined> = [];
  let actions!: ReturnType<typeof useSearchActions>;
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(CrossWindowRefreshHarness, {
        lastTreeVersion,
        pollTimer,
        onRender: (next) => { actions = next; },
        onListingRefresh: (folder) => { refreshedFolders.push(folder); },
      }));
    });

    await actions.refreshIndexState();
    await waitFor(() => refreshedFolders.length === 1);
    assert.deepEqual(refreshedFolders, ['/notes']);
    assert.equal(lastTreeVersion.current, 42);
  } finally {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    const mounted = renderer;
    if (mounted) await act(async () => mounted.unmount());
  }
});
