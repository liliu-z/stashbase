import { useMemo, useState } from 'react';

import type { AgentContextItem, AgentScopeEnvironment } from '@/features/agent/domain/context';
import { suggestedContextSource } from '@/features/agent/domain/draft-context';
import type { SourceReference } from '@/shared/domain/source-reference';

/** The document in front of the reader to offer as context, and the reader's
 *  way to decline it. A dismissal lasts while the same document stays in
 *  front; switching documents, even back to this one, offers it again. */
export function useSuggestedSource(
  environment: AgentScopeEnvironment | null,
  context: readonly AgentContextItem[],
): { source: SourceReference | null; dismiss: () => void } {
  const suggested = useMemo(
    () => suggestedContextSource(environment, context),
    [context, environment],
  );
  const active = environment?.activeSource;
  const activeKey = active ? `${active.folderPath}/${active.path}` : null;
  const [seenKey, setSeenKey] = useState(activeKey);
  const [dismissed, setDismissed] = useState(false);
  if (seenKey !== activeKey) {
    setSeenKey(activeKey);
    setDismissed(false);
  }
  return { dismiss: () => setDismissed(true), source: dismissed ? null : suggested };
}
