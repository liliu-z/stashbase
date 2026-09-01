import { useMemo, type MouseEvent } from 'react';
import '@/common/styles/tree.css';
import '@/features/workspace/workspace.css';
import { VIEWABLE_FILE_EXTENSION_ALTERNATION, type ViewerFormat } from '@shared/file-formats';
import type { FileMeta } from '@/common/api/api';
import { BotIcon, CancelledIcon, ChevronDownIcon, ClaudeIcon, ExternalLinkIcon, FolderIcon, WarningIcon } from '@/common/components/icons';
import { useTreeRowDrag } from '@/features/workspace/hooks/useTreeRowDrag';
import { TreeRovingContext, useTreeRoving, useTreeRow } from '@/features/workspace/hooks/useTreeRoving';
import { buildTree, isHiddenEntryPath, visibleNodePaths, type FolderNode, type TreeNode } from '@/features/workspace/lib/fileTreeModel';
import { basename } from '@/common/lib/paths';
import { useAppActions, useWorkspace } from '@/store/contexts/AppContext';
import { hasName } from '@/store/state/state';
import { getFileReadiness } from '@/store/lib/fileReadiness';
import { EmptyState } from '@/common/components/ui/empty-state';
import { FileTypeIcon } from '@/common/components/FileTypeIcon';
import { TooltipButton } from '@/common/components/TooltipButton';
import { showInFileManagerLabel } from '@/common/lib/fileManager';
import { NewFolderInput } from '@/features/workspace/components/NewFolderInput';
import { RenameInput, useRenameTarget } from '@/features/workspace/components/RenameInput';

const VIEWABLE_EXTENSION_RE = new RegExp(`\\.(${VIEWABLE_FILE_EXTENSION_ALTERNATION})$`, 'i');

export function FileTree() {
  const state = useWorkspace();
  const root = useMemo(
    () => buildTree(state.files, state.folders, state.fileOrder),
    [state.files, state.folders, state.fileOrder],
  );
  const visiblePaths = useMemo(
    () => visibleNodePaths(root.children, state.expanded),
    [root, state.expanded],
  );
  const roving = useTreeRoving(visiblePaths, state.selectedPath);

  const inputAtRoot = state.newFolderInputOpen && state.activeFolder === '';
  if (root.children.length === 0 && !inputAtRoot) {
    return <EmptyState>No files yet — click + to create a note</EmptyState>;
  }
  return (
    <TreeRovingContext.Provider value={roving}>
      <div role="tree" aria-label="Files">
        {inputAtRoot && <NewFolderInput parentPath="" depth={0} />}
        <TreeNodes nodes={root.children} depth={0} parent="" />
      </div>
    </TreeRovingContext.Provider>
  );
}

function TreeNodes({ nodes, depth, parent }: { nodes: TreeNode[]; depth: number; parent: string }) {
  // Current rendered basename order for these siblings — used by
  // drop-to-reorder so it can splice the dragged name into the right
  // position. Matches what `buildTree` produced (manual order + tail).
  const siblings = nodes.map((n) => n.name);
  return (
    <>
      {nodes.map((n, index) =>
        n.type === 'folder' ? (
          <FolderRow
            key={n.path}
            node={n}
            depth={depth}
            parent={parent}
            siblings={siblings}
            posInSet={index + 1}
            setSize={nodes.length}
          />
        ) : (
          <FileRow
            key={n.path}
            path={n.path}
            meta={n.meta}
            depth={depth}
            paddingLeft={depth * 14 + 26}
            parent={parent}
            siblings={siblings}
            posInSet={index + 1}
            setSize={nodes.length}
          />
        ),
      )}
    </>
  );
}

/** Stable DOM id for a folder's `role="group"` container, so the folder's
 *  treeitem can claim it through `aria-owns` — the group is a DOM SIBLING
 *  of its folder row (the flat-row layout drag/roving rely on), and
 *  without the explicit ownership ARIA has no child relation to infer.
 *  `encodeURIComponent` because id-reference lists are whitespace-split. */
function treeGroupId(folderPath: string): string {
  return `tree-group-${encodeURIComponent(folderPath)}`;
}

/** Where a row's context menu opens. A KEYBOARD-invoked contextmenu event
 *  (Shift+F10 / the Menu key) carries clientX/Y = 0,0 — anchoring there
 *  put the menu in the window corner, nowhere near the focused row. Those
 *  anchor to the row's own rect instead; real pointer coordinates win. */
function contextMenuPosition(e: MouseEvent): { x: number; y: number } {
  if (e.clientX || e.clientY) return { x: e.clientX, y: e.clientY };
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: rect.left + Math.min(24, rect.width), y: rect.bottom };
}

function FolderRow({
  node,
  depth,
  parent,
  siblings,
  posInSet,
  setSize,
}: {
  node: FolderNode;
  depth: number;
  parent: string;
  siblings: string[];
  posInSet: number;
  setSize: number;
}) {
  const state = useWorkspace();
  const { dispatch, actions } = useAppActions();
  const row = useTreeRow(node.path, parent);
  const isExpanded = hasName(state.expanded, node.path);
  const isRestricted = node.kind === 'excluded' || node.kind === 'unreadable';
  const externalActionLabel = showInFileManagerLabel();
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
    'tree-row folder group/row' +
    (!isRestricted && !isExpanded ? ' collapsed' : '') +
    (isRestricted ? ' restricted' : '') +
    (isHiddenEntryPath(node.path, 'folder') ? ' hidden-entry' : '') +
    (isActive ? ' active-folder' : '') +
    (dropEdge === 'into' ? ' drop-target' : '') +
    (dropEdge === 'above' ? ' drop-edge-above' : '') +
    (dropEdge === 'below' ? ' drop-edge-below' : '');

  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    const { x, y } = contextMenuPosition(e);
    dispatch({
      type: 'CTX_MENU',
      menu: { x, y, target: node.path, kind: isRestricted ? 'restricted' : 'folder' },
    });
  }

  return (
    <>
      <div
        ref={row.ref}
        className={rowClass}
        role="treeitem"
        aria-label={isRestricted
          ? `${node.name}, ${node.kind === 'excluded' ? 'contents excluded' : 'unreadable'}, ${externalActionLabel}`
          : node.name}
        aria-level={depth + 1}
        aria-posinset={posInSet}
        aria-setsize={setSize}
        aria-expanded={isRestricted ? undefined : isExpanded}
        aria-selected={isActive}
        // The children group renders as this row's SIBLING (below), so
        // ARIA needs the ownership spelled out — see `treeGroupId`.
        aria-owns={isRestricted ? undefined : treeGroupId(node.path)}
        tabIndex={row.tabIndex}
        style={{ paddingLeft: depth * 14 + 26 }}
        data-path={node.path}
        draggable={!isRestricted && !renaming}
        {...(isRestricted ? {} : dragProps)}
        title={isRestricted ? undefined : node.path}
        onFocus={row.onFocus}
        onClick={() => {
          if (renaming) return;
          if (isRestricted) actions.revealFile(node.path);
          else dispatch({ type: 'TOGGLE_FOLDER', path: node.path });
        }}
        onKeyDown={(e) => {
          if (row.moveFocus(e)) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (isRestricted) actions.revealFile(node.path);
            else if (!renaming) dispatch({ type: 'TOGGLE_FOLDER', path: node.path });
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (isRestricted) return;
            if (!isExpanded) dispatch({ type: 'TOGGLE_FOLDER', path: node.path });
            else row.focusNext();
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (isRestricted) {
              row.focusParent();
              return;
            }
            if (isExpanded) dispatch({ type: 'TOGGLE_FOLDER', path: node.path });
            else row.focusParent();
          }
        }}
        onContextMenu={onContextMenu}
      >
        {/* Two different slots on purpose: `.chev` is the 12px disclosure
          * step ("a direction, not an object") and only a chevron belongs
          * there, while a folder glyph is an OBJECT and takes the 14px
          * `.icon` step every other row glyph uses. Both slots are 16px
          * wide, so the label edge is unchanged. */}
        {isRestricted
          ? <span className="icon"><FolderIcon /></span>
          : <span className="chev"><ChevronDownIcon /></span>}
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
        {isRestricted && <TreeRevealAction path={node.path} label={externalActionLabel} />}
      </div>
      {!isRestricted && isExpanded && (
        <div id={treeGroupId(node.path)} role="group">
          {state.newFolderInputOpen && state.activeFolder === node.path && (
            <NewFolderInput parentPath={node.path} depth={depth + 1} />
          )}
          <TreeNodes nodes={node.children} depth={depth + 1} parent={node.path} />
        </div>
      )}
    </>
  );
}

function FileRow({
  path,
  meta,
  depth,
  paddingLeft,
  parent,
  siblings,
  posInSet,
  setSize,
}: {
  path: string;
  meta: FileMeta;
  depth: number;
  paddingLeft: number;
  parent: string;
  siblings: string[];
  posInSet: number;
  setSize: number;
}) {
  const state = useWorkspace();
  const format: ViewerFormat = meta.format;
  const isRestricted = meta.availability === 'unreadable'
    || (meta.entryKind != null && meta.entryKind !== 'regular');
  const isGeneric = format === 'generic';
  const { actions, dispatch } = useAppActions();
  const row = useTreeRow(path, parent);
  const isActive = state.selectedPath === path;
  const readiness = getFileReadiness(state, path);
  const renaming = useRenameTarget(path, 'file');

  // Names keep their extension. Three viewer formats (md / html / pdf)
  // coexist — PDF-derived notes ship as a `paper.pdf` + `paper.html` pair,
  // and collapsing both to "paper" leaves them indistinguishable. The ICP
  // is developers who already read extensions in the IDE, Finder, and git.
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
    `tree-row file group/row format-${format}` +
    (isGeneric ? ' non-retrievable' : '') +
    (isRestricted ? ' restricted' : '') +
    (isHiddenEntryPath(path, 'file') ? ' hidden-entry' : '') +
    (isActive ? ' active' : '') +
    (readiness.preparationFailure ? ' preparation-failed' : '') +
    (readiness.preparationCancellation ? ' preparation-cancelled' : '') +
    (dropEdge === 'above' ? ' drop-edge-above' : '') +
    (dropEdge === 'below' ? ' drop-edge-below' : '');

  const title = isRestricted
    ? restrictedFileExplanation(meta, path)
    : isGeneric
      ? `Not included in Search or automatic Chat context. ${path}`
      : readiness.preparationFailure
    ? `File preparation failed; this file may not be searchable. ${path}`
    : readiness.preparationCancellation
      ? `File preparation was cancelled; this file is not searchable until reprocessed. ${path}`
      : path;
  // Protect the extension during inline rename for every recognised
  // format — notes (md/html) *and* the binary viewer formats (pdf +
  // images). Without the binaries here, editing "photo.png" exposes the
  // whole name and a user can drop ".png", which silently breaks format
  // detection (the row vanishes) and orphans the derived OCR note.
  const extMatch = isGeneric ? null : name.match(VIEWABLE_EXTENSION_RE);
  const ext = extMatch ? extMatch[0] : isGeneric ? genericExtension(name) : '';

  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    const { x, y } = contextMenuPosition(e);
    dispatch({
      type: 'CTX_MENU',
      menu: { x, y, target: path, kind: isRestricted ? 'restricted' : 'file' },
    });
  }

  function openFile() {
    const activeTab = state.activeTab;
    // An out-of-folder tab with the same relative name is a different file.
    if (activeTab?.file?.name === path && !activeTab.file.folder) {
      dispatch({ type: 'SELECT_PATH', path });
    } else {
      void actions.selectFile(path);
    }
  }

  return (
    <div
      ref={row.ref}
      className={rowClass}
      role="treeitem"
      aria-label={isGeneric
        ? `${name}, not included in Search or automatic Chat context`
        : name}
      aria-level={depth + 1}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-selected={isActive}
      tabIndex={row.tabIndex}
      style={{ paddingLeft }}
      data-path={path}
      title={title}
      draggable={!isRestricted && !renaming}
      {...(isRestricted ? {} : dragProps)}
      onFocus={row.onFocus}
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
        if (row.moveFocus(e)) return;
        if (e.key === 'ArrowLeft') {
          if (row.focusParent()) e.preventDefault();
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
        <span className="label">{name}</span>
      )}
      {readiness.preparationFailure ? (
        <span
          className="preparation-status-icon preparation-failure-icon"
          role="img"
          aria-label="File preparation failed"
          title="File preparation failed; this file may not be searchable."
        >
          <WarningIcon />
        </span>
      ) : readiness.preparationCancellation ? (
        <span
          className="preparation-status-icon preparation-cancelled-icon"
          role="img"
          aria-label="File preparation cancelled"
          title="File preparation was cancelled. Reprocess it when you want searchable text."
        >
          <CancelledIcon />
        </span>
      ) : null}
      {/* Same escape the restricted FOLDER row carries. Opening one of
        * these files still lands on its explanation surface, but the
        * reduced-capability state should look and act the same on both
        * kinds of row. */}
      {isRestricted && <TreeRevealAction path={path} label={showInFileManagerLabel()} />}
    </div>
  );
}

/**
 * The row-level escape to the system file manager, shared by every
 * restricted entry so one reduced-capability state has one answer.
 *
 * Reveal-on-hover is spelled in utilities against the row's `group/row`,
 * not as a descendant rule in tree.css: that stylesheet is UNLAYERED and
 * therefore beats every Tailwind utility it matches, so a `color` there
 * silently defeated the ghost recipe's own hover ink. Utilities also match
 * the app's other hover-reveals (the sidebar's row actions, the chat tab
 * strip). The element keeps its box either way, so revealing it never
 * re-truncates the label beside it.
 *
 * `invisible`, not opacity alone: at rest this control must be genuinely
 * gone — not hit-testable, not announced — and a transparent button is
 * still both. Opacity carries the fade on the way in.
 *
 * `size-4 p-0` rather than the `icon-xs` recipe's 24px box: `.tree-row` is
 * pinned to a 28px min-height with 3px padding, leaving a 22px content
 * budget, and a 24px child silently grows every restricted row to 30px —
 * which also breaks the drop-target midpoint math that assumes whole
 * pixels. The sidebar's folder-head button makes the same override.
 */
function TreeRevealAction({ path, label }: { path: string; label: string }) {
  const { actions } = useAppActions();
  return (
    <TooltipButton
      label={label}
      // Not the `right` default: this button sits on the sidebar's right
      // edge, so a right-side tip always lands on the document pane. The
      // titlebar buttons that keep the default open into the empty
      // titlebar band instead.
      side="top"
      size="icon-xs"
      tabIndex={-1}
      className="invisible size-4 flex-none rounded-sm p-0 opacity-0 transition-opacity duration-fast group-hover/row:visible group-hover/row:opacity-100 group-focus-within/row:visible group-focus-within/row:opacity-100"
      onClick={(event) => {
        event.stopPropagation();
        actions.revealFile(path);
      }}
    >
      {/* The app-wide "opens outside the app" glyph — the same one the
        * folder menu and account links carry. A bare text arrow here rode
        * the row's font metrics instead of the icon button's svg sizing
        * and sat visibly off-grid. */}
      <ExternalLinkIcon />
    </TooltipButton>
  );
}

function genericExtension(name: string): string {
  const lastDot = name.lastIndexOf('.');
  return lastDot > 0 ? name.slice(lastDot) : '';
}

function restrictedFileExplanation(meta: FileMeta, path: string): string {
  // The platform-native name, not a generic "file manager": the action
  // button one hover away says "Show in Finder", and two names for one
  // destination in the same row reads as two different places.
  const externalActionLabel = showInFileManagerLabel();
  if (meta.availability === 'unreadable') {
    return `This file cannot be read. Use ${externalActionLabel} for details. ${path}`;
  }
  if (meta.entryKind === 'cloud-placeholder') {
    return `This cloud file is not downloaded. Use ${externalActionLabel} and download it before opening. ${path}`;
  }
  if (meta.entryKind === 'symlink') {
    return `Symbolic links are shown but not followed by StashBase. ${path}`;
  }
  return `This filesystem entry cannot be opened as a regular file. ${path}`;
}

function agentRulesIcon(fileBasename: string) {
  const normalized = fileBasename.toLowerCase();
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
