/**
 * Public surface of the Workspace feature — the folder/tab/library
 * chrome the shell lays out around a document.
 *
 * `workspace.css` rides the barrel because every surface below is styled
 * by it and none of them is optional; importing the barrel is what puts
 * the stylesheet in the graph, so no consumer has to remember it.
 *
 * Everything here is eager on purpose: each surface is either always
 * mounted (splitters, folder switcher) or mounted the moment the window
 * resolves its folder state (the file tree) or opens a tab, so a lazy
 * boundary would only add a flash.
 */
import { lazyWithRetry } from '@/common/components/ErrorBoundary';
import './workspace.css';

export { EmptyTabLanding } from '@/features/workspace/components/EmptyTabLanding';
/* Lazy like the account row: the ⋯ menu is an ATTACHED Base UI
 * composition (it hosts the app's one cascading submenu), and mounting
 * it eagerly would charge Base UI's whole menu + floating machinery to
 * the initial chunk. The Suspense fallback is the caller's problem —
 * a hover-revealed trigger tolerates a late mount invisibly. */
export const FolderHeaderMenu = lazyWithRetry(() =>
  import('@/features/workspace/components/FolderHeaderMenu').then((mod) => ({ default: mod.FolderHeaderMenu })));
export { FileTree } from '@/features/workspace/components/FileTree';
export { FolderSwitcher } from '@/features/workspace/components/FolderSwitcher';
export { MoveFilePicker } from '@/features/workspace/components/MoveFilePicker';
export { RemoveFolderModal } from '@/features/workspace/components/RemoveFolderModal';
export { TabStrip } from '@/features/workspace/components/TabStrip';
export { ChatSplitter, SidebarSplitter } from '@/features/workspace/components/WorkspaceSplitters';

export { useFolderFavorite } from '@/features/workspace/hooks/useFolderFavorite';
export { useFolderRemoval } from '@/features/workspace/hooks/useFolderRemoval';
export { useGlobalDragDrop } from '@/features/workspace/hooks/useGlobalDragDrop';
export { useLibraryReconcile } from '@/features/workspace/hooks/useLibraryReconcile';
export { useOpenFolderWindow } from '@/features/workspace/hooks/useOpenFolderWindow';

export { openMoveFilePicker } from '@/features/workspace/lib/moveFilePickerTrigger';
/* The two core add-folder flows, shared so the sidebar's Choose Folder
 * row and the switcher menu serve the same implementation. */
export { folderPickerFlows } from '@/features/workspace/lib/addFolderMenu';

/* `refreshLibraryMembership` (lib/libraryMembership.ts) is deliberately
 * absent: the membership resync is a consequence of a folder mutation,
 * never a step a caller sequences itself, so the hooks above own it and
 * the shell reaches it only by using one of them. */
