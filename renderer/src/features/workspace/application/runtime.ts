import { createStore, type StoreApi } from 'zustand/vanilla';

import type { WorkspaceQueryScope } from '@/features/workspace/application/ports';
import type { ActiveProjectFolder } from '@/features/workspace/domain/project';
import type { FolderSessionState } from '@/features/workspace/domain/session';
import {
  createWorkspaceState,
  disposeWorkspaceState,
  collapseAllTreeFolders,
  requestTreeCreate,
  revealTreePath,
  selectTreePath,
  type TreeCreateRequest,
  type WorkspaceScope,
  type WorkspaceState,
} from '@/features/workspace/domain/workspace';
import { createScopeGuard, type CapturedScope } from '@/shared/runtime/scope-guard';

/** What one workspace operation was started under: the folder scope, and the
 *  generation of operations live at the time. */
export type WorkspaceOperationScope = CapturedScope<WorkspaceScope>;

export interface WorkspaceRuntime {
  readonly scope: WorkspaceScope;
  readonly signal: AbortSignal;
  readonly store: StoreApi<WorkspaceState>;
  /** Runs `completion` only when the operation `captured` was started under is
   *  still the live one: same folder scope, no newer retirement, and a runtime
   *  that has not been disposed. Answers whether it ran, so a caller can drop
   *  the rest of a stale completion too. */
  accept(captured: WorkspaceOperationScope, completion: () => void): boolean;
  /** The token an operation is started under. Take it before the operation's
   *  first `await` and hand it back to `accept` afterwards: capturing at
   *  completion time would compare the live scope with itself and guard
   *  nothing. */
  capture(): WorkspaceOperationScope;
  dispose(): void;
  /** Asks the folder's tree to start naming a new entry. The tree decides
   *  where, beside its selection, and takes the request up when it is on
   *  screen. */
  /** Folds every folder in the tree. */
  collapseAll(): void;
  requestCreate(kind: TreeCreateRequest['kind']): void;
  retire(): void;
  /** Retires every operation in flight, so their completions are refused. The
   *  folder itself stays open: rebinding it re-reads the tree from scratch, and
   *  a completion aimed at the tree before that is no longer about this one. */
  retireOperations(): void;
  /** Selects `path`, opens the folders above it, and asks the tree to bring
   *  its row into view. The window uses it to keep the tree on the document
   *  in front of the reader; a gesture on a row goes through the tree's own
   *  hook. */
  revealPath(path: string): void;
  /** Points the tree at `path`, or at no row with `null`. */
  selectPath(path: string | null): void;
  /** The folder's presentation state as of now, for the saved session. */
  toSession(): WorkspaceState;
}

export interface WorkspaceRuntimeOptions {
  folder: ActiveProjectFolder;
  generation: number;
  queries: WorkspaceQueryScope;
  restored?: FolderSessionState | null;
}

export function createWorkspaceRuntime({
  folder,
  generation,
  queries,
  restored = null,
}: WorkspaceRuntimeOptions): WorkspaceRuntime {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Workspace runtime generation must be a positive safe integer.');
  }
  const scope: WorkspaceScope = Object.freeze({
    folder: Object.freeze({ ...folder }),
    generation,
  });
  const controller = new AbortController();
  const store = createStore<WorkspaceState>(() => createWorkspaceState(scope, restored));
  let disposed = false;
  let queriesRemoved = false;
  const guard = createScopeGuard<WorkspaceScope>({
    disposed: () => disposed,
    sameScope: (captured, live) =>
      captured.generation === live.generation && captured.folder.path === live.folder.path,
    scope: () => scope,
  });

  const finish = (removeQueries: boolean) => {
    if (!disposed) {
      disposed = true;
      guard.retireOperations();
      controller.abort();
      store.setState(disposeWorkspaceState);
      // Cancelling in-flight reads is best effort during teardown.
      // swallowed: the folder is already gone, so a rejected cancellation has no reader.
      void queries.cancel().catch(() => undefined);
    }
    if (removeQueries && !queriesRemoved) {
      queriesRemoved = true;
      queries.remove();
    }
  };

  return {
    scope,
    signal: controller.signal,
    store,
    accept: guard.accept,
    capture: guard.capture,
    dispose() {
      finish(false);
    },
    collapseAll() {
      store.setState(collapseAllTreeFolders);
    },
    requestCreate(kind) {
      if (disposed) return;
      store.setState((state) => requestTreeCreate(state, kind));
    },
    retire() {
      finish(true);
    },
    retireOperations: guard.retireOperations,
    revealPath(path) {
      if (disposed) return;
      store.setState((state) => revealTreePath(state, path));
    },
    selectPath(path) {
      if (disposed) return;
      store.setState((state) => selectTreePath(state, path));
    },
    toSession() {
      return store.getState();
    },
  };
}
