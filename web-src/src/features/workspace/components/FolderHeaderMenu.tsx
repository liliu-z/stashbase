import { useState } from 'react';
import { errorMessage } from '@/common/api/api';
import { electronBridge } from '@/common/lib/electronBridge';
import {
  CaretUpDownIcon,
  CollapseAllIcon,
  ExpandAllIcon,
  ExternalLinkIcon,
  MoreHorizontalIcon,
  NewFolderIcon,
  PreviewIcon,
  StarIcon,
  SyncIcon,
  TrashIcon,
} from '@/common/components/icons';
import type { MenuItem } from '@/common/components/Menu';
import { renderMenuItems } from '@/common/components/menuItemRows';
import {
  Menu,
  MenuPopup,
  MenuPortal,
  MenuPositioner,
  MenuTrigger,
} from '@/common/components/ui/menu';
import { ImportGitHubModal } from '@/features/workspace/components/ImportGitHubModal';
import { useLibraryMembership } from '@/features/workspace/hooks/useLibraryMembership';
import { libraryMenuItems } from '@/features/workspace/lib/libraryMenuItems';
import { nameSetSize } from '@/store/state/state';
import { useAppActions, useWorkspace } from '@/store/contexts/AppContext';

/**
 * The active-folder header's ⋯ menu — an ATTACHED Base UI composition,
 * not a ManagedMenu, because it hosts the one CASCADING submenu in the
 * app: **Change Folder…** flies the library membership out beside the
 * parent, which stays on screen (detached roots cannot do this; see the
 * Submenu note in ui/menu.tsx). Same membership content the titlebar
 * switcher serves (`libraryMenuItems` — one content home on purpose),
 * current folder carrying the accent dot.
 *
 * The window's current folder folds its low-frequency maintenance
 * actions in here — the header row only keeps new-note, history, and
 * this trigger visible, so the folder name keeps its room.
 */
export function FolderHeaderMenu({
  name,
  path,
  favorite,
  canOpenInNewWindow,
  onOpenChange,
  onToggleFavorite,
  onOpenInNewWindow,
  onRemove,
}: {
  name: string;
  /** The window's current folder (absolute path). */
  path: string;
  favorite: boolean;
  /** Desktop only — the browser shell cannot open a second window. */
  canOpenInNewWindow: boolean;
  /** Mirrors the menu's open state so the header can pin its action
   *  cluster visible while the menu is up. */
  onOpenChange: (open: boolean) => void;
  onToggleFavorite: () => void;
  onOpenInNewWindow: () => void;
  /** Asks for the remove confirmation; the owner shows the modal. */
  onRemove: () => void;
}) {
  const state = useWorkspace();
  const { actions, dispatch } = useAppActions();
  const [open, setOpen] = useState(false);
  const [importGitHubOpen, setImportGitHubOpen] = useState(false);

  // Same honesty rule as the titlebar switcher: membership can change
  // without this window acting; poll only while the menu is up.
  useLibraryMembership(open, state.recent, dispatch);

  const switchItems = libraryMenuItems({
    actions,
    bridge: electronBridge(),
    entries: state.recent,
    homeDir: state.homeDir ?? '',
    attention: (memberPath) => state.libraryFolderStatuses[memberPath] === 'failed',
    isCurrent: (memberPath) => memberPath === path,
    onPick: (memberPath) => {
      if (memberPath === path) return;
      void actions.openFolder(memberPath)
        .catch((e) => actions.toast(errorMessage(e), { level: 'error' }));
    },
    onImportGitHub: () => setImportGitHubOpen(true),
  });

  const items: MenuItem[] = [
    /* Navigation leads the menu: with a folder open, this menu is where
     * people look for "switch" (the titlebar trigger alone proved
     * undiscoverable). */
    {
      label: 'Change Folder…',
      icon: <CaretUpDownIcon />,
      detail: 'Open another library folder here',
      items: [...switchItems.pinned, ...switchItems.list],
    },
    { separator: true },
    {
      label: 'New Folder…',
      icon: <NewFolderIcon />,
      /* The action mounts an autofocused inline input — returning focus
       * to the ⋯ trigger would blur it shut on the spot. */
      returnFocus: false,
      onSelect: () => {
        if (state.activeFolder) dispatch({ type: 'EXPAND_FOLDER', path: state.activeFolder });
        dispatch({ type: 'NEW_FOLDER_INPUT', open: true });
      },
    },
    {
      label: 'Sync Folder',
      icon: <SyncIcon />,
      detail: 'Re-scan disk for external changes',
      onSelect: () => { void actions.runSync(); },
    },
    nameSetSize(state.expanded) === 0
      ? {
          label: 'Expand All Folders',
          icon: <ExpandAllIcon />,
          onSelect: () => dispatch({ type: 'EXPAND_ALL_FOLDERS', paths: state.folders.map((f) => f.path) }),
        }
        : {
            label: 'Collapse All Folders',
            icon: <CollapseAllIcon />,
            onSelect: () => dispatch({ type: 'COLLAPSE_ALL_FOLDERS' }),
          },
    {
      label: 'Show Hidden Files',
      icon: <PreviewIcon />,
      detail: 'Dot-folders such as .github, in every window',
      checked: state.showHiddenFiles,
      onSelect: () => { void actions.toggleShowHiddenFiles(); },
    },
    { separator: true },
    {
      label: favorite ? 'Remove from Favorites' : 'Add to Favorites',
      icon: <StarIcon />,
      onSelect: onToggleFavorite,
    },
    ...(canOpenInNewWindow ? [{
      label: 'Open in New Window',
      icon: <ExternalLinkIcon />,
      onSelect: onOpenInNewWindow,
    } satisfies MenuItem] : []),
    { separator: true },
    {
      label: 'Remove from Library',
      icon: <TrashIcon />,
      detail: 'Will not delete local files',
      danger: true,
      onSelect: onRemove,
    },
  ];

  return (
    <>
      <Menu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange(next);
        }}
      >
        <MenuTrigger
          className="inline-grid size-6 flex-none cursor-pointer place-items-center rounded-sm border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground data-[popup-open]:bg-active data-[popup-open]:text-foreground"
          aria-label={`More actions for ${name}`}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontalIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPortal>
          <MenuPositioner side="bottom" align="end" sideOffset={4} collisionPadding={6}>
            <MenuPopup className="flex max-h-overlay-md flex-col" style={{ minWidth: 210 }}>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-quiet">
                {renderMenuItems(items, null)}
              </div>
            </MenuPopup>
          </MenuPositioner>
        </MenuPortal>
      </Menu>
      {importGitHubOpen && (
        <ImportGitHubModal onClose={() => setImportGitHubOpen(false)} />
      )}
    </>
  );
}
