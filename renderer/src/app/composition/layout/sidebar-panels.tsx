import { FileText, FolderTree, ListTree, MessageSquare, Search } from 'lucide-react';
import type { ReactNode } from 'react';

import type {
  SidebarMode,
  SidebarPanelId,
} from '@/app/composition/commands/use-workspace-commands';
import {
  DocumentOutline,
  DocumentOutlineEmpty,
  type DocumentTabsRuntime,
} from '@/features/documents/public';
import type { IconComponent } from '@/lib/icon-context';

export interface SidebarModeEntry {
  icon: IconComponent;
  id: SidebarMode;
  label: string;
}

export interface SidebarPanel {
  /** True when the panel takes the whole column instead of sitting inside the
   *  scrolling tree region. */
  hidesTree: boolean;
  icon: IconComponent;
  id: SidebarPanelId;
  /** Shortcut announced on the tab, when the panel has one. */
  keyshortcuts?: string;
  label: string;
  /** What the tab's tooltip says; defaults to the label. */
  hint?: string;
  /** The mode the panel shows under. A mode with one panel shows it without
   *  a tab strip; a mode with several puts them in one. */
  mode: SidebarMode;
  /** `active` is true only for the selected panel, so a panel that is
   *  expensive to mount can stay unmounted until it is asked for. */
  render(active: boolean): ReactNode;
}

export interface SidebarPanelSources {
  chats: ReactNode;
  files: ReactNode;
  outline: DocumentTabsRuntime | null;
  search: ReactNode;
}

/**
 * The sidebar's modes, in the order the band's switch shows them. Documents
 * gathers the panels about the folder's files; Chats is the folder's
 * conversations.
 */
export const sidebarModes: readonly SidebarModeEntry[] = [
  { icon: FileText, id: 'documents', label: 'Documents' },
  { icon: MessageSquare, id: 'chats', label: 'Chats' },
];

/**
 * The sidebar's panels, in tab order.
 *
 * This list is the whole definition of the navigator: adding a panel is one
 * entry here, and nothing downstream counts tabs or compares indices. Files,
 * Document outline, and Search are the Documents mode and share its tab
 * strip; Chats is a mode of its own with no strip. Files and Document outline
 * share the scrolling tree region; Search and Chats replace it, which is what
 * `hidesTree` says.
 */
export function sidebarPanels({
  chats,
  files,
  outline,
  search,
}: SidebarPanelSources): SidebarPanel[] {
  return [
    {
      hidesTree: false,
      icon: FolderTree,
      id: 'files',
      label: 'Files',
      mode: 'documents',
      render: () => files,
    },
    {
      hidesTree: false,
      icon: ListTree,
      id: 'outline',
      label: 'Document outline',
      mode: 'documents',
      // Mounted only while shown: a long document's outline is hundreds of rows.
      render: (active) =>
        active ? outline ? <DocumentOutline runtime={outline} /> : <DocumentOutlineEmpty /> : null,
    },
    {
      hidesTree: true,
      hint: 'Search · Cmd/Ctrl Shift F',
      icon: Search,
      id: 'search',
      keyshortcuts: 'Meta+Shift+F Control+Shift+F',
      label: 'Search',
      mode: 'documents',
      render: () => search,
    },
    {
      hidesTree: true,
      icon: MessageSquare,
      id: 'chats',
      label: 'Chats',
      mode: 'chats',
      render: (active) => (active ? chats : null),
    },
  ];
}
