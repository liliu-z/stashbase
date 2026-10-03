/**
 * The pieces a popover with a search field over a short list is built from:
 * the keyboard that moves through the rows while focus stays in the field,
 * the field itself at the popover's compact scale, and the popup shell. The
 * chat history popover and the Settings font picker are two such popovers;
 * each keeps its own rows, empty states, and trigger.
 */
import { Popover } from '@base-ui/react/popover';
import { useEffect, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';

import { CommandInput } from '@/components/ui/command-menu';
import { Elevated } from '@/components/ui/elevated';
import { useShape } from '@/lib/shape-context';
import { SizeProvider } from '@/lib/size-context';
import { cn } from '@/lib/utils';
import { listNavigationTarget } from '@/shared/utils/list-cursor';

interface SearchListKeysOptions<Row> {
  readonly field: RefObject<HTMLInputElement | null>;
  readonly open: boolean;
  /** How many rows stand in the list at once, so a page key moves by that. */
  readonly pageSize: number;
  readonly rows: readonly Row[];
  onChoose(row: Row): void;
}

/** The active row, and the field's key handling that moves it and chooses it.
 *  A new list starts at its first row, and the field takes focus on open. */
export function useSearchListKeys<Row>({
  field,
  onChoose,
  open,
  pageSize,
  rows,
}: SearchListKeysOptions<Row>) {
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => setActiveIndex(0), [rows]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => field.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [field, open]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || rows.length === 0) return;
    const selected = rows[activeIndex];
    if (event.key === 'Enter' && selected) {
      event.preventDefault();
      onChoose(selected);
      return;
    }
    const target = listNavigationTarget(event.key, { activeIndex, count: rows.length, pageSize });
    if (target === null) return;
    event.preventDefault();
    setActiveIndex(target);
  };

  return { activeIndex, onKeyDown, setActiveIndex };
}

export interface SearchFieldProps {
  readonly activeIndex: number;
  readonly field: RefObject<HTMLInputElement | null>;
  readonly label: string;
  /** The list's id, which rows derive their own ids from. */
  readonly listId: string;
  readonly placeholder: string;
  readonly query: string;
  readonly rowCount: number;
  onKeyDown(event: KeyboardEvent<HTMLInputElement>): void;
  onQueryChange(query: string): void;
}

/** A combobox pointing at the active row with `aria-activedescendant`. The
 *  palette's prompt height and 14px text belong to the full-size command
 *  palette; here the field takes the rows' 12px, a 32px height, and the
 *  sidebar's 14px search glyph, so it reads at the popover's own scale. */
export function SearchField({
  activeIndex,
  field,
  label,
  listId,
  onKeyDown,
  onQueryChange,
  placeholder,
  query,
  rowCount,
}: SearchFieldProps) {
  return (
    <div className="[&>div]:h-8 [&>div]:px-3 [&>div>svg]:size-3.5">
      <CommandInput
        aria-activedescendant={activeIndex < rowCount ? `${listId}-row-${activeIndex}` : undefined}
        aria-autocomplete="list"
        aria-controls={rowCount > 0 ? listId : undefined}
        aria-expanded={rowCount > 0}
        aria-label={label}
        autoComplete="off"
        className="text-ui-12"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        ref={field}
        role="combobox"
        spellCheck={false}
        value={query}
      />
    </div>
  );
}

/** The popup under a trigger: the kit's menu width and the compact step, so
 *  rows sit on the sidebar's 28px rhythm and the popover reads as one more of
 *  the app's menus rather than the full-size command palette. */
export function SearchPopup({ children, label }: { children: ReactNode; label: string }) {
  const shape = useShape();
  return (
    <Popover.Portal>
      <Popover.Positioner align="end" className="z-50 outline-none" side="bottom" sideOffset={6}>
        <Popover.Popup
          aria-label={label}
          className={cn(
            'flex w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden outline-none',
            shape.container,
          )}
          render={<Elevated offset={2} shadowLevel={3} />}
        >
          <SizeProvider size="compact">{children}</SizeProvider>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  );
}
