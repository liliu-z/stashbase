import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useState } from 'react';

import { takePreparedRead } from '@/features/documents/application/prepare-document';

/** True when opening this document just read `queryKey`, so the mounting
 *  viewer neither refetches on mount nor checks again on first activation. */
export function usePreparedRead(queryKey: QueryKey): boolean {
  const client = useQueryClient();
  const [prepared] = useState(() => takePreparedRead(client, queryKey));
  return prepared;
}
