import { hashKey, type QueryClient, type QueryKey } from '@tanstack/react-query';

import type { DocumentScope } from '@/features/documents/domain/document';
import {
  documentTextFormat,
  documentViewerFormat,
} from '@/features/documents/domain/document-format';

import {
  DELIMITED_TABLE_MESSAGES,
  documentFailure,
  DOCUMENT_ASSET_MESSAGES,
  DOCUMENT_SOURCE_MESSAGES,
  GENERIC_PREVIEW_MESSAGES,
} from './failure-messages';
import type {
  DelimitedTablePort,
  DocumentAssetPort,
  DocumentSourcePort,
  GenericFilePreviewPort,
} from './ports';
import {
  delimitedTableHeadQuery,
  documentAssetQuery,
  documentSourceQuery,
  genericFilePreviewQuery,
} from './queries';

/** Reads `prepareDocument` made, by query, so the viewer that mounts right
 *  after uses that read instead of reading the file a second time. A read is
 *  used once, and only while it is this recent. */
const PREPARED_READ_MS = 2_000;
const preparedReads = new WeakMap<QueryClient, Map<string, number>>();

async function prepare(client: QueryClient, query: { queryKey: QueryKey }, read: Promise<unknown>) {
  await read;
  let reads = preparedReads.get(client);
  if (!reads) preparedReads.set(client, (reads = new Map()));
  reads.set(hashKey(query.queryKey), Date.now());
}

/** True when `prepareDocument` just read this query and no viewer has used
 *  that read yet; calling it uses the read. */
export function takePreparedRead(client: QueryClient, queryKey: QueryKey): boolean {
  const reads = preparedReads.get(client);
  const key = hashKey(queryKey);
  const at = reads?.get(key);
  reads?.delete(key);
  return at !== undefined && Date.now() - at < PREPARED_READ_MS;
}

/** Resolve a candidate before a usable preview gives up its slot. */
export async function prepareDocument(
  client: QueryClient,
  ports: {
    source: DocumentSourcePort;
    asset: DocumentAssetPort;
    genericPreview: GenericFilePreviewPort;
    table: DelimitedTablePort;
  },
  scope: DocumentScope,
): Promise<string | null> {
  const format = documentViewerFormat(scope.source.path);
  // A table opens on its first page, which a file too large to edit as text
  // still has; its text loads only when the reader asks for the source.
  if (format === 'csv') {
    try {
      const query = delimitedTableHeadQuery(ports.table, scope);
      await prepare(client, query, client.fetchQuery(query));
      return null;
    } catch (error) {
      return documentFailure(error, 'DelimitedTableError', DELIMITED_TABLE_MESSAGES).message;
    }
  }
  try {
    const query = documentTextFormat(scope.source.path)
      ? documentSourceQuery(ports.source, scope)
      : format === 'generic'
        ? genericFilePreviewQuery(ports.genericPreview, scope)
        : documentAssetQuery(ports.asset, scope);
    await prepare(client, query, client.fetchQuery<unknown>(query));
    return null;
  } catch (error) {
    if (documentTextFormat(scope.source.path))
      return documentFailure(error, 'DocumentSourceError', DOCUMENT_SOURCE_MESSAGES).message;
    return format === 'generic'
      ? documentFailure(error, 'GenericFilePreviewError', GENERIC_PREVIEW_MESSAGES).message
      : documentFailure(error, 'DocumentAssetError', DOCUMENT_ASSET_MESSAGES).message;
  }
}
