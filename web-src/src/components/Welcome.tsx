import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  errorMessage,
  type IndexStatus,
} from '../api';
import { ClaudeIcon, CodexIcon, CubeLogoIcon, FolderIcon, LibraryIcon, MoreHorizontalIcon, NewFolderIcon, PlugIcon } from '../icons';
import { useApp } from '../store/AppContext';
import type { LibraryFolderStatus } from '../store/state';
import { Menu, type MenuItem } from './Menu';
import { ModalShell } from './ModalShell';
import { openSettings } from './SettingsModal';

interface ElectronBridge {
  openFolderDialog?: (opts?: {
    title?: string;
    buttonLabel?: string;
    defaultPath?: string;
    allowCreateDirectory?: boolean;
  }) => Promise<string | null>;
}

interface FolderIndexSnapshot {
  state: LibraryFolderStatus;
  total: number;
  pending: number;
  converting: number;
}

const WELCOME_RECONCILE_COOLDOWN_MS = 30_000;
const OPEN_FOLDER_WATCHDOG_MS = 20_000;

/** Shorten an absolute path for display: `/Users/foo/Notes` → `~/Notes`
 *  when it lives under the user's home dir. Falls through unchanged
 *  otherwise (e.g. `/tmp/scratch`). */
function prettifyHome(abs: string, home: string): string {
  if (!home) return abs;
  if (abs === home) return '~';
  if (abs.startsWith(home + '/')) return '~/' + abs.slice(home.length + 1);
  return abs;
}

function basenameOfPath(path: string): string {
  const segs = path.split('/').filter(Boolean);
  return segs.pop() || path;
}

function folderIndexSnapshot(status: IndexStatus): FolderIndexSnapshot {
  const hasError = status.indexWarning
    || (status.preparationFailures?.some((problem) => problem.status !== 'cancelled') ?? false);
  const pending = status.pendingCount ?? 0;
  const converting = status.pendingConversions?.length ?? 0;
  const total = Math.max(0, status.total ?? 0);
  const indexReady = status.indexReady !== false;
  const isIndexing = !indexReady
    || status.visibleIndexingSettled === false
    || pending > 0
    || converting > 0;

  return {
    state: hasError ? 'failed' : isIndexing ? 'preparing' : 'ready',
    total,
    pending,
    converting,
  };
}

/**
 * Landing overlay shown when no folder is open (or after the user
 * explicitly goes home). The library is global; opening a folder only
 * changes the current view into one member folder.
 *
 *   - **New folder**: native picker opened at `~/Documents/StashBase`,
 *     with the OS "New Folder" affordance available.
 *   - **Open folder**: native picker to open any folder on disk in place.
 *   - **Library folders**: the member list (recents) — click to reopen.
 */
export function Welcome() {
  const { state, actions, dispatch } = useApp();
  const [folderHome, setFolderHome] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ path: string; name: string; rect: DOMRect } | null>(null);
  const [folderIndexSnapshots, setFolderIndexSnapshots] = useState<Record<string, FolderIndexSnapshot>>({});
  const [openingFolder, setOpeningFolder] = useState<{ path: string; name: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const welcomeReconcileStartedAt = useRef<Map<string, number>>(new Map());
  const openingRequestRef = useRef(0);

  const removeFolder = useCallback((path: string) => {
    setRemoving(true);
    void api.removeFolder(path)
      .then(() => {
        dispatch({ type: 'LIBRARY_FOLDER_STATUS_REMOVE', path });
      })
      .then(() => api.getFolder())
      .then((j) => dispatch({ type: 'WELCOME_SHOW', recent: j.recent ?? [], homeDir: j.homeDir }))
      .catch((e) => dispatch({ type: 'WELCOME_ERROR', error: errorMessage(e) }))
      .finally(() => { setRemoving(false); setConfirmRemove(null); });
  }, [dispatch]);

  const refreshFolderHome = useCallback(async () => {
    const r = await api.getFolderHome();
    setFolderHome(r.path);
    return r.path;
  }, []);

  // Fetch folderHome so New Folder opens the native picker at the
  // default StashBase location.
  useEffect(() => {
    void (async () => {
      try {
        await refreshFolderHome();
      } catch (err) {
        dispatch({ type: 'WELCOME_ERROR', error: errorMessage(err) });
      }
    })();
  }, [dispatch, refreshFolderHome]);

  useEffect(() => {
    if (!state.welcomeVisible) return;
    let cancelled = false;
    void Promise.all([api.getFolder(), refreshFolderHome()])
      .then(([j]) => {
        if (cancelled) return;
        dispatch({ type: 'WELCOME_SHOW', recent: j.recent ?? [], homeDir: j.homeDir });
      })
      .catch(() => { /* keep the current welcome state */ });
    return () => { cancelled = true; };
  }, [dispatch, refreshFolderHome, state.welcomeVisible]);

  useEffect(() => {
    if (!state.welcomeVisible) setOpeningFolder(null);
  }, [state.welcomeVisible]);

  useEffect(() => {
    if (!openingFolder || !state.welcomeVisible) return undefined;
    const timer = setTimeout(() => {
      setOpeningFolder(null);
      dispatch({
        type: 'WELCOME_ERROR',
        error: `Opening ${openingFolder.name} is taking longer than expected. Please try again.`,
      });
    }, OPEN_FOLDER_WATCHDOG_MS);
    return () => clearTimeout(timer);
  }, [dispatch, openingFolder, state.welcomeVisible]);

  useEffect(() => {
    if (!state.welcomeVisible || openingFolder || state.recent.length === 0) {
      setFolderIndexSnapshots({});
      return;
    }
    let cancelled = false;
    const paths = state.recent.map((r) => r.path);
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function refreshFolderStates() {
      const entries = await Promise.all(paths.map(async (path) => {
        try {
          const status = await api.indexStatus(path);
          return [path, folderIndexSnapshot(status)] as const;
        } catch {
          return [path, {
            state: state.libraryFolderStatuses[path] ?? 'unknown',
            total: 0,
            pending: 0,
            converting: 0,
          }] as const;
        }
      }));
      if (cancelled) return;
      const fresh = Object.fromEntries(entries) as Record<string, FolderIndexSnapshot>;
      let nextForPolling = fresh;
      setFolderIndexSnapshots((prev) => {
        const merged = Object.fromEntries(Object.entries(fresh).map(([path, snapshot]) => {
          const previous = prev[path];
          return [path, { ...previous, ...snapshot }];
        })) as Record<string, FolderIndexSnapshot>;
        nextForPolling = merged;
        return merged;
      });
      const keepPolling = Object.values(nextForPolling).some((s) => s.state === 'preparing' || s.state === 'unknown');
      if (keepPolling) timer = setTimeout(refreshFolderStates, 1500);
    }
    timer = setTimeout(refreshFolderStates, 750);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [openingFolder, state.libraryFolderStatuses, state.recent, state.welcomeVisible]);

  useEffect(() => {
    if (!state.welcomeVisible || openingFolder || state.recent.length === 0) return;
    const timer = setTimeout(() => {
      const now = Date.now();
      for (const folder of state.recent) {
        const lastStarted = welcomeReconcileStartedAt.current.get(folder.path) ?? 0;
        if (now - lastStarted < WELCOME_RECONCILE_COOLDOWN_MS) continue;
        welcomeReconcileStartedAt.current.set(folder.path, now);
        void api.sync(folder.path)
          .catch((err) => {
            console.warn(`[welcome] reconcile failed for ${folder.path}:`, err);
          });
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, [openingFolder, state.recent, state.welcomeVisible]);

  function openRecent(path: string) {
    const requestId = ++openingRequestRef.current;
    setFolderMenu(null);
    setOpeningFolder({ path, name: basenameOfPath(path) });
    void actions.openFolder(path)
      .catch((e) => {
        if (requestId !== openingRequestRef.current) return;
        const msg = errorMessage(e);
        // Remove the failed entry immediately so a stale/deleted path
        // doesn't remain clickable if the server refresh also fails.
        dispatch({
          type: 'WELCOME_SHOW',
          recent: state.recent.filter((r) => r.path !== path),
          homeDir: state.homeDir,
          error: msg,
        });
        void api.getFolder()
          .then((j) => dispatch({ type: 'WELCOME_SHOW', recent: j.recent ?? [], homeDir: j.homeDir, error: msg }))
          .catch(() => { /* keep the optimistic removal + original open error */ });
      })
      .finally(() => {
        if (requestId === openingRequestRef.current) setOpeningFolder(null);
      });
  }

  if (!state.welcomeVisible) return null;

  const removeTarget = confirmRemove
    ? (() => {
        const segs = confirmRemove.split('/').filter(Boolean);
        const name = segs.pop() || confirmRemove;
        const parent = prettifyHome(segs.length ? '/' + segs.join('/') : '/', state.homeDir ?? '');
        return { path: confirmRemove, name, parent };
      })()
    : null;

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-brand">
          <div className="welcome-logo">
            <CubeLogoIcon />
          </div>
          <div className="welcome-title">StashBase</div>
          <div className="welcome-sub">
            Open or create a folder to build your searchable library.
          </div>
        </div>

        <div className="welcome-recent">
          <div className="welcome-recent-head">
            <span className="welcome-recent-title">
              <span className="welcome-recent-head-icon">
                <LibraryIcon />
              </span>
              <span>
                Library <span className="welcome-recent-count">· {state.recent.length} {state.recent.length === 1 ? 'folder' : 'folders'}</span>
              </span>
            </span>
            <div className="welcome-recent-head-right">
              <div className="welcome-actions welcome-actions--header">
                <OpenFolderButton
                  shortLabel
                  primary
                  disabled={!!openingFolder}
                  onOpeningFolder={setOpeningFolder}
                />
                <NewFolderButton
                  shortLabel
                  disabled={!!openingFolder}
                  folderHome={folderHome}
                  refreshFolderHome={refreshFolderHome}
                  onOpeningFolder={setOpeningFolder}
                />
              </div>
            </div>
          </div>
          <div className="welcome-recent-list">
            {state.recent.length === 0 && (
              <div className="welcome-recent-empty">No folders yet.</div>
            )}
            {state.recent.length > 0 && (
              <>
                {state.recent.map((r) => {
                  const segs = r.path.split('/').filter(Boolean);
                  const name = segs.pop() || r.path;
                  const parent = prettifyHome(segs.length ? '/' + segs.join('/') : '/', state.homeDir ?? '');
                  const indexSnapshot = folderIndexSnapshots[r.path] ?? {
                    state: state.libraryFolderStatuses[r.path] ?? 'unknown',
                    total: 0,
                    pending: 0,
                    converting: 0,
                  };
                  const indexState = indexSnapshot.state;
                  return (
                    <div
                      key={r.path}
                      className="welcome-recent-row"
                      onClick={() => openRecent(r.path)}
                    >
                      <button
                        type="button"
                        className="welcome-recent-open"
                        title={r.path}
                        onClick={(e) => {
                          e.stopPropagation();
                          openRecent(r.path);
                        }}
                      >
                        <FolderIcon />
                        <span className="welcome-recent-main">
                          <span className="welcome-recent-line">
                            <span className="welcome-recent-name">{name}</span>
                            <span className="welcome-recent-path">{parent}</span>
                            {indexState === 'failed' && (
                              <span
                                className="welcome-recent-status is-failed"
                                aria-label="Search needs attention"
                                title="Some files in this folder could not be prepared for search."
                              >
                                <WarningMark />
                              </span>
                            )}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="welcome-recent-more"
                        title="More actions"
                        aria-label={`More actions for ${name}`}
                        aria-haspopup="menu"
                        aria-expanded={folderMenu?.path === r.path}
                        onClick={(e) => {
                          e.stopPropagation();
                          setFolderMenu({ path: r.path, name, rect: e.currentTarget.getBoundingClientRect() });
                        }}
                      >
                        <MoreHorizontalIcon />
                      </button>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>

        <div className="welcome-mcp">
          <div className="welcome-mcp-icon">
            <PlugIcon />
          </div>
          <div className="welcome-mcp-text">
            <div className="welcome-mcp-title">
              <span>Connect your Agents</span>
              <span className="welcome-mcp-agent-icons" aria-hidden="true">
                <ClaudeIcon />
                <CodexIcon />
                <span className="welcome-mcp-agent-more">+</span>
              </span>
            </div>
          </div>
          <button
            className="welcome-mcp-btn"
            type="button"
            onClick={() => openSettings('mcp')}
          >
            Open MCP Settings
          </button>
        </div>

        {state.welcomeError && (
          <div className="welcome-err">{state.welcomeError}</div>
        )}
      </div>
      {openingFolder && (
        <div className="welcome-loading" role="status" aria-live="polite">
          <div className="welcome-loading-spinner" />
          <div className="welcome-loading-text">Opening {openingFolder.name}</div>
        </div>
      )}
      {folderMenu && (
        <Menu
          anchor={{ rect: folderMenu.rect, align: 'right' }}
          minWidth={190}
          items={[
            {
              label: 'Remove from Library',
              detail: 'Will not delete local files',
              danger: true,
              onSelect: () => setConfirmRemove(folderMenu.path),
            },
          ] satisfies MenuItem[]}
          onClose={() => setFolderMenu(null)}
        />
      )}
      {removeTarget && (
        <ModalShell onCancel={removing ? () => { /* wait for removal */ } : () => setConfirmRemove(null)} top>
          <h3>Remove from Library?</h3>
          <p className="modal-hint">
            StashBase will remove <strong className="welcome-remove-name">{removeTarget.name}</strong> from your Library.
            It will <strong>not</strong> delete the folder or its files from your disk.
          </p>
          <div className="welcome-remove-path" title={removeTarget.path}>
            {removeTarget.parent}
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className="modal-btn"
              disabled={removing}
              onClick={() => setConfirmRemove(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="modal-btn danger"
              disabled={removing}
              onClick={() => removeFolder(removeTarget.path)}
            >
              {removing ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}

function WarningMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path className="warning-mark-shape" d="M8 2.2 14.4 13.2H1.6L8 2.2Z" />
      <text className="warning-mark-text" x="8" y="12" textAnchor="middle">!</text>
    </svg>
  );
}

/** "Open folder" action — pick ANY folder on disk (anywhere, any nesting
 *  level) and open it in place. Nothing is copied: the folder is indexed
 *  where it lives. Browser fallback (no Electron bridge)
 *  hides the button — no portable absolute-path picker. */
function OpenFolderButton({
  shortLabel = false,
  primary = false,
  disabled = false,
  onOpeningFolder,
}: {
  shortLabel?: boolean;
  primary?: boolean;
  disabled?: boolean;
  onOpeningFolder?: (folder: { path: string; name: string } | null) => void;
}) {
  const { actions, dispatch } = useApp();
  const [busy, setBusy] = useState(false);
  const bridge = useMemo<ElectronBridge | undefined>(
    () => (window as { electron?: ElectronBridge }).electron,
    [],
  );
  if (typeof bridge?.openFolderDialog !== 'function') return null;
  async function onClick() {
    if (busy || disabled) return;
    setBusy(true);
    try {
      const picked = await bridge!.openFolderDialog!({
        title: 'Select folder',
        buttonLabel: 'Select folder',
        allowCreateDirectory: true,
      });
      if (picked) {
        onOpeningFolder?.({ path: picked, name: basenameOfPath(picked) });
        await actions.openFolder(picked);
      }
    } catch (err) {
      dispatch({ type: 'WELCOME_ERROR', error: errorMessage(err) });
    } finally {
      onOpeningFolder?.(null);
      setBusy(false);
    }
  }
  return (
    <button
      className={'welcome-action' + (primary ? ' is-primary' : '')}
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      title="Add any folder on your disk to the library — indexed in place, not copied"
    >
      <span className="welcome-action-icon">
        <FolderIcon />
      </span>
      <span className="welcome-action-label">{shortLabel ? 'Open' : 'Open folder'}</span>
    </button>
  );
}

/** Same native picker as Open folder, but starts at the default StashBase
 *  home so the OS panel's New Folder button lands in the expected place. */
function NewFolderButton({
  folderHome,
  refreshFolderHome,
  shortLabel = false,
  disabled = false,
  onOpeningFolder,
}: {
  folderHome: string;
  refreshFolderHome: () => Promise<string>;
  shortLabel?: boolean;
  disabled?: boolean;
  onOpeningFolder?: (folder: { path: string; name: string } | null) => void;
}) {
  const { actions, dispatch } = useApp();
  const [busy, setBusy] = useState(false);
  const bridge = useMemo<ElectronBridge | undefined>(
    () => (window as { electron?: ElectronBridge }).electron,
    [],
  );

  if (typeof bridge?.openFolderDialog !== 'function') return null;

  async function onClick() {
    if (busy || disabled) return;
    setBusy(true);
    try {
      const defaultPath = folderHome || await refreshFolderHome();
      const picked = await bridge!.openFolderDialog!({
        title: 'Create or select folder',
        buttonLabel: 'Select folder',
        defaultPath,
        allowCreateDirectory: true,
      });
      if (picked) {
        onOpeningFolder?.({ path: picked, name: basenameOfPath(picked) });
        await actions.openFolder(picked);
      }
    } catch (err) {
      dispatch({ type: 'WELCOME_ERROR', error: errorMessage(err) });
    } finally {
      onOpeningFolder?.(null);
      setBusy(false);
    }
  }

  return (
    <button
      className="welcome-action"
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      title="Create or choose a folder under the default StashBase location and add it to the library"
    >
      <span className="welcome-action-icon">
        <NewFolderIcon />
      </span>
      <span className="welcome-action-label">{shortLabel ? 'New' : 'New folder'}</span>
    </button>
  );
}
