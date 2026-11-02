import { useMemo, useState } from 'react';

import type { AgentSessionRuntime } from '@/features/agent/application/session-runtime';
import type { AgentContextItem, AgentScopeEnvironment } from '@/features/agent/domain/context';
import { currentContextSource, fileContextItem } from '@/features/agent/domain/draft-context';
import type { SourceReference } from '@/shared/domain/source-reference';

/** Current document context follows the visible document until a submission
 *  captures it. Removing it excludes that document until the reader switches
 *  documents, without turning an otherwise empty chat into a saved draft. */
export function useCurrentSource(
  environment: AgentScopeEnvironment | null,
  context: readonly AgentContextItem[],
  session: AgentSessionRuntime,
) {
  const current = useMemo(() => currentContextSource(environment, context), [context, environment]);
  const active = environment?.activeSource;
  const activeKey = active ? `${active.folderPath}/${active.path}` : null;
  const [seenKey, setSeenKey] = useState(activeKey);
  const [dismissed, setDismissed] = useState(false);
  if (seenKey !== activeKey) {
    setSeenKey(activeKey);
    setDismissed(false);
  }
  const item = useMemo(
    () =>
      current && !dismissed
        ? { ...fileContextItem(current), boundVersion: environment?.versions[current.path] ?? null }
        : null,
    [current, dismissed, environment],
  );
  return {
    // Capture before access/setup, queueing, or steering snapshots the draft.
    capture: () => {
      if (item) session.addContext(item);
    },
    dismiss: (source: SourceReference) => {
      if (`${source.folderPath}/${source.path}` === activeKey) setDismissed(true);
    },
    item,
  };
}
