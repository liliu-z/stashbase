import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  errorMessage,
  type FolderImportPreview,
  type ImportFolderMode,
} from '../api';
import { CubeLogoIcon, FolderIcon, GitCloneIcon, NewFolderIcon } from '../icons';
import { useApp } from '../store/AppContext';
import { CloneRepoModal } from './CloneRepoModal';
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

/** Shorten an absolute path for display: `/Users/foo/Notes` → `~/Notes`
 *  when it lives under the user's home dir. Falls through unchanged
 *  otherwise (e.g. `/tmp/scratch`). */
function prettifyHome(abs: string, home: string): string {
  if (!home) return abs;
  if (abs === home) return '~';
  if (abs.startsWith(home + '/')) return '~/' + abs.slice(home.length + 1);
  return abs;
}

/**
 * Landing overlay shown when no space is open (or after the user
 * explicitly goes home). Spaces are flat under the library root
 * (`~/Documents/StashBase/` by default) and are identified by name.
 *
 *   - **New space**: text input for a name; server creates the folder
 *     under kbRoot and opens it.
 *   - **Open space**: dropdown of existing direct-child folders under
 *     kbRoot; click to open.
 *   - **Clone repo**: name defaults to repo name, user can override.
 *
 * No folder picker — names alone make the kbRoot invariant trivial to
 * enforce and skip a system dialog round-trip.
 */
export function Welcome() {
  const { state, actions, dispatch } = useApp();
  const [cloneOpen, setCloneOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [openOpen, setOpenOpen] = useState(false);
  const [importSource, setImportSource] = useState<string | null>(null);
  const [kbRoot, setKbRoot] = useState('');
  const [rootPickerOpen, setRootPickerOpen] = useState(false);
  const [showAllRecent, setShowAllRecent] = useState(false);

  // Fetch kbRoot so copy can show `~/Documents/StashBase` as the
  // container path in the hints below the action buttons.
  useEffect(() => {
    void (async () => {
      try {
        const r = await api.getKbRoot();
        setKbRoot(r.path);
        if (r.needsPicker) setRootPickerOpen(true);
      } catch (err) {
        dispatch({ type: 'WELCOME_ERROR', error: errorMessage(err) });
      }
    })();
  }, [dispatch]);

  if (!state.welcomeVisible) return null;

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-brand">
          <div className="welcome-logo">
            <CubeLogoIcon />
          </div>
          <div className="welcome-title">StashBase</div>
          <div className="welcome-sub">
            Local knowledge base for you and your AI. Continuously indexed,{' '}
            <span style={{ whiteSpace: 'nowrap' }}>MCP-compatible</span>.
          </div>
        </div>

        <div className="welcome-actions">
          <button
            className="welcome-action"
            type="button"
            onClick={() => setOpenOpen(true)}
            title="Open an existing space in your library"
          >
            <span className="welcome-action-icon">
              <FolderIcon />
            </span>
            <span className="welcome-action-label">Open space</span>
          </button>
          <button
            className="welcome-action"
            type="button"
            onClick={() => setNewOpen(true)}
            title="Create a new space in your library"
          >
            <span className="welcome-action-icon">
              <NewFolderIcon />
            </span>
            <span className="welcome-action-label">New space</span>
          </button>
          <button
            className="welcome-action"
            type="button"
            onClick={() => setCloneOpen(true)}
            title="Clone a git repo (HTTPS or SSH) as a new space"
          >
            <span className="welcome-action-icon">
              <GitCloneIcon />
            </span>
            <span className="welcome-action-label">Clone repo</span>
          </button>
          <ImportFolderButton onPicked={setImportSource} />
        </div>

        <div className="welcome-mcp">
          <div className="welcome-mcp-text">
            <div className="welcome-mcp-title">Connect AI tools</div>
            <div className="welcome-mcp-sub">
              Searchable from Claude, Codex, ChatGPT, and more.
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

        {state.recent.length > 0 && (
          <div className="welcome-recent">
            <div className="welcome-recent-head">
              <span>Recent spaces</span>
              {state.recent.length > 12 && (
                <button
                  className="welcome-recent-more"
                  type="button"
                  onClick={() => setShowAllRecent((v) => !v)}
                >
                  {showAllRecent ? 'Show less' : `Show all (${state.recent.length})`}
                </button>
              )}
            </div>
            <div className="welcome-recent-pills">
              {(showAllRecent ? state.recent : state.recent.slice(0, 12)).map((r) => {
                const name = r.path.split('/').filter(Boolean).pop() || r.path;
                return (
                  <button
                    key={r.path}
                    type="button"
                    className="welcome-recent-pill"
                    title={name}
                    onClick={() => { void actions.openSpace(r.path); }}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {state.welcomeError && (
          <div className="welcome-err">{state.welcomeError}</div>
        )}
      </div>
      {cloneOpen && <CloneRepoModal onClose={() => setCloneOpen(false)} />}
      {importSource && (
        <ImportFolderModal
          source={importSource}
          homeDir={state.homeDir ?? ''}
          onClose={() => setImportSource(null)}
        />
      )}
      {rootPickerOpen && (
        <KbRootPickerModal
          initialPath={kbRoot}
          homeDir={state.homeDir ?? ''}
          onSaved={(path) => {
            setKbRoot(path);
            setRootPickerOpen(false);
          }}
        />
      )}
      {newOpen && (
        <NewSpaceModal
          kbRoot={kbRoot}
          homeDir={state.homeDir ?? ''}
          onClose={() => setNewOpen(false)}
        />
      )}
      {openOpen && (
        <OpenSpaceModal
          kbRoot={kbRoot}
          homeDir={state.homeDir ?? ''}
          onClose={() => setOpenOpen(false)}
        />
      )}
    </div>
  );
}

function KbRootPickerModal({
  initialPath,
  homeDir,
  onSaved,
}: {
  initialPath: string;
  homeDir: string;
  onSaved: (path: string) => void;
}) {
  const { actions } = useApp();
  const [path, setPath] = useState(initialPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const display = path ? prettifyHome(path, homeDir) : '~/Documents/StashBase';

  useEffect(() => setPath(initialPath), [initialPath]);

  async function browse() {
    const bridge = (window as { electron?: ElectronBridge }).electron;
    const picked = await bridge?.openFolderDialog?.({
      title: 'Choose KB root',
      buttonLabel: 'Use as KB Root',
      defaultPath: path || undefined,
    });
    if (picked) setPath(picked);
  }

  async function submit(confirmNonEmpty = false) {
    const p = path.trim();
    if (!p) { setError('Path required'); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api.setKbRoot(p, confirmNonEmpty);
      onSaved(r.path);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !confirmNonEmpty) {
        setBusy(false);
        const ok = await actions.confirm('That directory is not empty. Use it as the KB root anyway?');
        if (ok) void submit(true);
        return;
      }
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <ModalShell onCancel={() => { /* first-run picker is required */ }}>
      <h3>Choose KB root</h3>
      <p className="modal-hint">
        Spaces will live as folders inside <code>{display}</code>.
      </p>
      <input
        type="text"
        className="modal-input"
        value={path}
        disabled={busy}
        spellCheck={false}
        onChange={(e) => setPath(e.target.value)}
        autoFocus
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') { e.preventDefault(); void submit(); }
        }}
      />
      {error && <div className="modal-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="modal-btn" onClick={() => { void browse(); }} disabled={busy}>
          Browse
        </button>
        <button type="button" className="modal-btn primary" onClick={() => { void submit(); }} disabled={busy || !path.trim()}>
          {busy ? 'Saving…' : 'Use this folder'}
        </button>
      </div>
    </ModalShell>
  );
}

/** "Import folder" action — opens the native folder picker, then asks
 *  the server to copy the chosen directory into <kbRoot>/<basename> as
 *  a brand-new space. Browser fallback (no Electron bridge) hides the
 *  button entirely: there's no portable file-picker we'd trust to
 *  return an absolute path the server can act on. */
function ImportFolderButton({ onPicked }: { onPicked: (path: string) => void }) {
  const { dispatch } = useApp();
  const [busy, setBusy] = useState(false);
  const bridge = useMemo<ElectronBridge | undefined>(
    () => (window as { electron?: ElectronBridge }).electron,
    [],
  );
  if (typeof bridge?.openFolderDialog !== 'function') return null;
  async function onClick() {
    if (busy) return;
    setBusy(true);
    try {
      const picked = await bridge!.openFolderDialog!({
        title: 'Import folder as space',
        buttonLabel: 'Choose Folder',
        allowCreateDirectory: false,
      });
      if (picked) onPicked(picked);
    } catch (err) {
      dispatch({ type: 'WELCOME_ERROR', error: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      className="welcome-action"
      type="button"
      onClick={onClick}
      disabled={busy}
      title="Copy an existing folder on your disk into the library as a new space"
    >
      <span className="welcome-action-icon">
        <FolderIcon />
      </span>
      <span className="welcome-action-label">{busy ? 'Choosing…' : 'Import folder'}</span>
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function ImportFolderModal({
  source,
  homeDir,
  onClose,
}: {
  source: string;
  homeDir: string;
  onClose: () => void;
}) {
  const { actions } = useApp();
  const [preview, setPreview] = useState<FolderImportPreview | null>(null);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<ImportFolderMode>('copy');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once a move import finished but left the original behind (see
  // FolderImportResult.warning). The space exists; we keep the modal up
  // to show the cleanup notice and let the user open it deliberately.
  const [doneName, setDoneName] = useState<string | null>(null);
  const previewSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const seq = ++previewSeq.current;
    setPreview(null);
    setError(null);
    void (async () => {
      try {
        const p = await api.previewImportFolder(source);
        if (cancelled || seq !== previewSeq.current) return;
        setPreview(p);
        setName(p.name);
      } catch (err) {
        if (!cancelled && seq === previewSeq.current) setError(errorMessage(err));
      }
    })();
    return () => { cancelled = true; };
  }, [source]);

  async function refreshName(nextName: string) {
    setName(nextName);
    const seq = ++previewSeq.current;
    if (!nextName.trim()) {
      setPreview(null);
      setError(null);
      return;
    }
    try {
      const p = await api.previewImportFolder(source, nextName);
      if (seq !== previewSeq.current) return;
      setPreview(p);
      setError(null);
    } catch (err) {
      if (seq !== previewSeq.current) return;
      setError(errorMessage(err));
    }
  }

  async function submit() {
    const n = name.trim();
    if (!n) { setError('Name required'); return; }
    if (n.includes('/') || n.includes('\\') || n.startsWith('.')) {
      setError('Name cannot contain slashes or start with "."');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.importFolder(source, {
        name: n,
        mode,
        confirmExisting: true,
      });
      if (result.warning) {
        // Import succeeded but the original couldn't be removed. Keep the
        // modal open so the notice survives; the user opens the space
        // (which unmounts Welcome) only after acknowledging it.
        setDoneName(result.name);
        setError(result.warning);
        setBusy(false);
        return;
      }
      onClose();
      await actions.openSpaceByName(result.name);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const sourceDisplay = prettifyHome(source, homeDir);
  const destinationDisplay = preview ? prettifyHome(preview.destination, homeDir) : '';
  const importActionMessage = mode === 'move'
    ? 'Importing moves this existing folder into your StashBase library and removes the original.'
    : 'Importing copies this existing folder into your StashBase library.';
  const serverWarnings = (preview?.warnings ?? []).filter((w) =>
    w !== 'Importing copies this existing folder into your StashBase library.',
  );

  return (
    <ModalShell onCancel={busy ? () => { /* swallow during import */ } : onClose}>
      <h3>Import folder</h3>
      <p className="modal-hint">
        Imports <code>{sourceDisplay}</code> as a new space.
      </p>
      <input
        type="text"
        className="modal-input"
        placeholder="Space name"
        autoComplete="off"
        spellCheck={false}
        value={name}
        onChange={(e) => { void refreshName(e.target.value); }}
        disabled={busy}
        autoFocus
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') { e.preventDefault(); void submit(); }
          else if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); }
        }}
      />
      <label className="modal-check">
        <input
          type="checkbox"
          checked={mode === 'move'}
          disabled={busy}
          onChange={(e) => setMode(e.target.checked ? 'move' : 'copy')}
        />
        <span>Move folder into StashBase instead of copying</span>
      </label>
      {preview && (
        <div className="modal-hint">
          <div>Destination: <code>{destinationDisplay}</code></div>
          <div>{preview.entryCount} item{preview.entryCount === 1 ? '' : 's'} · {formatBytes(preview.totalBytes)}</div>
          {preview.exists && <div>{importActionMessage}</div>}
          {preview.hasSnapshot && <div>Snapshot found; StashBase will import it when the space opens.</div>}
          {serverWarnings.map((w) => <div key={w}>{w}</div>)}
        </div>
      )}
      {error && <div className={doneName ? 'modal-warning' : 'modal-error'}>{error}</div>}
      <div className="modal-actions">
        <button type="button" className="modal-btn" onClick={onClose} disabled={busy}>
          {doneName ? 'Close' : 'Cancel'}
        </button>
        {doneName ? (
          <button
            type="button"
            className="modal-btn primary"
            onClick={() => { onClose(); void actions.openSpaceByName(doneName); }}
          >Open space</button>
        ) : (
          <button
            type="button"
            className="modal-btn primary"
            onClick={() => { void submit(); }}
            disabled={busy || !preview || !name.trim()}
          >{busy ? 'Importing…' : mode === 'move' ? 'Move into StashBase' : 'Copy into StashBase'}</button>
        )}
      </div>
    </ModalShell>
  );
}

/** "New space" modal: a single text input. Server creates the folder
 *  under kbRoot and opens it in one shot. Names go through
 *  `validateSpaceName` server-side; we do a quick client-side check
 *  to avoid a round-trip on obvious mistakes. */
function NewSpaceModal({
  kbRoot,
  homeDir,
  onClose,
}: {
  kbRoot: string;
  homeDir: string;
  onClose: () => void;
}) {
  const { actions } = useApp();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootDisplay = kbRoot ? prettifyHome(kbRoot, homeDir) : '~/Documents/StashBase';

  async function submit() {
    const n = name.trim();
    if (!n) { setError('Name required'); return; }
    if (n.includes('/') || n.includes('\\') || n.startsWith('.')) {
      setError('Name cannot contain slashes or start with "."');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await actions.openSpaceByName(n);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <ModalShell onCancel={busy ? () => { /* swallow during create */ } : onClose}>
      <h3>New space</h3>
      <p className="modal-hint">
        Creates <code>{rootDisplay}/&lt;name&gt;</code> and opens it. The
        folder is created if it doesn't exist yet.
      </p>
      <input
        type="text"
        className="modal-input"
        placeholder="e.g. research, notes, cs183b"
        autoComplete="off"
        spellCheck={false}
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={busy}
        autoFocus
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') { e.preventDefault(); void submit(); }
          else if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); }
        }}
      />
      {error && <div className="modal-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="modal-btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="modal-btn primary"
          onClick={() => { void submit(); }}
          disabled={busy || !name.trim()}
        >{busy ? 'Opening…' : 'Create'}</button>
      </div>
    </ModalShell>
  );
}

/** "Open space" modal: list of direct-child folders under kbRoot,
 *  recently-opened ones first then the rest alphabetically. Includes
 *  everything in the library — folders the user created via Finder
 *  but never opened still show up. Empty state nudges toward
 *  New / Clone. */
function OpenSpaceModal({
  kbRoot,
  homeDir,
  onClose,
}: {
  kbRoot: string;
  homeDir: string;
  onClose: () => void;
}) {
  const { actions } = useApp();
  const [names, setNames] = useState<string[] | null>(null);
  // Re-fetched on mount instead of read from AppContext: `state.recent`
  // is captured at bootstrap and never refreshed after opens (`goHome`
  // reuses `stateRef.current.recent`), so it would skew this modal's
  // ordering after the user has opened any new space.
  const [recentNames, setRecentNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootDisplay = kbRoot ? prettifyHome(kbRoot, homeDir) : '~/Documents/StashBase';

  useEffect(() => {
    void (async () => {
      try {
        const [avail, spaceState] = await Promise.all([
          api.listAvailableSpaces(),
          api.getSpace(),
        ]);
        setNames(avail.names);
        // RecentSpace paths are absolute; under the flat invariant
        // the last segment is the space name. Server returns them
        // most-recent-first already.
        setRecentNames(
          (spaceState.recent ?? [])
            .map((r) => r.path.split('/').filter(Boolean).pop() || '')
            .filter(Boolean),
        );
      } catch (err) {
        setError(errorMessage(err));
        setNames([]);
      }
    })();
  }, []);

  // Recently-opened first (freshest at top), then everything else
  // alphabetically.
  const ordered = useMemo(() => {
    if (!names) return [];
    const present = new Set(names);
    const seen = new Set<string>();
    const head: string[] = [];
    for (const n of recentNames) {
      if (present.has(n) && !seen.has(n)) {
        head.push(n);
        seen.add(n);
      }
    }
    const rest = names.filter((n) => !seen.has(n));
    return [...head, ...rest];
  }, [names, recentNames]);

  async function pick(n: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await actions.openSpaceByName(n);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <ModalShell onCancel={busy ? () => { /* swallow during open */ } : onClose}>
      <h3>Open space</h3>
      <p className="modal-hint">
        Spaces in <code>{rootDisplay}</code>.
      </p>
      {names === null ? (
        <div className="modal-hint">Loading…</div>
      ) : names.length === 0 ? (
        <div className="modal-hint">
          No spaces yet — use <strong>New space</strong> or <strong>Clone repo</strong> to create one.
        </div>
      ) : (
        <div className="welcome-open-list">
          {ordered.map((n) => (
            <button
              key={n}
              type="button"
              className="welcome-open-row"
              disabled={busy}
              onClick={() => { void pick(n); }}
            >
              {n}
            </button>
          ))}
        </div>
      )}
      {error && <div className="modal-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="modal-btn" onClick={onClose} disabled={busy}>
          {busy ? 'Opening…' : 'Cancel'}
        </button>
      </div>
    </ModalShell>
  );
}
