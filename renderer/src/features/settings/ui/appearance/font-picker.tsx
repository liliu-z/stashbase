/**
 * A font choice from the fonts on this computer: a trigger that names the
 * current family, and a popover with a search field and the families to
 * choose from, each with a sample drawn in its own face. The fonts StashBase
 * ships come first, so a choice that looks the same on every computer is
 * always at hand; a chosen family that has since been uninstalled is kept and
 * marked.
 */
import { Popover } from '@base-ui/react/popover';
import { ChevronDown } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { CommandItem, CommandList } from '@/components/ui/command-menu';
import type { IncludedFont, SystemFont } from '@/features/settings/domain/appearance';
import { SearchField, SearchPopup, useSearchListKeys } from '@/shared/ui/search-popover';

/** A few hundred rows draw at once; the search field narrows the rest. */
const ROW_LIMIT = 200;
const ROW_PAGE_SIZE = 8;

type FontRow =
  | { readonly kind: 'included'; readonly font: IncludedFont; readonly note: string }
  | { readonly kind: 'installed'; readonly family: string; readonly note: string | null };

const rowName = (row: FontRow) => (row.kind === 'included' ? row.font.label : row.family);

export interface FontPickerProps {
  readonly disabled?: boolean;
  /** The fonts StashBase ships, listed first. */
  readonly included: readonly IncludedFont[];
  /** The included font in use while no installed font is chosen. */
  readonly includedValue: string | null;
  /** Null while the list is loading or where this build cannot list fonts. */
  readonly installed: readonly SystemFont[] | null;
  readonly installedFailure?: string | null;
  readonly label: string;
  /** Only monospaced families, for the code font. */
  readonly monospaceOnly?: boolean;
  /** The installed family chosen, or null for the included font. */
  readonly value: string | null;
  onChooseIncluded(value: string): void;
  onChooseInstalled(family: string): void;
}

export function FontPicker({
  disabled = false,
  included,
  includedValue,
  installed,
  installedFailure = null,
  label,
  monospaceOnly = false,
  onChooseIncluded,
  onChooseInstalled,
  value,
}: FontPickerProps) {
  const listId = useId();
  const searchField = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const current =
    value ??
    included.find((font) => font.value === includedValue)?.label ??
    included[0]?.label ??
    '';
  const missing =
    value !== null && installed !== null && !installed.some((font) => font.family === value);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (family: string) => needle === '' || family.toLowerCase().includes(needle);
    const all: FontRow[] = [
      ...included.map((font) => ({ font, kind: 'included' as const, note: 'Included' })),
      ...(missing && value
        ? [{ family: value, kind: 'installed' as const, note: 'Not installed' }]
        : []),
      ...(installed ?? [])
        .filter((font) => !monospaceOnly || font.monospace)
        .filter((font) => !included.some((own) => own.label === font.family))
        .map((font) => ({ family: font.family, kind: 'installed' as const, note: null })),
    ];
    return all.filter((row) => matches(rowName(row))).slice(0, ROW_LIMIT);
  }, [included, installed, missing, monospaceOnly, query, value]);

  const choose = (row: FontRow) => {
    setOpen(false);
    if (row.kind === 'included') onChooseIncluded(row.font.value);
    else onChooseInstalled(row.family);
  };

  const { activeIndex, onKeyDown, setActiveIndex } = useSearchListKeys({
    field: searchField,
    onChoose: choose,
    open,
    pageSize: ROW_PAGE_SIZE,
    rows,
  });

  return (
    <Popover.Root
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
      open={open}
    >
      <Popover.Trigger
        disabled={disabled}
        render={
          <Button
            aria-label={`${label}: ${current}${missing ? ' (not installed)' : ''}`}
            className="w-56 justify-between"
            size="compact"
            trailingIcon={ChevronDown}
            variant="tertiary"
          />
        }
      >
        <span className="min-w-0 flex-1 truncate text-left">{current}</span>
      </Popover.Trigger>
      <SearchPopup label={label}>
        <SearchField
          activeIndex={activeIndex}
          field={searchField}
          label={`Search ${label.toLowerCase()}s`}
          listId={listId}
          onKeyDown={onKeyDown}
          onQueryChange={setQuery}
          placeholder="Search fonts"
          query={query}
          rowCount={rows.length}
        />
        {installed === null && !installedFailure && (
          <p className="px-4 py-2 text-caption text-muted-foreground" role="status">
            Finding installed fonts…
          </p>
        )}
        {installedFailure && (
          <p className="px-4 py-2 text-caption text-muted-foreground" role="status">
            {installedFailure}
          </p>
        )}
        {rows.length === 0 ? (
          <p className="px-4 py-3 text-caption text-muted-foreground" role="status">
            No matching fonts.
          </p>
        ) : (
          <CommandList
            activeIndex={activeIndex}
            aria-label={label}
            className="max-h-72"
            id={listId}
            onActiveIndexChange={setActiveIndex}
          >
            {rows.map((row, index) => {
              const name = rowName(row);
              return (
                <CommandItem
                  aria-label={row.note ? `${name}, ${row.note}` : name}
                  id={`${listId}-row-${index}`}
                  key={`${row.kind}:${name}`}
                  onClick={() => choose(row)}
                >
                  <span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
                  {row.note && (
                    <span className="shrink-0 text-caption text-muted-foreground">{row.note}</span>
                  )}
                  {/* The sample, not the name, wears the face: a symbol font
                      would otherwise spell its own name in icons. */}
                  <span
                    aria-hidden="true"
                    className="w-8 shrink-0 text-right text-ui-15 text-foreground"
                    style={{
                      fontFamily:
                        row.kind === 'included'
                          ? row.font.fontFamily
                          : `"${row.family}", var(--font-sans)`,
                    }}
                  >
                    Aa
                  </span>
                </CommandItem>
              );
            })}
          </CommandList>
        )}
      </SearchPopup>
    </Popover.Root>
  );
}
