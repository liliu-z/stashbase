/** A CSV's rows, read a page at a time as the reader scrolls to them. The
 *  first page carries the table's shape and version and follows the file;
 *  every other page belongs to one version, so a change on disk reads the
 *  pages in view again instead of mixing rows from two files. */
import { useQueries, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';

import type { DocumentRuntime } from '@/features/documents/application/document-runtime';
import {
  DelimitedTableError,
  type DelimitedTablePort,
} from '@/features/documents/application/ports';
import {
  delimitedTableHeadQuery,
  delimitedTablePageQuery,
  TABLE_PAGE_ROWS,
} from '@/features/documents/application/queries';
import type { DelimitedTablePage } from '@/features/documents/domain/table';

import { useDocumentRefresh } from './use-document-refresh';
import { usePreparedRead } from './use-prepared-read';

type LoadedTable = Extract<DelimitedTablePage, { kind: 'table' }>;

export interface DelimitedTableView {
  head: UseQueryResult<DelimitedTablePage>;
  onVisibleRows(first: number, last: number): void;
  readRows(top: number, bottom: number, signal: AbortSignal): Promise<string[][]>;
  /** A row's values, or undefined while its page is loading. */
  row(index: number): readonly string[] | undefined;
}

export function useDelimitedTable(
  api: DelimitedTablePort,
  runtime: DocumentRuntime,
  active: boolean,
): DelimitedTableView {
  const queryClient = useQueryClient();
  const scope = runtime.scope;
  const headQuery = delimitedTableHeadQuery(api, scope);
  const prepared = usePreparedRead(headQuery.queryKey);
  const head = useQuery({ ...headQuery, refetchOnMount: !prepared });
  const { refetch } = head;
  useDocumentRefresh(active, refetch, prepared);

  // A save from the source view changes the file; read the table again then
  // rather than at the next poll.
  const savedVersion = useStore(runtime.store, (state) => state.editor?.version);
  useEffect(() => {
    if (savedVersion) void refetch({ cancelRefetch: false });
  }, [refetch, savedVersion]);

  const table: LoadedTable | null = head.data?.kind === 'table' ? head.data : null;
  const [visible, setVisible] = useState({ first: 0, last: 0 });
  const pages = useMemo(() => {
    if (!table) return [];
    const first = Math.max(1, Math.floor(visible.first / TABLE_PAGE_ROWS));
    const last = Math.floor(Math.min(visible.last, table.rowCount - 1) / TABLE_PAGE_ROWS);
    const wanted: number[] = [];
    for (let page = first; page <= last; page += 1) wanted.push(page);
    return wanted;
  }, [table, visible.first, visible.last]);

  const results = useQueries({
    queries: pages.map((page) => ({
      ...delimitedTablePageQuery(api, scope, table?.version ?? '', page),
      enabled: table !== null,
    })),
  });
  const loaded = new Map<number, DelimitedTablePage | undefined>(
    pages.map((page, index) => [page, results[index]?.data]),
  );

  // A page read after the file changed answers for a newer version than the
  // shape on screen; take the new shape first.
  const stale = results.some(
    (result) => result.data?.kind === 'table' && result.data.version !== table?.version,
  );
  useEffect(() => {
    if (stale) void refetch({ cancelRefetch: false });
  }, [refetch, stale]);

  const rowFrom = (page: DelimitedTablePage | undefined, index: number) =>
    page?.kind === 'table' && table && page.version === table.version
      ? page.rows[index - page.start]
      : undefined;

  const row = (index: number) => {
    const page = Math.floor(index / TABLE_PAGE_ROWS);
    return rowFrom(page === 0 ? (table ?? undefined) : loaded.get(page), index);
  };

  const onVisibleRows = useCallback((first: number, last: number) => {
    setVisible((current) =>
      current.first === first && current.last === last ? current : { first, last },
    );
  }, []);

  const readRows = async (top: number, bottom: number, signal: AbortSignal) => {
    if (!table) throw new DelimitedTableError('unavailable', 'The table is not loaded.');
    const rows: string[][] = [];
    for (
      let page = Math.floor(top / TABLE_PAGE_ROWS);
      page <= Math.floor(bottom / TABLE_PAGE_ROWS);
      page += 1
    ) {
      signal.throwIfAborted();
      const data =
        page === 0
          ? table
          : await queryClient.fetchQuery(delimitedTablePageQuery(api, scope, table.version, page));
      if (data.kind !== 'table' || data.version !== table.version) {
        void refetch({ cancelRefetch: false });
        throw new DelimitedTableError('unavailable', 'The file changed while it was read.');
      }
      for (const [offset, values] of data.rows.entries()) {
        const index = data.start + offset;
        if (index >= top && index <= bottom) rows.push(values);
      }
    }
    signal.throwIfAborted();
    return rows;
  };

  return { head, onVisibleRows, readRows, row };
}
