/**
 * The project section of the sidebar: the active folder as a collapsible
 * section header carrying the tree's creates. A window keeps its folder for
 * its life; another folder is another window (File → New Window lands on the
 * welcome screen, where folders are opened, created, imported and removed),
 * so the header offers no way to switch.
 */
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ChevronRight, FilePlus, Folder, FoldVertical, FolderPlus, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Tooltip } from '@/components/ui/tooltip';
import type { ProjectRegistryPort } from '@/features/workspace/application/ports';
import { projectQuery } from '@/features/workspace/application/queries';
import { FOCUS_RING } from '@/lib/focus-ring';
import { fontWeights } from '@/lib/font-weight';
import { useShape } from '@/lib/shape-context';
import { spring } from '@/lib/springs';
import { useMotionTier } from '@/lib/use-motion-tier';
import { cn } from '@/lib/utils';
import { FailureLine } from '@/shared/ui/failure-notice';

export interface ProjectSidebarProps {
  api: ProjectRegistryPort;
  /** The id of the region the header folds, for its `aria-controls`. */
  contentId: string;
  /** Whether the header folds its region and offers the tree's creates
   *  (default true). False in Chats mode: the fold and the creates belong
   *  to the file tree, so the header is the name alone there. */
  foldable?: boolean | undefined;
  /** Starts a new file in the folder, beside the tree's selection. Absent,
   *  the header offers no such action. */
  onNewFile?: (() => void) | undefined;
  /** Starts a new folder in the folder, beside the tree's selection. */
  onNewFolder?: (() => void) | undefined;
  /** Folds every folder in the tree. Offered while the tree is showing. */
  onCollapseAll?: (() => void) | undefined;
  onOpenChange(open: boolean): void;
  /** Whether the folder's section is unfolded. The header is the toggle;
   *  the region it folds is the caller's, beneath it. */
  open: boolean;
}

export function ProjectSidebar({
  api,
  contentId,
  foldable = true,
  onCollapseAll,
  onNewFile,
  onNewFolder,
  onOpenChange,
  open,
}: ProjectSidebarProps) {
  const project = useQuery(projectQuery(api));
  // The section header is the kit's collapsible group label, fed the group
  // context by hand: the region it folds is the sidebar's filling pane
  // column, which a measured-height group could not hold, so the fold lives
  // with the caller and only the header's toggle, chevron, and action
  // reservation come from here. The actions overlaying its end are the
  // creates on offer.
  // The header is its own toggle: the fold chevron rides inline after the
  // name, always showing which way the section stands, and the kit's group
  // label, whose chevron lives at the row's end, is not involved.
  const shape = useShape();
  const pivot = useMotionTier(spring.fast);

  if (project.isPending) return null;

  if (project.isError) {
    return (
      <div className="px-2 py-2">
        <FailureLine className="px-2" tone="capability">
          Projects unavailable.
        </FailureLine>
        <SidebarMenu aria-label="Project recovery" className="mt-1">
          <SidebarMenuItem>
            <SidebarMenuButton
              icon={RefreshCw}
              label="Retry"
              onClick={() => void project.refetch()}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </div>
    );
  }

  const activeFolder = project.data.activeFolder;
  if (!activeFolder) return null;

  // The header's substance: a 32px row, one step over the 28px rows it
  // heads, the folder glyph on the column's 16px glyph line with the name
  // set semibold at the rows' 13px after it, on the rows' own text line, so
  // the identity reads as a heading and not as a stray row. Ink throughout, no fill and no rule:
  // a line under it sat too close to the Chats panel's own.
  const name = (
    <>
      <Folder aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
      <span className="min-w-0 truncate" style={{ fontVariationSettings: fontWeights.semibold }}>
        {activeFolder.name}
      </span>
    </>
  );
  const rowClass = 'h-8 gap-2 text-ui-13 text-foreground';
  const actionsCount = (onNewFile ? 1 : 0) + (onNewFolder ? 1 : 0) + (onCollapseAll ? 1 : 0);

  if (!foldable) {
    return (
      // Chats mode: the name alone, the same row at the same size, with no
      // fold and no creates, since both belong to the file tree.
      <div
        className={cn('flex w-full shrink-0 items-center px-2 select-none', rowClass)}
        data-folder-header=""
        title={activeFolder.name}
      >
        {name}
      </div>
    );
  }

  return (
    // No extra horizontal wrap: the group's own p-2 already gives the 8px
    // inset every other sidebar row uses (footer, tree), and the row's own
    // padding then lands the glyph on the sidebar's shared 16px column, same
    // as the footer rows' glyphs.
    <div className="group/group-header relative w-full">
      {/* The folder is a section header, the way a workspace heads its rows
       *  in a multi-root sidebar: the name in ink, a click folds the content
       *  beneath it, and a chevron right after the name, always showing,
       *  says which way it stands, down when unfolded and right when folded,
       *  the way a chat client's sidebar keeps its chevron beside the name.
       *  It is neither a place the reader is at nor a control that stands
       *  out, so it carries no fill and no current-page claim. Its header
       *  actions overlay the row's end at the rows' own action size, 24px
       *  boxes 4px apart, the pitch a tree row's trailing actions keep:
       *  the basic creates, New file and New folder, and Collapse all while
       *  the tree is showing. Hover is the column's from this row down: the
       *  navigator carries `group/group-header-hover` on the region from the
       *  folder name to the footer, so the pointer anywhere over the
       *  folder's content shows the actions, and the band above and the
       *  footer below leave them be. Focus stays the row's own, through
       *  `group/group-header` here, so a focused view tab or tree row does
       *  not leave the actions standing. */}
      <button
        aria-controls={contentId}
        aria-expanded={open}
        className={cn(
          'flex w-full shrink-0 cursor-pointer items-center px-2 text-left outline-none select-none',
          rowClass,
          FOCUS_RING,
          shape.item,
        )}
        data-folder-header=""
        onClick={() => onOpenChange(!open)}
        // The name stops short of the action cluster: 24px per action plus
        // 4px between, and that gap again before the text, less the 8px the
        // row's own padding already gives: 28n + 6.
        style={{ paddingRight: `${actionsCount * 28 + 6}px` }}
        title={activeFolder.name}
        type="button"
      >
        {name}
        {/* -ml-1 pulls the chevron to 4px behind the name, closer than the
         *  row's 8px gap, so it reads as the name's own mark. One
         *  chevron-right glyph, sprung 90° to point down while unfolded. It
         *  shows with the actions, under the column's hover or a keyboard
         *  focus, and stays while folded as the reopen cue. */}
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          className={cn(
            '-ml-1 inline-flex shrink-0 text-muted-foreground transition-opacity duration-fast',
            'group-hover/group-header:opacity-100 group-hover/group-header-hover:opacity-100 group-has-[:focus-visible]/group-header:opacity-100 pointer-coarse:opacity-100',
            open ? 'opacity-0' : 'opacity-100',
          )}
          transition={pivot}
        >
          <ChevronRight aria-hidden className="size-3.5" strokeWidth={1.5} />
        </motion.span>
      </button>
      {actionsCount > 0 && (
        // Revealed with the column's hover, or with a keyboard focus inside
        // the header (focus-visible, not focus-within: a click on an action
        // leaves focus on it, and the pointer leaving must still take the
        // actions away); a touch pointer has no hover, so it sees them
        // standing. right-1.5 puts the last box's centre 18px in from the
        // row's edge, the axis a tree row's trailing action sits on.
        <div className="absolute inset-y-0 right-1.5 flex items-center gap-1 opacity-0 transition-opacity duration-fast group-hover/group-header:opacity-100 group-hover/group-header-hover:opacity-100 group-has-[:focus-visible]/group-header:opacity-100 pointer-coarse:opacity-100">
          {onNewFile && (
            <Tooltip content="New file" side="bottom">
              <Button
                aria-label="New file"
                className="size-6"
                data-sidebar="group-action"
                onClick={onNewFile}
                size="icon-compact"
                variant="ghost"
              >
                <FilePlus aria-hidden="true" />
              </Button>
            </Tooltip>
          )}
          {onNewFolder && (
            <Tooltip content="New folder" side="bottom">
              <Button
                aria-label="New folder"
                className="size-6"
                data-sidebar="group-action"
                onClick={onNewFolder}
                size="icon-compact"
                variant="ghost"
              >
                <FolderPlus aria-hidden="true" />
              </Button>
            </Tooltip>
          )}
          {onCollapseAll && (
            <Tooltip content="Collapse all" side="bottom">
              <Button
                aria-label="Collapse all folders"
                className="size-6"
                data-sidebar="group-action"
                onClick={onCollapseAll}
                size="icon-compact"
                variant="ghost"
              >
                <FoldVertical aria-hidden="true" />
              </Button>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}
