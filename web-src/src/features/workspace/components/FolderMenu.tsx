import {
  CollapseAllIcon,
  ExpandAllIcon,
  ExternalLinkIcon,
  NewFolderIcon,
  PreviewIcon,
  StarIcon,
  SyncIcon,
  TrashIcon,
} from '@/common/components/icons';
import { useAppActions, useWorkspace } from '@/store/contexts/AppContext';
import { nameSetSize } from '@/store/state/state';
import { Menu, type MenuItem } from '@/common/components/Menu';

/** The ⋯ folder menu shared by the active-folder header and every
 *  library row. The window's current folder folds its low-frequency
 *  maintenance actions in here — the header row only keeps new-note,
 *  history, and this menu visible, so the folder name keeps its room. */
export function FolderMenu({
  rect,
  isCurrent,
  favorite,
  canOpenInNewWindow,
  onToggleFavorite,
  onOpenInNewWindow,
  onRemove,
  onClose,
}: {
  rect: DOMRect;
  /** Whether the menu's folder is the window's current folder. */
  isCurrent: boolean;
  favorite: boolean;
  /** Desktop only — the browser shell cannot open a second window. */
  canOpenInNewWindow: boolean;
  onToggleFavorite: () => void;
  onOpenInNewWindow: () => void;
  /** Asks for the remove confirmation; the owner shows the modal. */
  onRemove: () => void;
  onClose: () => void;
}) {
  const state = useWorkspace();
  const { actions, dispatch } = useAppActions();

  return (
    <Menu
      anchor={{ rect, align: 'right' }}
      minWidth={210}
      items={[
        ...(isCurrent ? [
          {
            label: 'New Folder…',
            icon: <NewFolderIcon />,
            /* The action mounts an autofocused inline input — returning
             * focus to the ⋯ trigger would blur it shut on the spot. */
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
            onSelect: () => { void actions.setShowHiddenFiles(!state.showHiddenFiles); },
          },
          { separator: true },
        ] satisfies MenuItem[] : []),
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
      ] satisfies MenuItem[]}
      onClose={onClose}
    />
  );
}
