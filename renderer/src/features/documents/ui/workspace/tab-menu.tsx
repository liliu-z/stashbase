/** The open documents' tab menu: what a right click, the menu key or
 *  Shift+F10 offers on a tab. Closing is the strip's own business; showing the
 *  file on disk and copying its path come from the app, which owns those
 *  host adapters. It is drawn by the shared menu surface, so it reads as the
 *  file tree's menu does. */
import { Copy, ExternalLink, X, type LucideIcon } from 'lucide-react';
import { useState } from 'react';

import {
  DropdownContent,
  DropdownMenu,
  DropdownSeparator,
  type DropdownAnchor,
} from '@/components/ui/dropdown';
import { MenuItem } from '@/components/ui/menu-item';
import { isExternalSource } from '@/shared/domain/external-source';
import type { SourceReference } from '@/shared/domain/source-reference';

/** What the app lends the tab menu for the file behind a tab. */
export interface DocumentTabMenuActions {
  /** Puts the file's path on the clipboard, from the disk root or from the
   *  project folder. */
  onCopyPath(source: SourceReference, form: 'absolute' | 'relative'): void;
  /** Shows the file in the system file manager. */
  onReveal(source: SourceReference): void;
  revealLabel: string;
}

/** The close commands the strip answers for one tab. */
export interface DocumentTabCloseCommands {
  close(): void;
  closeAll(): void;
  /** Absent when no other tab is open. */
  closeOthers: (() => void) | null;
  /** Absent when the tab is the last one. */
  closeToRight: (() => void) | null;
}

interface MenuAction {
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  run(): void;
}

type MenuRow = MenuAction | 'separator';

function tabMenuRows(
  source: SourceReference,
  commands: DocumentTabCloseCommands,
  actions: DocumentTabMenuActions | undefined,
): MenuRow[] {
  const rows: MenuRow[] = [
    { icon: X, label: 'Close', run: commands.close },
    {
      disabled: !commands.closeOthers,
      icon: X,
      label: 'Close others',
      run: () => commands.closeOthers?.(),
    },
    {
      disabled: !commands.closeToRight,
      icon: X,
      label: 'Close to the right',
      run: () => commands.closeToRight?.(),
    },
    { icon: X, label: 'Close all', run: commands.closeAll },
  ];
  if (!actions) return rows;
  rows.push(
    'separator',
    { icon: ExternalLink, label: actions.revealLabel, run: () => actions.onReveal(source) },
    { icon: Copy, label: 'Copy path', run: () => actions.onCopyPath(source, 'absolute') },
  );
  // A file opened from outside the project has no project-relative path.
  if (!isExternalSource(source)) {
    rows.push({
      icon: Copy,
      label: 'Copy relative path',
      run: () => actions.onCopyPath(source, 'relative'),
    });
  }
  return rows;
}

/** The tab the menu is showing for, kept through the close so its rows do not
 *  change under the exit. */
export interface ShownTabMenu {
  anchor: DropdownAnchor;
  tabId: string;
}

export function useTabMenu() {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<ShownTabMenu | null>(null);
  return {
    open,
    setOpen,
    shown,
    show(next: ShownTabMenu) {
      setShown(next);
      setOpen(true);
    },
  };
}

/** One menu for the whole strip, so a single popup serves every tab. */
export function DocumentTabMenu({
  actions,
  commands,
  menu,
  name,
  source,
}: {
  actions: DocumentTabMenuActions | undefined;
  commands: DocumentTabCloseCommands;
  menu: ReturnType<typeof useTabMenu>;
  name: string;
  source: SourceReference;
}) {
  const rows = tabMenuRows(source, commands, actions);
  return (
    <DropdownMenu onOpenChange={menu.setOpen} open={menu.open}>
      <DropdownContent
        align="start"
        anchor={menu.shown?.anchor ?? null}
        aria-label={`${name} tab actions`}
        className="w-56"
      >
        {rows.map((row, index) =>
          row === 'separator' ? (
            <DropdownSeparator key={`after-${(rows[index - 1] as MenuAction).label}`} />
          ) : (
            <MenuItem
              disabled={row.disabled ?? false}
              icon={row.icon}
              key={row.label}
              label={row.label}
              onSelect={row.run}
            />
          ),
        )}
      </DropdownContent>
    </DropdownMenu>
  );
}
