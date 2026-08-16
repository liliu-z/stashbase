import { createContext, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { VIEWABLE_FILE_EXTENSION_ALTERNATION } from '../../../shared/file-formats.ts';
import { BotIcon, ChevronDownIcon, ClaudeIcon } from '../icons';
import type { FileMeta, FolderMeta } from '../api';
import { useTreeRowDrag } from '../hooks/useTreeRowDrag';
import { basename } from '../lib/paths';
import { useApp } from '../store/AppContext';
import { getFileReadiness } from '../store/fileReadiness';
import { emptyStateClass } from './emptyState';
import { RenameInput, useRenameTarget } from './RenameInput';

const VIEWABLE_EXTENSION_RE = new RegExp(`\\.(${VIEWABLE_FILE_EXTENSION_ALTERNATION})$`, 'i');

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

const TreeFocusContext = createContext<{
  rovingPath: string | null;
  setRovingPath: (path: string) => void;
}>({ rovingPath: null, setRovingPath: () => undefined });

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

function displayName(name: string): string {
  // Show the extension. Three viewer formats (md / html / pdf) coexist
  // — PDF-derived notes ship as a `paper.pdf` + `paper.html` pair, and
  // collapsing both to "paper" leaves them visually indistinguishable.
  // ICP is developers who already read extensions everywhere (IDE /
  // Finder / git), so the noise cost is small. Kept as a hook so we
  // can flip back to stripping later without churning call sites.
  return name;
}

function visibleNodePaths(nodes: TreeNode[], expanded: Set<string>, paths: string[] = []): string[] {
  for (const node of nodes) {
    paths.push(node.path);
    if (node.type === 'folder' && expanded.has(node.path)) {
      visibleNodePaths(node.children, expanded, paths);
    }
  }
  return paths;
}

export function FileTree() {
  const { state } = useApp();
  const [rovingPath, setRovingPath] = useState<string | null>(null);
  const root = useMemo(
    () => buildTree(state.files, state.folders, state.fileOrder),
    [state.files, state.folders, state.fileOrder],
  );
  const visiblePaths = useMemo(
    () => visibleNodePaths(root.children, state.expanded),
    [root, state.expanded],
  );
  const effectiveRovingPath = rovingPath && visiblePaths.includes(rovingPath)
    ? rovingPath
    : state.selectedPath && visiblePaths.includes(state.selectedPath)
      ? state.selectedPath
      : visiblePaths[0] ?? null;
  const focusContext = useMemo(
    () => ({ rovingPath: effectiveRovingPath, setRovingPath }),
    [effectiveRovingPath],
  );

  const inputAtRoot = state.newFolderInputOpen && state.activeFolder === '';
  if (root.children.length === 0 && !inputAtRoot) {
    const { sourceCode = 0, other = 0 } = state.unsupportedFiles || {};
    const total = sourceCode + other;
    if (total > 0) {
      return (
        <div className={emptyStateClass + ' flex-col items-center gap-1 text-center'}>
          <div className="font-semibold text-foreground">No supported files found</div>
          {/* text-xs, the ramp's meta step — the note scales with
            * --ui-scale where the old hardcoded 11px did not. */}
          <div className="text-xs leading-snug">
            StashBase found {total} file{total === 1 ? '' : 's'} in this folder, but none can currently be displayed or indexed. Nothing on disk was changed.
          </div>
        </div>
      );
    }
    return <div className={emptyStateClass}>No notes yet — click + to create one</div>;
  }
  return (
    <TreeFocusContext.Provider value={focusContext}>
      <div role="tree" aria-label="Files">
        {inputAtRoot && <NewFolderInput parentPath="" depth={0} />}
        <TreeNodes nodes={root.children} depth={0} parent="" />
      </div>
    </TreeFocusContext.Provider>
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
            depth={depth}
            paddingLeft={depth * 14 + 26}
            parent={parent}
            siblings={siblings}
          />
        ),
      )}
    </>
  );
}

function visibleTreeItems(current: HTMLElement): HTMLElement[] {
  const tree = current.closest('[role="tree"]');
  if (!tree) return [];
  return Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'))
    .filter((item) => !item.closest('.tree-children.collapsed'));
}

function moveTreeFocus(event: KeyboardEvent<HTMLDivElement>): boolean {
  const items = visibleTreeItems(event.currentTarget);
  const index = items.indexOf(event.currentTarget);
  let target: HTMLElement | undefined;
  if (event.key === 'ArrowDown') target = items[index + 1];
  else if (event.key === 'ArrowUp') target = items[index - 1];
  else if (event.key === 'Home') target = items[0];
  else if (event.key === 'End') target = items.at(-1);
  if (!target) return false;
  event.preventDefault();
  target.focus();
  return true;
}

function focusParentTreeItem(current: HTMLElement, parentPath: string): boolean {
  if (!parentPath) return false;
  const parent = visibleTreeItems(current).find((item) => item.dataset.path === parentPath);
  parent?.focus();
  return !!parent;
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
  const treeFocus = useContext(TreeFocusContext);
  const isExpanded = state.expanded.has(node.path);
  const isActive = state.selectedPath === node.path;
  const renaming = useRenameTarget(node.path, 'folder');
  const { dropEdge, dragProps } = useTreeRowDrag({
    kind: 'folder',
    path: node.path,
    name: node.name,
    parent,
    siblings,
  });

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
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    dispatch({
      type: 'CTX_MENU',
      menu: { x: e.clientX, y: e.clientY, target: node.path, kind: 'folder' },
    });
  }

  return (
    <>
      <div
        className={rowClass}
        role="treeitem"
        aria-label={node.name}
        aria-level={depth + 1}
        aria-expanded={isExpanded}
        aria-selected={isActive}
        tabIndex={treeFocus.rovingPath === node.path ? 0 : -1}
        style={{ paddingLeft: depth * 14 + 26 }}
        data-path={node.path}
        draggable={!renaming}
        {...dragProps}
        onFocus={() => treeFocus.setRovingPath(node.path)}
        onClick={() => {
          if (renaming) return;
          dispatch({ type: 'TOGGLE_FOLDER', path: node.path });
        }}
        onKeyDown={(e) => {
          if (moveTreeFocus(e)) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!renaming) dispatch({ type: 'TOGGLE_FOLDER', path: node.path });
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (!isExpanded) dispatch({ type: 'TOGGLE_FOLDER', path: node.path });
            else {
              const items = visibleTreeItems(e.currentTarget);
              items[items.indexOf(e.currentTarget) + 1]?.focus();
            }
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (isExpanded) dispatch({ type: 'TOGGLE_FOLDER', path: node.path });
            else focusParentTreeItem(e.currentTarget, parent);
          }
        }}
        onContextMenu={onContextMenu}
      >
        <span className="chev"><ChevronDownIcon /></span>
        {renaming ? (
          <RenameInput
            initialBasename={node.name}
            ext=""
            ariaLabel={`Rename folder ${node.name}`}
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
        role="group"
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
  depth,
  paddingLeft,
  parent,
  siblings,
}: {
  path: string;
  format: FileGlyphFormat;
  depth: number;
  paddingLeft: number;
  parent: string;
  siblings: string[];
}) {
  const { state, actions, dispatch } = useApp();
  const treeFocus = useContext(TreeFocusContext);
  const isActive = state.selectedPath === path;
  const readiness = getFileReadiness(state, path);
  const renaming = useRenameTarget(path, 'file');

  const name = basename(path);
  // Named agent rules-books are tagged by their owner's logo. They are still
  // ordinary Markdown files in the tree; only the glyph changes.
  const metaIcon = agentRulesIcon(name);
  const { dropEdge, dragProps } = useTreeRowDrag({
    kind: 'file',
    path,
    name,
    parent,
    siblings,
  });

  const rowClass =
    `tree-row file format-${format}` +
    (isActive ? ' active' : '') +
    (readiness.preparationFailure ? ' preparation-failed' : '') +
    (readiness.preparationCancellation ? ' preparation-cancelled' : '') +
    (dropEdge === 'above' ? ' drop-edge-above' : '') +
    (dropEdge === 'below' ? ' drop-edge-below' : '');

  const display = displayName(name);
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
  const extMatch = name.match(VIEWABLE_EXTENSION_RE);
  const ext = extMatch ? extMatch[0] : '';

  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    dispatch({
      type: 'CTX_MENU',
      menu: { x: e.clientX, y: e.clientY, target: path, kind: 'file' },
    });
  }

  function openFile() {
    const activeTab = state.activeTabId
      ? state.tabs.find((t) => t.id === state.activeTabId)
      : null;
    // An out-of-folder tab with the same relative name is a different file.
    if (activeTab?.file?.name === path && !activeTab.file.folder) {
      dispatch({ type: 'SELECT_PATH', path });
    } else {
      void actions.selectFile(path);
    }
  }

  return (
    <div
      className={rowClass}
      role="treeitem"
      aria-label={display}
      aria-level={depth + 1}
      aria-selected={isActive}
      tabIndex={treeFocus.rovingPath === path ? 0 : -1}
      style={{ paddingLeft }}
      data-path={path}
      title={title}
      draggable={!renaming}
      {...dragProps}
      onFocus={() => treeFocus.setRovingPath(path)}
      onClick={() => {
        if (renaming) return;
        // Single-click → open the file in its own persistent tab (or
        // focus the tab that already has it). The wasteful reload case
        // (clicking the file open in THIS tab) is handled inside
        // `selectFile` — it sees the file is already shown and just
        // re-selects the row. There is no double-click open: one click
        // always opens a lasting tab.
        openFile();
      }}
      onKeyDown={(e) => {
        if (moveTreeFocus(e)) return;
        if (e.key === 'ArrowLeft') {
          if (focusParentTreeItem(e.currentTarget, parent)) e.preventDefault();
          return;
        }
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (!renaming) openFile();
      }}
      onContextMenu={onContextMenu}
    >
      <span className="icon">{metaIcon ?? <FileTypeIcon format={format} />}</span>
      {renaming ? (
        <RenameInput
          initialBasename={ext ? name.slice(0, -ext.length) : name}
          ext={ext}
          ariaLabel={`Rename file ${name}`}
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
  // The Claude mark keeps its baked-in brand coral. It is now the only
  // coloured glyph in the tree — the format icons went muted — but it is a
  // LOGO, not a state or a category, and CLAUDE.md appears at most once per
  // folder, so it stays inside the one-small-moment colour budget rather
  // than becoming a hue-per-row.
  // AGENTS.md stays muted — its bot represents a vendor-neutral contract.
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
        aria-label={parentPath ? `New folder in ${parentPath}` : 'New folder in folder root'}
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

/** Per-format file glyph, from Phosphor's `fill` weight.
 *
 *  Fill, not the chrome set's `regular`: these carry a format label inside
 *  the page (PDF, DOC, MD), and at 14px a knocked-out letterform in a solid
 *  silhouette stays readable where thin outlined strokes turn to mush.
 *
 *  Colour is `currentColor`, so the tree's `--muted` applies and a column of
 *  files reads as one quiet list. They were brand-coloured (PDF red, docx
 *  blue) and it made the sidebar the loudest surface in the app — a hue per
 *  row is exactly the repeated-element case the colour budget rules out.
 *  The silhouette and its letterform carry the format instead. */
export type FileGlyphFormat = 'md' | 'html' | 'json' | 'csv' | 'pdf' | 'image' | 'docx' | 'audio';

export function FileTypeIcon({ format }: { format: FileGlyphFormat }) {
  if (format === 'image') {
    return (
      <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M158.66,219.56A8,8,0,0,1,152,232H24a8,8,0,0,1-6.73-12.33l36-56a8,8,0,0,1,13.46,0l9.76,15.18,20.85-31.29a8,8,0,0,1,13.32,0ZM216,88V216a16,16,0,0,1-16,16h-8a8,8,0,0,1,0-16h8V96H152a8,8,0,0,1-8-8V40H56v88a8,8,0,0,1-16,0V40A16,16,0,0,1,56,24h96a8,8,0,0,1,5.66,2.34l56,56A8,8,0,0,1,216,88Zm-56-8h28.69L160,51.31Z"/></svg>
    );
  }
  if (format === 'csv') {
    return (
      <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
        <path d="M44,120H212a4,4,0,0,0,4-4V88a8,8,0,0,0-2.34-5.66l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40v76A4,4,0,0,0,44,120ZM152,44l44,44H152ZM80,180a36,36,0,0,1-36,36A36.08,36.08,0,0,1,12.78,198.8,8,8,0,0,1,26.11,189.6,20.08,20.08,0,0,0,44,200a20,20,0,0,0,0-40,20.08,20.08,0,0,0-17.89,10.4,8,8,0,0,1-13.33-9.2A36,36,0,0,1,80,180Zm64-16a8,8,0,0,0-8-8H104a8,8,0,0,0-8,8v12a8,8,0,0,0,8,8h24v8H104a8,8,0,0,0,0,16h24a24,24,0,0,0,24-24v-12a8,8,0,0,0-8-8H120v-8h24A8,8,0,0,0,144,164Zm96,0a8,8,0,0,0-7.39-4.94h-2.22a8,8,0,0,0-7.39,4.94L200,210.66,176.61,164a8,8,0,0,0-7.39-4.94h-2.22A8,8,0,0,0,160,164a8.27,8.27,0,0,0,.61,3.06l32,64a8,8,0,0,0,14.78,0l32-64A8.27,8.27,0,0,0,240,164Z"/>
      </svg>
    );
  }
  if (format === 'pdf') {
    return (
      <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M44,120H212a4,4,0,0,0,4-4V88a8,8,0,0,0-2.34-5.66l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40v76A4,4,0,0,0,44,120ZM152,44l44,44H152Zm72,108.53a8.18,8.18,0,0,1-8.25,7.47H192v16h15.73a8.17,8.17,0,0,1,8.25,7.47,8,8,0,0,1-8,8.53H192v15.73a8.17,8.17,0,0,1-7.47,8.25,8,8,0,0,1-8.53-8V152a8,8,0,0,1,8-8h32A8,8,0,0,1,224,152.53ZM64,144H48a8,8,0,0,0-8,8v55.73A8.17,8.17,0,0,0,47.47,216,8,8,0,0,0,56,208v-8h7.4c15.24,0,28.14-11.92,28.59-27.15A28,28,0,0,0,64,144Zm-.35,40H56V160h8a12,12,0,0,1,12,13.16A12.25,12.25,0,0,1,63.65,184ZM128,144H112a8,8,0,0,0-8,8v56a8,8,0,0,0,8,8h15.32c19.66,0,36.21-15.48,36.67-35.13A36,36,0,0,0,128,144Zm-.49,56H120V160h8a20,20,0,0,1,20,20.77C147.58,191.59,138.34,200,127.51,200Z"/></svg>
    );
  }
  if (format === 'html') {
    return (
      <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M44,128H212a4,4,0,0,0,4-4V88a8,8,0,0,0-2.34-5.66l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40v84A4,4,0,0,0,44,128ZM152,44l44,44H152ZM68,160v48a8,8,0,0,1-16,0V192H32v16a8,8,0,0,1-16,0V160a8,8,0,0,1,16,0v16H52V160a8,8,0,0,1,16,0Zm56,0a8,8,0,0,1-8,8h-8v40a8,8,0,0,1-16,0V168H84a8,8,0,0,1,0-16h32A8,8,0,0,1,124,160Zm72,0v48a8,8,0,0,1-16,0V184l-9.6,12.8a8,8,0,0,1-12.8,0L148,184v24a8,8,0,0,1-16,0V160a8,8,0,0,1,14.4-4.8L164,178.67l17.6-23.47A8,8,0,0,1,196,160Zm56,48a8,8,0,0,1-8,8H216a8,8,0,0,1-8-8V160a8,8,0,0,1,16,0v40h20A8,8,0,0,1,252,208Z"/></svg>
    );
  }
  if (format === 'json') {
    return (
      <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34Zm-104,88a8,8,0,0,1-11.32,11.32l-24-24a8,8,0,0,1,0-11.32l24-24a8,8,0,0,1,11.32,11.32L91.31,152Zm72-12.68-24,24a8,8,0,0,1-11.32-11.32L164.69,152l-18.35-18.34a8,8,0,0,1,11.32-11.32l24,24A8,8,0,0,1,181.66,157.66ZM152,88V44l44,44Z"/></svg>
    );
  }
  if (format === 'docx') {
    return (
      <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M44,120H212.07a4,4,0,0,0,4-4V88a8,8,0,0,0-2.34-5.66l-56-56A8,8,0,0,0,152.05,24H56A16,16,0,0,0,40,40v76A4,4,0,0,0,44,120Zm108-76,44,44h-44ZM52,144H36a8,8,0,0,0-8,8v56a8,8,0,0,0,8,8H51.33C71,216,87.55,200.52,88,180.87A36,36,0,0,0,52,144Zm-.49,56H44V160h8a20,20,0,0,1,20,20.77C71.59,191.59,62.35,200,51.52,200Zm170.67-4.28a8.26,8.26,0,0,1-.73,11.09,30,30,0,0,1-21.4,9.19c-17.65,0-32-16.15-32-36s14.36-36,32-36a30,30,0,0,1,21.4,9.19,8.26,8.26,0,0,1,.73,11.09,8,8,0,0,1-11.9.38A14.21,14.21,0,0,0,200.06,160c-8.82,0-16,9-16,20s7.18,20,16,20a14.25,14.25,0,0,0,10.23-4.66A8,8,0,0,1,222.19,195.72ZM128,144c-17.65,0-32,16.15-32,36s14.37,36,32,36,32-16.15,32-36S145.69,144,128,144Zm0,56c-8.83,0-16-9-16-20s7.18-20,16-20,16,9,16,20S136.86,200,128,200Z"/></svg>
    );
  }
  if (format === 'audio') {
    return (
      <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M152,180a40.55,40.55,0,0,1-20,34.91A8,8,0,0,1,124,201.09a24.49,24.49,0,0,0,0-42.18A8,8,0,0,1,132,145.09,40.55,40.55,0,0,1,152,180ZM99.06,128.61a8,8,0,0,0-8.72,1.73L68.69,152H48a8,8,0,0,0-8,8v40a8,8,0,0,0,8,8H68.69l21.65,21.66A8,8,0,0,0,104,224V136A8,8,0,0,0,99.06,128.61ZM216,88V216a16,16,0,0,1-16,16H168a8,8,0,0,1,0-16h32V96H152a8,8,0,0,1-8-8V40H56v80a8,8,0,0,1-16,0V40A16,16,0,0,1,56,24h96a8,8,0,0,1,5.66,2.34l56,56A8,8,0,0,1,216,88Zm-56-8h28.69L160,51.31Z"/></svg>
    );
  }
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40v76a4,4,0,0,0,4,4H196a4,4,0,0,1,4,4V224a8,8,0,0,0,9.19,7.91,8.15,8.15,0,0,0,6.81-8.16V88A8,8,0,0,0,213.66,82.34ZM152,88V44l44,44Zm-8,56H128a8,8,0,0,0-8,8v56a8,8,0,0,0,8,8h15.32c19.66,0,36.21-15.48,36.67-35.13A36,36,0,0,0,144,144Zm-.49,56H136V160h8a20,20,0,0,1,20,20.77C163.58,191.59,154.34,200,143.51,200ZM104,152v55.73A8.17,8.17,0,0,1,96.53,216,8,8,0,0,1,88,208V177.38l-13.32,19a8.3,8.3,0,0,1-4.2,3.2,8,8,0,0,1-9-3L48,177.38v30.35A8.17,8.17,0,0,1,40.53,216,8,8,0,0,1,32,208V152.31a8.27,8.27,0,0,1,4.56-7.53,8,8,0,0,1,10,2.63L68,178.05l21.27-30.39a8.28,8.28,0,0,1,8.06-3.55A8,8,0,0,1,104,152Z"/></svg>
  );
}
