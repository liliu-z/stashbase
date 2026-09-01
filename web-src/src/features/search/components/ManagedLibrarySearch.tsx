import type { ReactNode } from 'react';
import { useWorkspace } from '@/store/contexts/AppContext';
import type { LibrarySearchMode, LibrarySearchPrefill } from '@/common/lib/librarySearchTrigger';
import { SegmentedControl, SegmentedControlItem } from '@/common/components/ui/segmented-control';
import { basename } from '@/common/lib/paths';
import { cn } from '@/common/lib/utils';
import { EmptyState } from '@/common/components/ui/empty-state';
import { fileGlyphFormat } from '@/common/lib/fileGlyphFormat';
import { useFocusTrap } from '@/common/hooks/useFocusTrap';
import { folderMenuEntries } from '@/common/lib/libraryScope';
import { ScopeMenu } from '@/common/components/ScopeMenu';
import { FileTypeIcon } from '@/common/components/FileTypeIcon';
import { SemanticIndexingNoticeView } from '@/common/components/SemanticIndexingNotice';
import { useSemanticIndexingNotice } from '@/store/hooks/useSemanticIndexingNotice';
import { PICKER_VEIL_CLASS, pickerPanelClass } from '@/common/lib/pickerChrome';
import { folderBasename } from '@/features/search/lib/librarySearch';
import { highlightRanges } from '@/features/search/lib/highlightRanges';
import { EMBEDDER_KEY_ERROR, useLibrarySearchController } from '@/features/search/hooks/useLibrarySearchController';
import { SearchStatusBanner } from '@/features/search/components/SearchStatusBanner';
import { SemanticHitRow } from '@/features/search/components/SemanticHitRow';
import { openEmbeddingSetup } from '@/common/lib/embeddingSetupTrigger';

/**
 * The library search popup — the app's one search surface. A palette-style
 * modal (Quick Open chrome) over the WHOLE library by default, narrowable to
 * any one library folder through the shared `ScopeMenu` — the same picker,
 * folder list, and rows the chat composer binds a session with. Query, mode,
 * toggles, scope, and results live in module memory (`librarySearch.ts`),
 * never in the reducer, so the popup survives close/reopen and folder
 * switches.
 *
 * Behaviour lives in `useLibrarySearchController`; this file is the chrome
 * plus the two result lists, which are tightly bound to this JSX tree.
 *
 * Opening a result NEVER switches the window's folder: a hit in the active
 * folder opens normally; a hit in another member folder opens as an
 * out-of-folder read-only tab (`actions.openLibraryFile`), which carries its
 * own "open that folder in a new window" affordance in the document banner.
 * Only from the no-folder workspace does a pick bind the folder — there is
 * no context to preserve there.
 */

/* The results scroller's inset, named once because the semantic and the
 * keyword branch each render their own list and the two must not drift
 * apart. Two padding utilities are not a component. */
const HIT_LIST_CLASS = 'px-1.5 py-1';

/** Search-mode segments: the primitive's chunky pressed treatment (bold +
 *  raised shadow) turned down to a quiet swap of surface and colour. It is
 *  a className on `SegmentedControlItem`, which already owns the control —
 *  this is the turn-down, not a control of its own. */
const SEARCH_MODE_SEGMENT_CLASS =
  'px-2 py-0.5 text-xs font-normal data-pressed:font-normal data-pressed:shadow-none';

/** Folder band above each group — the quiet section-strip treatment the
 *  sidebar uses, so "this run of results lives here" reads as structure
 *  rather than as another result. A `<div>` with one text child in two
 *  branches of this file: a component would add an element that forwards
 *  a string. */
const FOLDER_HEADER_CLASS =
  'sticky top-0 z-1 -mx-1.5 bg-card/95 px-4 pt-2 pb-1 text-xs font-medium text-muted-foreground backdrop-blur-sm';

export default function ManagedLibrarySearch({ prefill, onClose }: {
  prefill?: LibrarySearchPrefill | null;
  onClose: () => void;
}) {
  const state = useWorkspace();
  const semanticNotice = useSemanticIndexingNotice();
  const {
    query, mode, scope, searching, error, semanticHits, keywordResult,
    entries, semanticView, keywordGroups, active, setActive, inputRef,
    hasLibrary, librarySpansFolders, onQueryChange, setSearchMode, setSearchScope,
    activateEntry, rowProps,
  } = useLibrarySearchController({ prefill, onClose });
  // `aria-modal` promises the rest of the app is inert; the trap makes it
  // true — Tab cycles the panel's controls and closing restores focus.
  const panelRef = useFocusTrap<HTMLDivElement>();

  const isKeyword = mode === 'keyword';
  const trimmedQuery = query.trim();
  // Same membership list, order, and "ensure the window folder" rule the
  // composer's picker uses — the two menus must offer the same folders.
  const folderEntries = folderMenuEntries(state.recent, state.folderPath);

  /** Muted centered notice filling the results area (loading, errors,
   *  no matches); `flex-col items-center` keeps multi-line copy stacked.
   *  A disabled option rather than a bare `<div>`, because it renders
   *  inside the `role="listbox"` scroller — same reasoning as
   *  `PickerEmptyRow`, which owns this shape for the `<ul>` pickers. */
  function renderEmpty(children: ReactNode) {
    return (
      <EmptyState role="option" aria-disabled="true" aria-selected={false} className="flex-col items-center">
        {children}
      </EmptyState>
    );
  }

  function renderKeywordResults(): ReactNode {
    if (searching && !keywordResult) return renderEmpty('Searching…');
    if (!keywordResult || keywordResult.files.length === 0) return renderEmpty('No matches');
    return (
      <div className={HIT_LIST_CLASS} role="presentation">
        {keywordGroups.map((folderGroup) => (
          <div key={folderGroup.folder} role="group" aria-label={folderBasename(folderGroup.folder)}>
            {librarySpansFolders && (
              <div className={FOLDER_HEADER_CLASS} role="presentation">{folderBasename(folderGroup.folder)}</div>
            )}
            {folderGroup.files.map((group) => (
              <div className="mb-1.5" role="presentation" key={`${group.file.folder}::${group.file.path}`}>
                <div
                  className={cn(
                    'flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 hover:bg-muted',
                    group.index === active && 'bg-active',
                  )}
                  title={`${group.file.folder}/${group.file.path}`}
                  {...rowProps(group.index)}
                >
                  {/* Same identity line as the semantic rows —
                    * the folder now lives in the band above, so
                    * only the match count keeps the right edge. */}
                  <span className="inline-flex size-4 flex-none items-center justify-center [&_svg]:size-3.5">
                    <FileTypeIcon format={fileGlyphFormat(group.file.path).format} />
                  </span>
                  <span className="min-w-0 truncate text-base font-medium text-foreground">
                    {basename(group.file.path)}
                  </span>
                  <span className="ml-auto min-w-4 shrink-0 rounded-full bg-muted px-1.5 text-center text-2xs leading-4 text-muted-foreground">{group.file.totalMatches}</span>
                </div>
                {group.matches.map(({ match, index }) => (
                  <div
                    key={`${match.line}#${index}`}
                    className={cn(
                      'flex cursor-pointer items-baseline gap-2 rounded-md py-0.5 pr-2.5 pl-4 text-sm leading-normal hover:bg-muted',
                      index === active && 'bg-active',
                    )}
                    title={`Line ${match.line}`}
                    {...rowProps(index)}
                  >
                    <span className="min-w-6 shrink-0 text-right text-muted-foreground tabular-nums select-none">{match.line}</span>
                    <span className="min-w-0 flex-1 truncate text-foreground [&_mark]:rounded-xs [&_mark]:bg-accent-amber/30 [&_mark]:px-px [&_mark]:text-inherit">
                      {highlightRanges(match.text, match.ranges)}
                    </span>
                  </div>
                ))}
                {group.hiddenCount > 0 && (
                  /* Presentation, not an option: it cannot be selected or
                   * activated, so the listbox must not count it. */
                  <div className="cursor-default py-0.5 pr-2.5 pl-4 text-xs text-muted-foreground" role="presentation">+ {group.hiddenCount} more in this file</div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  function renderSemanticResults(): ReactNode {
    if (searching && !semanticHits) return renderEmpty('Searching…');
    if (!semanticView || semanticView.total === 0) return renderEmpty('No matches');
    return (
      <div className={HIT_LIST_CLASS} role="presentation">
        {semanticView.groups.map((group) => (
          <div key={group.folder} role="group" aria-label={folderBasename(group.folder)}>
            {librarySpansFolders && (
              <div className={FOLDER_HEADER_CLASS} role="presentation">{folderBasename(group.folder)}</div>
            )}
            {group.rows.map(({ hit, index }) => (
              <SemanticHitRow
                key={`${hit.fileName}#${hit.chunkIndex}#${index}`}
                hit={hit}
                isActive={index === active}
                rowProps={rowProps(index)}
              />
            ))}
          </div>
        ))}
      </div>
    );
  }

  /** The results-area body: readiness gates first, then the mode's list. */
  function renderResults(): ReactNode {
    if (!hasLibrary) {
      return renderEmpty(
        <>
          <div>Your library has no folders yet.</div>
          <div>Add a folder from the sidebar to make it searchable.</div>
        </>,
      );
    }
    if (!trimmedQuery) {
      /* Nothing typed, nothing to say: the placeholder and the scope
       * pill on the row above already name where a search will look,
       * and a third line repeating it was the only thing in an
       * otherwise empty panel. */
      return null;
    }
    if (error === EMBEDDER_KEY_ERROR || (error && error.startsWith("Similarity Search isn't set up"))) {
      return renderEmpty(
        <>
          <div>Set up Similarity Search to search by meaning.</div>
          <div>Exact Search works without Similarity Search.</div>
        </>,
      );
    }
    if (error) return renderEmpty(<>Search failed: {error}</>);
    return isKeyword ? renderKeywordResults() : renderSemanticResults();
  }

  return (
    <div
      className={cn('library-search-veil quick-open-blocking', PICKER_VEIL_CLASS)}
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      // Escape must dismiss from ANY focus inside the popup — the mode
      // toggles, scope pill, and banner buttons are all focusable.
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {/* FIXED height, not a content cap: results stream in and change
        * count as the user types, and a panel that resizes under the
        * pointer makes the list impossible to aim at. The list scrolls
        * inside instead. */}
      <div ref={panelRef} className={cn(pickerPanelClass('wide'), 'flex h-[min(480px,calc(100vh-64px))] flex-col')} role="dialog" aria-modal="true" aria-label="Search library">
        {/* Query and the two search settings share ONE row: the settings
          * belong to the query being typed, and a separate toolbar band
          * under the field spent a whole row on two short controls. The
          * result tally is gone with it — the list itself already shows
          * how much came back, and a live count next to the caret is
          * movement the eye must ignore on every keystroke. */}
        <div className="flex items-center gap-1 border-b border-border pr-3">
          {/* Deliberately NOT the `Input` primitive — same exemption as Quick
            * Open. `Input` is the box role (own fill, border, container
            * corner, h-9); this field is a seam across the top of the panel,
            * and the panel is the box AND the focus affordance. Its
            * `overflow-hidden` corners clip a focus ring into a stray bar,
            * which is why `.library-search-veil input:focus-visible` in
            * `web-src/src/styles/globals.css` is unlayered. */}
          <input
            ref={inputRef}
            /* Placeholder at 55% of muted: at this 20px size a full-strength
               muted line reads as typed text and the empty popup looks
               pre-filled. */
            className="min-w-0 flex-1 border-0 bg-transparent px-3.5 py-3.5 [font-family:inherit] text-xl text-foreground outline-0 placeholder:text-placeholder"
            /* The placeholder names the live scope and changes with it — a
             * stable accessible name on top of it, so the field is never
             * named only by hint text. */
            aria-label="Search library"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="library-search-results"
            aria-expanded="true"
            aria-activedescendant={entries.length ? `library-search-${active}` : undefined}
            /* Names the live scope rather than listing formats: the old
               "notes, PDFs, images, and media transcripts" taught coverage
               once and then sat there as a long line the user re-read on
               every open. */
            placeholder={scope.kind === 'folder'
              ? `Search in ${folderBasename(scope.path)}`
              : 'Search in library'}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(index + 1, Math.max(0, entries.length - 1))); }
              else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
              else if (event.key === 'Home' && !query) { event.preventDefault(); setActive(0); }
              else if (event.key === 'End' && !query) { event.preventDefault(); setActive(Math.max(0, entries.length - 1)); }
              else if (event.key === 'Enter' && entries[active]) { event.preventDefault(); activateEntry(entries[active]); }
            }}
          />
          {/* Where it looks, then how it matches. Mode is a two-segment
            * control, not a single state-showing button: one button had
            * to answer "is this label what I AM or what I'd BECOME?" in
            * its copy, and no wording settles that. Both options visible,
            * one pressed, question gone. */}
          <ScopeMenu
            scope={scope}
            entries={folderEntries}
            homeDir={state.homeDir ?? ''}
            heading="Search scope"
            libraryDetail="Search every folder in your library"
            side="bottom"
            ariaLabel="Search scope"
            onSetScope={setSearchScope}
          />
          {/* Lighter than the Settings pickers this primitive was built
            * for: no outer border, a quiet track, and the pressed segment
            * keeps NORMAL weight — bold-on-white beside a 20px query line
            * read as the loudest thing in the popup. Surface and colour
            * carry the selection instead. */}
          <SegmentedControl aria-label="Search mode" className="border-0 bg-muted p-0.5" value={[mode]} onValueChange={(next) => {
            const picked = next[0] as LibrarySearchMode | undefined;
            if (!picked || picked === mode) return;
            if (picked === 'semantic' && state.embedderHasKey === false) {
              onClose();
              openEmbeddingSetup();
              return;
            }
            setSearchMode(picked);
          }}>
            <SegmentedControlItem
              value="semantic"
              className={SEARCH_MODE_SEGMENT_CLASS}
              title={state.embedderHasKey === false
                ? 'Match by meaning — needs Similarity Search setup'
                : 'Match by meaning'}
            >
              Similarity
            </SegmentedControlItem>
            <SegmentedControlItem value="keyword" className={SEARCH_MODE_SEGMENT_CLASS} title="Match exact text">
              Exact
            </SegmentedControlItem>
          </SegmentedControl>
        </div>
        {semanticNotice && <SemanticIndexingNoticeView {...semanticNotice} />}
        <SearchStatusBanner semanticMode={!isKeyword} onNavigateAway={onClose} />
        <div id="library-search-results" role="listbox" aria-label="Search results" className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
          {renderResults()}
        </div>
      </div>
    </div>
  );
}
