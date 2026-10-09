import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import type { AgentFilesChanged } from '@/features/agent/public';
import type { SourceReference } from '@/shared/domain/source-reference';
import { useRequestSignals } from '@/shared/runtime/use-request-signals';
import { useWindowFocus } from '@/shared/runtime/use-window-focus';

import { refreshFolder } from './refresh-folder';

export interface FolderRefreshOptions {
  /** The folder the workspace is on, or null while none is open. */
  folderPath: string | null;
  /** Restarts preparation for one source; resolves once the call settled. */
  reprocessSource(source: SourceReference): Promise<void>;
  /** Reconciles a folder with its disk; never rejects, resolving once settled. */
  syncFolder(folderPath: string, signal?: AbortSignal): Promise<void>;
  /** The host's tree revision for `folderPath`, or undefined before the
   *  first status poll answers. */
  treeVersion: number | undefined;
}

export interface FolderRefresh {
  /** Files an Agent wrote: show them, reload the documents they touched, then
   *  reconcile the folder's index and readiness. A turn that wrote through a
   *  shell command or a subagent names no file and takes the same path with
   *  no documents to reload. */
  onAgentFilesChanged(change: AgentFilesChanged): void;
  /** Restarts preparation for one source and re-reads the folder once the
   *  call has settled. Preparation changes what the tree and the status line
   *  say, so the two always travel together. */
  reprocess(source: SourceReference): void;
}

/**
 * Keeping the open folder's listing honest against writes the window did not
 * make.
 *
 * The host publishes a tree revision with every status poll when an app write
 * or reconcile may have changed the listing. Re-read it — but only after a
 * revision has been seen for *this* folder, otherwise every folder switch would
 * refetch a listing that was just fetched. The other source is the Agent, which
 * reports exactly which files its settled write changed, or that a settled turn
 * ran work it could not see into; those are refreshed directly and then
 * reconciled, and nothing here selects a file on its behalf. Returning focus to
 * the window also re-reads the listing and reconciles external filesystem edits.
 */
export function useFolderRefresh({
  folderPath,
  reprocessSource,
  syncFolder,
  treeVersion,
}: FolderRefreshOptions): FolderRefresh {
  const queryClient = useQueryClient();
  const openSignal = useRequestSignals<'focus'>();
  const focusSync = useRef<{
    signal: AbortSignal;
    lastRefreshedAt: number;
    pending: boolean;
  } | null>(null);
  const seenTreeVersion = useRef<{ folder: string | null; version: number | undefined }>({
    folder: null,
    version: undefined,
  });

  useEffect(() => {
    const signal = openSignal('focus');
    focusSync.current = folderPath ? { signal, lastRefreshedAt: -Infinity, pending: false } : null;
    return () => {
      focusSync.current = null;
    };
  }, [folderPath, openSignal]);

  const onFocus = useCallback(() => {
    const attempt = focusSync.current;
    if (!folderPath || !attempt || Date.now() - attempt.lastRefreshedAt < 5_000) {
      return;
    }
    attempt.lastRefreshedAt = Date.now();
    // Browsing disk changes must not wait for indexing or its availability.
    refreshFolder(queryClient, folderPath, { listing: true, status: false });
    if (attempt.pending) return;
    attempt.pending = true;
    void syncFolder(folderPath, attempt.signal).finally(() => {
      attempt.pending = false;
      if (focusSync.current !== attempt) return;
      refreshFolder(queryClient, folderPath, { listing: true, status: true });
    });
  }, [folderPath, queryClient, syncFolder]);

  useWindowFocus(onFocus, folderPath !== null);

  useEffect(() => {
    if (treeVersion === undefined || !folderPath) return;
    const seen = seenTreeVersion.current;
    seenTreeVersion.current = { folder: folderPath, version: treeVersion };
    if (seen.folder !== folderPath || seen.version === undefined) return;
    if (seen.version === treeVersion) return;
    refreshFolder(queryClient, folderPath, { listing: true, status: false });
  }, [folderPath, queryClient, treeVersion]);

  const refresh = useCallback(() => {
    if (!folderPath) return;
    refreshFolder(queryClient, folderPath, { listing: true, status: true });
  }, [folderPath, queryClient]);

  const onAgentFilesChanged = useCallback(
    ({ scope, sources }: AgentFilesChanged) => {
      if (scope.kind !== 'folder') return;
      const folder = scope.path;
      refreshFolder(queryClient, folder, { documents: sources, listing: true, status: false });
      void syncFolder(folder).finally(() =>
        refreshFolder(queryClient, folder, { listing: true, status: true }),
      );
    },
    [queryClient, syncFolder],
  );

  const reprocess = useCallback(
    (source: SourceReference) => void reprocessSource(source).finally(refresh),
    [refresh, reprocessSource],
  );

  return { onAgentFilesChanged, reprocess };
}
