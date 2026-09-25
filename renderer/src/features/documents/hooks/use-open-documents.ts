import { useCallback, useSyncExternalStore } from 'react';

import type { DocumentTabsRuntime } from '@/features/documents/application/tabs-runtime';
import type { SourceReference } from '@/shared/domain/source-reference';

/**
 * Reading the open-document set from outside the feature.
 *
 * A tabs runtime is a store, but nothing outside Documents may hold that
 * store: the shell asks these hooks instead, so the tab shape stays an
 * implementation detail and every reader gets the same answer on the same
 * frame. Both tolerate a null runtime, which is what a window between folders
 * holds.
 */

const NO_SOURCES: readonly SourceReference[] = [];

function useTabsSnapshot<Value>(
  runtime: DocumentTabsRuntime | null,
  read: (runtime: DocumentTabsRuntime) => Value,
  absent: Value,
): Value {
  const subscribe = useCallback(
    (listener: () => void) => runtime?.subscribe(listener) ?? (() => undefined),
    [runtime],
  );
  const snapshot = useCallback(() => (runtime ? read(runtime) : absent), [absent, read, runtime]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const readHasDocuments = (runtime: DocumentTabsRuntime) => runtime.hasDocuments();
const readOpenSources = (runtime: DocumentTabsRuntime) => runtime.openSources();
const readActiveSource = (runtime: DocumentTabsRuntime) => runtime.activeSource();

/** Whether any document is open. */
export function useHasOpenDocuments(runtime: DocumentTabsRuntime | null): boolean {
  return useTabsSnapshot(runtime, readHasDocuments, false);
}

/** The sources behind the open tabs. The array only changes when a tab opens
 *  or closes, so a memo keyed on it stays stable across other renders. */
export function useOpenDocumentSources(
  runtime: DocumentTabsRuntime | null,
): readonly SourceReference[] {
  return useTabsSnapshot(runtime, readOpenSources, NO_SOURCES);
}

/** The source behind the tab in front of the reader, or null with none. */
export function useActiveDocumentSource(
  runtime: DocumentTabsRuntime | null,
): SourceReference | null {
  return useTabsSnapshot(runtime, readActiveSource, null);
}
