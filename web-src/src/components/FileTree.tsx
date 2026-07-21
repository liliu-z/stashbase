import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from 'react';
import { VIEWABLE_FILE_EXTENSION_ALTERNATION } from '../../../shared/file-formats.ts';
import { BotIcon, ChevronDownIcon, ClaudeIcon } from '../icons';
import type { FileMeta, FolderMeta } from '../api';
import { FILE_MIME, FOLDER_MIME } from '../dragMime';
import { useApp } from '../store/AppContext';
import { getFileReadiness } from '../store/fileReadiness';
import { RenameInput, useRenameTarget } from './RenameInput';

const VIEWABLE_EXTENSION_RE = new RegExp(`\\.(${VIEWABLE_FILE_EXTENSION_ALTERNATION})$`, 'i');

/** Where in a row the cursor is during dragover — drives the drop
 *  indicator + the action the drop triggers. `into` is folder-only
 *  (move the dragged file/folder into that folder, current behavior);
 *  `above` / `below` are reorder slots (same parent only). */
type DropEdge = 'above' | 'into' | 'below' | null;

// Module-scoped breadcrumbs the drag source writes at `dragstart` so
// drop targets can verify "same parent" / "not yourself" without
// resorting to MIME data (`dataTransfer.getData` is unreadable during
// `dragover`). Cleared on `dragend`.
let dragSourceParent: string | null = null;
let dragSourceName: string | null = null;
let dragSourceKind: 'file' | 'folder' | null = null;

interface FolderNode {
  type: 'folder';
  name: string;
  path: string;
  children: TreeNode[];
}

interface FileNode {
  type: 'file';
  name: string;
  path: string;
  meta: FileMeta;
}

type TreeNode = FolderNode | FileNode;

function buildTree(
  files: FileMeta[],
  folders: FolderMeta[],
  fileOrder: Record<string, string[]>,
): FolderNode {
  const root: FolderNode = { type: 'folder', name: '', path: '', children: [] };
  const folderMap = new Map<string, FolderNode>();
  folderMap.set('', root);

  const ensureFolder = (folderPath: string): FolderNode => {
    const cached = folderMap.get(folderPath);
    if (cached) return cached;
    const segs = folderPath.split('/');
    const parentPath = segs.slice(0, -1).join('/');
    const parent = ensureFolder(parentPath);
    const node: FolderNode = {
      type: 'folder',
      name: segs[segs.length - 1],
      path: folderPath,
      children: [],
    };
    parent.children.push(node);
    folderMap.set(folderPath, node);
    return node;
  };
  for (const f of folders) ensureFolder(f.path);

  for (const f of files) {
    const segs = f.name.split('/');
    const parentPath = segs.slice(0, -1).join('/');
    const parent = ensureFolder(parentPath);
    parent.children.push({
      type: 'file',
      name: segs[segs.length - 1],
      path: f.name,
      meta: f,
    });
  }

  // Sort: items the user has manually ordered come first (in the
  // recorded order), unranked items follow in folders-first +
  // alphabetical order. Names in `fileOrder` that no longer exist on
  // disk are dropped silently (renamed / deleted files don't keep
  // their slot).
  const sortNodes = (nodes: TreeNode[], parentPath: string) => {
    const order = fileOrder[parentPath];
    if (order && order.length > 0) {
      const rank = new Map<string, number>();
      order.forEach((name, i) => rank.set(name, i));
      nodes.sort((a, b) => {
        const ai = rank.get(a.name);
        const bi = rank.get(b.name);
        if (ai != null && bi != null) return ai - bi;
        if (ai != null) return -1;
        if (bi != null) return 1;
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } else {
      nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }
    for (const n of nodes) if (n.type === 'folder') sortNodes(n.children, n.path);
  };
  sortNodes(root.children, '');
  return root;
}

/** Split a path into `parent` and `basename`. Parent is `""` for
 *  folder-root entries. Used by drag-to-reorder to verify same-parent
 *  before accepting a drop. */
function splitParent(p: string): { parent: string; base: string } {
  const i = p.lastIndexOf('/');
  return i < 0 ? { parent: '', base: p } : { parent: p.slice(0, i), base: p.slice(i + 1) };
}

/** Reorder helper: produce a new array where `dragName` lands at the
 *  position of `dropName` (above or below it). Used for the manual
 *  sidebar ordering optimistic update. */
function reorder(
  names: string[],
  dragName: string,
  dropName: string,
  edge: 'above' | 'below',
): string[] {
  const without = names.filter((n) => n !== dragName);
  const dropIdx = without.indexOf(dropName);
  if (dropIdx < 0) return names; // dropName not in current list — bail
  const insertAt = edge === 'above' ? dropIdx : dropIdx + 1;
  return [...without.slice(0, insertAt), dragName, ...without.slice(insertAt)];
}

function displayName(name: string): string {
  // Show the extension. Three viewer formats (md / html / pdf) coexist
  // — PDF-derived notes ship as a `paper.pdf` + `paper.html` pair, and
  // collapsing both to "paper" leaves them visually indistinguishable.
  // ICP is developers who already read extensions everywhere (IDE /
  // Finder / git), so the noise cost is small. Kept as a hook so we
  // can flip back to stripping later without churning call sites.
  return name;
}

export function FileTree() {
  const { state } = useApp();
  const root = useMemo(
    () => buildTree(state.files, state.folders, state.fileOrder),
    [state.files, state.folders, state.fileOrder],
  );

  const inputAtRoot = state.newFolderInputOpen && state.activeFolder === '';
  if (root.children.length === 0 && !inputAtRoot) {
    return <div className="empty-list">No notes yet — click + to create one</div>;
  }
  return (
    <>
      {inputAtRoot && <NewFolderInput parentPath="" depth={0} />}
      <TreeNodes nodes={root.children} depth={0} parent="" />
    </>
  );
}

function TreeNodes({ nodes, depth, parent }: { nodes: TreeNode[]; depth: number; parent: string }) {
  // Current rendered basename order for these siblings — used by
  // drop-to-reorder so it can splice the dragged name into the right
  // position. Matches what `buildTree` produced (manual order + tail).
  const siblings = nodes.map((n) => n.name);
  return (
    <>
      {nodes.map((n) =>
        n.type === 'folder' ? (
          <FolderRow
            key={n.path}
            node={n}
            depth={depth}
            parent={parent}
            siblings={siblings}
          />
        ) : (
          <FileRow
            key={n.path}
            path={n.path}
            format={n.meta.format}
            paddingLeft={depth * 14 + 26}
            parent={parent}
            siblings={siblings}
          />
        ),
      )}
    </>
  );
}

function FolderRow({
  node,
  depth,
  parent,
  siblings,
}: {
  node: FolderNode;
  depth: number;
  parent: string;
  siblings: string[];
}) {
  const { state, dispatch, actions } = useApp();
  const isExpanded = state.expanded.has(node.path);
  const isActive = state.selectedPath === node.path;
  const renaming = useRenameTarget(node.path, 'folder');
  const [dropEdge, setDropEdge] = useState<DropEdge>(null);

  const rowClass =
    'tree-row folder' +
    (isExpanded ? '' : ' collapsed') +
    (isActive ? ' active-folder' : '') +
    (dropEdge === 'into' ? ' drop-target' : '') +
    (dropEdge === 'above' ? ' drop-edge-above' : '') +
    (dropEdge === 'below' ? ' drop-edge-below' : '');

  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    dispatch({
      type: 'CTX_MENU',
      menu: { x: e.clientX, y: e.clientY, target: node.path, kind: 'folder' },
    });
  }

  function onDragStart(e: DragEvent<HTMLDivElement>) {
    e.stopPropagation();
    e.dataTransfer.setData(FOLDER_MIME, node.path);
    e.dataTransfer.effectAllowed = 'move';
    dragSourceParent = parent;
    dragSourceName = node.name;
    dragSourceKind = 'folder';
  }
  function onDragEnd() {
    dragSourceParent = null;
    dragSourceName = null;
    dragSourceKind = null;
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    const t = e.dataTransfer.types;
    const isFile = t.includes(FILE_MIME);
    const isFolder = t.includes(FOLDER_MIME);
    if (!isFile && !isFolder) return; // external OS drop → global handler
    e.preventDefault();
    e.stopPropagation();
    // Self → no indicator.
    if (dragSourceKind === 'folder' && dragSourceName === node.name && dragSourceParent === parent) {
      setDropEdge(null);
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const r = (e.clientY - rect.top) / rect.height;
    // Folder zones: 0–25% = above, 25–75% = into, 75–100% = below.
    let edge: DropEdge = r < 0.25 ? 'above' : r >= 0.75 ? 'below' : 'into';
    // Above/below means "same level as this row" even when dragging a
    // file across folders. Middle still means "move into this folder".
    if ((edge === 'above' || edge === 'below') && dragSourceParent !== parent && isFolder) {
      edge = null;
    }
    if (edge === 'into' && isFolder) edge = null;
    setDropEdge(edge);
    e.dataTransfer.dropEffect = edge ? 'move' : 'none';
  }
  function onDragLeave() { setDropEdge(null); }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    // External OS file drops bubble to the window importer, which
    // targets this folder via `closest('.tree-row.folder')`. Swallowing
    // them here (unconditional stopPropagation) made drops onto a folder
    // row fail. Only internal move/reorder drags are handled below.
    const t = e.dataTransfer.types;
    if (!t.includes(FILE_MIME) && !t.includes(FOLDER_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    const edge = dropEdge;
    setDropEdge(null);
    if (!edge) return;
    if (edge === 'into') {
      const filePath = e.dataTransfer.getData(FILE_MIME);
      if (filePath) void actions.moveFile(filePath, node.path);
      return;
    }
    if (!dragSourceName) return;
    if (dragSourceParent !== parent) {
      const filePath = e.dataTransfer.getData(FILE_MIME);
      if (!filePath || dragSourceKind !== 'file') return;
      const slot = edge;
      void (async () => {
        const moved = await actions.moveFile(filePath, parent);
        if (!moved) return;
        const next = reorder(siblings, dragSourceName!, node.name, slot);
        await actions.setFolderOrder(parent, next);
      })();
      return;
    }
    const next = reorder(siblings, dragSourceName, node.name, edge);
    void actions.setFolderOrder(parent, next);
  }

  return (
    <>
      <div
        className={rowClass}
        style={{ paddingLeft: depth * 14 + 26 }}
        data-path={node.path}
        draggable={!renaming}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => {
          if (renaming) return;
          dispatch({ type: 'TOGGLE_FOLDER', path: node.path });
        }}
        onContextMenu={onContextMenu}
      >
        <span className="chev"><ChevronDownIcon /></span>
        {renaming ? (
          <RenameInput
            initialBasename={node.name}
            ext=""
            onCommit={(newName) => {
              void actions.renameFolder(node.path, newName);
            }}
            onCancel={() => dispatch({ type: 'RENAMING', renaming: null })}
          />
        ) : (
          <span className="label">{node.name}</span>
        )}
      </div>
      <div
        className={'tree-children' + (isExpanded ? '' : ' collapsed')}
        style={{ '--guide-left': `${depth * 14 + 33}px` } as CSSProperties}
      >
        {state.newFolderInputOpen && state.activeFolder === node.path && (
          <NewFolderInput parentPath={node.path} depth={depth + 1} />
        )}
        <TreeNodes nodes={node.children} depth={depth + 1} parent={node.path} />
      </div>
    </>
  );
}

function FileRow({
  path,
  format,
  paddingLeft,
  parent,
  siblings,
}: {
  path: string;
  format: 'md' | 'html' | 'pdf' | 'image' | 'docx' | 'audio';
  paddingLeft: number;
  parent: string;
  siblings: string[];
}) {
  const { state, actions, dispatch } = useApp();
  const isActive = state.selectedPath === path;
  const readiness = getFileReadiness(state, path);
  const renaming = useRenameTarget(path, 'file');
  const [dropEdge, setDropEdge] = useState<DropEdge>(null);

  const basename = path.split('/').pop() ?? path;
  // Named agent rules-books are tagged by their owner's logo. They are still
  // ordinary Markdown files in the tree; only the glyph changes.
  const metaIcon = agentRulesIcon(basename);

  const rowClass =
    `tree-row file format-${format}` +
    (isActive ? ' active' : '') +
    (readiness.preparationFailure ? ' preparation-failed' : '') +
    (readiness.preparationCancellation ? ' preparation-cancelled' : '') +
    (dropEdge === 'above' ? ' drop-edge-above' : '') +
    (dropEdge === 'below' ? ' drop-edge-below' : '');

  const display = displayName(basename);
  const title = readiness.preparationFailure
    ? `File preparation failed; this file may not be searchable. ${path}`
    : readiness.preparationCancellation
      ? `File preparation was cancelled; this file is not searchable until reprocessed. ${path}`
    : path;
  // Protect the extension during inline rename for every recognised
  // format — notes (md/html) *and* the binary viewer formats (pdf +
  // images). Without the binaries here, editing "photo.png" exposes the
  // whole name and a user can drop ".png", which silently breaks format
  // detection (the row vanishes) and orphans the derived OCR note.
  const extMatch = basename.match(VIEWABLE_EXTENSION_RE);
  const ext = extMatch ? extMatch[0] : '';

  function onDragStart(e: DragEvent<HTMLDivElement>) {
    e.dataTransfer.setData(FILE_MIME, path);
    e.dataTransfer.setData('text/plain', path);
    e.dataTransfer.effectAllowed = 'move';
    dragSourceParent = parent;
    dragSourceName = basename;
    dragSourceKind = 'file';
  }
  function onDragEnd() {
    dragSourceParent = null;
    dragSourceName = null;
    dragSourceKind = null;
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    const t = e.dataTransfer.types;
    const isFile = t.includes(FILE_MIME);
    const isFolder = t.includes(FOLDER_MIME);
    if (!isFile && !isFolder) return;
    e.preventDefault();
    e.stopPropagation();
    // File rows accept above/below only. For file drags across folders,
    // above/below means "move to this row's parent at this level".
    if (dragSourceParent !== parent && !isFile) {
      setDropEdge(null);
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    // Self → skip.
    if (dragSourceParent === parent && dragSourceKind === 'file' && dragSourceName === basename) {
      setDropEdge(null);
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const r = (e.clientY - rect.top) / rect.height;
    setDropEdge(r < 0.5 ? 'above' : 'below');
    e.dataTransfer.dropEffect = 'move';
  }
  function onDragLeave() { setDropEdge(null); }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    // External OS file drops aren't ours — let them bubble to the
    // window-level importer (`useGlobalDragDrop`). Unconditionally
    // stopping propagation here is what made a drop landing on a file
    // row silently fail. Only internal reorder drags are handled below.
    const t = e.dataTransfer.types;
    if (!t.includes(FILE_MIME) && !t.includes(FOLDER_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    const edge = dropEdge;
    setDropEdge(null);
    if (!edge || edge === 'into') return;
    if (!dragSourceName) return;
    if (dragSourceParent !== parent) {
      const filePath = e.dataTransfer.getData(FILE_MIME);
      if (!filePath || dragSourceKind !== 'file') return;
      const slot = edge;
      void (async () => {
        const moved = await actions.moveFile(filePath, parent);
        if (!moved) return;
        const next = reorder(siblings, dragSourceName!, basename, slot);
        await actions.setFolderOrder(parent, next);
      })();
      return;
    }
    const next = reorder(siblings, dragSourceName, basename, edge);
    void actions.setFolderOrder(parent, next);
  }

  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    dispatch({
      type: 'CTX_MENU',
      menu: { x: e.clientX, y: e.clientY, target: path, kind: 'file' },
    });
  }

  return (
    <div
      className={rowClass}
      style={{ paddingLeft }}
      data-path={path}
      title={title}
      draggable={!renaming}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => {
        if (renaming) return;
        // Single-click → replace the active tab's file (or activate
        // the existing tab that has this file already). The wasteful
        // reload case (clicking the file open in THIS tab) is handled
        // inside `selectFile` — it sees the file is already shown and
        // just re-selects the row.
        const activeTab = state.activeTabId
          ? state.tabs.find((t) => t.id === state.activeTabId)
          : null;
        if (activeTab?.file?.name === path) {
          dispatch({ type: 'SELECT_PATH', path });
        } else {
          void actions.selectFile(path);
        }
      }}
      onDoubleClick={() => {
        if (renaming) return;
        // Double-click → open in a new tab (VS Code semantics).
        void actions.openInNewTab(path);
      }}
      onContextMenu={onContextMenu}
    >
      <span className="icon">{metaIcon ?? <FileTypeIcon format={format} />}</span>
      {renaming ? (
        <RenameInput
          initialBasename={ext ? basename.slice(0, -ext.length) : basename}
          ext={ext}
          onCommit={(newBasename) => {
            void actions.renameFile(path, newBasename);
          }}
          onCancel={() => dispatch({ type: 'RENAMING', renaming: null })}
        />
      ) : (
        <span className="label">{display}</span>
      )}
      {readiness.preparationFailure ? (
        <span
          className="preparation-status-icon preparation-failure-icon"
          aria-label="File preparation failed"
          title="File preparation failed; this file may not be searchable."
        >
          <WarningGlyph />
        </span>
      ) : readiness.preparationCancellation ? (
        <span
          className="preparation-status-icon preparation-cancelled-icon"
          aria-label="File preparation cancelled"
          title="File preparation was cancelled. Reprocess it when you want searchable text."
        >
          <CancelledGlyph />
        </span>
      ) : null}
    </div>
  );
}

function CancelledGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.25 8h5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function agentRulesIcon(basename: string) {
  const normalized = basename.toLowerCase();
  if (normalized === 'claude.md') return <ClaudeIcon />;
  if (normalized === 'agents.md') return <BotIcon className="agent-rules-icon" />;
  return null;
}

function WarningGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path className="warning-mark-shape" d="M8 2.2 14.4 13.2H1.6L8 2.2Z" />
      <text className="warning-mark-text" x="8" y="12" textAnchor="middle">!</text>
    </svg>
  );
}

/** Inline input for naming a new folder. Mounts inside the parent
 *  folder's children area (or at the top level when `parentPath`
 *  is `''`), so the affordance reads "the new folder will live
 *  here". Same Enter/Esc/blur/IME semantics as `<RenameInput>`. */
function NewFolderInput({ parentPath, depth }: { parentPath: string; depth: number }) {
  const { actions, dispatch } = useApp();
  const ref = useRef<HTMLInputElement | null>(null);
  const doneRef = useRef(false);

  useEffect(() => { ref.current?.focus(); }, []);

  function commit() {
    if (doneRef.current) return;
    doneRef.current = true;
    const name = ref.current?.value.trim() ?? '';
    dispatch({ type: 'NEW_FOLDER_INPUT', open: false });
    if (!name) return;
    const full = parentPath ? `${parentPath}/${name}` : name;
    void actions.newFolder(full);
  }
  function cancel() {
    if (doneRef.current) return;
    doneRef.current = true;
    dispatch({ type: 'NEW_FOLDER_INPUT', open: false });
  }

  return (
    <div
      className="tree-row folder new-folder-row"
      style={{ paddingLeft: depth * 14 + 26 }}
    >
      <span className="chev new-folder-spacer" aria-hidden="true" />
      <input
        ref={ref}
        type="text"
        className="tree-create-input"
        placeholder="New folder name…"
        onKeyDown={(e) => {
          // Skip while IME is composing — Chinese / Japanese / Korean
          // users press Enter to pick a candidate, not to commit.
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        onBlur={() => {
          if (doneRef.current) return;
          const name = ref.current?.value.trim() ?? '';
          if (name) commit(); else cancel();
        }}
      />
    </div>
  );
}

/** Per-format file icon. Both share an outline envelope; the inner
 *  glyph is the format-specific differentiator. Colour is layered on
 *  via the `.format-<x>` CSS class on the row. */
// File-type glyphs are pulled from the Material Icon Theme (the popular
// VS Code set, MIT) instead of hand-drawn paper + tiny text — at 16px a
// distinct filled silhouette + brand colour reads at a glance where a
// 6px "PDF"/"MD" label did not. Each SVG keeps its native viewBox and
// hard-coded brand fill, so the `.format-*` CSS colour rules no longer
// apply to them (they targeted `currentColor`).
function FileTypeIcon({ format }: { format: 'md' | 'html' | 'pdf' | 'image' | 'docx' | 'audio' }) {
  if (format === 'image') {
    return (
      <svg viewBox="0 0 16 16">
        <path fill="#26a69a" d="M8.5 6h4l-4-4zM3.875 1H9.5l4 4v8.6c0 .773-.616 1.4-1.375 1.4h-8.25c-.76 0-1.375-.627-1.375-1.4V2.4c0-.777.612-1.4 1.375-1.4M4 13.6h8V8l-2.625 2.8L8 9.4zm1.25-7.7c-.76 0-1.375.627-1.375 1.4s.616 1.4 1.375 1.4c.76 0 1.375-.627 1.375-1.4S6.009 5.9 5.25 5.9" />
      </svg>
    );
  }
  if (format === 'pdf') {
    return (
      <svg viewBox="0 0 24 24">
        <path fill="#ef5350" d="M13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m4.93 10.44c.41.9.93 1.64 1.53 2.15l.41.32c-.87.16-2.07.44-3.34.93l-.11.04.5-1.04c.45-.87.78-1.66 1.01-2.4m6.48 3.81c.18-.18.27-.41.28-.66.03-.2-.02-.39-.12-.55-.29-.47-1.04-.69-2.28-.69l-1.29.07-.87-.58c-.63-.52-1.2-1.43-1.6-2.56l.04-.14c.33-1.33.64-2.94-.02-3.6a.85.85 0 0 0-.61-.24h-.24c-.37 0-.7.39-.79.77-.37 1.33-.15 2.06.22 3.27v.01c-.25.88-.57 1.9-1.08 2.93l-.96 1.8-.89.49c-1.2.75-1.77 1.59-1.88 2.12-.04.19-.02.36.05.54l.03.05.48.31.44.11c.81 0 1.73-.95 2.97-3.07l.18-.07c1.03-.33 2.31-.56 4.03-.75 1.03.51 2.24.74 3 .74.44 0 .74-.11.91-.3m-.41-.71.09.11c-.01.1-.04.11-.09.13h-.04l-.19.02c-.46 0-1.17-.19-1.9-.51.09-.1.13-.1.23-.1 1.4 0 1.8.25 1.9.35M7.83 17c-.65 1.19-1.24 1.85-1.69 2 .05-.38.5-1.04 1.21-1.69zm3.02-6.91c-.23-.9-.24-1.63-.07-2.05l.07-.12.15.05c.17.24.19.56.09 1.1l-.03.16-.16.82z" />
      </svg>
    );
  }
  if (format === 'html') {
    return (
      <svg viewBox="0 0 32 32">
        <path fill="#e65100" d="m4 4 2 22 10 2 10-2 2-22Zm19.72 7H11.28l.29 3h11.86l-.802 9.335L15.99 25l-6.635-1.646L8.93 19h3.02l.19 2 3.86.77 3.84-.77.29-4H8.84L8 8h16Z" />
      </svg>
    );
  }
  if (format === 'docx') {
    return (
      <svg viewBox="0 0 32 32">
        <path fill="#2b579a" d="M6 3h13l7 7v19H6z" />
        <path fill="#fff" opacity=".9" d="M19 3v7h7z" />
        <path fill="#fff" d="M9 14h2.1l1 6 1.2-6H15l1.2 6 1-6H19l-1.7 9h-2l-1.1-5.7L13 23h-2z" />
      </svg>
    );
  }
  if (format === 'audio') {
    return (
      <svg viewBox="0 0 24 24">
        <path fill="#8b5cf6" d="M5 9h2v6H5zm3-4h2v14H8zm3 2h2v10h-2zm3-5h2v20h-2zm3 6h2v8h-2z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 32 32">
      <path fill="#42a5f5" d="m14 10-4 3.5L6 10H4v12h4v-6l2 2 2-2v6h4V10zm12 6v-6h-4v6h-4l6 8 6-8z" />
    </svg>
  );
}
