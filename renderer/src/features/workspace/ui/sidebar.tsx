/**
 * The project section of the sidebar: the active folder as a collapsible
 * section header carrying the tree's creates, whose name is the project
 * switcher. A window keeps its folder for its life, so another project opens
 * in its own window, or focuses the window already showing it; removing a
 * project stays on the welcome screen.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FilePlus,
  Folder,
  FolderDown,
  FolderOpen,
  FoldVertical,
  FolderPlus,
  Plus,
  RefreshCw,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownContent,
  DropdownMenu,
  DropdownSeparator,
  DropdownTrigger,
} from '@/components/ui/dropdown';
import { MenuItem } from '@/components/ui/menu-item';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Tooltip } from '@/components/ui/tooltip';
import type { ProjectRegistryPort } from '@/features/workspace/application/ports';
import { projectQuery } from '@/features/workspace/application/queries';
import {
  displayFolderPath,
  folderName,
  isTemporaryFolderPath,
  parentFolderPath,
} from '@/features/workspace/domain/project';
import type { ProjectEntry } from '@/features/workspace/hooks/use-project-entry';
import { FOCUS_RING } from '@/lib/focus-ring';
import { fontWeights } from '@/lib/font-weight';
import { useShape } from '@/lib/shape-context';
import { spring } from '@/lib/springs';
import { useMotionTier } from '@/lib/use-motion-tier';
import { cn } from '@/lib/utils';
import { useRequestSignals } from '@/shared/runtime/use-request-signals';
import { FailureLine } from '@/shared/ui/failure-notice';

export interface ProjectSidebarProps {
  api: ProjectRegistryPort;
  /** The id of the region the header folds, for its `aria-controls`. */
  contentId: string;
  /** The window's one entry operation, shared with Welcome, which the
   *  switcher's rows start. */
  entry: ProjectEntry;
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
  /** The platform's name for showing a folder in its file manager. */
  revealLabel: string;
}

/** Enough recent projects to switch between without the menu scrolling;
 *  the rest stay on the welcome screen. */
const RECENT_LIMIT = 8;
/** The menu hangs off the sidebar's header, so its rows keep the sidebar's
 *  8px inset and glyph gap, as the account menu at the column's foot does. */
const MENU_ROW = 'gap-2 px-2';

export function ProjectSidebar({
  api,
  contentId,
  entry,
  onCollapseAll,
  onNewFile,
  onNewFolder,
  onOpenChange,
  open,
  revealLabel,
}: ProjectSidebarProps) {
  const project = useQuery(projectQuery(api));
  // A second reveal replaces the one still in flight, and unmounting drops it.
  const signalFor = useRequestSignals<'reveal'>();
  const reveal = useMutation({
    mutationFn: (path: string) => api.revealFolder(path, signalFor('reveal')),
  });
  // The section header is the kit's collapsible group label, fed the group
  // context by hand: the region it folds is the sidebar's filling pane
  // column, which a measured-height group could not hold, so the fold lives
  // with the caller and only the header's toggle, chevron, and action
  // reservation come from here. The actions overlaying its end are the
  // creates on offer.
  // The fold is the leading glyph's, since the name opens the switcher; the
  // kit's group label, whose chevron lives at the row's end, is not involved.
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

  const { activeFolder, homeDirectory } = project.data;
  if (!activeFolder) return null;
  // The same memory of places Welcome lists, without the scratch folders a
  // smoke test or an import registers.
  const recent = project.data.projects
    .filter((member) => !isTemporaryFolderPath(member.path))
    .slice(0, RECENT_LIMIT);
  const names = recent.map((member) => folderName(member.path));
  const sharedNames = new Set(names.filter((name, index) => names.indexOf(name) !== index));
  const actionsCount = (onNewFile ? 1 : 0) + (onNewFolder ? 1 : 0) + (onCollapseAll ? 1 : 0);

  return (
    // No extra horizontal wrap: the group's own p-2 already gives the 8px
    // inset every other sidebar row uses (footer, tree), and the trigger's own
    // padding then lands the glyph on the sidebar's shared 16px column, same
    // as the footer rows' glyphs.
    <div className="group/group-header relative w-full">
      {/* The folder heads its rows the way a workspace heads a document
       *  tool's sidebar: the name, with a muted chevron-down after it, is
       *  the project switcher, and the folder glyph before it is the fold,
       *  turning into a chevron while the pointer is over the row or the
       *  section is folded, the way a page icon becomes its toggle. A fold
       *  chevron after the name read as the switcher's own mark. Its header
       *  actions overlay the row's end at the rows' own action size, 24px
       *  boxes 4px apart: the basic creates, New file and New folder, and
       *  Collapse all while the tree is showing. Hover is the column's from
       *  this row down for the actions: the navigator carries
       *  `group/group-header-hover` on the region from the folder name to
       *  the footer. The glyph's swap answers this row alone, so a pointer
       *  over the tree leaves the folder a folder. */}
      <div
        className="flex h-8 w-full items-center"
        data-folder-header=""
        // The name stops short of the action cluster: 24px per action plus
        // 4px between, and that gap again before the text.
        style={{ paddingRight: `${actionsCount * 28 + 6}px` }}
      >
        {/* ml-[5px] and the 20px box put the 14px glyph at the row's 8px
         *  inset, the column's shared 16px glyph line. */}
        <button
          aria-controls={contentId}
          aria-expanded={open}
          aria-label={open ? 'Fold project' : 'Unfold project'}
          className={cn(
            'relative ml-[5px] inline-grid size-5 shrink-0 cursor-pointer place-items-center text-foreground outline-none',
            FOCUS_RING,
            shape.item,
          )}
          onClick={() => onOpenChange(!open)}
          type="button"
        >
          <Folder
            aria-hidden
            className={cn(
              'col-start-1 row-start-1 size-3.5 transition-opacity duration-fast',
              open
                ? 'group-hover/group-header:opacity-0 group-has-[:focus-visible]/group-header:opacity-0'
                : 'opacity-0',
            )}
            strokeWidth={2}
          />
          {/* One chevron-right glyph, sprung 90° to point down while
           *  unfolded, so it says which way the section stands. */}
          <motion.span
            animate={{ rotate: open ? 90 : 0 }}
            className={cn(
              'col-start-1 row-start-1 inline-flex text-muted-foreground transition-opacity duration-fast',
              open
                ? 'opacity-0 group-hover/group-header:opacity-100 group-has-[:focus-visible]/group-header:opacity-100'
                : 'opacity-100',
            )}
            transition={pivot}
          >
            <ChevronRight aria-hidden className="size-3.5" strokeWidth={1.5} />
          </motion.span>
        </button>
        <DropdownMenu disabled={entry.isPending}>
          <DropdownTrigger
            render={
              <button
                aria-label={`Switch project: ${activeFolder.name}`}
                className={cn(
                  // ml-0.5 and pl-[3px] land the name 8px past the glyph,
                  // the gap every sidebar row keeps, with the hover fill
                  // clear of the glyph's own box.
                  'ml-0.5 flex h-7 min-w-0 cursor-pointer items-center gap-1 pr-1.5 pl-[3px] text-left text-ui-13 text-foreground outline-none select-none hover:bg-hover data-[popup-open]:bg-hover',
                  FOCUS_RING,
                  shape.item,
                )}
                title={activeFolder.path}
                type="button"
              />
            }
          >
            {/* The header's substance: a 32px row, one step over the 28px
             *  rows it heads, the name set semibold at the rows' 13px, so
             *  the identity reads as a heading and not as a stray row. */}
            <span
              className="min-w-0 truncate"
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {activeFolder.name}
            </span>
            <ChevronDown
              aria-hidden
              className="size-3 shrink-0 text-muted-foreground"
              strokeWidth={1.5}
            />
          </DropdownTrigger>
          <DropdownContent align="start" className="w-72">
            {recent.map((member) => (
              <MenuItem
                checked={member.path === activeFolder.path}
                className={MENU_ROW}
                // A choice that takes the reader elsewhere: the menu is done
                // either way, unlike a radio that stays to be changed again.
                closeOnClick
                // Distinct folders may share a name; only then does the
                // directory each sits in say which is which. The full path
                // is the row's title either way.
                {...(sharedNames.has(folderName(member.path)) && {
                  description: displayFolderPath(parentFolderPath(member.path), homeDirectory),
                })}
                key={member.path}
                label={folderName(member.path)}
                // Another project opens in its own window, or focuses the
                // window already showing it; this one keeps its folder.
                onSelect={() => {
                  if (member.path !== activeFolder.path) entry.select(member.path);
                }}
                title={member.path}
              />
            ))}
            {recent.length > 0 && <DropdownSeparator />}
            {/* The one row about this project rather than another: where its
             *  folder sits on disk, which the name alone does not say. */}
            <MenuItem
              className={MENU_ROW}
              icon={ExternalLink}
              label={revealLabel}
              onSelect={() => reveal.mutate(activeFolder.path)}
            />
            <DropdownSeparator />
            <MenuItem
              className={MENU_ROW}
              icon={FolderOpen}
              label="Open project…"
              onSelect={entry.open}
            />
            <MenuItem
              className={MENU_ROW}
              icon={Plus}
              label="Create project…"
              onSelect={() => entry.create(homeDirectory)}
            />
            <MenuItem
              className={MENU_ROW}
              icon={FolderDown}
              label="Import from GitHub…"
              onSelect={entry.importDialog.start}
            />
          </DropdownContent>
        </DropdownMenu>
      </div>
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
      {entry.failure && (
        <FailureLine className="px-2 pb-1" tone="input">
          {entry.failure}
        </FailureLine>
      )}
      {reveal.isError && (
        <FailureLine className="px-2 pb-1" tone="input">
          The project folder could not be shown. Check that it is still available.
        </FailureLine>
      )}
    </div>
  );
}
