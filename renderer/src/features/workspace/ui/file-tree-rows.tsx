/**
 * One line of the file tree: its icon vocabulary, its indentation, and the
 * button that carries the row's semantics. Nesting reads from indentation
 * alone; the tree draws no guides, which are a code editor's idiom.
 *
 * The row owns no tree state. Everything it needs to draw itself arrives as a
 * value and everything it can do leaves as a callback, so the tree component
 * stays the single place that decides what a gesture means.
 */
import {
  ChevronDown,
  ChevronRight,
  CircleSlash,
  ExternalLink,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson2,
  FileQuestion,
  FileSpreadsheet,
  FileText,
  FileType2,
  Folder,
  type LucideIcon,
  MoreHorizontal,
  TriangleAlert,
} from 'lucide-react';
import { useRef, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';

import { Button } from '@/components/ui/button';
import { caretOffsetAtPoint } from '@/components/ui/inline-input';
import { SidebarMenuAction } from '@/components/ui/sidebar-menu-action';
import type { ViewerFormat } from '@/features/workspace/domain/tree';
import {
  fileIsRestricted,
  folderIsRestricted,
  type TreeRow,
  type WorkspaceEntry,
} from '@/features/workspace/domain/tree';
import { cn } from '@/lib/utils';

import { writeTreeDrag } from './file-tree-drop';

// The tree sits on the sidebar's row, the compact step: 28px tall with the
// 14px glyph and 13px label every other row in the column has, so the
// folder header, New chat, the footer, and the tree read as one list. A
// level indents by the glyph plus 12px.
const TREE_ROOT_INSET = 8;
const TREE_LEVEL_INDENT = 26;

const FILE_ICONS: Record<ViewerFormat, LucideIcon> = {
  audio: FileAudio,
  csv: FileSpreadsheet,
  docx: FileText,
  generic: FileQuestion,
  html: FileCode2,
  image: FileImage,
  json: FileJson2,
  md: FileText,
  pdf: FileType2,
  txt: FileText,
};

/** Preparation states that need the user. Pending work stays unmarked. */
export interface FileTreeRowMarker {
  kind: 'cancelled' | 'failed';
  title: string;
}

const MARKER_ICONS: Record<FileTreeRowMarker['kind'], LucideIcon> = {
  cancelled: CircleSlash,
  failed: TriangleAlert,
};

const GENERIC_TITLE = 'Search and automatic Chat context exclude this file.';
const GENERIC_LABEL = 'excluded from Search and automatic Chat context';

export function rowInset(depth: number): CSSProperties {
  return {
    paddingLeft: `${TREE_ROOT_INSET + (depth - 1) * TREE_LEVEL_INDENT}px`,
  };
}

export function entryOf(row: TreeRow): WorkspaceEntry {
  return { kind: row.node.type, path: row.node.path };
}

export function rowIsRestricted(row: TreeRow): boolean {
  return row.node.type === 'folder' ? folderIsRestricted(row.node) : fileIsRestricted(row.node);
}

/** A file excluded from Search and automatic Chat context. */
function rowIsGeneric(row: TreeRow): boolean {
  return row.node.type === 'file' && row.node.format === 'generic';
}

/** The run of a name a rename should offer for replacement: the stem ahead
 *  of a file's extension, or the whole name of a folder. */
export function nameSelection(row: TreeRow): { end: number; start: number } {
  const name = row.node.name;
  const dot = row.node.type === 'file' ? name.lastIndexOf('.') : -1;
  return { end: dot > 0 ? dot : name.length, start: 0 };
}

interface RowDescription {
  marker?: FileTreeRowMarker | undefined;
  revealLabel: string;
}

/** What the row announces. A restricted entry says what activating it does,
 *  a generic one says why Search cannot see it, and a marked one carries the
 *  preparation state that needs the user. */
function rowLabel(row: TreeRow, { marker, revealLabel }: RowDescription): string {
  if (rowIsRestricted(row)) return `${row.node.name}, restricted, ${revealLabel}`;
  if (rowIsGeneric(row)) return `${row.node.name}, ${GENERIC_LABEL}`;
  return marker ? `${row.node.name}, ${marker.title}` : row.node.name;
}

/** What the row says on hover; the full path when it has nothing else to say. */
function rowTitle(row: TreeRow, { marker, revealLabel }: RowDescription): string {
  if (rowIsRestricted(row)) return revealLabel;
  if (rowIsGeneric(row)) return GENERIC_TITLE;
  return marker?.title ?? row.node.path;
}

/** The leading icon: a folder's disclosure state, or the file's format. */
export function rowIcon(row: TreeRow, expanded: boolean): LucideIcon {
  if (row.node.type !== 'folder') {
    // A workbook has no format of its own yet opens as a worksheet preview.
    return row.node.format === 'generic' && /\.xlsx$/i.test(row.node.path)
      ? FileSpreadsheet
      : FILE_ICONS[row.node.format];
  }
  if (rowIsRestricted(row)) return Folder;
  return expanded ? ChevronDown : ChevronRight;
}

export interface FileTreeRowProps {
  expanded: boolean;
  /** The active folder, for the source identity a drag carries. */
  folderPath: string;
  index: number;
  marker?: FileTreeRowMarker | undefined;
  onActivate(row: TreeRow): void;
  /** A drag the row started has ended, wherever it was dropped. */
  onDragEnd(): void;
  /** The row's own drag began; its payload is already written. */
  onDragStart(row: TreeRow): void;
  onFocus(path: string): void;
  /** A double click on a file: the reader asking for its document to stay
   *  open rather than be the preview the next click replaces. */
  onKeep(row: TreeRow): void;
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>, row: TreeRow, editable: boolean): void;
  /** Opens the tree's menu on this row, under the control that asked for it. */
  onOpenMenu(row: TreeRow, anchor: HTMLElement): void;
  onRename(row: TreeRow, caretOffset?: number): void;
  /** This row's menu is open, so its "…" stays showing. */
  menuOpen: boolean;
  registerRow(path: string, element: HTMLButtonElement | null): void;
  revealLabel: string;
  row: TreeRow;
  selected: boolean;
  tabStop: boolean;
}

export function FileTreeRow({
  expanded,
  folderPath,
  index,
  marker,
  onActivate,
  onDragEnd,
  onDragStart,
  onFocus,
  onKeep,
  onKeyDown,
  onOpenMenu,
  onRename,
  menuOpen,
  registerRow,
  revealLabel,
  row,
  selected,
  tabStop,
}: FileTreeRowProps) {
  const restricted = rowIsRestricted(row);
  const editable = !restricted;
  // Any editable entry can move. Every ordinary file can also be explicitly
  // attached to Chat; its runtime decides how to read it.
  const draggable = !restricted;
  const trailingIcon = restricted ? ExternalLink : marker ? MARKER_ICONS[marker.kind] : undefined;
  const element = useRef<HTMLButtonElement | null>(null);
  const menuButton = useRef<HTMLButtonElement | null>(null);
  // Pressing the "…" closes an open menu as a press outside it before the
  // click lands, so the click needs to know the menu was this row's.
  const menuWasOpen = useRef(false);

  // A click acts at once: a folder toggle is the tree's most frequent gesture
  // and must not wait out a double-click window. Only the first click of a
  // double click acts, so the second lands on the folder as that click left
  // it, or on a file already previewed.
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail > 1) return;
    onActivate(row);
  };

  // A double click keeps a file's document open; on a folder it starts the
  // rename, which a file still reaches through F2 and the menu.
  const onDoubleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (!editable) return;
    event.preventDefault();
    if (row.node.type === 'file') {
      onKeep(row);
      return;
    }
    const target = event.target instanceof HTMLElement ? event.target : event.currentTarget;
    onRename(row, caretOffsetAtPoint(target, event.clientX, event.clientY));
  };

  return (
    <div className="group/tree-row relative z-10" role="none">
      <Button
        active={selected}
        aria-expanded={row.node.type === 'folder' && !restricted ? expanded : undefined}
        aria-label={rowLabel(row, { marker, revealLabel })}
        aria-level={row.depth}
        aria-posinset={row.position}
        aria-selected={selected}
        aria-setsize={row.setSize}
        className={cn(
          // gap-2 over the compact button gap lands the label on the sidebar's
          // menu rows' text line, 38px in, so the tree and the rows around it
          // share one text edge. A row scrolled into view clears the list's
          // edge fade, so the document the tree reveals is never left dimmed.
          'w-full scroll-my-(--scroll-fade-size) justify-start gap-2',
          '[&>span:last-child]:w-full [&>span:last-child]:min-w-0 [&>span:last-child]:justify-start',
          '[&>span:last-child>span]:min-w-0 [&>span:last-child>span]:flex-1 [&>span:last-child>span]:truncate [&>span:last-child>span]:text-left [&>span:last-child>span]:[text-box:normal]',
          // The row rests in ink, label and glyph alike, over the ghost
          // button's grey, the way the sidebar's menu rows do; hovered and
          // selected are one treatment, the one row tint, with neither colour
          // nor stroke changing. The important stroke holds the button's own
          // hover thickening off.
          'text-foreground [&_svg]:stroke-[1.5]! [&_svg]:text-foreground',
          // A trailing glyph sits on the row's action axis, 18px in from the
          // edge (a 24px action box at right-1.5): 11px of padding centres the
          // 14px glyph there, where the compact button's 12px would not.
          trailingIcon !== undefined && 'pr-[11px]',
          // The row's "…" shows on that same axis under the pointer, on
          // keyboard focus, and while its menu is open. A row with no trailing
          // glyph widens its gutter to clear it, the reservation a sidebar
          // row makes for its revealed action; a trailing glyph gives up its
          // place instead, so the label never moves.
          trailingIcon === undefined
            ? cn(
                'transition-[padding] duration-fast group-hover/tree-row:pr-[34px] group-has-[:focus-visible]/tree-row:pr-[34px]',
                menuOpen && 'pr-[34px]',
              )
            : cn(
                '[&_svg:last-of-type]:transition-opacity [&_svg:last-of-type]:duration-fast group-hover/tree-row:[&_svg:last-of-type]:opacity-0 group-has-[:focus-visible]/tree-row:[&_svg:last-of-type]:opacity-0',
                menuOpen && '[&_svg:last-of-type]:opacity-0',
              ),
          // The reveal glyph on a restricted row is a trailing control, not a
          // status: the row already says what it is by carrying a folder glyph
          // where a browsable folder carries its chevron, so it stands only on
          // the selected row. A preparation marker is a status and stays.
          restricted && !selected && '[&_svg:last-of-type]:opacity-0',
        )}
        data-path={row.node.path}
        data-proximity-index={index}
        draggable={draggable}
        leadingIcon={rowIcon(row, expanded)}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onDragEnd={onDragEnd}
        onDragStart={(event) => {
          if (!draggable) {
            event.preventDefault();
            return;
          }
          writeTreeDrag(
            event.dataTransfer,
            row.node.path,
            row.node.type === 'file' ? { folderPath, path: row.node.path } : null,
          );
          onDragStart(row);
        }}
        onFocus={() => onFocus(row.node.path)}
        onKeyDown={(event) => {
          // The keys a context menu is asked for with, answered here on every
          // platform rather than only where the browser maps them to one.
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            onOpenMenu(row, menuButton.current ?? event.currentTarget);
            return;
          }
          onKeyDown(event, row, editable);
        }}
        ref={(button) => {
          element.current = button;
          registerRow(row.node.path, button);
        }}
        role="treeitem"
        size="compact"
        style={
          {
            ...(selected ? {} : { '--hover': 'transparent' }),
            ...rowInset(row.depth),
          } as CSSProperties
        }
        tabIndex={tabStop ? 0 : -1}
        title={rowTitle(row, { marker, revealLabel })}
        {...(trailingIcon === undefined ? {} : { trailingIcon })}
        variant="ghost"
      >
        {row.node.name}
      </Button>
      {/* The row's "…" opens the same menu a right click does. A tree owns
       *  only its rows, so the button stays out of the accessibility tree
       *  and the tab order; the row's menu key is its keyboard way in. It
       *  carries the row's path, so a right click on it opens that row's menu
       *  too. */}
      <SidebarMenuAction
        aria-hidden="true"
        className={cn(
          'opacity-0 group-hover/tree-row:opacity-100 group-has-[:focus-visible]/tree-row:opacity-100',
          menuOpen && 'opacity-100',
        )}
        data-path={row.node.path}
        onClick={(event) => {
          if (menuWasOpen.current) return;
          // Focus goes to the row first, so closing the menu returns it there.
          element.current?.focus();
          onOpenMenu(row, event.currentTarget);
        }}
        onMouseDown={(event) => event.preventDefault()}
        onPointerDown={() => {
          menuWasOpen.current = menuOpen;
        }}
        ref={menuButton}
        tabIndex={-1}
      >
        <MoreHorizontal aria-hidden="true" />
      </SidebarMenuAction>
    </div>
  );
}
