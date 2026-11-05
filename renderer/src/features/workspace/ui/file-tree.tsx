/**
 * The Files tree owns row visibility, gestures, and focus after mutations.
 * Adjacent file-tree modules own row rendering, group animation, keyboard
 * navigation, focus, drop targeting, and clipboard actions.
 */
import { AnimatePresence, useReducedMotionConfig } from 'framer-motion';
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { Button } from '@/components/ui/button';
import { FilesError, type FilesPort } from '@/features/workspace/application/ports';
import type { WorkspaceRuntime } from '@/features/workspace/application/runtime';
import type { TreeRow, WorkspaceEntry, WorkspaceListing } from '@/features/workspace/domain/tree';
import type { WorkspaceScope } from '@/features/workspace/domain/workspace';
import {
  useFileOperations,
  type TreeOpenOptions,
} from '@/features/workspace/hooks/use-file-operations';
import { useFiles } from '@/features/workspace/hooks/use-files';
import { useReveal } from '@/features/workspace/hooks/use-reveal';
import { useTree } from '@/features/workspace/hooks/use-tree';
import { useShape } from '@/lib/shape-context';
import { useProximityHover } from '@/lib/use-proximity-hover';
import { useTouchPrimary } from '@/lib/use-touch-primary';
import type { SourceReference } from '@/shared/domain/source-reference';
import { FailureLine, FailureNotice } from '@/shared/ui/failure-notice';

import { DeleteEntryDialog } from './delete-entry-dialog';
import type { FileImportAction } from './file-import';
import { ClipboardFailure, useTreeClipboard } from './file-tree-clipboard';
import { useTreeDraft } from './file-tree-draft';
import { dropRegion, useTreeDrop } from './file-tree-drop';
import { tabStopPath, useTreeRowFocus } from './file-tree-focus';
import { treeGestures } from './file-tree-gestures';
import { TreeGroup, TreeHighlights } from './file-tree-group';
import { FileTreeMenu, fileTreeMenuTarget, useFileTreeMenu } from './file-tree-menu';
import {
  hoverRect,
  itemKey,
  nestTreeItems,
  renderedPathKey as pathKeyOf,
  rowAtTarget,
  treeItems,
  type RenderNode,
  type TreeItem,
} from './file-tree-model';
import { DraftNameRow, RenameNameRow } from './file-tree-naming';
import { useTreePage } from './file-tree-page';
import { FileTreeRow, type FileTreeRowMarker } from './file-tree-rows';
import { useTreeSpaceContextMenu } from './file-tree-space-menu';
import { FileTreeLoading, FileTreeUnavailable } from './file-tree-status';

const EMPTY_LISTING: WorkspaceListing = {
  files: [],
  folderName: '',
  folders: [],
  showHiddenFiles: false,
};
export type { FileTreeRowMarker };

export interface FileTreeProps {
  api: FilesPort;
  /** Import from the menu, and desktop files dropped onto a folder. */
  importFiles?: FileImportAction | undefined;
  /** Opens a source. A click browses, which opens a preview; a double click,
   *  and a file the tree just created, ask for a tab that stays. */
  onOpenSource?: ((source: SourceReference, options?: TreeOpenOptions) => void) | undefined;
  /** Offered from the row context menu for failed or cancelled sources. */
  /** The Workbench-wide hidden-entry visibility, offered on the tree's own
   *  space. Absent when the window has no folder to list. */
  hiddenFiles?: { readonly disabled: boolean; readonly shown: boolean; toggle(): void } | undefined;
  onReprocess?: ((source: SourceReference) => void) | undefined;
  onScopeLost?: ((scope: WorkspaceScope) => void) | undefined;
  /** Settles the open documents under an entry before it is renamed or
   *  deleted: saves and closes them and answers their sources, or null when
   *  a save failed and the entry must stay put. */
  mutateSources?:
    | ((entry: WorkspaceEntry, operation: () => Promise<string | null>) => Promise<boolean>)
    | undefined;
  revealLabel: string;
  /** Keyed by folder-relative file path. */
  rowMarkers?: Readonly<Record<string, FileTreeRowMarker>> | undefined;
  runtime: WorkspaceRuntime;
}

export function FileTree({
  api,
  hiddenFiles,
  importFiles,
  onOpenSource,
  onReprocess,
  onScopeLost,
  mutateSources,
  revealLabel,
  rowMarkers,
  runtime,
}: FileTreeProps) {
  const files = useFiles(runtime, api);
  const tree = useTree(runtime, files.data ?? EMPTY_LISTING);
  const reveal = useReveal(runtime, api);
  const clipboard = useTreeClipboard(runtime.scope.folder.path);
  const operations = useFileOperations(runtime, api, {
    onOpenSource,
    mutateSources,
  });
  const [renameCaret, setRenameCaret] = useState<number | undefined>();
  const treeElement = useRef<HTMLDivElement>(null);
  const sectionElement = useRef<HTMLElement>(null);
  const shape = useShape();
  const reduceMotion = useReducedMotionConfig() ?? false;
  const touchPrimary = useTouchPrimary();
  const {
    activeIndex,
    handlers: proximityHandlers,
    isMeasured,
    itemRects,
    registerItem,
    sessionRef,
  } = useProximityHover(treeElement);
  const { naming } = operations;

  const page = useTreePage(runtime, tree.rows, treeElement);
  const { renderedRows } = page;
  const renderedPathKey = useMemo(() => pathKeyOf(renderedRows), [renderedRows]);
  const rowFocus = useTreeRowFocus(renderedPathKey);
  const { focus, registerRow, reset: resetRoving, setRovingPath } = rowFocus;

  useEffect(() => {
    if (files.error instanceof FilesError && files.error.kind === 'scope-lost') {
      onScopeLost?.(runtime.scope);
    }
  }, [files.error, onScopeLost, runtime]);

  useEffect(() => resetRoving(), [resetRoving, runtime.scope.generation]);

  const items = useMemo(() => treeItems(renderedRows, naming), [naming, renderedRows]);
  const nodes = useMemo(() => nestTreeItems(items), [items]);
  /** Bumped when a group finishes moving, so the proximity layer re-measures rows. */
  const [layoutRevision, setLayoutRevision] = useState(0);
  const bumpLayout = useCallback(() => setLayoutRevision((revision) => revision + 1), []);
  const tabStop = tabStopPath(renderedRows, rowFocus.rovingPath, tree.selectedPath);

  useLayoutEffect(() => {
    const rows = Array.from(
      treeElement.current?.querySelectorAll<HTMLElement>('[data-proximity-index]') ?? [],
    ).filter((row) => row.closest('[data-tree-exiting]') === null);
    const indexOf = (row: HTMLElement) => Number(row.dataset.proximityIndex);
    rows.forEach((row) => registerItem(indexOf(row), row));
    return () => rows.forEach((row) => registerItem(indexOf(row), null));
  }, [layoutRevision, naming, registerItem, renderedPathKey]);

  useTreeSpaceContextMenu(sectionElement, files.status);
  const menu = useFileTreeMenu();

  const drop = useTreeDrop({
    importDrop: importFiles,
    listingKey: files.status,
    operations,
    rows: renderedRows,
    section: sectionElement,
    tree,
  });
  const dropRect = isMeasured ? dropRegion(renderedRows, itemRects, drop.target) : null;
  const activeRect = hoverRect(isMeasured, itemRects, activeIndex, renderedRows, tree.selectedPath);

  const endNaming = (returnTo: string | null) => {
    operations.cancelNaming();
    focus(returnTo);
  };

  // A settled mutation hands focus to the row it produced, once the
  // refreshed listing shows it.
  const { consumeSettledPath, settledPath } = operations;
  useEffect(() => {
    if (!settledPath || !renderedRows.some((row) => row.node.path === settledPath)) return;
    focus(settledPath);
    consumeSettledPath();
  }, [consumeSettledPath, focus, renderedPathKey, renderedRows, settledPath]);

  useTreeDraft({
    listing: files.data,
    operations,
    renderedPathKey,
    renderedRows,
    runtime,
    select: tree.select,
    setRenameCaret,
    setRovingPath,
  });

  const { activate, beginRename, keep, onKeyDown } = treeGestures({
    focus,
    onOpenSource,
    operations,
    renderedRows,
    reveal,
    runtime,
    setRenameCaret,
    setRovingPath,
    tree,
  });

  const markerOf = (row: TreeRow) =>
    row.node.type === 'file' ? rowMarkers?.[row.node.path] : undefined;
  const menuTarget = (row: TreeRow | undefined) =>
    fileTreeMenuTarget(row, row && markerOf(row), Boolean(onReprocess));

  if (files.isPending) return <FileTreeLoading />;
  if (files.isError && !files.data) {
    return <FileTreeUnavailable error={files.error} onRetry={() => void files.refetch()} />;
  }

  // The rename field already frames its own line, so only the sentence
  // travels there; the standalone notice below is where the tone decides how
  // loudly the refusal is said.
  const refusal = operations.failure;
  const namingProblem = naming ? (refusal?.message ?? null) : null;

  const renderItem = (item: TreeItem): ReactNode => {
    const commit = (name: string) => void operations.commitNaming(name);
    if (item.kind === 'draft') {
      return (
        <DraftNameRow
          depth={item.depth}
          entryKind={item.entryKind}
          onCancel={() => endNaming(item.parentPath || tabStop)}
          onCommit={commit}
          parentPath={item.parentPath}
          problem={namingProblem}
        />
      );
    }

    const { index, row } = item;
    const expanded = row.node.type === 'folder' && tree.expanded[row.node.path] === true;

    if (naming?.kind === 'rename' && naming.entry.path === row.node.path) {
      return (
        <RenameNameRow
          caretOffset={renameCaret}
          expanded={expanded}
          onCancel={() => endNaming(row.node.path)}
          onCommit={commit}
          problem={namingProblem}
          row={row}
        />
      );
    }

    return (
      <FileTreeRow
        expanded={expanded}
        folderPath={runtime.scope.folder.path}
        index={index}
        marker={markerOf(row)}
        menuOpen={menu.openPath === row.node.path}
        onActivate={activate}
        onDragEnd={drop.endDrag}
        onDragStart={drop.startDrag}
        onFocus={setRovingPath}
        onKeep={keep}
        onKeyDown={onKeyDown}
        onOpenMenu={(menuRow, anchor) => menu.openRow(menuTarget(menuRow), anchor)}
        onRename={beginRename}
        registerRow={registerRow}
        revealLabel={revealLabel}
        row={row}
        selected={tree.selectedPath === row.node.path}
        tabStop={tabStop === row.node.path}
      />
    );
  };

  const renderNodes = (list: RenderNode[]): ReactNode =>
    list.map((node) => {
      const folder =
        node.item.kind === 'row' && node.item.row.node.type === 'folder'
          ? node.item.row.node.path
          : null;
      return (
        <Fragment key={itemKey(node.item)}>
          {renderItem(node.item)}
          {folder !== null && (
            <AnimatePresence initial={false}>
              {node.children.length > 0 && (
                <TreeGroup
                  appear={!page.opened.includes(folder)}
                  key={folder}
                  onSettle={bumpLayout}
                  reduceMotion={reduceMotion}
                >
                  {renderNodes(node.children)}
                </TreeGroup>
              )}
            </AnimatePresence>
          )}
        </Fragment>
      );
    });

  return (
    <FileTreeMenu
      actions={{
        importFiles,
        onCopyPath: clipboard.copy,
        onCreate: operations.beginCreate,
        onDelete: operations.requestDelete,
        onRename: (entry) => {
          const row = renderedRows.find((candidate) => candidate.node.path === entry.path);
          if (row) beginRename(row);
        },
        hiddenFiles: hiddenFiles ?? null,
        onReprocess: (entry) =>
          onReprocess?.({ folderPath: runtime.scope.folder.path, path: entry.path }),
        onReveal: (entry) => void reveal.reveal(entry.path),
      }}
      menu={menu}
      render={
        // pt-0: the navigator's group already sets the 8px the strip floats
        // on, the same gap the Document outline's first row keeps, so the tree
        // adds none of its own and both panels start on one line.
        <section aria-label="Files" className="min-w-0 px-2 pb-2" ref={sectionElement} />
      }
      resolveTarget={(event) => menuTarget(rowAtTarget(renderedRows, event.target))}
      revealLabel={revealLabel}
    >
      {files.isError && (
        <FileTreeUnavailable error={files.error} onRetry={() => void files.refetch()} />
      )}
      {items.length === 0 ? (
        <p className="px-2 py-4 text-caption leading-relaxed text-muted-foreground">
          This folder has no visible files yet.
        </p>
      ) : (
        <div
          aria-label="Files"
          className="relative"
          onMouseEnter={() => {
            if (!touchPrimary) proximityHandlers.onMouseEnter();
          }}
          onMouseLeave={proximityHandlers.onMouseLeave}
          onMouseMove={(event) => {
            if (!touchPrimary) proximityHandlers.onMouseMove(event);
          }}
          ref={treeElement}
          role="tree"
          tabIndex={-1}
        >
          <TreeHighlights
            className={shape.bg}
            drop={dropRect}
            hover={activeRect}
            hoverKey={sessionRef.current}
            reduceMotion={reduceMotion}
          />

          {renderNodes(nodes)}
        </div>
      )}

      {page.more > 0 && (
        <Button className="mt-1 w-full justify-start" onClick={page.showMore} variant="ghost">
          Show {page.more} more
        </Button>
      )}

      {refusal && !naming && !operations.deleting && (
        <FailureNotice className="px-2 pt-2" failure={refusal} />
      )}
      {reveal.error && (
        <FailureLine className="px-2 pt-2" tone="input">
          {reveal.error}
        </FailureLine>
      )}
      {clipboard.refused && <ClipboardFailure />}
      {importFiles?.refusals}

      <DeleteEntryDialog
        entry={operations.deleting}
        failure={operations.deleting ? (refusal?.message ?? null) : null}
        onCancel={operations.cancelDelete}
        onConfirm={() => void operations.confirmDelete()}
        pending={operations.pending}
      />
    </FileTreeMenu>
  );
}
