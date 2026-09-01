import { useId, type ReactNode } from 'react';

import { FolderIcon, LibraryIcon } from '@/common/components/icons';
import { cn } from '@/common/lib/utils';
import {
  Menu,
  MenuPopup,
  MenuPortal,
  MenuPositioner,
  MenuTrigger,
} from '@/common/components/ui/menu';
import { MenuOptionContent, menuOptionVariants } from '@/common/components/ui/menu-option';
import { MenuRadioGroup, MenuRadioItem, MenuSectionLabel } from '@/common/components/ui/menu-radio';
import { Pill } from '@/common/components/ui/pill';
import { basename, shortenFolderPath } from '@/common/lib/paths';
import {
  folderScope,
  LIBRARY_SCOPE,
  scopeDisplayName,
  type LibraryFolderOption,
  type LibraryScope,
} from '@/common/lib/libraryScope';

/** Radio value standing in for the whole-Library choice. Folder values are
 *  absolute paths, so this spelling can never collide with one. */
const LIBRARY_VALUE = '__library__';

/**
 * The app's ONE scope picker: the whole Library, or one library folder.
 * Both surfaces that pick a scope share it — the chat composer (which
 * scope a new session binds) and the search popup (which folder a search
 * covers) — so the two read as the same control with the same rows,
 * ordering, and states rather than two lookalikes that drift.
 *
 * Callers vary only the copy (`heading`, `libraryDetail`), the side the
 * popup opens toward, whether the trigger is locked (the composer locks it
 * once a conversation has content — a chat never rebinds), and an optional
 * `footer` section pinned below the list.
 *
 * `footer` exists for Chat controls whose meaning is inseparable from the
 * selected scope: retrieval answers how matching works, while Agent
 * Instructions edit durable guidance for that exact scope. It is a slot
 * rather than a built-in section so this stays the scope picker: the caller
 * owns what goes in it, and the search popup passes nothing.
 *
 * A locked scope no longer kills the trigger when a footer is present.
 * The lock is a rule about the scope VALUE, not about reading the binding,
 * and a menu holding independent scope controls has to stay openable for the
 * life of the conversation. Locked rows go inert in place and say why.
 */
export function ScopeMenu({
  scope,
  entries,
  homeDir,
  heading,
  libraryDetail,
  side = 'top',
  ariaLabel,
  locked = false,
  disabled = false,
  triggerClassName,
  footer,
  onSetScope,
}: {
  scope: LibraryScope;
  entries: LibraryFolderOption[];
  homeDir: string;
  /** Menu title, e.g. "Session scope" / "Search scope". */
  heading: string;
  /** Second line on the Library row, e.g. "Search every folder". */
  libraryDetail: string;
  side?: 'top' | 'bottom';
  ariaLabel?: string;
  locked?: boolean;
  disabled?: boolean;
  triggerClassName?: string;
  /** Caller-owned section pinned below the scrolling scope list. */
  footer?: ReactNode;
  onSetScope: (scope: LibraryScope) => void;
}) {
  const headingId = useId();
  const isLibrary = scope.kind === 'library';
  // Something in the popup is still actionable, so the trigger stays live
  // and keeps a normal pill's weight rather than a settled value's dimming.
  const openable = Boolean(footer);
  return (
    <Menu>
      <MenuTrigger
        render={<Pill locked={locked && !openable} className={cn('max-w-40', triggerClassName)} />}
        disabled={disabled || (locked && !openable)}
        aria-label={ariaLabel ?? heading}
        title={isLibrary
          ? `${heading} — the whole library`
          : `${heading} — ${shortenFolderPath(scope.path, homeDir)}`}
      >
        {scopeDisplayName(scope)}
      </MenuTrigger>
      <MenuPortal>
        <MenuPositioner side={side} align="start" sideOffset={6} collisionPadding={8}>
          {/* `w-overlay-md` is the menu step (the rows carry a folder name
            * over its shortened path, so this is a dialog-column measure,
            * not an anchored strip). It replaces a hand-typed `w-85` plus
            * its own `calc(100vw-24px)` clamp — a fourth spelling of the
            * 16px-a-side margin every other floating surface gets free
            * from `--overlay-fit`, and 4px tighter than all of them. */}
          {/* The popup is named BY its own visible title rather than by a
            * second copy of the same string in an `aria-label`: one label
            * doing both jobs cannot drift out of step with the text beside
            * it. The trigger keeps its `aria-label` — its visible text is
            * the current scope, not the question. */}
          {/* The list scrolls, the footer does not: a pinned section that
            * scrolls out of reach behind a long folder list is a setting
            * the user cannot find twice. */}
          <MenuPopup className="max-h-overlay-sm w-overlay-md p-0" aria-labelledby={headingId}>
            <div className="min-h-0 flex-1 overflow-auto p-1.5">
              {/* The heading is the popup's (and the radio group's) name, not
                * a menu item of its own — `presentation` keeps this row out of
                * the menu's item semantics. */}
              <div role="presentation" className="flex flex-col items-start gap-0.5 px-2 pt-1 pb-2 text-sm">
                <span id={headingId} className="font-semibold text-foreground">{heading}</span>
                {locked && (
                  <span className="text-xs font-normal text-muted-foreground">Set for this conversation</span>
                )}
              </div>
              {/* One single-choice set, so `menuitemradio` rows in a radio
                * group rather than plain menu items with a decorative check:
                * the current scope reads back as `aria-checked`, not as a
                * styling difference only sighted users get. The rows keep the
                * `MenuOption` look by wearing its variant classes; the check
                * glyph now comes from the radio primitive's own indicator
                * (`pr-8` clears its lane on the checked row only, matching
                * the old inline-check layout on unchecked rows). */}
              <MenuRadioGroup
                aria-labelledby={headingId}
                className="flex flex-col gap-px"
                value={isLibrary ? LIBRARY_VALUE : scope.path}
                onValueChange={(value) => onSetScope(
                  value === LIBRARY_VALUE ? LIBRARY_SCOPE : folderScope(String(value)),
                )}
              >
                <MenuRadioItem
                  value={LIBRARY_VALUE}
                  label="Library"
                  closeOnClick
                  disabled={locked}
                  className={cn(menuOptionVariants({ active: isLibrary }), isLibrary && 'pr-8')}
                >
                  <MenuOptionContent icon={LibraryIcon} title="Library" description={libraryDetail} />
                </MenuRadioItem>
                {entries.length > 0 && <MenuSectionLabel>Folders</MenuSectionLabel>}
                {entries.map((entry) => {
                  const active = scope.kind === 'folder' && scope.path === entry.path;
                  return (
                    <MenuRadioItem
                      key={entry.path}
                      value={entry.path}
                      label={basename(entry.path)}
                      closeOnClick
                      disabled={locked}
                      className={cn(menuOptionVariants({ active }), active && 'pr-8')}
                    >
                      <MenuOptionContent
                        icon={FolderIcon}
                        title={basename(entry.path)}
                        description={shortenFolderPath(entry.path, homeDir)}
                      />
                    </MenuRadioItem>
                  );
                })}
              </MenuRadioGroup>
            </div>
            {footer && (
              <div className="shrink-0 border-t border-border p-1.5">{footer}</div>
            )}
          </MenuPopup>
        </MenuPositioner>
      </MenuPortal>
    </Menu>
  );
}
