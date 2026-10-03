/**
 * The exact-text search backend.
 *
 * It owns the request it sends, the occurrence rows it renders, and the
 * evidence highlighting that makes a match readable. The surface knows only
 * the `SearchBackend` record this module returns.
 */
import { TextSearch } from 'lucide-react';

import { CommandItem } from '@/components/ui/command-menu';
import type { ExactSearchPort } from '@/features/retrieval/application/ports';
import { retrievalQueryKeys } from '@/features/retrieval/application/queries';
import {
  exactSearchNavigationIntent,
  exactSearchOccurrences,
  exactSearchSegments,
  type ExactSearchMatch,
  type ExactSearchOccurrence,
  type ExactSearchRequest,
  type ExactSearchResult,
} from '@/features/retrieval/domain/exact-search';
import { parentPathOf } from '@/shared/utils/file-path';

import type { SearchBackend, SearchRows } from './backend';
import { rowLabel, SourceName } from './row';

const EXACT_DELAY_MS = 160;

interface ExactGroup {
  readonly directory: string;
  readonly occurrences: readonly ExactSearchOccurrence[];
  /** Row number of this group's first occurrence. */
  readonly start: number;
  readonly totalMatches: number;
}

function matchLocation(match: ExactSearchMatch): string {
  if (match.pdfPage) return `Page ${match.pdfPage}`;
  return `Line ${match.line}`;
}

function Evidence({ occurrence }: { occurrence: ExactSearchOccurrence }) {
  return (
    <span className="line-clamp-2 text-caption leading-relaxed break-words text-muted-foreground">
      {exactSearchSegments(occurrence.match.text, [occurrence.range]).map((segment) =>
        segment.highlighted ? (
          <mark className="bg-accent text-foreground" key={segment.offset}>
            {segment.text}
          </mark>
        ) : (
          <span key={segment.offset}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

/** Occurrences outside the searched folder never reach the reader, whatever
 *  the daemon answered. */
function groupOccurrences(result: ExactSearchResult, folderPath: string): ExactGroup[] {
  const groups: ExactGroup[] = [];
  let start = 0;
  for (const file of result.files) {
    if (file.source.folderPath !== folderPath) continue;
    const occurrences = exactSearchOccurrences(file);
    if (occurrences.length === 0) continue;
    groups.push({
      directory: parentPathOf(file.source.path),
      occurrences,
      start,
      totalMatches: file.totalMatches,
    });
    start += occurrences.length;
  }
  return groups;
}

function exactRows(
  result: ExactSearchResult,
  request: ExactSearchRequest,
  folderPath: string,
): SearchRows {
  const groups = groupOccurrences(result, folderPath);
  const occurrences = groups.flatMap((group) => group.occurrences);
  return {
    count: occurrences.length,
    intent: (index) => {
      const occurrence = occurrences[index];
      return occurrence ? exactSearchNavigationIntent(occurrence, request) : null;
    },
    note: result.truncated
      ? `Showing the first results from ${result.totalMatches.toLocaleString()} matches.`
      : null,
    render: (view) =>
      groups.map((group) => {
        const first = group.occurrences[0];
        if (!first) return null;
        const groupId = `${view.rowId(group.start)}-file`;
        return (
          <div aria-labelledby={groupId} key={first.file.id} role="group">
            <div
              className="flex min-w-0 items-center gap-2 px-3 pt-2 pb-1 text-caption"
              id={groupId}
            >
              <SourceName path={first.file.source.path} />
              <span className="shrink-0 text-ui-10 text-muted-foreground tabular-nums">
                {group.totalMatches}
              </span>
            </div>
            {group.directory && (
              <p className="truncate px-9 pb-1 text-ui-10 text-muted-foreground">
                {group.directory}
              </p>
            )}
            {group.occurrences.map((occurrence, offset) => {
              const index = group.start + offset;
              const location = matchLocation(occurrence.match);
              return (
                <CommandItem
                  aria-label={rowLabel(
                    occurrence.file.source.path,
                    location,
                    occurrence.match.text.trim() || 'Matching source',
                  )}
                  className="h-auto min-h-11 items-start py-1.5 pl-9"
                  id={view.rowId(index)}
                  key={occurrence.id}
                  onClick={() => view.onOpen(index)}
                >
                  <span className="mt-0.5 w-9 shrink-0 text-ui-10 text-muted-foreground tabular-nums">
                    {location}
                  </span>
                  <span className="min-w-0 flex-1">
                    <Evidence occurrence={occurrence} />
                  </span>
                </CommandItem>
              );
            })}
          </div>
        );
      }),
  };
}

/** Keyword search: always available, because it never consults the AI
 *  Index. A capital letter in the query makes the match case-sensitive. */
export function exactSearchBackend(api: ExactSearchPort): SearchBackend {
  return {
    delayMs: EXACT_DELAY_MS,
    emptyMessage: 'No exact matches.',
    icon: TextSearch,
    id: 'exact',
    label: 'By keyword',
    lane: ({ folderPath, query }) => {
      const request: ExactSearchRequest = {
        caseSensitive: /[A-Z]/u.test(query),
        folderPath,
        query,
        wholeWord: false,
      };
      return {
        fetch: async (signal) => exactRows(await api.search(request, signal), request, folderPath),
        key: retrievalQueryKeys.exact(request),
      };
    },
    placeholder: 'Search',
    resultsLabel: 'Keyword search results',
    surfaceLabel: 'Exact workspace search',
    tabTitle: 'Match the exact text you type',
  };
}
