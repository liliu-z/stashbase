import { useEffect, useMemo, useState } from 'react';
import { api, type FileMeta, type FolderMeta } from '@/common/api/api';
import { useLatestRef } from '@/common/hooks/useLatestRef';
import type { LibraryScope } from '@/common/lib/libraryScope';
import type { WorkspaceState } from '@/store/contexts/AppContext';
import { mentionListingPlan } from '@/features/agent-panel/lib/folderState';
import { folderRefsEqual } from '@/store/lib/folderPath';
import { isRetrievableViewerFormat } from '@shared/file-formats';

/** Scope-specific file listing: `@` mentions, folder-file attachment
 *  validation, and context resolution run against the session's bound
 *  folder, not the window's current one. Library-wide chats have no
 *  single folder listing, so mentions are disabled there.
 *
 *  The session core owns the events that invalidate this listing (a tool
 *  wrote files, a cross-folder session became ready), so it re-fetches
 *  through the returned `bumpSessionListing` rather than by watching the
 *  socket itself. */
export function useAgentMentionListing({
  connectedScope,
  workspace,
  disabled = false,
}: {
  connectedScope: LibraryScope | null;
  workspace: WorkspaceState;
  /** A retired folder scope remains visible for attribution, but it can no
   * longer authorize file listing or attachment resolution. */
  disabled?: boolean;
}) {
  // Removal reaches the renderer through two independent channels: the
  // session's structured `scope-removed` exit and the window's membership
  // update. Whichever arrives first must revoke listing access immediately;
  // otherwise switching the window to another folder during that narrow gap
  // can issue one stale cross-folder `/api/files` request for the removed
  // root. Before the first membership load, an empty list is not yet
  // authoritative, so it must not disable a valid startup session.
  const scopeIsNoLongerMember = workspace.membershipLoaded
    && connectedScope?.kind === 'folder'
    && !workspace.recent.some((entry) => folderRefsEqual(entry.path, connectedScope.path));
  const listingPlan = disabled || scopeIsNoLongerMember
    ? { kind: 'disabled' as const }
    : connectedScope
    ? mentionListingPlan(connectedScope)
    : workspace.folderPath
      ? { kind: 'folder' as const, root: workspace.folderPath }
      : { kind: 'disabled' as const };
  const listingRoot = listingPlan.kind === 'folder' ? listingPlan.root : null;
  const mentionsDisabled = listingPlan.kind === 'disabled';
  const [sessionListing, setSessionListing] = useState<{ files: FileMeta[]; folders: FolderMeta[] } | null>(null);
  const [sessionListingNonce, setSessionListingNonce] = useState(0);
  useEffect(() => {
    if (!listingRoot) {
      setSessionListing(null);
      return;
    }
    // Never render the previous scope's paths while the next authorized
    // listing is in flight.
    setSessionListing(null);
    let cancelled = false;
    void api.listFiles(listingRoot)
      .then((payload) => {
        if (!cancelled) setSessionListing({ files: payload.files, folders: payload.folders });
      })
      .catch(() => {
        // Keep whatever listing we had; the next turn/tool refresh retries.
      });
    return () => { cancelled = true; };
  }, [listingRoot, sessionListingNonce]);
  const listedFiles = mentionsDisabled ? [] : sessionListing?.files ?? [];
  const listedFolders = mentionsDisabled ? [] : sessionListing?.folders ?? [];
  const mentionFiles = listedFiles.filter((file) => isRetrievableViewerFormat(file.format));
  const mentionFolders = listedFolders.filter((folder) => !folder.kind || folder.kind === 'normal');
  const knownFilePaths = useMemo(() => new Set(mentionFiles.map((f) => f.name)), [mentionFiles]);
  // Mirrored for prompt sends driven from the once-bound WS handler
  // (queued prompts fire on `turn-end`): `resolveFolderContext` must
  // validate against the listing as of send time, not connect time.
  const knownFilePathsRef = useLatestRef(knownFilePaths);

  function bumpSessionListing() {
    setSessionListingNonce((n) => n + 1);
  }

  return {
    mentionFiles,
    mentionFolders,
    knownFilePaths,
    knownFilePathsRef,
    bumpSessionListing,
  };
}
