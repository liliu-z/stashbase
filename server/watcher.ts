/**
 * Tree-version signal — the surviving piece of the old fs.watch layer.
 *
 * StashBase does not watch the filesystem. Reconcile runs at deterministic
 * event points instead: folder open/switch, MCP `reindex`, and the
 * renderer's `/api/sync` on window focus, after an Agent write settles, or after
 * an Agent turn that ran a shell command, a subagent, or another tool whose
 * writes name no file. There is no debounce window, no self-write suppression
 * TTL, and no watcher-vs-import race gate. External edits made while the
 * app is open are reconciled on the next event point; on focus the renderer also
 * refreshes its listing immediately so browsing does not wait for indexing.
 * Everything the app (or an agent via API) writes is indexed on its own write path.
 *
 * What remains is a monotonic counter the renderer polls through
 * `/api/index-status.treeVersion`: any bump means "the visible file tree
 * may have changed — refetch /api/files". Routes that create/delete/move
 * files call `noteTreeChanged()` after the disk operation; `/api/sync`
 * bumps it after every reconcile that ran to completion.
 */

let fsChangeCounter = 0;

/** Read-only view of the tree-change counter for `/api/index-status`. */
export function getFsChangeCounter(): number {
  return fsChangeCounter;
}

/** Notify renderers that a write changed the visible file tree. */
export function noteTreeChanged(): void {
  fsChangeCounter++;
}
